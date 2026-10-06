import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import dotenv from "dotenv";
import { analyzeFood, reviseFood } from "./gemini.js";
import { appendEntries, deleteBatch, ensureReady, getTargets, readLog, replaceBatch, setTargets } from "./sheets.js";
import {
  MEALS,
  addDays,
  mealFromTime,
  nowParts,
  parseClockTime,
  parseTargetCommand,
  sanitizeItem,
  snowflakeTime,
  sumNutrients,
} from "./nutrition.js";
import {
  cancelledEmbed,
  correctionChanges,
  dayEmbed,
  entryEmbed,
  fmt,
  helpEmbed,
  revertRow,
  targetEmbed,
  undoRow,
  weekEmbed,
} from "./embeds.js";

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const targetChannelId = process.env.DISCORD_CHANNEL_ID;
const authorizedUsers = (process.env.DISCORD_AUTHORIZED_USERS || "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

const HELP_COMMANDS = new Set(["bantuan", "help", "cara pakai"]);
const TODAY_COMMANDS = new Set(["hari ini", "today", "ringkasan", "summary", "laporan"]);
const YESTERDAY_COMMANDS = new Set(["kemarin", "yesterday"]);
const WEEK_COMMANDS = new Set(["minggu ini", "mingguan", "week", "7 hari"]);

const MAX_IMAGES = 4;
// Photos are downscaled through Discord's media proxy — plenty for Gemini, far less RAM on the host
const MAX_IMAGE_SIDE = 1600;
// A text message this soon after the latest entry may be a follow-up correction of it
const FOLLOW_UP_WINDOW_MS = 3 * 60 * 60 * 1000;
// Daily nudge in the bot's channel when nothing is logged for today yet — "HH:mm" local time, "off" disables
const reminderTime = parseClockTime(process.env.REMINDER_TIME ?? "21:00");
const REMINDER_CHECK_MS = 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

function isUserAuthorized(userId) {
  if (authorizedUsers.length === 0) return true;
  return authorizedUsers.includes(userId);
}

function isChannelAllowed(channelId) {
  if (!targetChannelId) return true;
  return targetChannelId === channelId;
}

/**
 * Day totals + targets needed by every entry reply
 */
async function dayContext(date) {
  const { entries, targets } = await readLog();
  return {
    dayTotals: sumNutrients(entries.filter((e) => e.date === date)),
    targets,
    today: nowParts().date,
  };
}

function remainingText({ dayTotals, targets }) {
  if (!targets.calories) return "";
  const left = targets.calories - dayTotals.calories;
  return left >= 0 ? ` Sisa hari ini: **${fmt(left)} kkal**.` : ` Lebih **${fmt(-left)} kkal** dari target.`;
}

function resizedUrl(attachment) {
  const { width, height, proxyURL, url } = attachment;
  if (!width || !height || !proxyURL || Math.max(width, height) <= MAX_IMAGE_SIDE) return url;

  const scale = MAX_IMAGE_SIDE / Math.max(width, height);
  const resized = new URL(proxyURL);
  resized.searchParams.set("width", String(Math.round(width * scale)));
  resized.searchParams.set("height", String(Math.round(height * scale)));
  return resized.toString();
}

async function downloadImage(attachment) {
  const preferred = resizedUrl(attachment);
  let res = await fetch(preferred);
  if (!res.ok && preferred !== attachment.url) res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Gagal mengunduh gambar (HTTP ${res.status})`);

  const mimeType = res.headers.get("content-type")?.split(";")[0] || attachment.contentType || "image/jpeg";
  return { data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType };
}

/**
 * The batch ID lives in the Undo button of the bot's entry reply
 */
function findUndoId(message) {
  for (const row of message.components) {
    for (const component of row.components ?? []) {
      if (component.customId?.startsWith("undo:")) return component.customId.slice("undo:".length);
    }
  }
  return null;
}

/**
 * The bot's reply for an entry, if it is still among the channel's recent messages
 */
async function findEntryMessage(channel, batchId) {
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  return recent?.find((m) => m.author.id === client.user.id && findUndoId(m) === batchId) ?? null;
}

/**
 * Rows of the latest entry (by Discord message time), if recent enough for a follow-up to correct it
 */
function latestRecentEntry(entries, now) {
  let latestId = null;
  let latestTime = 0;
  for (const e of entries) {
    const t = snowflakeTime(e.id);
    if (t > latestTime) {
      latestTime = t;
      latestId = e.id;
    }
  }
  if (!latestId || now - latestTime > FOLLOW_UP_WINDOW_MS) return null;
  return entries.filter((e) => e.id === latestId);
}

/**
 * The latest correction of each entry, so its Kembalikan button can undo it:
 * batchId -> { statusMsgId, entryMsgId, rows (before the correction), deleted }.
 * In memory only — after a restart the button just says it's too late.
 */
const corrections = new Map();
const MAX_CORRECTIONS = 100;

function rememberCorrection(batchId, correction) {
  corrections.delete(batchId); // re-insert so the Map stays oldest-first
  corrections.set(batchId, correction);
  if (corrections.size > MAX_CORRECTIONS) corrections.delete(corrections.keys().next().value);
}

/**
 * Replaces a logged meal with corrected items — or deletes it when there are none — and updates
 * its entry message. revision: { items, meal, dayOffset, confidence, notes }; meal "AUTO" keeps the old one.
 */
async function applyCorrection({ batchId, existing, revision, statusMsg, entryMsg }) {
  const [first] = existing;
  const messages = { statusMsgId: statusMsg.id, entryMsgId: entryMsg?.id ?? null };

  if (revision.items.length === 0) {
    const deleted = await deleteBatch(batchId);
    if (deleted.length > 0) rememberCorrection(batchId, { ...messages, rows: deleted, deleted: true });
    const embed = cancelledEmbed(deleted, await dayContext(first.date));
    if (entryMsg) await entryMsg.edit({ embeds: [embed], components: [] });
    await statusMsg.edit({
      content: "↩️ Entri dihapus.",
      embeds: entryMsg ? [] : [embed],
      components: deleted.length > 0 ? [revertRow(batchId)] : [],
    });
    console.log(`↩️ Deleted entry ${batchId} (${deleted.length} item(s)) by correction`);
    return;
  }

  const updated = {
    id: batchId,
    date: revision.dayOffset ? addDays(nowParts().date, revision.dayOffset) : first.date,
    time: first.time,
    meal: MEALS.includes(revision.meal) ? revision.meal : first.meal,
    source: first.source,
    confidence: revision.confidence,
  };
  const replaced = await replaceBatch(batchId, revision.items.map((item) => ({ ...updated, ...item })));
  rememberCorrection(batchId, { ...messages, rows: replaced, deleted: false });

  const ctx = await dayContext(updated.date);
  const embed = entryEmbed({ ...updated, items: revision.items, notes: revision.notes }, ctx, "Dikoreksi");
  const changes = correctionChanges(
    { calories: sumNutrients(existing).calories, meal: first.meal, date: first.date },
    { calories: sumNutrients(revision.items).calories, meal: updated.meal, date: updated.date }
  );
  const summary = `✏️ Koreksi disimpan: ${changes}.${remainingText(ctx)}`;

  if (entryMsg) {
    await entryMsg.edit({ embeds: [embed], components: [undoRow(batchId)] });
    await statusMsg.edit({ content: summary, components: [revertRow(batchId)] });
  } else {
    await statusMsg.edit({ content: summary, embeds: [embed], components: [revertRow(batchId, true)] });
  }
  console.log(`✏️ Corrected entry ${batchId}: ${changes.replaceAll("**", "")}`);
}

/**
 * Kembalikan: puts an entry back as it was before its latest correction
 */
async function handleRevert(interaction, batchId) {
  const saved = corrections.get(batchId);
  if (saved?.statusMsgId !== interaction.message.id) {
    await interaction.editReply({ components: findUndoId(interaction.message) ? [undoRow(batchId)] : [] });
    await interaction.followUp({
      content: "⚠️ Koreksi ini tidak bisa dikembalikan lagi — sudah ada koreksi yang lebih baru, atau bot sempat dimulai ulang.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Taken before any await, so a double-click can't restore it twice
  corrections.delete(batchId);

  const { rows } = saved;
  try {
    if (saved.deleted) await appendEntries(rows);
    else await replaceBatch(batchId, rows);
  } catch (err) {
    if (!corrections.has(batchId)) corrections.set(batchId, saved); // a later click can retry
    throw err;
  }

  const ctx = await dayContext(rows[0].date);
  const embed = entryEmbed({ ...rows[0], items: rows, notes: "" }, ctx, "Dikembalikan");
  const summary = `⏪ Koreksi dibatalkan — kembali ke **${fmt(sumNutrients(rows).calories)} kkal**.${remainingText(ctx)}`;
  const entryMsg = saved.entryMsgId && (await interaction.channel.messages.fetch(saved.entryMsgId).catch(() => null));

  if (entryMsg) {
    await entryMsg.edit({ embeds: [embed], components: [undoRow(batchId)] });
    await interaction.editReply({ content: summary, components: [] });
  } else {
    await interaction.editReply({ content: summary, embeds: [embed], components: [undoRow(batchId)] });
  }
  console.log(`⏪ Reverted correction of entry ${batchId}`);
}

// Entries being undone right now — a double-clicked Batalkan sends two interactions
const undoing = new Set();

async function handleUndo(interaction, batchId) {
  if (undoing.has(batchId)) return;
  undoing.add(batchId);
  try {
    const deleted = await deleteBatch(batchId);
    const ctx = await dayContext(deleted[0]?.date ?? nowParts().date);
    await interaction.editReply({ embeds: [cancelledEmbed(deleted, ctx)], components: [] });
    console.log(`↩️ Undo entry ${batchId} (${deleted.length} item(s))`);
  } finally {
    undoing.delete(batchId);
  }
}

/**
 * Photo(s) and/or text -> estimate -> append to Log -> reply with Undo button.
 * A text-only message may instead be a follow-up correcting the latest entry ("nasinya cuma 1").
 */
async function handleFoodLog(message, images, text) {
  const statusMsg = await message.reply(
    images.length ? "🔍 *Menganalisis foto makanan dengan Gemini Vision...*" : "🔍 *Menghitung nutrisi...*"
  );

  try {
    const { date: today, time } = nowParts(message.createdAt);
    const previousRows = images.length
      ? null
      : latestRecentEntry((await readLog()).entries, message.createdTimestamp);
    const previous = previousRows && {
      time: previousRows[0].time,
      meal: previousRows[0].meal,
      items: previousRows.map(sanitizeItem),
    };

    const result = await analyzeFood({
      images: await Promise.all(images.map(downloadImage)),
      text,
      time,
      previous,
    });

    if (result.intent === "CORRECT_PREVIOUS" && previousRows) {
      const batchId = previousRows[0].id;
      const entryMsg = await findEntryMessage(message.channel, batchId);
      await applyCorrection({ batchId, existing: previousRows, revision: result, statusMsg, entryMsg });
      return;
    }

    if (result.intent === "NONE" || result.items.length === 0) {
      await statusMsg.edit(
        images.length
          ? "⚠️ Tidak ada makanan atau minuman yang terdeteksi. Coba foto yang lebih jelas atau tambahkan keterangan."
          : { content: null, embeds: [helpEmbed()] }
      );
      return;
    }

    const entry = {
      id: message.id,
      date: addDays(today, result.dayOffset),
      time,
      meal: result.meal === "AUTO" ? mealFromTime(time) : result.meal,
      source: images.length ? "Foto" : "Teks",
      confidence: result.confidence,
    };

    await appendEntries(result.items.map((item) => ({ ...entry, ...item })));

    const ctx = await dayContext(entry.date);
    await statusMsg.edit({
      content: null,
      embeds: [entryEmbed({ ...entry, items: result.items, notes: result.notes }, ctx)],
      components: [undoRow(entry.id)],
    });
    console.log(
      `🍽️ Logged ${entry.meal} (${entry.source}): ${result.items.length} item(s), ${sumNutrients(result.items).calories} kkal`
    );
  } catch (err) {
    console.error("Food log error:", err);
    await statusMsg.edit(`❌ Gagal mencatat makanan: ${err.message}`);
  }
}

/**
 * A text reply to one of the bot's entry messages corrects that entry.
 * Returns false when the replied-to message isn't an entry, so it's handled as a normal message.
 */
async function handleCorrection(message, text) {
  const ref = await message.fetchReference().catch(() => null);
  if (!ref || ref.author.id !== client.user.id) return false;

  const batchId = findUndoId(ref);
  if (!batchId) return false;

  const statusMsg = await message.reply("✏️ *Memperbarui entri...*");

  try {
    const { entries } = await readLog();
    const existing = entries.filter((e) => e.id === batchId);
    if (existing.length === 0) {
      await statusMsg.edit("⚠️ Entri ini sudah tidak ada di log (sudah dibatalkan atau dihapus dari sheet).");
      return true;
    }

    const result = await reviseFood({ items: existing.map(sanitizeItem), meal: existing[0].meal, correction: text });

    if (result.action === "NONE") {
      await statusMsg.edit(
        "ℹ️ Untuk mengoreksi, balas dengan perubahannya, misal `cuma setengah porsi`, `nasinya 2 centong`, atau `tambah es teh manis`."
      );
      return true;
    }

    const revision = result.action === "DELETE" ? { ...result, items: [] } : result;
    await applyCorrection({ batchId, existing, revision, statusMsg, entryMsg: ref });
  } catch (err) {
    console.error("Correction error:", err);
    await statusMsg.edit(`❌ Gagal mengoreksi entri: ${err.message}`);
  }
  return true;
}

async function replyDay(message, offset) {
  const today = nowParts().date;
  const date = addDays(today, offset);
  const { entries, targets } = await readLog();
  await message.reply({ embeds: [dayEmbed({ date, entries: entries.filter((e) => e.date === date), targets, today })] });
}

async function replyWeek(message) {
  const today = nowParts().date;
  const { entries, targets } = await readLog();
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i - 6);
    const dayEntries = entries.filter((e) => e.date === date);
    return { date, count: dayEntries.length, totals: sumNutrients(dayEntries) };
  });
  await message.reply({ embeds: [weekEmbed({ days, targets })] });
}

async function replyTargets(message, targets) {
  const updated = Object.keys(targets).length > 0;
  const result = updated ? await setTargets(targets) : await getTargets();
  await message.reply({ embeds: [targetEmbed(result, updated)] });
  if (updated) console.log(`🎯 Targets updated: ${JSON.stringify(result)}`);
}

let lastReminderDate = null;

/**
 * Once a day, at or after the reminder time: if today has no Log rows, ping the channel.
 * The day is only marked done after a successful check, so a Sheets/Discord hiccup is retried next minute.
 * A bot (re)started after the reminder time still reminds that same evening.
 */
async function checkReminder() {
  const { date, time } = nowParts();
  if (time < reminderTime || lastReminderDate === date) return;

  const { entries } = await readLog();
  if (!entries.some((e) => e.date === date)) {
    const channel = await client.channels.fetch(targetChannelId);
    const mentions = authorizedUsers.map((id) => `<@${id}> `).join("");
    await channel.send(
      `${mentions}⏰ Belum ada makanan yang dicatat hari ini. ` +
        "Kirim foto makananmu atau ketik misalnya `nasi goreng + es teh manis`."
    );
    console.log(`⏰ Sent reminder for ${date}`);
  }
  lastReminderDate = date;
}

function scheduleReminderCheck() {
  setTimeout(async () => {
    try {
      await checkReminder();
    } catch (err) {
      console.error("Reminder error:", err);
    }
    scheduleReminderCheck();
  }, REMINDER_CHECK_MS);
}

client.once(Events.ClientReady, (c) => {
  console.log("\n=======================================================");
  console.log(`🤖 Discord Calorie Bot online as: ${c.user.tag}`);
  console.log(`📡 Ready to receive food photos and meal messages!`);
  if (targetChannelId) {
    console.log(`🔒 Restricted to Channel ID: ${targetChannelId}`);
  }
  if (reminderTime && targetChannelId) {
    console.log(`⏰ Daily reminder at ${reminderTime} if nothing is logged`);
    scheduleReminderCheck();
  } else if (reminderTime) {
    console.log("⏰ Daily reminder off — set DISCORD_CHANNEL_ID to enable it");
  }
  console.log("=======================================================\n");
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots and webhooks
  if (message.author.bot) return;

  // Check authorization & channel
  if (!isUserAuthorized(message.author.id)) return;
  if (!isChannelAllowed(message.channelId)) return;

  const text = message.content.trim();
  const command = text.toLowerCase().replace(/[?!.]+$/, "").replace(/\s+/g, " ").trim();
  const images = [...message.attachments.values()]
    .filter((att) => att.contentType?.startsWith("image/"))
    .slice(0, MAX_IMAGES);

  try {
    // 1. Reply to an entry -> correction
    if (message.reference?.messageId && text && images.length === 0) {
      if (await handleCorrection(message, text)) return;
    }

    // 2. Commands
    if (images.length === 0) {
      if (HELP_COMMANDS.has(command)) {
        await message.reply({ embeds: [helpEmbed()] });
        return;
      }
      if (TODAY_COMMANDS.has(command)) {
        await replyDay(message, 0);
        return;
      }
      if (YESTERDAY_COMMANDS.has(command)) {
        await replyDay(message, -1);
        return;
      }
      if (WEEK_COMMANDS.has(command)) {
        await replyWeek(message);
        return;
      }
      const targets = parseTargetCommand(text);
      if (targets) {
        await replyTargets(message, targets);
        return;
      }
      if (!text) return;
    }

    // 3. Food photo(s) or text description
    await handleFoodLog(message, images, text);
  } catch (err) {
    console.error("Discord message error:", err);
    await message.reply(`❌ Terjadi kesalahan: ${err.message}`).catch(() => {});
  }
});

const BUTTONS = {
  undo: { handle: handleUndo, failure: "Gagal membatalkan" },
  revert: { handle: handleRevert, failure: "Gagal mengembalikan" },
};

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const [action, batchId] = interaction.customId.split(":");
  const button = BUTTONS[action];
  if (!button) return;

  if (!isUserAuthorized(interaction.user.id)) {
    await interaction.reply({ content: "⛔ Kamu tidak diizinkan memakai bot ini.", flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    await interaction.deferUpdate();
    await button.handle(interaction, batchId);
  } catch (err) {
    console.error(`Button ${action} error:`, err);
    await interaction
      .followUp({ content: `❌ ${button.failure}: ${err.message}`, flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    client.destroy().finally(() => process.exit(0));
  });
}

ensureReady()
  .then(() => console.log("📗 Spreadsheet ready"))
  .catch((err) => console.error(`⚠️ Spreadsheet not ready yet: ${err.message}`));

if (!token) {
  console.error("❌ DISCORD_TOKEN is not set in .env");
  process.exit(1);
}

client.login(token).catch((err) => {
  console.error("❌ Failed to login to Discord:", err.message);
  process.exit(1);
});

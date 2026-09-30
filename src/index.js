import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import dotenv from "dotenv";
import { analyzeFood, reviseFood } from "./gemini.js";
import { appendEntries, deleteBatch, ensureReady, getTargets, readLog, replaceBatch, setTargets } from "./sheets.js";
import {
  MEALS,
  addDays,
  mealFromTime,
  nowParts,
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
 * Replaces a logged meal with corrected items — or deletes it when there are none — and updates
 * its entry message. revision: { items, meal, dayOffset, confidence, notes }; meal "AUTO" keeps the old one.
 */
async function applyCorrection({ batchId, existing, revision, statusMsg, entryMsg }) {
  const [first] = existing;

  if (revision.items.length === 0) {
    const deleted = await deleteBatch(batchId);
    const embed = cancelledEmbed(deleted, await dayContext(first.date));
    if (entryMsg) await entryMsg.edit({ embeds: [embed], components: [] });
    await statusMsg.edit(entryMsg ? "↩️ Entri dihapus." : { content: "↩️ Entri dihapus.", embeds: [embed] });
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
  await replaceBatch(batchId, revision.items.map((item) => ({ ...updated, ...item })));

  const ctx = await dayContext(updated.date);
  const embed = entryEmbed({ ...updated, items: revision.items, notes: revision.notes }, ctx, "Dikoreksi");
  const changes = correctionChanges(
    { calories: sumNutrients(existing).calories, meal: first.meal, date: first.date },
    { calories: sumNutrients(revision.items).calories, meal: updated.meal, date: updated.date }
  );
  const summary = `✏️ Koreksi disimpan: ${changes}.${remainingText(ctx)}`;

  if (entryMsg) {
    await entryMsg.edit({ embeds: [embed], components: [undoRow(batchId)] });
    await statusMsg.edit(summary);
  } else {
    await statusMsg.edit({ content: summary, embeds: [embed], components: [undoRow(batchId)] });
  }
  console.log(`✏️ Corrected entry ${batchId}: ${changes.replaceAll("**", "")}`);
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

client.once(Events.ClientReady, (c) => {
  console.log("\n=======================================================");
  console.log(`🤖 Discord Calorie Bot online as: ${c.user.tag}`);
  console.log(`📡 Ready to receive food photos and meal messages!`);
  if (targetChannelId) {
    console.log(`🔒 Restricted to Channel ID: ${targetChannelId}`);
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith("undo:")) return;

  if (!isUserAuthorized(interaction.user.id)) {
    await interaction.reply({ content: "⛔ Kamu tidak diizinkan memakai bot ini.", flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    await interaction.deferUpdate();
    const batchId = interaction.customId.slice("undo:".length);
    const deleted = await deleteBatch(batchId);
    const ctx = await dayContext(deleted[0]?.date ?? nowParts().date);
    await interaction.editReply({ embeds: [cancelledEmbed(deleted, ctx)], components: [] });
    console.log(`↩️ Undo entry ${batchId} (${deleted.length} item(s))`);
  } catch (err) {
    console.error("Undo error:", err);
    await interaction
      .followUp({ content: `❌ Gagal membatalkan: ${err.message}`, flags: MessageFlags.Ephemeral })
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

import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import dotenv from "dotenv";
import { GeminiBusyError, analyzeFood, reviseFood } from "./gemini.js";
import { appendEntries, deleteBatch, ensureReady, getTargets, readLog, replaceBatch, setTargets } from "./sheets.js";
import {
  MEALS,
  addDays,
  mealFromTime,
  nowParts,
  parseClockTime,
  parseTargetCommand,
  parseWeeklySchedule,
  sanitizeItem,
  snowflakeTime,
  sumNutrients,
  weekday,
} from "./nutrition.js";
import {
  cancelledEmbed,
  correctionChanges,
  dayEmbed,
  entryEmbed,
  fmt,
  helpEmbed,
  retryRow,
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
// Prefix for the bot's scheduled posts
const mentions = authorizedUsers.map((id) => `<@${id}> `).join("");

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
// Weekly recap of the 7 days up to yesterday — "<day> HH:mm" local time, "off" disables
const weeklyRecap = parseWeeklySchedule(process.env.WEEKLY_RECAP ?? "minggu 05:00");
const RECAP_TITLE = "📅 Rekap Mingguan";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const JOB_CHECK_MS = 60 * 1000;

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
 * The bot's reply that shows a request's progress: a new one, or — on Coba lagi — the failed one, reused
 */
async function workingMessage(message, content, statusMsg) {
  if (!statusMsg) return message.reply(content);
  await statusMsg.edit({ content, embeds: [], components: [] });
  return statusMsg;
}

function onGeminiRetry(statusMsg) {
  return () => statusMsg.edit("⏳ *Gemini sedang sibuk, mencoba lagi...*").catch(() => {});
}

/**
 * When Gemini was busy, nothing was saved — offer Coba lagi for the same message. Other errors as they are.
 */
async function showFailure(statusMsg, message, failure, err) {
  if (err instanceof GeminiBusyError) {
    await statusMsg.edit({
      content: "⏳ Gemini sedang sibuk, jadi belum ada yang disimpan. Tekan **Coba lagi** sebentar lagi.",
      embeds: [],
      components: [retryRow(message.id)],
    });
  } else {
    await statusMsg.edit({ content: `❌ ${failure}: ${err.message}`, embeds: [], components: [] });
  }
}

/**
 * Photo(s) and/or text -> estimate -> append to Log -> reply with Undo button.
 * A text-only message may instead be a follow-up correcting the latest entry ("nasinya cuma 1").
 */
async function handleFoodLog(message, images, text, retryOf = null) {
  const statusMsg = await workingMessage(
    message,
    images.length ? "🔍 *Menganalisis foto makanan dengan Gemini Vision...*" : "🔍 *Menghitung nutrisi...*",
    retryOf
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
      onRetry: onGeminiRetry(statusMsg),
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
    await showFailure(statusMsg, message, "Gagal mencatat makanan", err);
  }
}

/**
 * A text reply to one of the bot's entry messages corrects that entry.
 * Returns false when the replied-to message isn't an entry, so it's handled as a normal message.
 */
async function handleCorrection(message, text, retryOf = null) {
  const ref = await message.fetchReference().catch(() => null);
  if (!ref || ref.author.id !== client.user.id) return false;

  const batchId = findUndoId(ref);
  if (!batchId) return false;

  const statusMsg = await workingMessage(message, "✏️ *Memperbarui entri...*", retryOf);

  try {
    const { entries } = await readLog();
    const existing = entries.filter((e) => e.id === batchId);
    if (existing.length === 0) {
      await statusMsg.edit("⚠️ Entri ini sudah tidak ada di log (sudah dibatalkan atau dihapus dari sheet).");
      return true;
    }

    const result = await reviseFood({
      items: existing.map(sanitizeItem),
      meal: existing[0].meal,
      correction: text,
      onRetry: onGeminiRetry(statusMsg),
    });

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
    await showFailure(statusMsg, message, "Gagal mengoreksi entri", err);
  }
  return true;
}

async function replyDay(message, offset) {
  const today = nowParts().date;
  const date = addDays(today, offset);
  const { entries, targets } = await readLog();
  await message.reply({ embeds: [dayEmbed({ date, entries: entries.filter((e) => e.date === date), targets, today })] });
}

/**
 * Per-day totals for the 7 days ending on `end`, oldest first
 */
function weekDays(entries, end) {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(end, i - 6);
    const dayEntries = entries.filter((e) => e.date === date);
    return { date, count: dayEntries.length, totals: sumNutrients(dayEntries) };
  });
}

async function replyWeek(message) {
  const { entries, targets } = await readLog();
  await message.reply({ embeds: [weekEmbed({ days: weekDays(entries, nowParts().date), targets })] });
}

async function replyTargets(message, targets) {
  const updated = Object.keys(targets).length > 0;
  const result = updated ? await setTargets(targets) : await getTargets();
  await message.reply({ embeds: [targetEmbed(result, updated)] });
  if (updated) console.log(`🎯 Targets updated: ${JSON.stringify(result)}`);
}

/**
 * Reminder: if today has no Log rows, ping the channel
 */
async function checkReminder(date) {
  const { entries } = await readLog();
  if (!entries.some((e) => e.date === date)) {
    const channel = await client.channels.fetch(targetChannelId);
    await channel.send(
      `${mentions}⏰ Belum ada makanan yang dicatat hari ini. ` +
        "Kirim foto makananmu atau ketik misalnya `nasi goreng + es teh manis`."
    );
    console.log(`⏰ Sent reminder for ${date}`);
  }
}

/**
 * Weekly recap: the 7 days up to yesterday, compared with the 7 before
 */
async function sendWeeklyRecap(date) {
  const channel = await client.channels.fetch(targetChannelId);
  // A restart later on the recap day would post it again — unless it's already in the channel
  const recent = await channel.messages.fetch({ limit: 100 });
  const posted = recent.some(
    (m) =>
      m.author.id === client.user.id &&
      nowParts(m.createdAt).date === date &&
      m.embeds[0]?.title?.startsWith(RECAP_TITLE)
  );
  if (posted) return;

  const { entries, targets } = await readLog();
  const end = addDays(date, -1);
  const embed = weekEmbed({
    days: weekDays(entries, end),
    previous: weekDays(entries, addDays(end, -7)),
    targets,
    title: RECAP_TITLE,
  });
  await channel.send({ content: `${mentions}📅 Ini rekap makanmu seminggu terakhir.`, embeds: [embed] });
  console.log(`📅 Sent weekly recap for ${addDays(end, -6)} to ${end}`);
}

/**
 * Scheduled posts in the bot's channel, checked once a minute. Each runs at most once a day, at or
 * after its time. A day is only marked done after a successful run, so a Sheets/Discord hiccup is
 * retried next minute, and a bot (re)started after the time still runs it that day.
 */
const jobs = [];

function scheduleJobs() {
  setTimeout(async () => {
    const { date, time } = nowParts();
    for (const job of jobs) {
      if (job.doneDate === date || !job.isDue(date, time)) continue;
      try {
        await job.run(date);
        job.doneDate = date;
      } catch (err) {
        console.error(`${job.name} error:`, err);
      }
    }
    scheduleJobs();
  }, JOB_CHECK_MS);
}

client.once(Events.ClientReady, (c) => {
  console.log("\n=======================================================");
  console.log(`🤖 Discord Calorie Bot online as: ${c.user.tag}`);
  console.log(`📡 Ready to receive food photos and meal messages!`);
  if (targetChannelId) {
    console.log(`🔒 Restricted to Channel ID: ${targetChannelId}`);
    if (reminderTime) {
      console.log(`⏰ Daily reminder at ${reminderTime} if nothing is logged`);
      jobs.push({ name: "Reminder", isDue: (date, time) => time >= reminderTime, run: checkReminder });
    }
    if (weeklyRecap) {
      console.log(`📅 Weekly recap every ${DAY_NAMES[weeklyRecap.day]} at ${weeklyRecap.time}`);
      jobs.push({
        name: "Weekly recap",
        isDue: (date, time) => weekday(date) === weeklyRecap.day && time >= weeklyRecap.time,
        run: sendWeeklyRecap,
      });
    }
    if (jobs.length > 0) scheduleJobs();
  } else if (reminderTime || weeklyRecap) {
    console.log("⏰ Daily reminder and weekly recap off — set DISCORD_CHANNEL_ID to enable them");
  }
  console.log("=======================================================\n");
});

/**
 * Routes a user message. retryOf: the bot's failed reply when Coba lagi runs the message again.
 */
async function handleMessage(message, retryOf = null) {
  const text = message.content.trim();
  const command = text.toLowerCase().replace(/[?!.]+$/, "").replace(/\s+/g, " ").trim();
  const images = [...message.attachments.values()]
    .filter((att) => att.contentType?.startsWith("image/"))
    .slice(0, MAX_IMAGES);

  // 1. Reply to an entry -> correction
  if (message.reference?.messageId && text && images.length === 0) {
    if (await handleCorrection(message, text, retryOf)) return;
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
  await handleFoodLog(message, images, text, retryOf);
}

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots and webhooks
  if (message.author.bot) return;

  // Check authorization & channel
  if (!isUserAuthorized(message.author.id)) return;
  if (!isChannelAllowed(message.channelId)) return;

  try {
    await handleMessage(message);
  } catch (err) {
    console.error("Discord message error:", err);
    await message.reply(`❌ Terjadi kesalahan: ${err.message}`).catch(() => {});
  }
});

// Messages being run again right now — a double-clicked Coba lagi sends two interactions
const retrying = new Set();

/**
 * Coba lagi: runs the user's original message again, reusing the failed reply
 */
async function handleRetry(interaction, messageId) {
  if (retrying.has(messageId)) return;
  retrying.add(messageId);
  try {
    const message = await interaction.channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      await interaction.editReply({ content: "⚠️ Pesan aslinya sudah dihapus — kirim ulang makanannya.", components: [] });
      return;
    }
    console.log(`🔁 Retry message ${messageId}`);
    await handleMessage(message, interaction.message);
  } finally {
    retrying.delete(messageId);
  }
}

const BUTTONS = {
  undo: { handle: handleUndo, failure: "Gagal membatalkan" },
  revert: { handle: handleRevert, failure: "Gagal mengembalikan" },
  retry: { handle: handleRetry, failure: "Gagal mencoba lagi" },
};

// customId "<action>:<id>" — an entry's batch ID, or for retry the user's message ID
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const [action, id] = interaction.customId.split(":");
  const button = BUTTONS[action];
  if (!button) return;

  if (!isUserAuthorized(interaction.user.id)) {
    await interaction.reply({ content: "⛔ Kamu tidak diizinkan memakai bot ini.", flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    await interaction.deferUpdate();
    await button.handle(interaction, id);
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

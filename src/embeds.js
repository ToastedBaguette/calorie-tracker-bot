import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { EXTRA_KEYS, MEALS, NUTRIENTS, TARGET_KEYS, addDays, formatDateId, sumNutrients } from "./nutrition.js";

const COLORS = {
  ok: 0x2ecc71,
  over: 0xe67e22,
  info: 0x3498db,
  muted: 0x95a5a6,
};

/**
 * 1450 -> "1.450", 0.5 -> "0,5"
 */
export function fmt(n) {
  return (Number(n) || 0).toLocaleString("id-ID", { maximumFractionDigits: 1 });
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function progressBar(value, target, width = 12) {
  const ratio = target ? value / target : 0;
  const filled = Math.min(width, Math.round(ratio * width));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${Math.round(ratio * 100)}%`;
}

function macroLine(t) {
  return `P ${fmt(t.protein)} g · K ${fmt(t.carbs)} g · L ${fmt(t.fat)} g`;
}

function extrasLine(t) {
  return `Serat ${fmt(t.fiber)} g · Gula ${fmt(t.sugar)} g · Natrium ${fmt(t.sodium)} mg`;
}

function dayLabel(date, today) {
  if (date === today) return "Hari Ini";
  if (date === addDays(today, -1)) return "Kemarin";
  return formatDateId(date);
}

/**
 * "⚠️" over a limit (sugar, sodium), "✅" a goal reached (fiber), "" otherwise or without a target
 */
function goalMark(key, value, target) {
  const { goal } = NUTRIENTS.find((n) => n.key === key);
  if (!target) return "";
  if (goal === "max" && value > target) return "⚠️";
  if (goal === "min" && value >= target) return "✅";
  return "";
}

/**
 * "Protein 80/120 g", "Gula 62/50 g ⚠️", or just "Serat 12 g" without a target
 */
function nutrientProgress(key, totals, targets) {
  const { label, unit } = NUTRIENTS.find((n) => n.key === key);
  if (!targets[key]) return `${label} ${fmt(totals[key])} ${unit}`;
  const mark = goalMark(key, totals[key], targets[key]);
  return `${label} ${fmt(totals[key])}/${fmt(targets[key])} ${unit}${mark ? ` ${mark}` : ""}`;
}

function hasExtraTargets(targets) {
  return EXTRA_KEYS.some((key) => targets[key]);
}

/**
 * Calorie progress against the target plus macro totals, e.g. for the "Hari Ini" field.
 * Fiber, sugar and sodium join in once one of them has a target.
 */
export function dayProgress(totals, targets) {
  const lines = [];
  if (targets.calories) {
    const left = targets.calories - totals.calories;
    lines.push(`\`${progressBar(totals.calories, targets.calories)}\``);
    lines.push(
      `**${fmt(totals.calories)} / ${fmt(targets.calories)} kkal** · ` +
        (left >= 0 ? `sisa **${fmt(left)}**` : `lebih **${fmt(-left)}**`)
    );
  } else {
    lines.push(`**${fmt(totals.calories)} kkal** · atur target: \`target 2000\``);
  }

  lines.push(["protein", "carbs", "fat"].map((key) => nutrientProgress(key, totals, targets)).join(" · "));
  if (hasExtraTargets(targets)) {
    lines.push(EXTRA_KEYS.map((key) => nutrientProgress(key, totals, targets)).join(" · "));
  }
  return lines.join("\n");
}

/**
 * What a correction changed: "900 → **705 kkal**", "Camilan → **Makan Siang**", or both.
 * before/after: { calories, meal, date }
 */
export function correctionChanges(before, after) {
  const changes = [];
  if (before.calories !== after.calories) changes.push(`${fmt(before.calories)} → **${fmt(after.calories)} kkal**`);
  if (before.meal !== after.meal) changes.push(`${before.meal} → **${after.meal}**`);
  if (before.date !== after.date) changes.push(`${formatDateId(before.date)} → **${formatDateId(after.date)}**`);
  return changes.length ? changes.join(" · ") : `**${fmt(after.calories)} kkal**`;
}

function itemLine(item) {
  const portion = item.portion ? ` · ${item.portion}` : "";
  return `**${item.name}**${portion}\n╰ ${fmt(item.calories)} kkal · ${macroLine(item)}`;
}

/**
 * Reply for a logged (or corrected) meal
 */
export function entryEmbed({ meal, date, items, confidence, notes }, { dayTotals, targets, today }, action = "Dicatat") {
  const totals = sumNutrients(items);
  const over = targets.calories && dayTotals.calories > targets.calories;
  const when = date === today ? "" : ` (${dayLabel(date, today)})`;
  const description = items.map(itemLine).join("\n") + (notes ? `\n\n*${notes}*` : "");

  return new EmbedBuilder()
    .setColor(over ? COLORS.over : COLORS.ok)
    .setTitle(`🍽️ ${meal} ${action}${when} — ${fmt(totals.calories)} kkal`)
    .setDescription(truncate(description, 4000))
    .addFields(
      { name: "Total", value: `**${fmt(totals.calories)} kkal**\n${macroLine(totals)}\n${extrasLine(totals)}` },
      { name: `${dayLabel(date, today)} · ${formatDateId(date)}`, value: dayProgress(dayTotals, targets) }
    )
    .setFooter({ text: `Estimasi AI · keyakinan ${confidence} · balas pesan ini untuk koreksi` })
    .setTimestamp();
}

/**
 * Replaces an entry's reply after Undo
 */
export function cancelledEmbed(deleted, { dayTotals, targets, today }) {
  const embed = new EmbedBuilder().setColor(COLORS.muted).setTimestamp();
  if (deleted.length === 0) {
    return embed.setTitle("↩️ Dibatalkan").setDescription("Entri sudah tidak ada di log.");
  }

  const { meal, date } = deleted[0];
  return embed
    .setTitle(`↩️ ${meal} Dibatalkan — ${fmt(sumNutrients(deleted).calories)} kkal`)
    .setDescription(truncate(deleted.map((item) => `~~${item.name}~~`).join("\n"), 4000))
    .addFields({ name: `${dayLabel(date, today)} · ${formatDateId(date)}`, value: dayProgress(dayTotals, targets) });
}

function undoButton(batchId) {
  return new ButtonBuilder()
    .setCustomId(`undo:${batchId}`)
    .setLabel("Batalkan")
    .setEmoji("↩️")
    .setStyle(ButtonStyle.Secondary);
}

export function undoRow(batchId) {
  return new ActionRowBuilder().addComponents(undoButton(batchId));
}

/**
 * Coba lagi on a failed reply runs the user's original message again
 */
export function retryRow(messageId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`retry:${messageId}`)
      .setLabel("Coba lagi")
      .setEmoji("🔁")
      .setStyle(ButtonStyle.Primary)
  );
}

/**
 * Kembalikan on a correction reply puts the entry back as it was; withUndo when that reply also shows the entry
 */
export function revertRow(batchId, withUndo = false) {
  const revert = new ButtonBuilder()
    .setCustomId(`revert:${batchId}`)
    .setLabel("Kembalikan")
    .setEmoji("⏪")
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(...(withUndo ? [undoButton(batchId)] : []), revert);
}

/**
 * Summary for one day: progress, then items grouped by meal
 */
export function dayEmbed({ date, entries, targets, today }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`📊 Ringkasan ${dayLabel(date, today)} — ${formatDateId(date)}`)
    .setTimestamp();

  if (entries.length === 0) {
    return embed.setDescription(
      "Belum ada makanan yang dicatat. Kirim foto makananmu atau ketik misalnya `nasi goreng + es teh manis`."
    );
  }

  const totals = sumNutrients(entries);
  embed.setDescription(dayProgress(totals, targets));

  // Known meals in day order first, then anything typed by hand in the sheet
  const meals = [...MEALS, ...new Set(entries.map((e) => e.meal))].filter(
    (meal, i, all) => all.indexOf(meal) === i && entries.some((e) => e.meal === meal)
  );
  for (const meal of meals) {
    const items = entries.filter((e) => e.meal === meal);
    embed.addFields({
      name: `${meal || "Tanpa Kategori"} — ${fmt(sumNutrients(items).calories)} kkal`,
      value: truncate(items.map((i) => `• ${i.name} · ${fmt(i.calories)} kkal`).join("\n"), 1024),
    });
  }

  // With an extras target, the progress above already shows them
  if (!hasExtraTargets(targets)) embed.addFields({ name: "Lainnya", value: extrasLine(totals) });
  return embed;
}

/**
 * The logged days and their per-day average of every nutrient. days: [{ date, count, totals }]
 */
function dailyAverage(days) {
  const logged = days.filter((d) => d.count > 0);
  const sum = sumNutrients(logged.map((d) => d.totals));
  const avg = Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round(v / (logged.length || 1))]));
  return { logged, avg };
}

/**
 * "1.850 → **1.720** kkal/hari (↓130)"
 */
function change(before, after, unit) {
  const diff = after - before;
  const delta = diff === 0 ? "sama" : `${diff > 0 ? "↑" : "↓"}${fmt(Math.abs(diff))}`;
  return `${fmt(before)} → **${fmt(after)}** ${unit} (${delta})`;
}

/**
 * Seven-day overview. days: [{ date, count, totals }] oldest first; previous: the 7 days before,
 * for a comparison (the weekly recap).
 */
export function weekEmbed({ days, targets, title = "📅 7 Hari Terakhir", previous = null }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`${title} — ${formatDateId(days[0].date)} s/d ${formatDateId(days.at(-1).date)}`)
    .setTimestamp();

  const { logged, avg } = dailyAverage(days);
  if (logged.length === 0) {
    return embed.setDescription("Belum ada makanan yang dicatat dalam 7 hari terakhir.");
  }

  const scale = Math.max(1, targets.calories || 0, ...days.map((d) => d.totals.calories));
  const width = 10;
  const lines = days.map((d) => {
    const filled = Math.round((d.totals.calories / scale) * width);
    const over = targets.calories && d.totals.calories > targets.calories ? " ▲" : "";
    const value = d.count ? fmt(d.totals.calories) : "-";
    return `${formatDateId(d.date).padEnd(11)} ${"█".repeat(filled)}${"░".repeat(width - filled)} ${value.padStart(6)}${over}`;
  });
  embed.setDescription(`\`\`\`\n${lines.join("\n")}\n\`\`\``);

  let average = `**${fmt(avg.calories)} kkal/hari**\n${macroLine(avg)}`;
  if (targets.calories) {
    const overDays = logged.filter((d) => d.totals.calories > targets.calories).length;
    average += `\nTarget ${fmt(targets.calories)} kkal · ${overDays} hari di atas target`;
  }
  const extras = EXTRA_KEYS.filter((key) => targets[key]).map((key) => {
    const { label, goal } = NUTRIENTS.find((n) => n.key === key);
    const marked = logged.filter((d) => goalMark(key, d.totals[key], targets[key])).length;
    return goal === "max" ? `${label} di atas batas ${marked} hari` : `${label} tercapai ${marked} hari`;
  });
  if (extras.length > 0) average += `\n${extras.join(" · ")}`;
  embed.addFields({ name: `Rata-rata (${logged.length} hari tercatat)`, value: average });

  const before = previous && dailyAverage(previous);
  if (before?.logged.length > 0) {
    embed.addFields({
      name: `Dibanding 7 hari sebelumnya (${before.logged.length} hari tercatat)`,
      value:
        `Kalori ${change(before.avg.calories, avg.calories, "kkal/hari")}\n` +
        `Protein ${change(before.avg.protein, avg.protein, "g/hari")}`,
    });
  }
  return embed;
}

export function targetEmbed(targets, updated) {
  const lines = TARGET_KEYS.map((key) => {
    const { label, unit, goal } = NUTRIENTS.find((n) => n.key === key);
    const name = goal ? `**${label}** (${goal === "max" ? "maks" : "min"})` : `**${label}**`;
    return `• ${name}: ${targets[key] ? `${fmt(targets[key])} ${unit}` : "*belum diatur*"}`;
  });

  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(updated ? "🎯 Target Harian Diperbarui" : "🎯 Target Harian")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Ubah: target 2000 p120 k250 l60 serat30 gula50 natrium2000 · hapus satu: target p0" });
}

export function helpEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.muted)
    .setTitle("💡 Cara Menggunakan Calorie Bot")
    .setDescription(
      "• **Foto:** kirim foto makanan, screenshot pesanan GoFood/GrabFood, atau label gizi (boleh beberapa gambar). " +
        "Tambah keterangan kalau perlu, misal `setengah porsi, tanpa nasi`.\n" +
        "• **Teks:** `nasi padang rendang + es teh manis`, `sarapan 2 telur rebus`, `kemarin malam martabak 2 potong`\n" +
        "• **Koreksi:** balas (reply) pesan bot, misal `cuma setengah porsi` atau `tambah kerupuk`. " +
        "Koreksi keliru? Tekan ⏪ Kembalikan\n" +
        "• **Batalkan:** tekan tombol ↩️ Batalkan\n" +
        "• **Ringkasan:** `hari ini`, `kemarin`, `minggu ini`\n" +
        "• **Target:** `target 2000 p120 k250 l60` (kalori, protein, karbo, lemak), " +
        "`target serat30 gula50 natrium2000` (serat minimal, gula & natrium maksimal) · `target` untuk melihat"
    );
}

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { MEALS, NUTRIENTS, TARGET_KEYS, addDays, formatDateId, sumNutrients } from "./nutrition.js";

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
 * Calorie progress against the target plus macro totals, e.g. for the "Hari Ini" field
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

  const macros = ["protein", "carbs", "fat"].map((key) => {
    const { label } = NUTRIENTS.find((n) => n.key === key);
    return targets[key]
      ? `${label} ${fmt(totals[key])}/${fmt(targets[key])} g`
      : `${label} ${fmt(totals[key])} g`;
  });
  lines.push(macros.join(" · "));
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

export function undoRow(batchId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`undo:${batchId}`)
      .setLabel("Batalkan")
      .setEmoji("↩️")
      .setStyle(ButtonStyle.Secondary)
  );
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

  embed.addFields({ name: "Lainnya", value: extrasLine(totals) });
  return embed;
}

/**
 * Last-7-days overview. days: [{ date, count, totals }] oldest first.
 */
export function weekEmbed({ days, targets }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`📅 7 Hari Terakhir — ${formatDateId(days[0].date)} s/d ${formatDateId(days.at(-1).date)}`)
    .setTimestamp();

  const logged = days.filter((d) => d.count > 0);
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

  const sum = sumNutrients(logged.map((d) => d.totals));
  const avg = Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round(v / logged.length)]));
  let average = `**${fmt(avg.calories)} kkal/hari**\n${macroLine(avg)}`;
  if (targets.calories) {
    const overDays = logged.filter((d) => d.totals.calories > targets.calories).length;
    average += `\nTarget ${fmt(targets.calories)} kkal · ${overDays} hari di atas target`;
  }
  embed.addFields({ name: `Rata-rata (${logged.length} hari tercatat)`, value: average });
  return embed;
}

export function targetEmbed(targets, updated) {
  const lines = TARGET_KEYS.map((key) => {
    const { label, unit } = NUTRIENTS.find((n) => n.key === key);
    return `• **${label}**: ${targets[key] ? `${fmt(targets[key])} ${unit}` : "*belum diatur*"}`;
  });

  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(updated ? "🎯 Target Harian Diperbarui" : "🎯 Target Harian")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Ubah: target 2000 p120 k250 l60 · hapus satu: target p0" });
}

export function helpEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.muted)
    .setTitle("💡 Cara Menggunakan Calorie Bot")
    .setDescription(
      "• **Foto:** kirim foto makanan, screenshot pesanan GoFood/GrabFood, atau label gizi (boleh beberapa gambar). " +
        "Tambah keterangan kalau perlu, misal `setengah porsi, tanpa nasi`.\n" +
        "• **Teks:** `nasi padang rendang + es teh manis`, `sarapan 2 telur rebus`, `kemarin malam martabak 2 potong`\n" +
        "• **Koreksi:** balas (reply) pesan bot, misal `cuma setengah porsi` atau `tambah kerupuk`\n" +
        "• **Batalkan:** tekan tombol ↩️ Batalkan\n" +
        "• **Ringkasan:** `hari ini`, `kemarin`, `minggu ini`\n" +
        "• **Target:** `target 2000 p120 k250 l60` (kalori, protein, karbo, lemak) · `target` untuk melihat"
    );
}

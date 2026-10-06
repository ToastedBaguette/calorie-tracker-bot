import { test } from "node:test";
import assert from "node:assert/strict";
import { correctionChanges, dayProgress, weekEmbed } from "../src/embeds.js";
import { addDays } from "../src/nutrition.js";

const base = { calories: 900, meal: "Camilan", date: "2026-09-30" };

test("correctionChanges names only what changed", () => {
  assert.equal(correctionChanges(base, { ...base, meal: "Makan Siang" }), "Camilan → **Makan Siang**");
  assert.equal(correctionChanges(base, { ...base, calories: 705 }), "900 → **705 kkal**");
  assert.equal(
    correctionChanges(base, { ...base, calories: 1050, meal: "Makan Siang" }),
    "900 → **1.050 kkal** · Camilan → **Makan Siang**"
  );
  assert.equal(correctionChanges(base, { ...base, date: "2026-09-29" }), "Rab, 30 Sep → **Sel, 29 Sep**");
  assert.equal(correctionChanges(base, base), "**900 kkal**");
});

const totals = { calories: 1500, protein: 80, carbs: 200, fat: 50, fiber: 31, sugar: 62, sodium: 1800 };

test("dayProgress marks limits and goals once an extras target is set", () => {
  const targets = { calories: 2000, protein: 120, carbs: null, fat: null, fiber: 30, sugar: 50, sodium: 2000 };
  assert.deepEqual(dayProgress(totals, targets).split("\n").slice(1), [
    "**1.500 / 2.000 kkal** · sisa **500**",
    "Protein 80/120 g · Karbo 200 g · Lemak 50 g",
    "Serat 31/30 g ✅ · Gula 62/50 g ⚠️ · Natrium 1.800/2.000 mg",
  ]);
});

test("dayProgress leaves the extras out without their targets", () => {
  const lines = dayProgress(totals, { calories: null, protein: 120 }).split("\n");
  assert.deepEqual(lines, ["**1.500 kkal** · atur target: `target 2000`", "Protein 80/120 g · Karbo 200 g · Lemak 50 g"]);
});

function week(end, logged) {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(end, i - 6);
    const day = logged[date];
    return { date, count: day ? 1 : 0, totals: { ...totals, calories: 0, protein: 0, ...day } };
  });
}

test("weekEmbed counts extras days and compares with the week before", () => {
  const embed = weekEmbed({
    days: week("2026-10-10", {
      "2026-10-09": { calories: 1800, protein: 100, sugar: 70, fiber: 20 },
      "2026-10-10": { calories: 1600, protein: 90, sugar: 30, fiber: 35 },
    }),
    previous: week("2026-10-03", { "2026-10-01": { calories: 1900, protein: 80 } }),
    targets: { calories: 2000, fiber: 30, sugar: 50 },
    title: "📅 Rekap Mingguan",
  }).toJSON();

  assert.equal(embed.title, "📅 Rekap Mingguan — Min, 4 Okt s/d Sab, 10 Okt");
  const [average, comparison] = embed.fields;
  assert.equal(average.name, "Rata-rata (2 hari tercatat)");
  assert.match(average.value, /\nSerat tercapai 1 hari · Gula di atas batas 1 hari$/);
  assert.equal(comparison.name, "Dibanding 7 hari sebelumnya (1 hari tercatat)");
  assert.equal(comparison.value, "Kalori 1.900 → **1.700** kkal/hari (↓200)\nProtein 80 → **95** g/hari (↑15)");
});

test("weekEmbed skips the comparison when the week before is empty", () => {
  const embed = weekEmbed({
    days: week("2026-10-10", { "2026-10-10": { calories: 1600 } }),
    previous: week("2026-10-03", {}),
    targets: {},
  }).toJSON();
  assert.deepEqual(embed.fields.map((f) => f.name), ["Rata-rata (1 hari tercatat)"]);
});

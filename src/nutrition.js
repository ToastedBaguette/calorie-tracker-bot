/**
 * Pure helpers: time zone math, meal inference, nutrient totals, command parsing.
 * No I/O here — everything is unit-tested in test/nutrition.test.js.
 */

export const TIMEZONE = process.env.TZ || "Asia/Jakarta";

export const MEALS = ["Sarapan", "Makan Siang", "Camilan", "Makan Malam"];

// goal: "min" is reached by eating at least the target, "max" is a limit not to exceed
export const NUTRIENTS = [
  { key: "calories", label: "Kalori", unit: "kkal", digits: 0 },
  { key: "protein", label: "Protein", unit: "g", digits: 1 },
  { key: "carbs", label: "Karbo", unit: "g", digits: 1 },
  { key: "fat", label: "Lemak", unit: "g", digits: 1 },
  { key: "fiber", label: "Serat", unit: "g", digits: 1, goal: "min" },
  { key: "sugar", label: "Gula", unit: "g", digits: 1, goal: "max" },
  { key: "sodium", label: "Natrium", unit: "mg", digits: 0, goal: "max" },
];

// Daily targets the user can set — a subset of NUTRIENTS, stored in this order in Target!B2:B8,
// so new keys only ever go at the end
export const TARGET_KEYS = ["calories", "protein", "carbs", "fat", "fiber", "sugar", "sodium"];
export const EXTRA_KEYS = ["fiber", "sugar", "sodium"];

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Current date and time in the bot's time zone: { date: "YYYY-MM-DD", time: "HH:mm" }
 */
export function nowParts(at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * Shifts a "YYYY-MM-DD" date by n days
 */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * "2026-09-30" -> "Rab, 30 Sep"
 */
export function formatDateId(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat("id-ID", { weekday: "short", timeZone: "UTC" }).format(d);
  const dayMonth = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
  return `${weekday}, ${dayMonth}`;
}

/**
 * 0 (Sunday) … 6 (Saturday) for a "YYYY-MM-DD" date
 */
export function weekday(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

const WEEKDAYS = {
  minggu: 0, sun: 0, sunday: 0,
  senin: 1, mon: 1, monday: 1,
  selasa: 2, tue: 2, tuesday: 2,
  rabu: 3, wed: 3, wednesday: 3,
  kamis: 4, thu: 4, thursday: 4,
  jumat: 5, fri: 5, friday: 5,
  sabtu: 6, sat: 6, saturday: 6,
};

/**
 * "minggu 05:00" / "Sun 5" -> { day: 0, time: "05:00" }; null for "off" or anything else
 */
export function parseWeeklySchedule(text) {
  const match = String(text ?? "").trim().toLowerCase().match(/^(\S+)\s+(\S+)$/);
  if (!match || !Object.hasOwn(WEEKDAYS, match[1])) return null;
  const time = parseClockTime(match[2]);
  return time && { day: WEEKDAYS[match[1]], time };
}

/**
 * "21:00" / "21.00" / "9" -> "21:00" / "09:00"; null for "off", "" or anything else
 */
export function parseClockTime(text) {
  const match = String(text ?? "").trim().match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2] ?? 0);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Creation time (ms since epoch) encoded in a Discord ID; 0 for anything else
 */
export function snowflakeTime(id) {
  if (!/^\d{15,20}$/.test(String(id))) return 0;
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

/**
 * Meal type from the local clock when the user didn't say which meal it was
 */
export function mealFromTime(time) {
  const [h, m] = time.split(":").map(Number);
  const minutes = h * 60 + m;
  if (minutes >= 4 * 60 && minutes < 10 * 60 + 30) return "Sarapan";
  if (minutes >= 10 * 60 + 30 && minutes < 15 * 60) return "Makan Siang";
  if (minutes >= 17 * 60 && minutes < 22 * 60) return "Makan Malam";
  return "Camilan";
}

/**
 * Coerces a model-produced item into clean, non-negative, rounded numbers
 */
export function sanitizeItem(item) {
  const clean = {
    name: String(item.name || "Makanan").trim(),
    portion: String(item.portion || "").trim(),
  };
  for (const { key, digits } of NUTRIENTS) {
    const n = Number(item[key]);
    clean[key] = Number.isFinite(n) && n > 0 ? round(n, digits) : 0;
  }
  return clean;
}

/**
 * Sums every nutrient across items (entries from the sheet or fresh model items)
 */
export function sumNutrients(items) {
  const totals = {};
  for (const { key, digits } of NUTRIENTS) {
    totals[key] = round(items.reduce((sum, item) => sum + (Number(item[key]) || 0), 0), digits);
  }
  return totals;
}

const TARGET_LABELS = {
  protein: "protein",
  prot: "protein",
  p: "protein",
  karbohidrat: "carbs",
  karbo: "carbs",
  carbs: "carbs",
  carb: "carbs",
  k: "carbs",
  c: "carbs",
  lemak: "fat",
  fat: "fat",
  l: "fat",
  f: "fat",
  kalori: "calories",
  kkal: "calories",
  kcal: "calories",
  cal: "calories",
  serat: "fiber",
  fiber: "fiber",
  gula: "sugar",
  sugar: "sugar",
  natrium: "sodium",
  sodium: "sodium",
};

/**
 * Parses "target 2000 p120 k250 l60" / "goal 1800 protein 100".
 * Returns null if the text is not a target command, {} for a bare "target".
 */
export function parseTargetCommand(text) {
  const match = text.trim().match(/^(?:target|goal)\b(.*)$/is);
  if (!match) return null;

  // "2.000" / "2,000" -> "2000"
  const rest = match[1].replace(/(\d)[.,](\d{3})(?!\d)/g, "$1$2");
  const targets = {};
  const labels = Object.keys(TARGET_LABELS).sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(`(?:\\b(${labels})\\b\\s*[:=]?\\s*|\\b(${labels}))?(\\d+)`, "gi");

  for (const [, spacedLabel, gluedLabel, value] of rest.matchAll(re)) {
    const label = (spacedLabel || gluedLabel || "").toLowerCase();
    const key = label ? TARGET_LABELS[label] : "calories";
    targets[key] = Number(value);
  }
  return targets;
}

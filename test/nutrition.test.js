import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  formatDateId,
  mealFromTime,
  nowParts,
  parseTargetCommand,
  sanitizeItem,
  snowflakeTime,
  sumNutrients,
} from "../src/nutrition.js";

test("nowParts converts to Asia/Jakarta (UTC+7)", () => {
  assert.deepEqual(nowParts(new Date("2026-09-30T17:30:00Z")), { date: "2026-10-01", time: "00:30" });
  assert.deepEqual(nowParts(new Date("2026-09-30T05:05:00Z")), { date: "2026-09-30", time: "12:05" });
});

test("addDays crosses month and year boundaries", () => {
  assert.equal(addDays("2026-10-01", -1), "2026-09-30");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-09-30", 0), "2026-09-30");
});

test("formatDateId uses Indonesian names", () => {
  assert.match(formatDateId("2026-09-30"), /^Rab, 30 Sep$/);
});

test("mealFromTime buckets the day", () => {
  assert.equal(mealFromTime("07:15"), "Sarapan");
  assert.equal(mealFromTime("10:29"), "Sarapan");
  assert.equal(mealFromTime("12:00"), "Makan Siang");
  assert.equal(mealFromTime("16:00"), "Camilan");
  assert.equal(mealFromTime("19:30"), "Makan Malam");
  assert.equal(mealFromTime("23:10"), "Camilan");
  assert.equal(mealFromTime("02:00"), "Camilan");
});

test("sanitizeItem clamps and rounds model output", () => {
  assert.deepEqual(
    sanitizeItem({ name: " Nasi putih ", portion: "1 piring", calories: 260.4, protein: "4.36", carbs: 57, fat: -1, fiber: null, sugar: "x", sodium: 2.6 }),
    { name: "Nasi putih", portion: "1 piring", calories: 260, protein: 4.4, carbs: 57, fat: 0, fiber: 0, sugar: 0, sodium: 3 }
  );
});

test("sumNutrients adds every nutrient", () => {
  const totals = sumNutrients([
    { calories: 260, protein: 4.4, carbs: 57, fat: 0.4, fiber: 0.6, sugar: 0.1, sodium: 2 },
    { calories: 195, protein: 20.1, carbs: 3, fat: 11.2, fiber: 0, sugar: 1, sodium: 480 },
  ]);
  assert.deepEqual(totals, { calories: 455, protein: 24.5, carbs: 60, fat: 11.6, fiber: 0.6, sugar: 1.1, sodium: 482 });
});

test("parseTargetCommand", () => {
  assert.equal(parseTargetCommand("nasi goreng"), null);
  assert.equal(parseTargetCommand("targetnya berapa"), null);
  assert.deepEqual(parseTargetCommand("target"), {});
  assert.deepEqual(parseTargetCommand("target 2000"), { calories: 2000 });
  assert.deepEqual(parseTargetCommand("Target 2.000 kkal"), { calories: 2000 });
  assert.deepEqual(parseTargetCommand("target 2000 p120 k250 l60"), { calories: 2000, protein: 120, carbs: 250, fat: 60 });
  assert.deepEqual(parseTargetCommand("goal 1800 protein 100 karbo: 200 lemak=55"), {
    calories: 1800,
    protein: 100,
    carbs: 200,
    fat: 55,
  });
  assert.deepEqual(parseTargetCommand("target kalori 1900 p 110"), { calories: 1900, protein: 110 });
  assert.deepEqual(parseTargetCommand("target p0"), { protein: 0 });
});

test("snowflakeTime decodes Discord IDs", () => {
  assert.equal(new Date(snowflakeTime("1554787275106426920")).toISOString().slice(0, 16), "2026-09-30T09:29");
  assert.equal(snowflakeTime("TEST-A"), 0);
  assert.equal(snowflakeTime(""), 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { correctionChanges } from "../src/embeds.js";

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

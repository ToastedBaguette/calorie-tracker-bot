import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { MEALS, sanitizeItem } from "./nutrition.js";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("Warning: GEMINI_API_KEY is not set in .env!");
}

const ai = new GoogleGenAI({ apiKey });

// Candidate models in order of priority (most stable & fastest first)
const CANDIDATE_MODELS = [
  ...new Set([process.env.GEMINI_MODEL || "gemini-3.5-flash", "gemini-3.6-flash", "gemini-flash-latest"]),
];

const FOOD_ITEM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: {
      type: Type.STRING,
      description: "Short food/drink name in Bahasa Indonesia, e.g. 'Nasi putih', 'Rendang sapi', 'Es teh manis'.",
    },
    portion: {
      type: Type.STRING,
      description: "Estimated portion including grams or ml, e.g. '1 piring (~200 g)', '1 gelas (~250 ml)', '2 potong (~120 g)'.",
    },
    calories: { type: Type.NUMBER, description: "Energy for this portion in kcal." },
    protein: { type: Type.NUMBER, description: "Protein in grams." },
    carbs: { type: Type.NUMBER, description: "Carbohydrates in grams." },
    fat: { type: Type.NUMBER, description: "Fat in grams." },
    fiber: { type: Type.NUMBER, description: "Dietary fiber in grams." },
    sugar: { type: Type.NUMBER, description: "Sugars in grams." },
    sodium: { type: Type.NUMBER, description: "Sodium in milligrams." },
  },
  required: ["name", "portion", "calories", "protein", "carbs", "fat", "fiber", "sugar", "sodium"],
};

const COMMON_PROPERTIES = {
  dayOffset: {
    type: Type.INTEGER,
    description: "0 unless the user says when it was eaten: -1 for 'kemarin'/yesterday, -2 for two days ago, etc.",
  },
  items: { type: Type.ARRAY, items: FOOD_ITEM_SCHEMA },
  confidence: {
    type: Type.STRING,
    enum: ["tinggi", "sedang", "rendah"],
    description: "How confident the portion and nutrient estimate is.",
  },
  notes: {
    type: Type.STRING,
    description: "One short sentence in Bahasa Indonesia with the key assumptions (portion, cooking method). Empty if none.",
  },
};

const FOOD_LOG_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      enum: ["NEW", "CORRECT_PREVIOUS", "NONE"],
      description:
        "NEW: the input shows or describes food/drink the user consumed. CORRECT_PREVIOUS: the text adjusts the previous entry given in the prompt (only possible when one is given). NONE: no food or drink (greeting, question, unrelated image).",
    },
    meal: {
      type: Type.STRING,
      enum: MEALS,
      description: "Meal type, following the MEAL TYPE rules.",
    },
    ...COMMON_PROPERTIES,
  },
  required: ["intent", "meal", "dayOffset", "items", "confidence", "notes"],
};

const REVISION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    action: {
      type: Type.STRING,
      enum: ["UPDATE", "DELETE", "NONE"],
      description:
        "UPDATE if the reply corrects the entry. DELETE if the user asks to remove/cancel the whole entry. NONE if the reply is not a correction (thanks, a question, chit-chat).",
    },
    meal: {
      type: Type.STRING,
      enum: ["AUTO", ...MEALS],
      description: "New meal type ONLY if the reply changes it (e.g. 'ini sarapan'). Otherwise AUTO.",
    },
    ...COMMON_PROPERTIES,
  },
  required: ["action", "meal", "dayOffset", "items", "confidence", "notes"],
};

const MEAL_GUIDE = `MEAL TYPE — use what the user says if they name it (sarapan, makan siang, makan malam, camilan/snack). Otherwise infer it from the local time and the food:
- Sarapan 04:00-10:30, Makan Siang 10:30-15:00, Makan Malam 17:00-22:00.
- A full meal (rice or noodles with lauk, a main dish) outside those windows belongs to the nearest main meal, e.g. nasi + ayam at 16:30 is Makan Siang, at 23:00 Makan Malam.
- Snacks, desserts, or drinks on their own are Camilan, at any time.`;

const ESTIMATION_GUIDE = `You are a precise nutrition analyst for an Indonesian user's personal calorie tracker.

HOW TO ESTIMATE:
- List every distinct food and drink separately (nasi, lauk, sayur, sambal, kerupuk, minuman...) — one item per component, not one item for the whole plate.
- Estimate each portion in grams/ml from visual cues: plate (~24-26 cm), bowl, glass, cutlery, hands, packaging. Put it in 'portion'.
- Account for hidden energy: frying oil (gorengan, ayam goreng, tumisan), santan (rendang, gulai, opor), sugar in drinks (es teh manis, kopi susu), sauces and sambal.
- Use Indonesian food composition values (TKPI) for local dishes and USDA values otherwise. Keep calories consistent with macros (about 4 x protein + 4 x carbs + 9 x fat).
- The image may be a food photo, a screenshot of a food-delivery order or menu (GoFood, GrabFood, ShopeeFood) — use the listed items and quantities — or a nutrition-facts label — use the label values times the servings eaten.
- The user's note overrides what you see: portion ("setengah porsi", "2 porsi"), exclusions ("tanpa nasi"), brand, or what they actually ate.
- If the portion is ambiguous, give the most likely estimate and lower 'confidence'. Never return zero calories for real food.
- Write names and notes in Bahasa Indonesia.`;

// A stuck model must not hang the reply: each call gets ATTEMPT_TIMEOUT_MS, a whole request TOTAL_TIMEOUT_MS
const ATTEMPT_TIMEOUT_MS = 45 * 1000;
const TOTAL_TIMEOUT_MS = 2 * 60 * 1000;
// Demand spikes are short — when every model is busy, wait this long and go through them once more
const BUSY_RETRY_DELAY_MS = 15 * 1000;

/**
 * Every model was busy or timed out — the same request is worth trying again later
 */
export class GeminiBusyError extends Error {
  constructor() {
    super("Gemini sedang sibuk");
    this.name = "GeminiBusyError";
  }
}

function isBusy(err) {
  return [429, 503].includes(err.status) || /\b(429|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/.test(err.message || "");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a Gemini request across the fallback models. If they are all busy or time out, calls onRetry,
 * waits, and goes through them once more; if that fails too, throws GeminiBusyError.
 */
async function generateWithFallback(contents, schema, onRetry) {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let lastError = null;
  let busy = false;

  for (let round = 0; round < 2; round++) {
    if (round > 0) {
      if (!busy || Date.now() + BUSY_RETRY_DELAY_MS >= deadline) break;
      console.warn(`All models busy. Retrying in ${BUSY_RETRY_DELAY_MS / 1000} s...`);
      await onRetry?.();
      await sleep(BUSY_RETRY_DELAY_MS);
      busy = false;
    }

    for (const model of CANDIDATE_MODELS) {
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) break;
      const signal = AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, timeLeft));
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            responseMimeType: "application/json",
            responseSchema: schema,
            abortSignal: signal,
          },
        });

        const text = response.text?.trim();
        if (!text) throw new Error("Empty response received from Gemini");

        return JSON.parse(text);
      } catch (err) {
        lastError = err;
        if (signal.aborted) {
          busy = true;
          console.warn(`Model ${model} timed out. Trying fallback...`);
        } else if (isBusy(err)) {
          busy = true;
          console.warn(`Model ${model} unavailable/busy. Trying fallback...`);
          await sleep(800);
        } else {
          console.warn(`Model ${model} failed (${err.message}). Trying fallback...`);
        }
      }
    }
  }

  throw busy ? new GeminiBusyError() : lastError;
}

function normalize(result) {
  const offset = Number.isInteger(result.dayOffset) ? result.dayOffset : 0;
  return {
    ...result,
    meal: MEALS.includes(result.meal) ? result.meal : "AUTO",
    dayOffset: Math.min(0, Math.max(-7, offset)),
    items: (result.items || []).map(sanitizeItem),
    confidence: result.confidence || "sedang",
    notes: (result.notes || "").trim(),
  };
}

function previousEntryGuide(previous) {
  return `The user's previous entry, logged at ${previous.time} as ${previous.meal}:
${JSON.stringify(previous.items, null, 2)}

Decide whether the new message adjusts that entry or logs new food:
- CORRECT_PREVIOUS only if it clearly refers back to or adjusts that entry, e.g. "nasinya cuma 1", "tadi itu setengah porsi", "ayamnya 2 potong", "tambah kerupuk tadi", "bukan rendang tapi gulai", "itu makan siang". Then return the COMPLETE corrected item list for that entry (keep untouched items exactly, scale/remove/add/rename as the message says), and meal = ${previous.meal} unless the message changes it. If the user wants the whole entry removed, return items [].
- If it describes other food or drink eaten, even shortly after, it is NEW: return only the new items. When in doubt, choose NEW.`;
}

/**
 * Estimates the nutrition of a meal from images (photos/screenshots) and/or a text description.
 * images: [{ data: base64, mimeType }]; time: local "HH:mm";
 * previous: the user's latest entry { time, meal, items } — lets a text follow-up correct it.
 * onRetry: called before a second pass when every model is busy.
 */
export async function analyzeFood({ images = [], text = "", time, previous = null, onRetry }) {
  const task = images.length
    ? `Analyze the food and drinks in the attached image${images.length > 1 ? "s (they belong to the same meal)" : ""}.`
    : "The user describes in text what they ate or drank (no image).";
  const prompt = `${ESTIMATION_GUIDE}

${MEAL_GUIDE}

Local time now: ${time}.
${task}
If there is no food or drink at all, set intent NONE and items [].
${previous ? `\n${previousEntryGuide(previous)}\n` : ""}
${text ? `User note:\n"""\n${text}\n"""` : ""}`;

  const parts = [...images.map((img) => ({ inlineData: img })), { text: prompt }];
  const result = await generateWithFallback([{ role: "user", parts }], FOOD_LOG_SCHEMA, onRetry);
  return normalize(result);
}

/**
 * Applies a free-text correction ("cuma setengah porsi", "tambah es teh") to a logged entry
 */
export async function reviseFood({ items, meal, correction, onRetry }) {
  const prompt = `${ESTIMATION_GUIDE}

The user logged this ${meal} entry earlier:
${JSON.stringify(items, null, 2)}

They replied to it with:
"""
${correction}
"""

For UPDATE, return the complete corrected list of items: keep untouched items exactly as they are, and scale, remove, add, or rename items as the reply says.
Set meal and dayOffset only if the reply changes them; otherwise meal AUTO and dayOffset 0.`;

  const result = await generateWithFallback([{ role: "user", parts: [{ text: prompt }] }], REVISION_SCHEMA, onRetry);
  return normalize(result);
}

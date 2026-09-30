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
  meal: {
    type: Type.STRING,
    enum: ["AUTO", ...MEALS],
    description:
      "Meal type ONLY if the user explicitly says it (sarapan/breakfast, makan siang/lunch, makan malam/dinner, camilan/snack). Otherwise AUTO.",
  },
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
    isFood: {
      type: Type.BOOLEAN,
      description: "True if the input shows or describes food/drink the user consumed. False for greetings, questions, or images without food.",
    },
    ...COMMON_PROPERTIES,
  },
  required: ["isFood", "meal", "dayOffset", "items", "confidence", "notes"],
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
    ...COMMON_PROPERTIES,
  },
  required: ["action", "meal", "dayOffset", "items", "confidence", "notes"],
};

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

/**
 * Helper to execute Gemini requests with automatic fallback across models
 */
async function generateWithFallback(contents, schema) {
  let lastError = null;

  for (const model of CANDIDATE_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      });

      const text = response.text?.trim();
      if (!text) throw new Error("Empty response received from Gemini");

      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      const errMsg = err.message || "";
      const isTransient =
        errMsg.includes("503") ||
        errMsg.includes("429") ||
        errMsg.includes("UNAVAILABLE") ||
        errMsg.includes("high demand") ||
        errMsg.includes("RESOURCE_EXHAUSTED");

      if (isTransient) {
        console.warn(`Model ${model} unavailable/busy. Trying fallback...`);
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }

      console.warn(`Model ${model} failed (${err.message}). Trying fallback...`);
    }
  }

  throw lastError;
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

/**
 * Estimates the nutrition of a meal from images (photos/screenshots) and/or a text description.
 * images: [{ data: base64, mimeType }]
 */
export async function analyzeFood({ images = [], text = "" }) {
  const task = images.length
    ? `Analyze the food and drinks in the attached image${images.length > 1 ? "s (they belong to the same meal)" : ""}.`
    : "The user describes in text what they ate or drank (no image). If it isn't about food or drink, set isFood false and items [].";
  const prompt = `${ESTIMATION_GUIDE}

${task}
If there is no food or drink at all, set isFood false and items [].
${text ? `User note:\n"""\n${text}\n"""` : ""}`;

  const parts = [...images.map((img) => ({ inlineData: img })), { text: prompt }];
  const result = await generateWithFallback([{ role: "user", parts }], FOOD_LOG_SCHEMA);
  return normalize(result);
}

/**
 * Applies a free-text correction ("cuma setengah porsi", "tambah es teh") to a logged entry
 */
export async function reviseFood({ items, meal, correction }) {
  const prompt = `${ESTIMATION_GUIDE}

The user logged this ${meal} entry earlier:
${JSON.stringify(items, null, 2)}

They replied to it with:
"""
${correction}
"""

For UPDATE, return the complete corrected list of items: keep untouched items exactly as they are, and scale, remove, add, or rename items as the reply says.
Set meal and dayOffset only if the reply changes them; otherwise meal AUTO and dayOffset 0.`;

  const result = await generateWithFallback([{ role: "user", parts: [{ text: prompt }] }], REVISION_SCHEMA);
  return normalize(result);
}

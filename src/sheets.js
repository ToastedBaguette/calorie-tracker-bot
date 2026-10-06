import { sheets as sheetsApi, auth as googleAuth } from "@googleapis/sheets";
import dotenv from "dotenv";
import fs from "fs";
import { NUTRIENTS, TARGET_KEYS } from "./nutrition.js";

dotenv.config();

// Accept either the bare ID or the full spreadsheet URL
const rawSpreadsheetId = (process.env.SPREADSHEET_ID || "").trim();
const spreadsheetId = rawSpreadsheetId.match(/\/d\/([\w-]+)/)?.[1] || rawSpreadsheetId;
const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || "./service_account.json";

const LOG = "Log";
const TARGET = "Target";
const DAILY = "Harian";

// Log columns: A ID · B Tanggal · C Jam · D Waktu Makan · E Makanan · F Porsi · G–M nutrients · N Sumber · O Keyakinan
const LOG_HEADERS = [
  "ID",
  "Tanggal",
  "Jam",
  "Waktu Makan",
  "Makanan",
  "Porsi",
  ...NUTRIENTS.map((n) => `${n.label} (${n.unit})`),
  "Sumber",
  "Keyakinan",
];
const LOG_RANGE = `'${LOG}'!A2:O`;
const NUTRIENT_COL = 6;

const TARGET_RANGE = `'${TARGET}'!B2:B${TARGET_KEYS.length + 1}`;
const TARGET_ROWS = [
  ["Target Harian", "Nilai"],
  ...TARGET_KEYS.map((key) => {
    const n = NUTRIENTS.find((x) => x.key === key);
    return [`${n.label} (${n.unit})`, ""];
  }),
];

// Per-day totals, computed live from the Log tab — for browsing in Google Sheets.
// Whole-column range: a bounded one like B2:M gets shifted by row inserts and deletes.
// QUERY types empty columns as text and sum() errors, hence IFERROR until the first row exists.
const DAILY_FORMULA =
  `=IFERROR(QUERY(${LOG}!B:M, "select B, sum(G), sum(H), sum(I), sum(J), sum(K), sum(L), sum(M), count(E) ` +
  `where B is not null group by B order by B desc ` +
  `label B 'Tanggal', sum(G) 'Kalori (kkal)', sum(H) 'Protein (g)', sum(I) 'Karbo (g)', sum(J) 'Lemak (g)', ` +
  `sum(K) 'Serat (g)', sum(L) 'Gula (g)', sum(M) 'Natrium (mg)', count(E) 'Item'", 1), "Belum ada data")`;

const INITIAL_CONTENT = {
  [LOG]: [LOG_HEADERS],
  [TARGET]: TARGET_ROWS,
};

let client = null;
let logSheetId = null;
let setupPromise = null;

// Log writes run one at a time: rows are deleted by position, so two overlapping writes
// (a double-clicked Batalkan, an undo during a correction) would hit the wrong rows
let logWrites = Promise.resolve();

function serializeLogWrite(task) {
  const run = logWrites.then(task);
  logWrites = run.catch(() => {});
  return run;
}

function getClient() {
  if (!client) {
    if (!fs.existsSync(keyFile)) {
      throw new Error(`Service account key not found at ${keyFile}`);
    }
    const auth = new googleAuth.GoogleAuth({
      keyFile,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    client = sheetsApi({ version: "v4", auth });
  }
  return client;
}

function serviceAccountEmail() {
  try {
    return JSON.parse(fs.readFileSync(keyFile, "utf-8")).client_email;
  } catch {
    return "the service account";
  }
}

async function getTabs() {
  const meta = await getClient().spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  return meta.data.sheets.map((s) => s.properties);
}

/**
 * Creates the Log / Target / Harian tabs on first run so no template import is needed.
 * Existing tabs are never overwritten.
 */
async function setupSpreadsheet() {
  if (!spreadsheetId) throw new Error("SPREADSHEET_ID is not set in .env");

  const api = getClient();
  let tabs;
  try {
    tabs = await getTabs();
  } catch (err) {
    throw new Error(
      `Cannot open the spreadsheet — share it with ${serviceAccountEmail()} as Editor (${err.message})`
    );
  }

  const titles = tabs.map((t) => t.title);
  const missing = [LOG, TARGET, DAILY].filter((t) => !titles.includes(t));

  if (missing.length > 0) {
    const requests = [];
    const [first] = tabs;
    const reuseDefaultTab =
      missing.includes(LOG) && tabs.length === 1 && missing.length === 3 && (await isTabEmpty(first.title));

    for (const title of missing) {
      if (title === LOG && reuseDefaultTab) {
        // A fresh spreadsheet has one empty default tab — turn it into Log instead of leaving it behind
        requests.push({
          updateSheetProperties: {
            properties: { sheetId: first.sheetId, title: LOG, gridProperties: { frozenRowCount: 1 } },
            fields: "title,gridProperties.frozenRowCount",
          },
        });
      } else {
        requests.push({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } });
      }
    }

    await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    console.log(`📗 Spreadsheet: created tab(s) ${missing.join(", ")}`);
    tabs = await getTabs();
  }

  // Harian holds only the bot's formula, so it is rewritten on every start — formula fixes
  // then reach existing spreadsheets too. Log and Target are only seeded when just created.
  const seeds = missing.filter((title) => title !== DAILY);
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        ...seeds.map((title) => ({ range: `'${title}'!A1`, values: INITIAL_CONTENT[title] })),
        { range: `'${DAILY}'!A1`, values: [[DAILY_FORMULA]] },
      ],
    },
  });

  logSheetId = tabs.find((t) => t.title === LOG).sheetId;
}

async function isTabEmpty(title) {
  const res = await getClient().spreadsheets.values.get({ spreadsheetId, range: `'${title}'!A1:Z20` });
  return !res.data.values?.length;
}

/**
 * Resolves once the spreadsheet is reachable and set up. A failure is retried on the next
 * call, so sharing the sheet later works without restarting the bot.
 */
export function ensureReady() {
  if (!setupPromise) {
    setupPromise = setupSpreadsheet().catch((err) => {
      setupPromise = null;
      throw err;
    });
  }
  return setupPromise;
}

// Dates/times typed by hand in the browser come back as serial numbers
function toIsoDate(value) {
  if (typeof value === "number") {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000)).toISOString().slice(0, 10);
  }
  return String(value ?? "").trim();
}

function toTime(value) {
  if (typeof value === "number") {
    const minutes = Math.round((value % 1) * 1440);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  return String(value ?? "").trim();
}

function toEntry(row) {
  const entry = {
    id: String(row[0] ?? ""),
    date: toIsoDate(row[1]),
    time: toTime(row[2]),
    meal: String(row[3] ?? ""),
    name: String(row[4] ?? ""),
    portion: String(row[5] ?? ""),
  };
  NUTRIENTS.forEach(({ key }, i) => {
    entry[key] = Number(row[NUTRIENT_COL + i]) || 0;
  });
  entry.source = String(row[NUTRIENT_COL + NUTRIENTS.length] ?? "");
  entry.confidence = String(row[NUTRIENT_COL + NUTRIENTS.length + 1] ?? "");
  return entry;
}

function toRow(entry) {
  return [
    entry.id,
    entry.date,
    entry.time,
    entry.meal,
    entry.name,
    entry.portion,
    ...NUTRIENTS.map(({ key }) => entry[key]),
    entry.source,
    entry.confidence,
  ];
}

// Typed cells for batchUpdate, matching valueInputOption RAW: dates, times and IDs stay text
function toCellRow(entry) {
  return {
    values: toRow(entry).map((value) => {
      if (typeof value === "number") return { userEnteredValue: { numberValue: value } };
      if (value === "" || value == null) return {};
      return { userEnteredValue: { stringValue: String(value) } };
    }),
  };
}

function toTargets(values = []) {
  return Object.fromEntries(
    TARGET_KEYS.map((key, i) => {
      const n = Number(values[i]?.[0]);
      return [key, Number.isFinite(n) && n > 0 ? n : null];
    })
  );
}

/**
 * Reads every logged item plus the daily targets in one request
 */
export async function readLog() {
  await ensureReady();
  const res = await getClient().spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [LOG_RANGE, TARGET_RANGE],
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const [log, targets] = res.data.valueRanges || [];
  return {
    entries: (log?.values || []).filter((row) => row[1] !== undefined && row[1] !== "").map(toEntry),
    targets: toTargets(targets?.values),
  };
}

/**
 * Appends item rows. RAW keeps "2026-09-30" and Discord IDs as text instead of letting Sheets reinterpret them.
 * OVERWRITE fills the empty rows below the table instead of inserting rows, which would shift references to Log.
 */
export function appendEntries(entries) {
  return serializeLogWrite(async () => {
    await ensureReady();
    await getClient().spreadsheets.values.append({
      spreadsheetId,
      range: `'${LOG}'!A1:O1`,
      valueInputOption: "RAW",
      insertDataOption: "OVERWRITE",
      requestBody: { values: entries.map(toRow) },
    });
  });
}

/**
 * One logged meal's entries and their 0-based sheet row indexes, top-down
 */
async function findBatchRows(id) {
  const res = await getClient().spreadsheets.values.get({
    spreadsheetId,
    range: LOG_RANGE,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const entries = [];
  const rowIndexes = [];
  (res.data.values || []).forEach((row, i) => {
    if (String(row[0] ?? "") === id) {
      entries.push(toEntry(row));
      rowIndexes.push(i + 1); // +1 for the header row
    }
  });
  return { entries, rowIndexes };
}

// Bottom-up so each deletion doesn't shift the rows still to be deleted
function deleteRowRequests(rowIndexes) {
  return [...rowIndexes]
    .reverse()
    .map((i) => ({ deleteDimension: { range: { sheetId: logSheetId, dimension: "ROWS", startIndex: i, endIndex: i + 1 } } }));
}

/**
 * Deletes every row of one logged meal. Returns the deleted entries.
 */
export function deleteBatch(id) {
  return serializeLogWrite(async () => {
    await ensureReady();
    const { entries, rowIndexes } = await findBatchRows(id);
    if (rowIndexes.length > 0) {
      await getClient().spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: deleteRowRequests(rowIndexes) } });
    }
    return entries;
  });
}

/**
 * Replaces one logged meal's rows with corrected ones, in place, in one batchUpdate — Sheets applies
 * all of it or nothing, so a failure leaves the old rows untouched. Returns the replaced entries.
 */
export function replaceBatch(id, entries) {
  return serializeLogWrite(async () => {
    await ensureReady();
    const { entries: replaced, rowIndexes } = await findBatchRows(id);
    if (rowIndexes.length === 0) throw new Error("entri sudah tidak ada di log");

    // The new rows go in above the old ones, which shift down by entries.length before they are deleted
    const start = rowIndexes[0];
    const requests = [
      { insertDimension: { range: { sheetId: logSheetId, dimension: "ROWS", startIndex: start, endIndex: start + entries.length } } },
      {
        updateCells: {
          start: { sheetId: logSheetId, rowIndex: start, columnIndex: 0 },
          rows: entries.map(toCellRow),
          fields: "userEnteredValue",
        },
      },
      ...deleteRowRequests(rowIndexes.map((i) => i + entries.length)),
    ];
    await getClient().spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    return replaced;
  });
}

export async function getTargets() {
  await ensureReady();
  const res = await getClient().spreadsheets.values.get({
    spreadsheetId,
    range: TARGET_RANGE,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return toTargets(res.data.values);
}

/**
 * Merges new targets into the Target tab. A value of 0 clears that target.
 */
export async function setTargets(partial) {
  const next = { ...(await getTargets()), ...partial };
  await getClient().spreadsheets.values.update({
    spreadsheetId,
    range: TARGET_RANGE,
    valueInputOption: "RAW",
    requestBody: { values: TARGET_KEYS.map((key) => [next[key] || ""]) },
  });
  return toTargets(TARGET_KEYS.map((key) => [next[key]]));
}

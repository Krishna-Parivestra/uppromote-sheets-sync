import { google } from "googleapis";
import { logger } from "../utils/logger.js";

export const SHEET_HEADERS = [
  "source_order_id",
  "source",
  "referral_id",
  "order_date",
  "product_name",
  "quantity",
  "order_amount",
  "commission_amount",
  "commission_status",
  "commission_status_raw",
  "order_status",
  "order_status_raw",
  "customer_name",
  "customer_email",
  "reference_id",
  "last_synced_at",
  "raw_snapshot_json",
];

const DATA_START_ROW = 2;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function getAuth() {
  const encoded = requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON_B64");
  let json;
  try {
    json = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (error) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not valid base64 JSON: ${error.message}`);
  }

  if (!json.client_email || !json.private_key) {
    throw new Error("Google service-account JSON is missing client_email or private_key");
  }

  return new google.auth.GoogleAuth({
    credentials: json,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function sheetsClient() {
  return google.sheets({ version: "v4", auth: getAuth() });
}

function serializeDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

// Google Sheets stores date/time values as serial day numbers. Using the
// serial representation keeps writes and subsequent reads stable, avoiding
// false updates caused by Sheets returning parsed dates as numbers.
function serializeSheetsDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.getTime() / 86400000 + 25569;
}

function serializeCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return serializeDate(value);
  return String(value);
}

export function orderToRow(order, syncedAt = new Date()) {
  return [
    serializeCell(order.sourceOrderId),
    serializeCell(order.source),
    serializeCell(order.referralId),
    serializeSheetsDate(order.orderDate),
    serializeCell(order.productName),
    serializeCell(order.quantity),
    serializeCell(order.orderAmount),
    serializeCell(order.commissionAmount),
    serializeCell(order.commissionStatus),
    serializeCell(order.commissionStatusRaw),
    serializeCell(order.orderStatus),
    serializeCell(order.orderStatusRaw),
    serializeCell(order.customerName),
    serializeCell(order.customerEmail),
    serializeCell(order.referenceId),
    serializeSheetsDate(syncedAt),
    order.rawSnapshot ? JSON.stringify(order.rawSnapshot) : "",
  ];
}

function rowKey(row) {
  return String(row?.[0] ?? "").trim();
}

function comparableRow(row) {
  return SHEET_HEADERS.map((_, index) => String(row?.[index] ?? "").trim());
}

function dataEqual(a, b) {
  return JSON.stringify(comparableRow(a)) === JSON.stringify(comparableRow(b));
}

async function ensureSheetHeader(sheets, spreadsheetId, tabName) {
  const range = `${tabName}!A1:${columnLetter(SHEET_HEADERS.length)}1`;
  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const existing = current.data.values?.[0] || [];
  const matches = existing.length === SHEET_HEADERS.length && SHEET_HEADERS.every((h, i) => existing[i] === h);
  if (matches) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [SHEET_HEADERS] },
  });
  logger.info("Initialized Google Sheet header", { tabName });
}

function columnLetter(number) {
  let n = number;
  let result = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

async function formatDateColumns(sheets, spreadsheetId, tabName) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  const sheet = metadata.data.sheets?.find((s) => s.properties?.title === tabName);
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId === undefined) throw new Error(`Google Sheet tab not found: ${tabName}`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 },
            cell: { userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm:ss" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 14, endColumnIndex: 15 },
            cell: { userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm:ss" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
      ],
    },
  });
}

async function readExistingRows(sheets, spreadsheetId, tabName) {
  const endColumn = columnLetter(SHEET_HEADERS.length);
  const range = `${tabName}!A${DATA_START_ROW}:${endColumn}`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return response.data.values || [];
}

export async function upsertOrders(orders) {
  const spreadsheetId = requireEnv("GOOGLE_SHEETS_ID");
  const tabName = process.env.GOOGLE_SHEETS_TAB?.trim() || "RAW_ORDERS";
  const sheets = sheetsClient();

  await ensureSheetHeader(sheets, spreadsheetId, tabName);
  await formatDateColumns(sheets, spreadsheetId, tabName);
  const existingRows = await readExistingRows(sheets, spreadsheetId, tabName);

  const rowByOrderId = new Map();
  for (let i = 0; i < existingRows.length; i++) {
    const id = rowKey(existingRows[i]);
    if (id) rowByOrderId.set(id, { rowNumber: DATA_START_ROW + i, row: existingRows[i] });
  }

  const now = new Date();
  const appendRows = [];
  const updates = [];
  let unchanged = 0;

  for (const order of orders) {
    const row = orderToRow(order, now);
    const id = rowKey(row);
    if (!id) continue;

    const existing = rowByOrderId.get(id);
    if (!existing) {
      appendRows.push(row);
      continue;
    }

    // Ignore last_synced_at when deciding whether source data changed.
    const existingComparable = [...existing.row];
    const newComparable = [...row];
    existingComparable[14] = "";
    newComparable[14] = "";

    if (dataEqual(existingComparable, newComparable)) {
      unchanged++;
      continue;
    }

    updates.push({ rowNumber: existing.rowNumber, row });
  }

  if (appendRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabName}!A:${columnLetter(SHEET_HEADERS.length)}`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: appendRows },
    });
  }

  if (updates.length > 0) {
    const data = updates.map(({ rowNumber, row }) => ({
      range: `${tabName}!A${rowNumber}:${columnLetter(SHEET_HEADERS.length)}${rowNumber}`,
      values: [row],
    }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data },
    });
  }

  const result = {
    found: orders.length,
    created: appendRows.length,
    updated: updates.length,
    unchanged,
  };
  logger.info("Google Sheets upsert completed", result);
  return result;
}

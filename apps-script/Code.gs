const HEADERS = [
  "account_id",
  "account_name",
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

const LEGACY_HEADERS = [
  "source_order_id", "source", "referral_id", "order_date", "product_name", "quantity",
  "order_amount", "commission_amount", "commission_status", "commission_status_raw",
  "order_status", "order_status_raw", "customer_name", "customer_email", "reference_id",
  "last_synced_at", "raw_snapshot_json",
];

const ACCOUNT_ID_INDEX = 0;
const SOURCE_ORDER_ID_INDEX = 2;
const COLUMN_COUNT = HEADERS.length;
const STAGING_TAB = "__SYNC_STAGING";
const WRITE_CHUNK_SIZE = 1000;

function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function getConfig() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = (props.getProperty("SPREADSHEET_ID") || "").trim();
  const secret = (props.getProperty("SYNC_SECRET") || "").trim();
  const tabName = (props.getProperty("TAB_NAME") || "RAW_ORDERS").trim();
  if (!spreadsheetId) throw new Error("SPREADSHEET_ID script property is not set");
  if (!secret) throw new Error("SYNC_SECRET script property is not set");
  return { spreadsheetId, secret, tabName };
}

function doGet() {
  return jsonResponse({ ok: true, service: "uppromote-sheets-sync", version: 4 });
}

function doPost(e) {
  try {
    const config = getConfig();
    const body = JSON.parse(e?.postData?.contents || "{}");
    if (body.secret !== config.secret) return jsonResponse({ ok: false, error: "Unauthorized" });

    if (body.action === "replaceAccountOrders") {
      if (!body.accountId) return jsonResponse({ ok: false, error: "accountId is required" });
      if (!Array.isArray(body.rows)) return jsonResponse({ ok: false, error: "rows must be an array" });
      return jsonResponse({
        ok: true,
        ...replaceAccountRows_(config.spreadsheetId, config.tabName, String(body.accountId), body.rows, Boolean(body.allowEmpty)),
      });
    }

    if (body.action === "upsertOrders") {
      if (!Array.isArray(body.rows)) return jsonResponse({ ok: false, error: "rows must be an array" });
      return jsonResponse({ ok: true, ...upsertRows_(config.spreadsheetId, config.tabName, body.rows) });
    }

    return jsonResponse({ ok: false, error: "Unsupported action" });
  } catch (error) {
    return jsonResponse({ ok: false, error: error.message, stack: error.stack });
  }
}

function ensureMainHeader_(sheet) {
  const headerWidth = Math.max(sheet.getLastColumn(), COLUMN_COUNT);
  const header = sheet.getRange(1, 1, 1, headerWidth).getValues()[0] || [];
  const current = header.slice(0, COLUMN_COUNT);
  const isCurrent = HEADERS.every((h, i) => current[i] === h);
  if (isCurrent) return;

  const isLegacy = LEGACY_HEADERS.every((h, i) => current[i] === h);
  if (isLegacy) {
    const lastRow = sheet.getLastRow();
    const legacyRows = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, LEGACY_HEADERS.length).getValues() : [];
    const migrated = legacyRows.map((oldRow) => {
      const row = new Array(COLUMN_COUNT).fill("");
      row[ACCOUNT_ID_INDEX] = "legacy";
      row[1] = "Legacy / Unassigned";
      for (let i = 0; i < oldRow.length; i++) row[i + 2] = oldRow[i];
      return row;
    });
    sheet.clearContents();
    sheet.getRange(1, 1, 1, COLUMN_COUNT).setValues([HEADERS]);
    if (migrated.length) writeChunks_(sheet, 2, migrated);
    return;
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, COLUMN_COUNT).setValues([HEADERS]);
    return;
  }

  throw new Error(`Unexpected header row in ${sheet.getName()}. Refusing to overwrite existing sheet structure.`);
}

function rowKey_(row) {
  const accountId = String(row?.[ACCOUNT_ID_INDEX] ?? "").trim();
  const orderId = String(row?.[SOURCE_ORDER_ID_INDEX] ?? "").trim();
  return accountId && orderId ? `${accountId}::${orderId}` : "";
}

function writeChunks_(sheet, startRow, rows) {
  for (let offset = 0; offset < rows.length; offset += WRITE_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + WRITE_CHUNK_SIZE);
    sheet.getRange(startRow + offset, 1, chunk.length, COLUMN_COUNT).setValues(chunk);
  }
}

function formatDateColumns_(sheet, rowCount) {
  if (rowCount <= 0) return;
  sheet.getRange(2, 6, rowCount, 1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheet.getRange(2, 18, rowCount, 1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
}

function normalizeIncomingRow_(rawRow, accountId, seenKeys) {
  if (!Array.isArray(rawRow) || rawRow.length < COLUMN_COUNT) return null;
  const row = rawRow.slice(0, COLUMN_COUNT);
  if (String(row[ACCOUNT_ID_INDEX] ?? "").trim() !== accountId) return null;
  const key = rowKey_(row);
  if (!key || seenKeys.has(key)) return null;
  seenKeys.add(key);
  return row;
}

/**
 * Replaces only one account's rows with the newest snapshot.
 * Other accounts are left untouched. The replacement is performed under a
 * script lock so two account runs cannot overwrite each other concurrently.
 */
function replaceAccountRows_(spreadsheetId, tabName, accountId, incomingRows, allowEmpty) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const sheet = spreadsheet.getSheetByName(tabName) || spreadsheet.insertSheet(tabName);
    ensureMainHeader_(sheet);

    const seenKeys = new Set();
    const incoming = [];
    for (const rawRow of incomingRows) {
      const row = normalizeIncomingRow_(rawRow, accountId, seenKeys);
      if (row) incoming.push(row);
    }

    if (incoming.length === 0 && !allowEmpty) {
      throw new Error(`Refusing to replace account ${accountId} with an empty or invalid dataset`);
    }

    const lastRow = sheet.getLastRow();
    const existing = lastRow >= 2
      ? sheet.getRange(2, 1, lastRow - 1, COLUMN_COUNT).getValues()
      : [];

    const output = [];
    let removedOld = 0;
    let keptOtherAccounts = 0;

    for (const row of existing) {
      const existingAccountId = String(row?.[ACCOUNT_ID_INDEX] ?? "").trim();
      if (existingAccountId === accountId) {
        removedOld++;
      } else {
        output.push(row);
        keptOtherAccounts++;
      }
    }

    output.push(...incoming);

    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, COLUMN_COUNT).clearContent();
    }
    if (output.length) writeChunks_(sheet, 2, output);
    formatDateColumns_(sheet, output.length);

    return {
      received: incomingRows.length,
      accepted: incoming.length,
      removedOld,
      keptOtherAccounts,
      written: incoming.length,
      finalRowCount: output.length,
    };
  } finally {
    lock.releaseLock();
  }
}

// Retained for compatibility with earlier deployments. New code uses
// replaceAccountOrders_, not incremental upserts.
function upsertRows_(spreadsheetId, tabName, incomingRows) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const sheet = spreadsheet.getSheetByName(tabName) || spreadsheet.insertSheet(tabName);
    ensureMainHeader_(sheet);
    const lastRow = sheet.getLastRow();
    const existingRows = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, COLUMN_COUNT).getValues() : [];
    const rowById = new Map();
    existingRows.forEach((row, index) => {
      const id = rowKey_(row);
      if (id) rowById.set(id, { index, row });
    });
    const appendRows = [];
    let created = 0, updated = 0, unchanged = 0, skipped = 0;
    for (const rawRow of incomingRows) {
      if (!Array.isArray(rawRow) || rawRow.length < COLUMN_COUNT) { skipped++; continue; }
      const row = rawRow.slice(0, COLUMN_COUNT);
      const id = rowKey_(row);
      if (!id) { skipped++; continue; }
      const existing = rowById.get(id);
      if (!existing) { appendRows.push(row); created++; continue; }
      existingRows[existing.index] = row;
      updated++;
    }
    if (updated > 0 && existingRows.length > 0) writeChunks_(sheet, 2, existingRows);
    if (appendRows.length > 0) writeChunks_(sheet, Math.max(sheet.getLastRow() + 1, 2), appendRows);
    const finalRowCount = Math.max(sheet.getLastRow() - 1, 0);
    formatDateColumns_(sheet, finalRowCount);
    return { received: incomingRows.length, created, updated, unchanged, skipped, finalRowCount };
  } finally {
    lock.releaseLock();
  }
}

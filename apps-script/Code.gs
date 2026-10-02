const HEADERS = [
  "account_id","account_name","source_order_id","source","referral_id","order_date","product_name","quantity",
  "order_amount","commission_amount","commission_status","commission_status_raw","order_status","order_status_raw",
  "customer_name","customer_email","reference_id","last_synced_at","raw_snapshot_json",
];

const LEGACY_HEADERS = [
  "source_order_id","source","referral_id","order_date","product_name","quantity","order_amount","commission_amount",
  "commission_status","commission_status_raw","order_status","order_status_raw","customer_name","customer_email",
  "reference_id","last_synced_at","raw_snapshot_json",
];

const ACCOUNT_ID_INDEX = 0;
const SOURCE_ORDER_ID_INDEX = 2;
const COLUMN_COUNT = HEADERS.length;
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
  return jsonResponse({ ok: true, service: "uppromote-sheets-sync", version: 5, mode: "full-rebuild" });
}

function doPost(e) {
  try {
    const config = getConfig();
    const body = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : "{}");
    if (body.secret !== config.secret) return jsonResponse({ ok: false, error: "Unauthorized" });

    if (body.action === "replaceAllOrders") {
      if (!Array.isArray(body.rows)) return jsonResponse({ ok: false, error: "rows must be an array" });
      return jsonResponse({ ok: true, ...replaceAllRows_(config.spreadsheetId, config.tabName, body.rows, Boolean(body.allowEmpty)) });
    }

    // Kept for compatibility with older clients.
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
  const width = Math.max(sheet.getLastColumn(), COLUMN_COUNT);
  const header = sheet.getRange(1, 1, 1, width).getValues()[0] || [];
  const current = header.slice(0, COLUMN_COUNT);
  if (HEADERS.every((h, i) => current[i] === h)) return;

  const isLegacy = LEGACY_HEADERS.every((h, i) => current[i] === h);
  if (isLegacy) {
    const lastRow = sheet.getLastRow();
    const legacyRows = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, LEGACY_HEADERS.length).getValues() : [];
    const migrated = legacyRows.map(oldRow => {
      const row = new Array(COLUMN_COUNT).fill("");
      row[0] = "legacy";
      row[1] = "Legacy / Unassigned";
      for (let i = 0; i < oldRow.length; i++) row[i + 2] = oldRow[i];
      return row;
    });
    sheet.getRange(1, 1, 1, sheet.getMaxColumns()).clearContent();
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
  const accountId = String(row && row[ACCOUNT_ID_INDEX] != null ? row[ACCOUNT_ID_INDEX] : "").trim();
  const orderId = String(row && row[SOURCE_ORDER_ID_INDEX] != null ? row[SOURCE_ORDER_ID_INDEX] : "").trim();
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

function normalizeFullRow_(rawRow, seenKeys) {
  if (!Array.isArray(rawRow) || rawRow.length < COLUMN_COUNT) return null;
  const row = rawRow.slice(0, COLUMN_COUNT);
  const key = rowKey_(row);
  if (!key || seenKeys.has(key)) return null;
  seenKeys.add(key);
  return row;
}

/**
 * FULL REBUILD MODE:
 * 1. Validate/dedupe the complete incoming dataset.
 * 2. Physically delete EVERY row below row 1.
 * 3. Create exactly the fresh row count and write it starting at row 2.
 *
 * Nothing is appended to the previous dataset.
 */
function replaceAllRows_(spreadsheetId, tabName, incomingRows, allowEmpty) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const sheet = spreadsheet.getSheetByName(tabName) || spreadsheet.insertSheet(tabName);
    ensureMainHeader_(sheet);

    const seenKeys = new Set();
    const rows = [];
    for (const rawRow of incomingRows) {
      const row = normalizeFullRow_(rawRow, seenKeys);
      if (row) rows.push(row);
    }

    if (rows.length === 0 && !allowEmpty) {
      throw new Error("Refusing to wipe sheet because the incoming dataset is empty or invalid");
    }

    // NUCLEAR FULL REBUILD:
    // Physically delete every row below the header, then create exactly
    // the number of fresh data rows required. This is intentionally NOT
    // clearContent(): the old spreadsheet rows themselves must disappear.
    const rowsBefore = sheet.getMaxRows();
    const dataRowsBefore = Math.max(rowsBefore - 1, 0);

    if (dataRowsBefore > 0) {
      sheet.deleteRows(2, dataRowsBefore);
    }

    if (rows.length > 0) {
      sheet.insertRowsAfter(1, rows.length);
      writeChunks_(sheet, 2, rows);
      formatDateColumns_(sheet, rows.length);
    }

    SpreadsheetApp.flush();

    return {
      received: incomingRows.length,
      accepted: rows.length,
      deletedPhysicalRows: dataRowsBefore,
      insertedPhysicalRows: rows.length,
      written: rows.length,
      finalRowCount: Math.max(sheet.getMaxRows() - 1, 0),
      mode: "full-rebuild-delete-recreate",
    };
  } finally {
    lock.releaseLock();
  }
}

function normalizeIncomingRow_(rawRow, accountId, seenKeys) {
  if (!Array.isArray(rawRow) || rawRow.length < COLUMN_COUNT) return null;
  const row = rawRow.slice(0, COLUMN_COUNT);
  if (String(row[ACCOUNT_ID_INDEX] || "").trim() !== accountId) return null;
  const key = rowKey_(row);
  if (!key || seenKeys.has(key)) return null;
  seenKeys.add(key);
  return row;
}

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
    if (incoming.length === 0 && !allowEmpty) throw new Error(`Refusing to replace account ${accountId} with an empty or invalid dataset`);

    const existingLastRow = sheet.getLastRow();
    const existing = existingLastRow >= 2 ? sheet.getRange(2, 1, existingLastRow - 1, COLUMN_COUNT).getValues() : [];
    const output = [];
    for (const row of existing) {
      if (String(row[ACCOUNT_ID_INDEX] || "").trim() !== accountId) output.push(row);
    }
    output.push(...incoming);

    const maxRows = sheet.getMaxRows();
    const maxCols = sheet.getMaxColumns();
    if (maxRows > 1) sheet.getRange(2, 1, maxRows - 1, maxCols).clearContent();
    if (output.length) writeChunks_(sheet, 2, output);
    formatDateColumns_(sheet, output.length);
    return { received: incomingRows.length, accepted: incoming.length, written: incoming.length, finalRowCount: output.length, mode: "account-replacement" };
  } finally {
    lock.releaseLock();
  }
}

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
      if (id) rowById.set(id, { index });
    });
    const appendRows = [];
    let created = 0, updated = 0, skipped = 0;
    for (const rawRow of incomingRows) {
      if (!Array.isArray(rawRow) || rawRow.length < COLUMN_COUNT) { skipped++; continue; }
      const row = rawRow.slice(0, COLUMN_COUNT);
      const id = rowKey_(row);
      if (!id) { skipped++; continue; }
      const existing = rowById.get(id);
      if (!existing) { appendRows.push(row); created++; }
      else { existingRows[existing.index] = row; updated++; }
    }
    if (updated > 0 && existingRows.length > 0) writeChunks_(sheet, 2, existingRows);
    if (appendRows.length > 0) writeChunks_(sheet, Math.max(sheet.getLastRow() + 1, 2), appendRows);
    const finalRowCount = Math.max(sheet.getLastRow() - 1, 0);
    formatDateColumns_(sheet, finalRowCount);
    return { received: incomingRows.length, created, updated, skipped, finalRowCount };
  } finally {
    lock.releaseLock();
  }
}

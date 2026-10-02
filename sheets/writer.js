import { logger } from "../utils/logger.js";

export const SHEET_HEADERS = [
  "account_id","account_name","source_order_id","source","referral_id","order_date","product_name","quantity",
  "order_amount","commission_amount","commission_status","commission_status_raw","order_status","order_status_raw",
  "customer_name","customer_email","reference_id","last_synced_at","raw_snapshot_json",
];

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
function serializeDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
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
export function orderToRow(order, account, syncedAt = new Date()) {
  return [
    serializeCell(account.id), serializeCell(account.name), serializeCell(order.sourceOrderId), serializeCell(order.source),
    serializeCell(order.referralId), serializeSheetsDate(order.orderDate), serializeCell(order.productName), serializeCell(order.quantity),
    serializeCell(order.orderAmount), serializeCell(order.commissionAmount), serializeCell(order.commissionStatus), serializeCell(order.commissionStatusRaw),
    serializeCell(order.orderStatus), serializeCell(order.orderStatusRaw), serializeCell(order.customerName), serializeCell(order.customerEmail),
    serializeCell(order.referenceId), serializeSheetsDate(syncedAt), order.rawSnapshot ? JSON.stringify(order.rawSnapshot) : "",
  ];
}
async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "follow",
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`Apps Script returned non-JSON response (HTTP ${response.status}): ${text.slice(0, 500)}`); }
  if (!response.ok || !payload.ok) throw new Error(payload.error || `Apps Script request failed with HTTP ${response.status}`);
  return payload;
}

/**
 * Full-run rebuild. `accountOrderSets` is an array of:
 *   { account, orders }
 *
 * We send ONE complete dataset to Apps Script. Apps Script clears the entire
 * sheet below the header and writes this dataset from row 2.
 */
export async function replaceAllOrders(accountOrderSets) {
  const url = requireEnv("GOOGLE_APPS_SCRIPT_URL");
  const secret = requireEnv("GOOGLE_APPS_SCRIPT_SECRET");

  const allRows = [];
  for (const item of accountOrderSets) {
    const account = item.account;
    const orders = Array.isArray(item.orders) ? item.orders : [];
    for (const order of orders) allRows.push(orderToRow(order, account));
  }

  const result = await postJson(url, {
    action: "replaceAllOrders",
    secret,
    rows: allRows,
    allowEmpty: false,
  });

  logger.info("Google Sheets FULL REBUILD completed", {
    accounts: accountOrderSets.length,
    totalRowsSent: allRows.length,
    ...result,
  });
  return result;
}

export async function replaceAccountOrders(orders, { account }) {
  const url = requireEnv("GOOGLE_APPS_SCRIPT_URL");
  const secret = requireEnv("GOOGLE_APPS_SCRIPT_SECRET");
  if (orders.length === 0 && !account.allowEmptyFullSync) throw new Error(`Refusing to replace account ${account.name} with an empty dataset`);
  const rows = orders.map((order) => orderToRow(order, account));
  const result = await postJson(url, {
    action: "replaceAccountOrders", secret, accountId: account.id, rows, allowEmpty: Boolean(account.allowEmptyFullSync),
  });
  logger.info("Google Sheets account replacement completed", { account: account.name, ...result });
  return result;
}

export async function upsertOrders(orders, { account }) {
  const url = requireEnv("GOOGLE_APPS_SCRIPT_URL");
  const secret = requireEnv("GOOGLE_APPS_SCRIPT_SECRET");
  const rows = orders.map((order) => orderToRow(order, account));
  const result = await postJson(url, { action: "upsertOrders", secret, rows });
  logger.info("Google Sheets upsert completed", { account: account.name, ...result });
  return result;
}

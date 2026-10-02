import { logger } from "../utils/logger.js";

export const SHEET_HEADERS = [
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
    serializeCell(account.id),
    serializeCell(account.name),
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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "follow",
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Apps Script returned non-JSON response (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Apps Script request failed with HTTP ${response.status}`);
  }
  return payload;
}

export async function replaceAccountOrders(orders, { account }) {
  const url = requireEnv("GOOGLE_APPS_SCRIPT_URL");
  const secret = requireEnv("GOOGLE_APPS_SCRIPT_SECRET");

  if (orders.length === 0 && !account.allowEmptyFullSync) {
    throw new Error(`Refusing to replace account ${account.name} with an empty dataset`);
  }

  const rows = orders.map((order) => orderToRow(order, account));
  const result = await postJson(url, {
    action: "replaceAccountOrders",
    secret,
    accountId: account.id,
    rows,
    allowEmpty: Boolean(account.allowEmptyFullSync),
  });

  logger.info("Google Sheets account replacement completed", {
    account: account.name,
    ...result,
  });

  return result;
}

export async function upsertOrders(orders, { account }) {
  const url = requireEnv("GOOGLE_APPS_SCRIPT_URL");
  const secret = requireEnv("GOOGLE_APPS_SCRIPT_SECRET");
  const chunkSize = Number(process.env.GOOGLE_APPS_SCRIPT_CHUNK_SIZE || 500);
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("GOOGLE_APPS_SCRIPT_CHUNK_SIZE must be a positive integer");
  }

  const rows = orders.map((order) => orderToRow(order, account));
  const aggregate = {
    received: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    finalRowCount: null,
  };

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const result = await postJson(url, {
      action: "upsertOrders",
      secret,
      rows: chunk,
    });
    aggregate.received += result.received || 0;
    aggregate.created += result.created || 0;
    aggregate.updated += result.updated || 0;
    aggregate.unchanged += result.unchanged || 0;
    aggregate.skipped += result.skipped || 0;
    aggregate.finalRowCount = result.finalRowCount ?? aggregate.finalRowCount;
    logger.info("Google Sheets upsert chunk completed", {
      account: account.name,
      offset,
      chunkSize: chunk.length,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
    });
  }

  logger.info("Google Sheets upsert completed", { account: account.name, ...aggregate });
  return aggregate;
}

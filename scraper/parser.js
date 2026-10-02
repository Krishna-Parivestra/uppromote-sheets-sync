import { COLUMN_ALIASES } from "./selectors.js";
import { normalizeCommissionStatus, normalizeOrderStatus } from "./commission.js";
import { logger } from "../utils/logger.js";

// Deliberately anchored on a leading digit (not a blanket char-strip) — currency
// prefixes like "Rs." carry their own stray period that would otherwise get
// mistaken for the decimal point (e.g. "Rs. 562.75" -> "0.562" if naively stripped).
function parseAmount(text) {
  if (!text) return null;
  const matches = String(text).match(/-?\d[\d,]*(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;
  const raw = matches[matches.length - 1].replace(/,/g, "");
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function parseQuantity(text) {
  if (!text) return null;
  const match = String(text).match(/-?\d+/);
  return match ? Number.parseInt(match[0], 10) : null;
}

// Matches the hypdshop Commission table's date cell, which renders as a relative
// label immediately followed (no separator) by the absolute timestamp, e.g.
// "34 minutes agoAug 12, 2026 2:34 PM" once <br> is flattened to plain text.
const ABSOLUTE_DATE_PATTERN =
  /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M))?/i;

const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// UpPromote displays times in the shop's own timezone (IST, this being an
// Indian storefront), never with an explicit offset. Parsing that text with
// the bare `Date` constructor interprets it in the *running process's* local
// time instead — which drifts between environments (a local Windows run in
// IST vs. Render's UTC container would each store a different instant for
// the same displayed timestamp). Anchoring explicitly to +05:30 keeps every
// environment consistent with what the source page actually shows.
const SOURCE_TIMEZONE_OFFSET = "+05:30";

function parseDate(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;

  const match = trimmed.match(ABSOLUTE_DATE_PATTERN);
  if (match) {
    const [, monthName, day, year, hour12, minute, meridiem] = match;
    const month = MONTH_INDEX[monthName.slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      let hour = 0;
      if (hour12 !== undefined) {
        hour = Number.parseInt(hour12, 10) % 12;
        if (meridiem?.toUpperCase() === "PM") hour += 12;
      }
      const iso = `${year}-${String(month + 1).padStart(2, "0")}-${day.padStart(2, "0")}T${String(hour).padStart(2, "0")}:${minute ?? "00"}:00${SOURCE_TIMEZONE_OFFSET}`;
      const parsed = new Date(iso);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  logger.debug("Unrecognized date format from source dashboard", { text: trimmed });
  return null;
}

/**
 * Maps a header row's visible text (e.g. ["Order ID", "Date", "Product", ...])
 * onto our known field names using COLUMN_ALIASES. Returns { field: columnIndex }.
 */
export function resolveColumnIndexes(headerTexts) {
  const normalizedHeaders = headerTexts.map((h) => h.trim().toLowerCase());
  const indexes = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = normalizedHeaders.findIndex((h) => aliases.some((alias) => h.includes(alias)));
    if (idx !== -1) indexes[field] = idx;
  }

  return indexes;
}

/**
 * UpPromote's own Commission column reads Rs. 0.00 for every row on this
 * account (confirmed against real data), which isn't usable as-is. When
 * COMMISSION_RATE is set (e.g. 0.07 for 7%), commission is computed from the
 * order amount instead of trusting that field. Leave COMMISSION_RATE unset
 * to fall back to whatever the source page actually shows.
 */
function computeCommissionAmount(orderAmount, scrapedCommissionAmount, commissionRate = process.env.COMMISSION_RATE) {
  const rate = Number(commissionRate);
  if (!Number.isFinite(rate) || rate <= 0) return scrapedCommissionAmount;
  if (orderAmount === null) return scrapedCommissionAmount;
  return Math.round(orderAmount * rate * 100) / 100;
}

/**
 * Builds a normalized order record from one table row's cell texts plus the
 * resolved column map. Any field UpPromote doesn't expose becomes null —
 * never fabricated (spec section 6).
 */
export function parseOrderRow(cellTexts, columnIndexes, { commissionRate } = {}) {
  const get = (field) => {
    const idx = columnIndexes[field];
    return idx === undefined ? null : (cellTexts[idx] ?? "").trim() || null;
  };

  // UpPromote renders order numbers as "#614037" — strip the leading "#" so it
  // doesn't double up wherever we display it as "Order #<sourceOrderId>".
  const sourceOrderId = get("sourceOrderId")?.replace(/^#/, "") || null;
  if (!sourceOrderId) return null; // unusable without a stable identifier

  const commissionStatusRaw = get("commissionStatus");
  const orderStatusRaw = get("orderStatus");
  const orderAmount = parseAmount(get("orderAmount"));
  const scrapedCommissionAmount = parseAmount(get("commissionAmount"));

  return {
    source: "uppromote",
    sourceOrderId,
    referralId: get("referralId"),
    orderDate: parseDate(get("orderDate")),
    productName: get("productName"),
    quantity: parseQuantity(get("quantity")),
    orderAmount,
    commissionAmount: computeCommissionAmount(orderAmount, scrapedCommissionAmount, commissionRate),
    commissionStatus: normalizeCommissionStatus(commissionStatusRaw),
    commissionStatusRaw,
    orderStatus: normalizeOrderStatus(orderStatusRaw),
    orderStatusRaw,
    customerName: get("customerName"),
    customerEmail: get("customerEmail"),
    referenceId: get("referenceId"),
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    rawSnapshot: Object.fromEntries(cellTexts.map((text, i) => [`col_${i}`, text])),
  };
}

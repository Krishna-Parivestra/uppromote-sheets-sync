/**
 * Maps whatever raw status text UpPromote renders (e.g. "Paid", "Unpaid",
 * "Denied", "Processing") onto our normalized enums, while always preserving
 * the raw string so nothing is lost if the mapping is incomplete.
 */
const COMMISSION_STATUS_MAP = [
  { pattern: /pending|unpaid|awaiting/i, value: "PENDING" },
  { pattern: /approved|paid|confirmed/i, value: "APPROVED" },
  { pattern: /reject|denied|declined|cancel/i, value: "REJECTED" },
];

const ORDER_STATUS_MAP = [
  { pattern: /pending/i, value: "PENDING" },
  { pattern: /processing|in progress/i, value: "PROCESSING" },
  { pattern: /completed|delivered|fulfilled|success/i, value: "COMPLETED" },
  { pattern: /cancel/i, value: "CANCELLED" },
  { pattern: /refund/i, value: "REFUNDED" },
];

function classify(rawText, map) {
  if (!rawText) return "UNKNOWN";
  const trimmed = rawText.trim();
  for (const { pattern, value } of map) {
    if (pattern.test(trimmed)) return value;
  }
  return "UNKNOWN";
}

export function normalizeCommissionStatus(rawText) {
  return classify(rawText, COMMISSION_STATUS_MAP);
}

export function normalizeOrderStatus(rawText) {
  return classify(rawText, ORDER_STATUS_MAP);
}

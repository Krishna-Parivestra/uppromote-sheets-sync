import { selectors } from "./selectors.js";
import { resolveColumnIndexes, parseOrderRow } from "./parser.js";
import { logger } from "../utils/logger.js";

async function firstMatch(page, candidateSelectors) {
  for (const sel of candidateSelectors) {
    try {
      const locator = page.locator(sel).first();
      if (await locator.count()) return locator;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function getTableContainer(page) {
  for (const sel of selectors.ordersTable.container) {
    const locator = page.locator(sel).first();
    if (await locator.count()) return locator;
  }
  return null;
}

async function getHeaderTexts(table) {
  for (const sel of selectors.ordersTable.headerRow) {
    const headerRow = table.locator(sel).first();
    if (await headerRow.count()) {
      for (const cellSel of selectors.ordersTable.headerCell) {
        const cells = headerRow.locator(cellSel);
        const count = await cells.count();
        if (count > 0) return cells.allTextContents();
      }
    }
  }
  return [];
}

/**
 * A bare "does *a* table exist" check is too broad — dashboard landing pages
 * commonly have unrelated tables (summaries, top products, etc.) that would
 * false-positive it. Require the table's own headers to actually resolve the
 * order identifier column before trusting we're on the right page.
 */
async function isOnOrdersSection(page) {
  const table = await getTableContainer(page);
  if (!table) return false;
  const headerTexts = await getHeaderTexts(table);
  const columnIndexes = resolveColumnIndexes(headerTexts);
  return columnIndexes.sourceOrderId !== undefined;
}

/**
 * Sets a "Show X entries" length control (standard DataTables markup — see
 * selectors.pagination.pageLengthSelect) to its maximum option, so the table
 * renders as many rows as it can in one view instead of relying on a Next
 * click that may not reliably re-render (spec section 8). A no-op if no such
 * control exists on the page. Each fresh page load resets this, so it must
 * run every time we land on the orders section, not just once.
 */
async function maximizePageLength(page) {
  for (const sel of selectors.pagination.pageLengthSelect) {
    try {
      const select = page.locator(sel).first();
      if (!(await select.count())) continue;

      const values = await select.locator("option").evaluateAll((opts) => opts.map((o) => o.value));
      const numericValues = values.map(Number).filter((n) => Number.isFinite(n));
      if (numericValues.length === 0) continue;

      const max = String(Math.max(...numericValues));
      const current = await select.inputValue().catch(() => null);
      if (current === max) return;

      await select.selectOption(max);
      await page.waitForTimeout(500);
      logger.debug("Set table page length to maximum", { value: max });
      return;
    } catch {
      // try next candidate
    }
  }
}

/**
 * Navigates from the authenticated dashboard landing page to the
 * Orders/Commission section using the UI (never a guessed direct URL),
 * per spec section 5. ensureAuthenticated() re-navigates to the base
 * dashboard URL on every call, so this must run before every extraction —
 * not just the initial historical sync — or live polling silently reads
 * the wrong page. Skips the click if the real orders table's already on
 * screen so steady-state polling doesn't reload the page every tick.
 */
export async function navigateToOrdersSection(page) {
  if (await isOnOrdersSection(page)) {
    await maximizePageLength(page);
    return;
  }

  const link = await firstMatch(page, selectors.navigation.ordersNavLink);
  if (!link) {
    logger.warn("Could not find an Orders/Commission nav link; assuming current page already shows orders");
    return;
  }
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {}),
    link.click(),
  ]);
  await maximizePageLength(page);
}

async function getRowLocators(table) {
  for (const sel of selectors.ordersTable.rows) {
    const rows = table.locator(sel);
    const count = await rows.count();
    if (count > 0) return rows;
  }
  return null;
}

/**
 * Reads whatever order rows are currently rendered in the table and returns
 * normalized records. Does not paginate — callers control that separately
 * (historical sync walks all pages; live monitoring just re-reads the
 * current view).
 */
export async function extractVisibleOrders(page) {
  const table = await getTableContainer(page);
  if (!table) {
    throw new Error(
      "Could not locate the orders table on the page. Update scraper/selectors.js after inspecting the real DOM."
    );
  }
  const headerTexts = await getHeaderTexts(table);
  const columnIndexes = resolveColumnIndexes(headerTexts);

  if (Object.keys(columnIndexes).length === 0) {
    logger.warn("No table columns matched known aliases — selectors/COLUMN_ALIASES likely need updating", {
      headerTexts,
    });
  }

  const rows = await getRowLocators(table);
  if (!rows) return [];

  const rowCount = await rows.count();
  const records = [];

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const cellTexts = await row.locator("td, [role=cell]").allTextContents();
    if (cellTexts.length === 0) continue;
    const record = parseOrderRow(
      cellTexts.map((t) => t.trim()),
      columnIndexes
    );
    if (record) records.push(record);
  }

  return records;
}

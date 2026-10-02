import { navigateToOrdersSection, extractVisibleOrders } from "./dashboard.js";
import { advancePagination } from "./pagination.js";
import { logger } from "../utils/logger.js";

// Defense-in-depth against a runaway pagination loop (e.g. a "Next" control
// that doesn't actually page the table) — advancePagination()'s own content
// fingerprint check is the primary guard; this is the hard ceiling.
const MAX_PAGES_SAFETY_LIMIT = 200;

/**
 * Walks every page of the Orders/Commission table via the UI's own
 * pagination and returns every record found (spec section 8/30, initial
 * historical sync). Idempotent upsert downstream means calling this again
 * is always safe.
 */
export async function scrapeAllOrders(page) {
  await navigateToOrdersSection(page);

  const all = [];
  const seenIds = new Set();
  let pageIndex = 1;

  while (pageIndex <= MAX_PAGES_SAFETY_LIMIT) {
    const records = await extractVisibleOrders(page);
    let newOnThisPage = 0;
    for (const record of records) {
      if (!seenIds.has(record.sourceOrderId)) {
        seenIds.add(record.sourceOrderId);
        all.push(record);
        newOnThisPage++;
      }
    }
    logger.info("Scraped orders page", { pageIndex, rowsFound: records.length, newOnThisPage });

    const advanced = await advancePagination(page);
    if (!advanced) break;
    pageIndex++;
  }

  return all;
}

/**
 * Reads only the currently visible view (first page / top of the table) for
 * continuous live monitoring — new orders surface here without walking the
 * full history on every poll (spec section 9/10).
 */
export async function scrapeCurrentSnapshot(page) {
  await navigateToOrdersSection(page);
  return extractVisibleOrders(page);
}

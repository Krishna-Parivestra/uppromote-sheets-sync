import { navigateToOrdersSection, extractVisibleOrders } from "./dashboard.js";
import { logger } from "../utils/logger.js";

// This reporting workflow intentionally uses only the currently visible
// UpPromote table (configured to its maximum visible page size, typically 100).
// No pagination is attempted because the user only needs the latest visible
// rows for each account.
export async function scrapeAllOrders(page, parseOptions = {}) {
  await navigateToOrdersSection(page);
  const records = await extractVisibleOrders(page, parseOptions);
  logger.info("Scraped current orders page", {
    rowsFound: records.length,
    maxRows: 100,
  });

  return {
    records: records.slice(0, 100),
    pagesScraped: 1,
    paginationComplete: true,
    stopReason: "single-page-100-row-mode",
  };
}

export async function scrapeCurrentSnapshot(page, parseOptions = {}) {
  await navigateToOrdersSection(page);
  return extractVisibleOrders(page, parseOptions);
}

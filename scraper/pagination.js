import { selectors } from "./selectors.js";
import { logger } from "../utils/logger.js";

async function firstClickable(page, candidateSelectors) {
  for (const sel of candidateSelectors) {
    try {
      const locator = page.locator(sel).first();
      if (await locator.isVisible({ timeout: 1000 })) {
        const disabled = await locator.getAttribute(selectors.pagination.disabledAttr).catch(() => null);
        const ariaDisabled = await locator.getAttribute("aria-disabled").catch(() => null);
        if (disabled !== null || ariaDisabled === "true") return { locator, disabled: true };
        return { locator, disabled: false };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function countRows(page) {
  for (const sel of selectors.ordersTable.rows) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) return count;
    } catch {
      // try next candidate
    }
  }
  return 0;
}

/**
 * Cheap fingerprint of the table's current content (row count + first/last
 * row text). Some "Next" links on a dashboard don't actually page the table
 * at all (e.g. they're unrelated UI, or the table already shows everything) —
 * a disabled-attribute check alone can't catch that, so we confirm the
 * content actually changed after clicking.
 */
async function getContentFingerprint(page) {
  for (const sel of selectors.ordersTable.rows) {
    try {
      const rows = page.locator(sel);
      const count = await rows.count();
      if (count > 0) {
        const first = await rows.first().innerText().catch(() => "");
        const last = await rows.last().innerText().catch(() => "");
        return `${count}::${first}::${last}`;
      }
    } catch {
      // try next candidate
    }
  }
  return "";
}

/**
 * Advances the orders table by whatever pagination mechanism the live UI
 * actually uses (spec section 8) — tried in order: Next button, Load
 * more/infinite scroll, page-number links. Returns true if new content
 * loaded, false once the end is reached.
 */
export async function advancePagination(page) {
  const before = await countRows(page);

  const next = await firstClickable(page, selectors.pagination.nextButton);
  if (next) {
    if (next.disabled) {
      logger.debug("Pagination: Next button disabled, reached last page");
      return { advanced: false, terminal: true, reason: "next-disabled" };
    }
    const fingerprintBefore = await getContentFingerprint(page);
    await next.locator.click();
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
    const fingerprintAfter = await getContentFingerprint(page);
    if (fingerprintAfter === fingerprintBefore) {
      logger.debug("Pagination: Next click produced no content change, treating as last page");
      return { advanced: false, terminal: false, reason: "next-no-content-change" };
    }
    return { advanced: true, terminal: false, reason: "next-clicked" };
  }

  const loadMore = await firstClickable(page, selectors.pagination.loadMoreButton);
  if (loadMore && !loadMore.disabled) {
    await loadMore.locator.click();
    await page.waitForTimeout(800);
    const after = await countRows(page);
    if (after > before) return { advanced: true, terminal: false, reason: "load-more-clicked" };
    return { advanced: false, terminal: false, reason: "load-more-no-growth" };
  }

  // Infinite scroll fallback: scroll to bottom and see if row count grows.
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(800);
  const afterScroll = await countRows(page);
  if (afterScroll > before) return { advanced: true, terminal: false, reason: "infinite-scroll" };

  logger.debug("Pagination: no next button, load-more, or scroll growth — treating current table as complete");
  return { advanced: false, terminal: true, reason: "no-pagination-controls" };
}

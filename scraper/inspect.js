/**
 * Standalone inspection tool (spec section 33). Run with `npm run inspect`
 * from backend/ after filling in .env. Logs into the real UpPromote
 * dashboard, navigates to Orders/Commission, and dumps:
 *   - logs/inspect-dom.html      full rendered HTML of the orders view
 *   - logs/inspect-summary.json  candidate tables, header text, pagination
 * Use these to fill in the real values in scraper/selectors.js. This script
 * never bypasses MFA/CAPTCHA — it stops and reports if either appears.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { browserSession } from "./browser.js";
import { ensureAuthenticated, AuthChallengeError } from "./auth.js";
import { navigateToOrdersSection } from "./dashboard.js";
import { selectors } from "./selectors.js";
import { logger } from "../utils/logger.js";

const LOG_DIR = path.resolve(process.cwd(), "logs");

async function summarizeTables(page) {
  const tables = page.locator("table, [role=table]");
  const count = await tables.count();
  const summary = [];

  for (let i = 0; i < count; i++) {
    const table = tables.nth(i);
    const headerTexts = await table.locator("th, [role=columnheader]").allTextContents().catch(() => []);
    const rowCount = await table.locator("tbody tr, [role=row]").count().catch(() => 0);
    summary.push({ index: i, headerTexts: headerTexts.map((t) => t.trim()), rowCount });
  }
  return summary;
}

async function summarizePagination(page) {
  const found = {};
  for (const [name, candidateSelectors] of Object.entries(selectors.pagination)) {
    if (!Array.isArray(candidateSelectors)) continue;
    for (const sel of candidateSelectors) {
      try {
        const count = await page.locator(sel).count();
        if (count > 0) {
          found[name] = found[name] || [];
          found[name].push({ selector: sel, count });
        }
      } catch {
        // ignore invalid selector on this page
      }
    }
  }
  return found;
}

async function main() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  try {
    const page = await ensureAuthenticated();
    logger.info("Authenticated. Navigating to Orders/Commission section...");
    await navigateToOrdersSection(page);
    await page.waitForTimeout(1500);

    const html = await page.content();
    fs.writeFileSync(path.join(LOG_DIR, "inspect-dom.html"), html, "utf-8");

    const tables = await summarizeTables(page);
    const pagination = await summarizePagination(page);
    const url = page.url();
    const title = await page.title();

    const summary = { url, title, tables, pagination, capturedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(LOG_DIR, "inspect-summary.json"), JSON.stringify(summary, null, 2), "utf-8");

    logger.info("Inspection complete", {
      htmlPath: "logs/inspect-dom.html",
      summaryPath: "logs/inspect-summary.json",
      tablesFound: tables.length,
    });
    console.log("\nInspection summary:\n" + JSON.stringify(summary, null, 2));
  } catch (err) {
    if (err instanceof AuthChallengeError) {
      logger.error(`Stopped: ${err.kind.toUpperCase()} challenge detected. Complete it manually in a headed browser, then rerun.`);
      console.error(
        `\nAn authorized ${err.kind.toUpperCase()} challenge appeared. This tool will not attempt to bypass it.\n` +
          "Set SCRAPER_HEADLESS=false, rerun `npm run inspect`, and complete the challenge yourself in the opened browser window."
      );
    } else {
      logger.error("Inspection failed", { message: err.message, stack: err.stack });
    }
    process.exitCode = 1;
  } finally {
    await browserSession.shutdown();
  }
}

main();

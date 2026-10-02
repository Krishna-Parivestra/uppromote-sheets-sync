import { ensureAuthenticated, AuthChallengeError } from "../scraper/auth.js";
import { scrapeAllOrders, scrapeCurrentSnapshot } from "../scraper/orders.js";
import { upsertOrders } from "../sheets/writer.js";
import { browserSession } from "../scraper/browser.js";
import { logger } from "../utils/logger.js";

export async function runSync({ mode = process.env.SCRAPE_MODE || "full" } = {}) {
  const startedAt = new Date();
  logger.info("Sync started", { mode, startedAt: startedAt.toISOString() });

  try {
    const page = await ensureAuthenticated();
    const records = mode === "snapshot"
      ? await scrapeCurrentSnapshot(page)
      : await scrapeAllOrders(page);

    const sheetResult = await upsertOrders(records);
    const completedAt = new Date();
    const result = {
      mode,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationSeconds: Math.round((completedAt - startedAt) / 1000),
      ...sheetResult,
    };

    logger.info("Sync completed", result);
    return result;
  } catch (error) {
    const challenge = error instanceof AuthChallengeError;
    logger.error("Sync failed", {
      message: error.message,
      challenge,
      challengeKind: error.kind,
      stack: error.stack,
    });
    throw error;
  } finally {
    // GitHub Actions is ephemeral, so close the browser at the end of every run.
    await browserSession.shutdown().catch((error) => {
      logger.warn("Browser shutdown failed", { message: error.message });
    });
  }
}

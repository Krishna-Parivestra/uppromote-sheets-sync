import { loadAccounts } from "../config/accounts.js";
import { ensureAuthenticated, AuthChallengeError } from "../scraper/auth.js";
import { scrapeAllOrders, scrapeCurrentSnapshot } from "../scraper/orders.js";
import { replaceAllOrders, upsertOrders } from "../sheets/writer.js";
import { BrowserSession } from "../scraper/browser.js";
import { logger } from "../utils/logger.js";

export async function runSync({ mode = process.env.SCRAPE_MODE || "full" } = {}) {
  const startedAt = new Date();
  const accounts = loadAccounts();
  logger.info("Multi-account sync started", { mode, accountCount: accounts.length, startedAt: startedAt.toISOString() });

  const results = [];
  const successfulOrderSets = [];

  for (const account of accounts) {
    const accountStartedAt = new Date();
    const session = new BrowserSession({
      storageStatePath: account.storageStatePath,
      storageStateB64: account.storageStateB64,
      label: account.name,
    });

    try {
      logger.info("Starting account scrape", { accountId: account.id, accountName: account.name });
      const page = await ensureAuthenticated({ session, account });

      if (mode === "snapshot") {
        const records = await scrapeCurrentSnapshot(page, { commissionRate: account.commissionRate });
        successfulOrderSets.push({ account, orders: records });
        const result = {
          accountId: account.id, accountName: account.name, mode,
          records: records.length, ok: true,
          durationSeconds: Math.round((new Date() - accountStartedAt) / 1000),
        };
        results.push(result);
        logger.info("Account scrape completed", result);
      } else {
        const scrapeResult = await scrapeAllOrders(page, { commissionRate: account.commissionRate });
        if (!scrapeResult.paginationComplete) {
          throw new Error(
            `Refusing full rebuild for ${account.name}: pagination was not proven complete ` +
            `(reason=${scrapeResult.stopReason}, pages=${scrapeResult.pagesScraped}, records=${scrapeResult.records.length}).`
          );
        }

        successfulOrderSets.push({ account, orders: scrapeResult.records });
        const result = {
          accountId: account.id, accountName: account.name, mode,
          pagesScraped: scrapeResult.pagesScraped,
          paginationComplete: scrapeResult.paginationComplete,
          stopReason: scrapeResult.stopReason,
          records: scrapeResult.records.length,
          ok: true,
          durationSeconds: Math.round((new Date() - accountStartedAt) / 1000),
        };
        results.push(result);
        logger.info("Account scrape completed", result);
      }
    } catch (error) {
      const challenge = error instanceof AuthChallengeError;
      const result = {
        accountId: account.id,
        accountName: account.name,
        ok: false,
        message: error.message,
        challenge: error.kind || null,
      };
      results.push(result);
      logger.error("Account scrape failed", {
        ...result,
        challenge,
        challengeKind: error.kind,
        stack: error.stack,
      });
    } finally {
      // IMPORTANT: shutdown only. Do not save storage state here.
      // Auth/session code should save a state only after a successful authenticated scrape.
      await session.shutdown().catch((error) => {
        logger.warn("Account browser shutdown failed", { account: account.name, message: error.message });
      });
    }
  }

  const failed = results.filter((result) => result.ok === false);
  let sheetResult = null;

  // CRITICAL: The sheet is rebuilt ONLY when every account succeeded.
  // Therefore a CAPTCHA/failure never causes an empty/partial sheet to replace good data.
  if (mode === "full" && failed.length === 0) {
    sheetResult = await replaceAllOrders(successfulOrderSets);
    logger.info("FULL DATASET REBUILD COMPLETED", sheetResult);
  } else if (mode === "full") {
    logger.error("FULL DATASET REBUILD SKIPPED because one or more accounts failed", {
      failedAccounts: failed.map((x) => x.accountName),
      successfulAccounts: successfulOrderSets.length,
    });
  }

  const completedAt = new Date();
  const summary = {
    mode,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationSeconds: Math.round((completedAt - startedAt) / 1000),
    accountCount: accounts.length,
    succeeded: accounts.length - failed.length,
    failed: failed.length,
    sheetRebuilt: Boolean(sheetResult),
    sheetResult,
    accounts: results,
  };

  logger.info("Multi-account sync finished", summary);

  if (failed.length > 0 && process.env.FAIL_WORKFLOW_ON_ANY_ACCOUNT_ERROR === "true") {
    throw new Error(`One or more account syncs failed: ${failed.map((x) => x.accountName).join(", ")}`);
  }

  return summary;
}

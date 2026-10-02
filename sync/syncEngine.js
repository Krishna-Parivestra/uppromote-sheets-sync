import { loadAccounts } from "../config/accounts.js";
import { ensureAuthenticated, AuthChallengeError } from "../scraper/auth.js";
import { scrapeAllOrders, scrapeCurrentSnapshot } from "../scraper/orders.js";
import { replaceAccountOrders, upsertOrders } from "../sheets/writer.js";
import { BrowserSession } from "../scraper/browser.js";
import { logger } from "../utils/logger.js";

export async function runSync({ mode = process.env.SCRAPE_MODE || "full" } = {}) {
  const startedAt = new Date();
  const accounts = loadAccounts();
  logger.info("Multi-account sync started", { mode, accountCount: accounts.length, startedAt: startedAt.toISOString() });

  const results = [];

  for (const account of accounts) {
    const accountStartedAt = new Date();
    const session = new BrowserSession({
      storageStatePath: account.storageStatePath,
      storageStateB64: account.storageStateB64,
      label: account.name,
    });

    try {
      logger.info("Starting account sync", { accountId: account.id, accountName: account.name });
      const page = await ensureAuthenticated({ session, account });

      if (mode === "snapshot") {
        const records = await scrapeCurrentSnapshot(page, { commissionRate: account.commissionRate });
        const sheetResult = await upsertOrders(records, { account });
        results.push({ accountId: account.id, accountName: account.name, mode, records: records.length, ...sheetResult });
      } else {
        const scrapeResult = await scrapeAllOrders(page, { commissionRate: account.commissionRate });
        if (!scrapeResult.paginationComplete) {
          throw new Error(
            `Refusing full replacement for ${account.name}: pagination was not proven complete ` +
            `(reason=${scrapeResult.stopReason}, pages=${scrapeResult.pagesScraped}, records=${scrapeResult.records.length}).`
          );
        }

        const syncId = `${account.id}-${Date.now()}`;
        const sheetResult = await replaceAccountOrders(scrapeResult.records, { account, syncId });
        results.push({
          accountId: account.id,
          accountName: account.name,
          mode,
          pagesScraped: scrapeResult.pagesScraped,
          paginationComplete: scrapeResult.paginationComplete,
          stopReason: scrapeResult.stopReason,
          records: scrapeResult.records.length,
          ...sheetResult,
        });
      }

      const accountCompletedAt = new Date();
      results[results.length - 1].durationSeconds = Math.round((accountCompletedAt - accountStartedAt) / 1000);
      logger.info("Account sync completed", results[results.length - 1]);
    } catch (error) {
      const challenge = error instanceof AuthChallengeError;
      logger.error("Account sync failed", {
        accountId: account.id,
        accountName: account.name,
        message: error.message,
        challenge,
        challengeKind: error.kind,
        stack: error.stack,
      });
      results.push({ accountId: account.id, accountName: account.name, ok: false, message: error.message, challenge: error.kind || null });
    } finally {
      await session.shutdown().catch((error) => {
        logger.warn("Account browser shutdown failed", { account: account.name, message: error.message });
      });
    }
  }

  const failed = results.filter((result) => result.ok === false);
  const completedAt = new Date();
  const summary = {
    mode,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationSeconds: Math.round((completedAt - startedAt) / 1000),
    accountCount: accounts.length,
    succeeded: accounts.length - failed.length,
    failed: failed.length,
    accounts: results,
  };

  logger.info("Multi-account sync finished", summary);
  if (failed.length > 0 && process.env.FAIL_WORKFLOW_ON_ANY_ACCOUNT_ERROR === "true") {
    throw new Error(`One or more account syncs failed: ${failed.map((x) => x.accountName).join(", ")}`);
  }
  return summary;
}

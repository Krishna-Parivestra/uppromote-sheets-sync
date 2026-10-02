import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../utils/logger.js";

const STORAGE_STATE_PATH = path.resolve(
  process.cwd(),
  process.env.PLAYWRIGHT_STORAGE_STATE_PATH || "./playwright-session/storage-state.json"
);

/**
 * Owns a single persistent Browser/Context/Page for the lifetime of the
 * process (spec section 10: never relaunch a browser per poll). Call
 * `getPage()` everywhere a scraper step needs the live page.
 */
class BrowserSession {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.launching = null;
  }

  async launch() {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.launching) return this.launching;

    this.launching = this._doLaunch();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  async _doLaunch() {
    const headless = process.env.SCRAPER_HEADLESS !== "false";
    logger.info("Launching Playwright browser", { headless });

    this.browser = await chromium.launch({ headless });

    const storageStateDir = path.dirname(STORAGE_STATE_PATH);
    if (!fs.existsSync(storageStateDir)) fs.mkdirSync(storageStateDir, { recursive: true });

    // On hosts without a persistent disk (e.g. Render's free/starter web
    // service filesystem is ephemeral across deploys), a session solved
    // interactively elsewhere can be carried forward via env var instead —
    // seed the file from it on first launch only, never overwriting a
    // session this same instance has already refreshed.
    if (!fs.existsSync(STORAGE_STATE_PATH) && process.env.PLAYWRIGHT_STORAGE_STATE_B64) {
      try {
        fs.writeFileSync(STORAGE_STATE_PATH, Buffer.from(process.env.PLAYWRIGHT_STORAGE_STATE_B64, "base64"));
        logger.info("Seeded Playwright session from PLAYWRIGHT_STORAGE_STATE_B64");
      } catch (err) {
        logger.warn("Failed to seed session from PLAYWRIGHT_STORAGE_STATE_B64", { message: err.message });
      }
    }

    const hasStoredSession = fs.existsSync(STORAGE_STATE_PATH);

    this.context = await this.browser.newContext({
      storageState: hasStoredSession ? STORAGE_STATE_PATH : undefined,
      viewport: { width: 1440, height: 900 },
    });

    this.page = await this.context.newPage();
    logger.info("Browser session ready", { reusedStoredSession: hasStoredSession });
    return this.page;
  }

  async saveStorageState() {
    if (!this.context) return;
    await this.context.storageState({ path: STORAGE_STATE_PATH });
    logger.debug("Saved Playwright storage state", { path: STORAGE_STATE_PATH });
  }

  async getPage() {
    if (this.page && !this.page.isClosed()) return this.page;
    return this.launch();
  }

  /** Hard reset: closes everything so the next getPage() starts fresh. Used on unrecoverable errors. */
  async reset() {
    logger.warn("Resetting browser session");
    try {
      await this.page?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  async shutdown() {
    await this.saveStorageState().catch(() => {});
    await this.reset();
  }
}

export const browserSession = new BrowserSession();

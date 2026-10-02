import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../utils/logger.js";

export class BrowserSession {
  constructor({ storageStatePath, storageStateB64 = "", label = "account" } = {}) {
    this.storageStatePath = path.resolve(
      process.cwd(),
      storageStatePath || "./playwright-session/storage-state.json"
    );
    this.storageStateB64 = storageStateB64;
    this.label = label;
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
    logger.info("Launching Playwright browser", { account: this.label, headless });

    this.browser = await chromium.launch({ headless });

    const storageStateDir = path.dirname(this.storageStatePath);
    if (!fs.existsSync(storageStateDir)) fs.mkdirSync(storageStateDir, { recursive: true });

    if (!fs.existsSync(this.storageStatePath) && this.storageStateB64) {
      try {
        fs.writeFileSync(this.storageStatePath, Buffer.from(this.storageStateB64, "base64"));
        logger.info("Seeded Playwright session from account storageStateB64", { account: this.label });
      } catch (err) {
        logger.warn("Failed to seed account Playwright session", { account: this.label, message: err.message });
      }
    }

    const hasStoredSession = fs.existsSync(this.storageStatePath);
    this.context = await this.browser.newContext({
      storageState: hasStoredSession ? this.storageStatePath : undefined,
      viewport: { width: 1440, height: 900 },
    });

    this.page = await this.context.newPage();
    logger.info("Browser session ready", { account: this.label, reusedStoredSession: hasStoredSession });
    return this.page;
  }

  async saveStorageState() {
    if (!this.context) return;
    await this.context.storageState({ path: this.storageStatePath });
    logger.debug("Saved Playwright storage state", { account: this.label, path: this.storageStatePath });
  }

  async getPage() {
    if (this.page && !this.page.isClosed()) return this.page;
    return this.launch();
  }

  async reset() {
    logger.warn("Resetting browser session", { account: this.label });
    try { await this.page?.close(); } catch {}
    try { await this.context?.close(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  async shutdown() {
    await this.saveStorageState().catch(() => {});
    await this.reset();
  }
}

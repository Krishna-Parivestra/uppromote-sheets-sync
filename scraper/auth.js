import fs from "node:fs";
import path from "node:path";
import { selectors } from "./selectors.js";
import { logger } from "../utils/logger.js";
import { browserSession } from "./browser.js";

export class AuthChallengeError extends Error {
  constructor(kind) {
    super(`Authorized user interaction required: ${kind}`);
    this.name = "AuthChallengeError";
    this.kind = kind; // "mfa" | "captcha"
  }
}

const LOG_DIR = path.resolve(process.cwd(), "logs");

/**
 * Saves a screenshot + HTML snapshot of the exact moment a challenge was
 * detected — purely observational (what's actually on screen), never used
 * to interact with or solve the challenge.
 */
async function captureChallengeEvidence(page, kind) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    await page.screenshot({ path: path.join(LOG_DIR, `challenge-${kind}.png`), fullPage: true });
    fs.writeFileSync(path.join(LOG_DIR, `challenge-${kind}.html`), await page.content(), "utf-8");
    logger.info("Saved challenge evidence", {
      screenshot: `logs/challenge-${kind}.png`,
      html: `logs/challenge-${kind}.html`,
    });
  } catch (err) {
    logger.warn("Could not capture challenge evidence", { message: err.message });
  }
}

async function firstVisible(page, candidateSelectors, timeout = 3000) {
  for (const sel of candidateSelectors) {
    try {
      const locator = page.locator(sel).first();
      if (await locator.isVisible({ timeout })) return locator;
    } catch {
      // selector not present, try next candidate
    }
  }
  return null;
}

async function isLoggedIn(page) {
  const indicator = await firstVisible(page, selectors.login.loggedInIndicator, 2000);
  return Boolean(indicator);
}

async function detectChallenge(page) {
  const mfa = await firstVisible(page, selectors.login.mfaIndicator, 1500);
  if (mfa) return "mfa";
  const captcha = await firstVisible(page, selectors.login.captchaIndicator, 1500);
  if (captcha) return "captcha";
  return null;
}

const MANUAL_RESOLUTION_TIMEOUT_MS = 5 * 60 * 1000;
const MANUAL_RESOLUTION_POLL_MS = 2000;

/**
 * When a real person is at the keyboard (headed browser), give them time to
 * actually solve the MFA/CAPTCHA in the visible window instead of closing it
 * out from under them the instant the challenge is detected. Still never
 * touches the challenge itself — just waits for isLoggedIn() to flip true.
 */
async function waitForManualResolution(page, kind) {
  logger.info(`Waiting up to ${MANUAL_RESOLUTION_TIMEOUT_MS / 1000}s for you to complete the ${kind.toUpperCase()} challenge in the open browser window...`);
  const deadline = Date.now() + MANUAL_RESOLUTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return true;
    await page.waitForTimeout(MANUAL_RESOLUTION_POLL_MS);
  }
  return false;
}

/**
 * Ensures the persistent page is authenticated against UPPROMOTE_URL.
 * Never attempts to bypass MFA/CAPTCHA — throws AuthChallengeError instead
 * so the caller can surface it to a human (spec sections 3, 29, 34).
 */
export async function ensureAuthenticated() {
  const page = await browserSession.getPage();
  const targetUrl = process.env.UPPROMOTE_URL;
  if (!targetUrl) throw new Error("UPPROMOTE_URL is not set in backend/.env");

  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

  if (await isLoggedIn(page)) {
    logger.info("Already authenticated (reused session)");
    return page;
  }

  const challenge = await detectChallenge(page);
  if (challenge) {
    await captureChallengeEvidence(page, challenge);
    const headed = process.env.SCRAPER_HEADLESS === "false";
    if (headed && (await waitForManualResolution(page, challenge))) {
      await browserSession.saveStorageState();
      logger.info("Challenge resolved manually, session saved");
      return page;
    }
    throw new AuthChallengeError(challenge);
  }

  logger.info("Login required, submitting authorized credentials");

  const email = process.env.UPPROMOTE_EMAIL;
  const password = process.env.UPPROMOTE_PASSWORD;
  if (!email || !password) {
    throw new Error("UPPROMOTE_EMAIL / UPPROMOTE_PASSWORD are not set in backend/.env");
  }

  const emailInput = await firstVisible(page, selectors.login.emailInput);
  const passwordInput = await firstVisible(page, selectors.login.passwordInput);
  if (!emailInput || !passwordInput) {
    throw new Error(
      "Could not find login form fields. Selectors likely need updating after inspecting the real login page (see scraper/selectors.js)."
    );
  }

  await emailInput.fill(email);
  await passwordInput.fill(password);

  const submit = await firstVisible(page, selectors.login.submitButton);
  if (!submit) throw new Error("Could not find login submit button; update scraper/selectors.js");

  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}),
    submit.click(),
  ]);

  const postLoginChallenge = await detectChallenge(page);
  if (postLoginChallenge) {
    await captureChallengeEvidence(page, postLoginChallenge);
    const headed = process.env.SCRAPER_HEADLESS === "false";
    if (headed && (await waitForManualResolution(page, postLoginChallenge))) {
      await browserSession.saveStorageState();
      logger.info("Challenge resolved manually, session saved");
      return page;
    }
    throw new AuthChallengeError(postLoginChallenge);
  }

  if (!(await isLoggedIn(page))) {
    throw new Error("Login submitted but authenticated dashboard was not detected. Check credentials / selectors.");
  }

  await browserSession.saveStorageState();
  logger.info("Login successful, session saved");
  return page;
}

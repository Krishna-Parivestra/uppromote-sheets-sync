import fs from "node:fs";
import path from "node:path";

const DEFAULT_STORAGE_DIR = "./playwright-session";

function decodeBase64Json(value, name) {
  try {
    const json = Buffer.from(value, "base64").toString("utf8");
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`${name} is not valid base64-encoded JSON: ${error.message}`);
  }
}

function loadRawAccounts() {
  const encoded = process.env.UPPROMOTE_ACCOUNTS_JSON_B64?.trim();
  if (encoded) return decodeBase64Json(encoded, "UPPROMOTE_ACCOUNTS_JSON_B64");

  const plain = process.env.UPPROMOTE_ACCOUNTS_JSON?.trim();
  if (plain) {
    try {
      return JSON.parse(plain);
    } catch (error) {
      throw new Error(`UPPROMOTE_ACCOUNTS_JSON is not valid JSON: ${error.message}`);
    }
  }

  const localPath = path.resolve("./config/accounts.local.json");
  if (fs.existsSync(localPath)) {
    try {
      return JSON.parse(fs.readFileSync(localPath, "utf8"));
    } catch (error) {
      throw new Error(`config/accounts.local.json is not valid JSON: ${error.message}`);
    }
  }

  // Backward-compatible single-account mode. This lets the current working
  // local setup continue to run while multiple accounts are being added.
  const email = process.env.UPPROMOTE_EMAIL?.trim();
  const password = process.env.UPPROMOTE_PASSWORD;
  const url = process.env.UPPROMOTE_URL?.trim();
  if (!email || !password || !url) {
    throw new Error(
      "Configure UPPROMOTE_ACCOUNTS_JSON_B64 (recommended for multi-account use), " +
      "or the legacy UPPROMOTE_URL / UPPROMOTE_EMAIL / UPPROMOTE_PASSWORD variables."
    );
  }

  return [{
    id: "default",
    name: "Default UpPromote Account",
    url,
    email,
    password,
    storageStatePath: process.env.PLAYWRIGHT_STORAGE_STATE_PATH || "./playwright-session/storage-state.json",
    commissionRate: process.env.COMMISSION_RATE || "",
  }];
}

function safeId(value) {
  return String(value).trim().replace(/[^A-Za-z0-9_-]/g, "_");
}

export function loadAccounts() {
  const raw = loadRawAccounts();
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("At least one UpPromote account must be configured");
  }

  const seen = new Set();
  const accounts = raw.map((account, index) => {
    if (!account || typeof account !== "object") {
      throw new Error(`Account at index ${index} is not an object`);
    }

    const id = safeId(account.id || `account_${index + 1}`);
    if (!id) throw new Error(`Account at index ${index} has an empty id`);
    if (seen.has(id)) throw new Error(`Duplicate UpPromote account id: ${id}`);
    seen.add(id);

    const name = String(account.name || id).trim();
    const url = String(account.url || "").trim();
    const email = String(account.email || "").trim();
    const password = account.password == null ? "" : String(account.password);
    if (!url || !email || !password) {
      throw new Error(`Account ${id} must define url, email and password`);
    }

    const storageStatePath = String(
      account.storageStatePath || path.join(DEFAULT_STORAGE_DIR, `${id}.json`)
    );

    return {
      id,
      name,
      url,
      email,
      password,
      storageStatePath,
      storageStateB64: account.storageStateB64 || "",
      commissionRate: account.commissionRate ?? process.env.COMMISSION_RATE ?? "",
    };
  });

  return accounts;
}

export function loadAccountsFromLocalFile(filePath = "./config/accounts.local.json") {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return null;
  const json = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!Array.isArray(json)) throw new Error(`${filePath} must contain a JSON array`);
  process.env.UPPROMOTE_ACCOUNTS_JSON_B64 = Buffer.from(JSON.stringify(json)).toString("base64");
  return loadAccounts();
}

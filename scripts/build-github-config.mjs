import fs from 'node:fs';

const bundles = [];
for (let i = 1; i <= 20; i += 1) {
  const raw = process.env[`UPPROMOTE_ACCOUNTS_BUNDLE_${i}`]?.trim();
  if (!raw) continue;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`UPPROMOTE_ACCOUNTS_BUNDLE_${i} is not valid base64 JSON: ${error.message}`);
  }
  if (!Array.isArray(decoded)) {
    throw new Error(`UPPROMOTE_ACCOUNTS_BUNDLE_${i} must contain a JSON array`);
  }
  bundles.push(...decoded);
}

if (bundles.length === 0) {
  throw new Error('No UPPROMOTE_ACCOUNTS_BUNDLE_* secrets were provided.');
}

const seen = new Set();
for (const account of bundles) {
  if (!account?.id) throw new Error('An account bundle entry is missing id');
  if (seen.has(account.id)) throw new Error(`Duplicate account id across bundles: ${account.id}`);
  seen.add(account.id);
  if (!account.email || !account.password || !account.url) {
    throw new Error(`Account ${account.id} must define url, email and password`);
  }
  if (!account.storageStateB64) {
    throw new Error(`Account ${account.id} has no stored Playwright session in its GitHub bundle`);
  }
}

const combined = Buffer.from(JSON.stringify(bundles)).toString('base64');
fs.appendFileSync(process.env.GITHUB_ENV, `UPPROMOTE_ACCOUNTS_JSON_B64=${combined}\n`, 'utf8');
console.log(`Loaded ${bundles.length} UpPromote accounts from ${bundles.length} GitHub secret bundle(s).`);

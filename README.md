# UpPromote → Google Sheets Sync (Step 1)

This is the first standalone version of the cloud sync pipeline, derived from the existing UpPromote scraper code.

## What is included

- Playwright authentication/session handling
- UpPromote Orders/Commission table extraction
- Header-driven column mapping
- Full-history pagination or current-page snapshot mode
- Status/amount/date normalization
- Google Sheets API writer
- Idempotent upsert using `source_order_id`
- Logging and clean process shutdown

## What is intentionally removed

- Supabase
- Express/API routes
- Socket.IO
- React/Vite frontend
- Website dashboard

## Data flow

`UpPromote → Playwright → parser → Google Sheets`

## Sheet structure

The default tab is `RAW_ORDERS` with these columns:

`source_order_id, source, referral_id, order_date, product_name, quantity, order_amount, commission_amount, commission_status, commission_status_raw, order_status, order_status_raw, customer_name, customer_email, reference_id, last_synced_at, raw_snapshot_json`

## Local setup

```bash
npm install
npx playwright install --with-deps chromium
cp .env.example .env
npm run check
npm run sync
```

Set these environment variables in `.env`:

- `UPPROMOTE_EMAIL`
- `UPPROMOTE_PASSWORD`
- `GOOGLE_SHEETS_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON_B64`

Share the target Google Sheet with the service-account `client_email` as an Editor before running the sync.

`SCRAPE_MODE=full` is the safer initial mode because it walks all available pages and lets the sheet upsert layer deduplicate records. Use `snapshot` later only after we add a reliable incremental strategy.

## Important authentication limitation

This code never bypasses MFA/CAPTCHA. In headless cloud execution, a new challenge causes the run to fail rather than waiting forever for human input. We will handle the operational strategy for session expiry/challenges in a later build step.

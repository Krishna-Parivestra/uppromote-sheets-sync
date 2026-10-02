# UpPromote -> Google Sheets (Step 4: Simple Account Replacement)

This version is intentionally simple for the reporting use case:

- Up to 100 rows are scraped per UpPromote account.
- Each account has its own login/session.
- Every row includes account_id and account_name.
- Every full sync replaces the previous rows for that account with the newest snapshot.
- Other accounts' rows are preserved.
- Empty/invalid snapshots are refused by default, so a scraper failure does not erase an account's good data.
- No pagination is used.
- Google Apps Script is the only Google-side component; no Google Cloud hosting is required.

## Local multi-account configuration

Create `config/accounts.local.json` (never commit it):

```json
[
  {
    "id": "hypdshop",
    "name": "HYPD Shop",
    "url": "https://af.uppromote.com/hypdshop/dashboard",
    "email": "YOUR_EMAIL",
    "password": "YOUR_PASSWORD",
    "storageStatePath": "./playwright-session/storage-state.json",
    "commissionRate": "",
    "allowEmptyFullSync": false
  },
  {
    "id": "account_2",
    "name": "SECOND ACCOUNT",
    "url": "https://af.uppromote.com/ACCOUNT_2/dashboard",
    "email": "SECOND_EMAIL",
    "password": "SECOND_PASSWORD",
    "storageStatePath": "./playwright-session/account_2.json",
    "commissionRate": "",
    "allowEmptyFullSync": false
  }
]
```

Use a unique `id` and `storageStatePath` for every account.

## Google Apps Script properties

In the spreadsheet's Apps Script project, create these Script Properties:

- `SPREADSHEET_ID`: the target spreadsheet ID
- `SYNC_SECRET`: a private secret shared with the Node runner
- `TAB_NAME`: `RAW_ORDERS`

Deploy the Apps Script as a web app and put its `/exec` URL into `GOOGLE_APPS_SCRIPT_URL`.

## Local test

```powershell
npm install
npm run check
npm run sync
```

For the first login of a new account, use `SCRAPER_HEADLESS=false` so the authorized user can complete any CAPTCHA/MFA challenge manually. After the session is saved, switch back to `true`.

## Expected replacement behavior

If HYPD Shop has 100 rows in the sheet and the next run contains 100 rows:

- old HYPD rows are removed
- newest HYPD rows are written
- rows belonging to other accounts stay untouched

If an order's commission/status changes, the newest row automatically replaces the old one. No duplicate-history logic is needed for the reporting sheet.

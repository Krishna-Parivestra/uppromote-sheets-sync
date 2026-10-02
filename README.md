# GitHub deployment patch for UpPromote → Google Sheets

This patch changes deployment from one oversized GitHub secret to several smaller encrypted bundles. The bundles contain the account credentials and Playwright storage state required for unattended cloud runs.

## Local preparation

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\prepare-github-bundles.ps1
```

The script copies one bundle at a time to the clipboard and tells you which GitHub secret name to create. It uses a 44,000-byte safety limit per bundle, below GitHub's 48 KiB secret limit.

## GitHub secrets

Create the bundle secrets reported by the script, plus:

- `GOOGLE_APPS_SCRIPT_URL`
- `GOOGLE_APPS_SCRIPT_SECRET`

The workflow accepts up to 8 bundle secrets out of the box. More can be added later by extending the workflow if the account set grows enough to require additional bundles.

## Schedule

The workflow runs at 00:15, 05:15, 10:15, 15:15, and 20:15 Asia/Kolkata. This is five scheduled runs per day; a conventional daily cron cannot represent a mathematically exact rolling five-hour interval across midnight.

# Creates the single GitHub secret value used by the cloud workflow.
# It reads local account passwords from config/accounts.local.json and embeds
# each account's Playwright storage-state file as base64.
# The final base64 value is copied to the clipboard, but is NOT printed.

$ErrorActionPreference = 'Stop'

$configPath = Join-Path (Get-Location) 'config\accounts.local.json'
if (-not (Test-Path $configPath)) {
    throw "Missing config/accounts.local.json"
}

$accounts = Get-Content -Raw $configPath | ConvertFrom-Json
if (-not ($accounts -is [System.Array])) {
    throw "accounts.local.json must contain an array"
}

$bundled = @()
foreach ($account in $accounts) {
    if (-not $account.id) { throw "An account is missing id" }
    if (-not $account.email) { throw "Account '$($account.id)' is missing email" }
    if (-not $account.password) { throw "Account '$($account.id)' is missing password" }

    $stateB64 = ''
    if ($account.storageStatePath) {
        $statePath = Join-Path (Get-Location) $account.storageStatePath
        if (Test-Path $statePath) {
            $bytes = [System.IO.File]::ReadAllBytes($statePath)
            $stateB64 = [Convert]::ToBase64String($bytes)
        } else {
            Write-Warning "No storage state found for '$($account.id)': $statePath"
        }
    }

    $bundled += [ordered]@{
        id = [string]$account.id
        name = [string]$account.name
        url = [string]$account.url
        email = [string]$account.email
        password = [string]$account.password
        storageStatePath = [string]$account.storageStatePath
        storageStateB64 = $stateB64
        commissionRate = if ($null -eq $account.commissionRate) { '' } else { [string]$account.commissionRate }
        allowEmptyFullSync = [bool]$account.allowEmptyFullSync
    }
}

$json = $bundled | ConvertTo-Json -Depth 10 -Compress
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
$size = [System.Text.Encoding]::UTF8.GetByteCount($b64)

Write-Host "Accounts bundled: $($bundled.Count)"
Write-Host "GitHub secret size: $size bytes"
Write-Host "GitHub limit: 49152 bytes"

if ($size -gt 49152) {
    throw "The combined secret is larger than GitHub's 48 KB secret limit. Stop here; use the per-account secret version instead."
}

Set-Clipboard -Value $b64
Write-Host "The secret value has been copied to your clipboard. Paste it into GitHub as UPPROMOTE_ACCOUNTS_JSON_B64."
Write-Host "For safety, the secret value was not printed."

# Prepares several GitHub Actions secrets instead of one oversized secret.
# Each bundle contains complete account records, including password and Playwright session state.
# Bundles are kept below GitHub's 48 KB secret limit with a safety margin.
$ErrorActionPreference = 'Stop'

$configPath = Join-Path (Get-Location) 'config\accounts.local.json'
if (-not (Test-Path $configPath)) { throw "Missing config/accounts.local.json" }

$accounts = Get-Content -Raw $configPath | ConvertFrom-Json
if (-not ($accounts -is [System.Array]) -or $accounts.Count -eq 0) {
    throw "config/accounts.local.json must contain at least one account"
}

$MAX_SECRET_BYTES = 44000

function Get-AccountPayload($account) {
    if (-not $account.id) { throw "An account is missing id" }
    if (-not $account.email) { throw "Account '$($account.id)' is missing email" }
    if (-not $account.password) { throw "Account '$($account.id)' is missing password" }
    if (-not $account.url) { throw "Account '$($account.id)' is missing url" }

    $stateB64 = ''
    if ($account.storageStatePath) {
        $statePath = Join-Path (Get-Location) $account.storageStatePath
        if (Test-Path $statePath) {
            $bytes = [System.IO.File]::ReadAllBytes($statePath)
            $stateB64 = [Convert]::ToBase64String($bytes)
        } else {
            throw "No Playwright session found for '$($account.id)': $statePath. Complete the login/CAPTCHA locally first."
        }
    }

    return [ordered]@{
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

$payloads = @()
foreach ($account in $accounts) {
    $payloads += Get-AccountPayload $account
}

# Greedily pack accounts into groups that remain comfortably below GitHub's 48 KB limit.
$bundles = @()
$current = @()
foreach ($payload in $payloads) {
    $candidate = @($current + $payload)
    $candidateJson = $candidate | ConvertTo-Json -Depth 12 -Compress
    $candidateB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($candidateJson))
    $candidateSize = [System.Text.Encoding]::UTF8.GetByteCount($candidateB64)

    if ($current.Count -gt 0 -and $candidateSize -gt $MAX_SECRET_BYTES) {
        $bundles += ,@($current)
        $current = @($payload)
    } else {
        $current = @($candidate)
    }
}
if ($current.Count -gt 0) { $bundles += ,@($current) }

Write-Host "Accounts: $($payloads.Count)"
Write-Host "Bundles required: $($bundles.Count)"
Write-Host "Safe bundle limit: $MAX_SECRET_BYTES bytes (GitHub hard limit: 49152)"
Write-Host ""

for ($i = 0; $i -lt $bundles.Count; $i++) {
    $number = $i + 1
    $json = $bundles[$i] | ConvertTo-Json -Depth 12 -Compress
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
    $size = [System.Text.Encoding]::UTF8.GetByteCount($b64)
    $secretName = "UPPROMOTE_ACCOUNTS_BUNDLE_$number"

    Set-Clipboard -Value $b64
    $names = ($bundles[$i] | ForEach-Object { $_.id }) -join ', '
    Write-Host "Bundle $number/$($bundles.Count): $secretName"
    Write-Host "Accounts: $names"
    Write-Host "Size: $size bytes"
    Write-Host "The bundle value is now in your clipboard."
    if ($number -lt $bundles.Count) {
        Read-Host "Paste it into GitHub, save the secret, then press Enter for the next bundle"
    } else {
        Write-Host "Paste this final bundle into GitHub, then press Enter to finish"
        [void](Read-Host)
    }
    Write-Host ""
}

Write-Host "Finished. Do not commit config/accounts.local.json or playwright-session/."

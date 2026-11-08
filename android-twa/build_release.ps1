# Builds a signed Galio release (.aab for Play, .apk for phone testing).
# Asks for the keystore passwords; they stay in this window only.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$ks  = Read-Host -AsSecureString 'Keystore slaptazodis (android.keystore)'
$key = Read-Host -AsSecureString 'Rakto "android" slaptazodis (jei tas pats - spauskite Enter)'
function Plain($s) { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
$env:BUBBLEWRAP_KEYSTORE_PASSWORD = Plain $ks
$k = Plain $key
if ([string]::IsNullOrEmpty($k)) { $k = $env:BUBBLEWRAP_KEYSTORE_PASSWORD }
$env:BUBBLEWRAP_KEY_PASSWORD = $k

try {
    npx --yes @bubblewrap/cli build --skipPwaValidation
} finally {
    Remove-Item Env:BUBBLEWRAP_KEYSTORE_PASSWORD, Env:BUBBLEWRAP_KEY_PASSWORD -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Paruosta:' -ForegroundColor Green
Get-ChildItem app-release-bundle.aab, app-release-signed.apk | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize

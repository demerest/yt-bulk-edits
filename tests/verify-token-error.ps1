<#
    Regression test for the helper's token-endpoint error reporting.

    Loads ONLY the function section of auth-helper.ps1 (everything before the
    "main" marker, so no HTTP listener starts), then calls Invoke-FormPost with
    deliberately bogus client credentials. Google answers 401 invalid_client;
    the helper must surface that name (and the fix hint), not a bare
    localized "(401) Unauthorized" - Windows PowerShell 5.1 leaves
    ErrorDetails empty for 401s, which is the bug this guards against.

    Run:  powershell -NoProfile -ExecutionPolicy Bypass -File tests\verify-token-error.ps1
#>
$ErrorActionPreference = 'Stop'

$here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$helperPath = Join-Path (Split-Path -Parent $here) 'auth-helper.ps1'
$marker    = '# ---------------------------------------------------------------- main'

$src = Get-Content $helperPath -Raw
$cut = $src.IndexOf($marker)
if ($cut -lt 0) { throw "marker not found in $helperPath - the file layout changed" }

$tmp = Join-Path $env:TEMP 'ytbe-funcs-only.ps1'
Set-Content -Path $tmp -Value $src.Substring(0, $cut) -Encoding UTF8
. $tmp   # allowed because this session runs under -ExecutionPolicy Bypass

try {
    Invoke-FormPost 'https://oauth2.googleapis.com/token' @{
        grant_type    = 'authorization_code'
        code          = 'BOGUS'
        client_id     = '12345-bogus.apps.googleusercontent.com'
        client_secret = 'WRONGSECRET'
        redirect_uri  = 'http://localhost:8787/callback'
        code_verifier = 'abc'
    } | Out-Null
    Write-Output 'RESULT=UNEXPECTED_SUCCESS'
    exit 1
} catch {
    $msg = $_.Exception.Message
    Write-Output ('THROWN: ' + $msg)
    $ok = ($msg -like '*invalid_client*') -and ($msg -like '*FIX:*')
    if ($ok) { Write-Output 'RESULT=PASS (error names invalid_client and includes the fix hint)' ; exit 0 }
    Write-Output 'RESULT=FAIL (error did not name invalid_client / missing fix hint)'
    exit 1
}

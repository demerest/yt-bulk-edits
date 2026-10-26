<#
.SYNOPSIS
    Local sign-in broker for yt-bulk-edits.

.DESCRIPTION
    Runs an HTTP listener on localhost only. It owns the OAuth client secret and
    the refresh token so the browser page never has to, refreshes access tokens
    on demand, serves the app at http://localhost:PORT/, and completes the Google
    redirect itself (no copy-pasting codes).

    Endpoints
      GET  /status      { ok, configured, signedIn, channel, expiresAt, hasRefresh }
      POST /config      { clientId, clientSecret, redirectUri } -> saved to auth-config.json
      POST /begin       { scope } -> { authUrl, state }  (PKCE challenge generated here)
      GET  /callback    Google redirects here with ?code=&state=
      GET  /token       { accessToken, expiresAt, scope } (refreshes if expired)
      POST /signout     deletes tokens.json
      GET  /            serves index.html (plus styles.css, js/*)

    SECURITY
      * Binds to http://localhost:PORT/ only - not reachable from other machines.
      * tokens.json and auth-config.json are written NEXT TO THIS SCRIPT IN
        PLAINTEXT. Do not put this folder in a public repo or a synced share
        without excluding them. Delete them (or press Sign out) to revoke.
      * Revoke the grant itself at https://myaccount.google.com/permissions

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File auth-helper.ps1
    powershell -ExecutionPolicy Bypass -File auth-helper.ps1 -Port 8787 -NoBrowser
#>

[CmdletBinding()]
param(
    [int]$Port = 8787,
    [switch]$NoBrowser,
    [string]$Scope = 'https://www.googleapis.com/auth/youtube'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Root        = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath  = Join-Path $Root 'auth-config.json'
$TokensPath  = Join-Path $Root 'tokens.json'
$BaseUrl     = "http://localhost:$Port"
$RedirectUri = "$BaseUrl/callback"

# In-memory PKCE challenges: state -> code_verifier
$script:Pending = @{}

# ---------------------------------------------------------------- helpers

function Write-Log([string]$Message, [string]$Level = 'info') {
    $colour = switch ($Level) { 'ok' { 'Green' } 'warn' { 'Yellow' } 'error' { 'Red' } default { 'Gray' } }
    $stamp = (Get-Date).ToString('HH:mm:ss')
    Write-Host "[$stamp] $Message" -ForegroundColor $colour
}

function Get-Config {
    if (-not (Test-Path $ConfigPath)) { return $null }
    try {
        $json = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        if (-not $json.clientId) { return $null }
        if (-not $json.redirectUri) { $json | Add-Member -NotePropertyName redirectUri -NotePropertyValue $RedirectUri -Force }
        return $json
    } catch { Write-Log "auth-config.json is corrupt: $($_.Exception.Message)" 'error'; return $null }
}

function Save-Config($Config) {
    $Config | ConvertTo-Json -Depth 4 | Set-Content -Path $ConfigPath -Encoding UTF8
}

function Get-Tokens {
    if (-not (Test-Path $TokensPath)) { return $null }
    try { return (Get-Content $TokensPath -Raw | ConvertFrom-Json) } catch { return $null }
}

function Save-Tokens($Tokens) {
    $Tokens | ConvertTo-Json -Depth 4 | Set-Content -Path $TokensPath -Encoding UTF8
}

function Clear-Tokens { if (Test-Path $TokensPath) { Remove-Item $TokensPath -Force } }

function New-Base64Url([byte[]]$Bytes) {
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-CodeVerifier {
    $bytes = New-Object byte[] 48
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    return New-Base64Url $bytes
}

function Get-CodeChallenge([string]$Verifier) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($Verifier))
    $sha.Dispose()
    return New-Base64Url $hash
}

function Read-ErrorBody($Exception) {
    # Windows PowerShell 5.1 leaves ErrorDetails empty for 401 responses, which is
    # exactly the case that matters here (invalid_client). Read the response
    # stream directly - the JSON body is what actually names the fault.
    try {
        if ($Exception -and $Exception.Response) {
            $stream = $Exception.Response.GetResponseStream()
            if ($stream) {
                $reader = New-Object IO.StreamReader($stream)
                $raw = $reader.ReadToEnd()
                $reader.Close()
                return $raw
            }
        }
    } catch { }
    return $null
}

function Invoke-FormPost([string]$Url, [hashtable]$Body) {
    $encoded = ($Body.GetEnumerator() | Where-Object { $null -ne $_.Value -and "$($_.Value)" -ne '' } |
        ForEach-Object { [uri]::EscapeDataString($_.Key) + '=' + [uri]::EscapeDataString([string]$_.Value) }) -join '&'
    try {
        return Invoke-RestMethod -Method Post -Uri $Url -ContentType 'application/x-www-form-urlencoded' -Body $encoded
    } catch {
        $raw = $null
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $raw = $_.ErrorDetails.Message }
        if (-not $raw) { $raw = Read-ErrorBody $_.Exception }
        $detail = $null
        if ($raw) { try { $detail = $raw | ConvertFrom-Json } catch { $detail = $null } }
        if ($detail -and $detail.error) {
            $msg = [string]$detail.error
            if ($detail.error_description) { $msg += ': ' + [string]$detail.error_description }
            if ([string]$detail.error -eq 'invalid_client') {
                $msg += ' | FIX: the Client ID and Client secret do not authenticate as a pair. Re-copy BOTH from Google Cloud Console > Credentials > your OAuth client (use Reset secret if unsure), re-paste them in the app and press Save to helper, then sign in again.'
            }
            throw "Google token endpoint: $msg"
        }
        $code = ''
        try { if ($_.Exception.Response) { $code = ' (HTTP ' + [int]$_.Exception.Response.StatusCode + ')' } } catch { }
        throw "Google token endpoint failed$code : $($_.Exception.Message)"
    }
}

function Update-TokensFromResponse($Response, [string]$Verifier) {
    $existing = Get-Tokens
    $now = [DateTime]::UtcNow
    # Precomputed rather than written as `if` expressions inside the hashtable:
    # statement-as-value is version-dependent and would break sign-in silently.
    $refresh = $Response.refresh_token
    if (-not $refresh -and $existing) { $refresh = $existing.refresh_token }
    $scp = $Response.scope
    if (-not $scp -and $existing) { $scp = $existing.scope }
    if (-not $scp) { $scp = $Scope }
    $chan = $null
    if ($existing) { $chan = $existing.channel }

    $tokens = [pscustomobject]@{
        access_token  = $Response.access_token
        refresh_token = $refresh
        scope         = $scp
        token_type    = 'Bearer'
        expires_at    = $now.AddSeconds([int]($Response.expires_in)).ToString('o')
        channel       = $chan
        saved_at      = $now.ToString('o')
    }
    Save-Tokens $tokens
    return $tokens
}

function Test-TokenExpired($Tokens) {
    if (-not $Tokens -or -not $Tokens.access_token) { return $true }
    if (-not $Tokens.expires_at) { return $false }
    try {
        $exp = [DateTime]::Parse($Tokens.expires_at).ToUniversalTime()
        return ([DateTime]::UtcNow.AddSeconds(60) -ge $exp)
    } catch { return $true }
}

function Invoke-Refresh($Tokens) {
    $config = Get-Config
    if (-not $config) { throw 'No OAuth client configured.' }
    if (-not $Tokens.refresh_token) { throw 'No refresh token stored - sign in again.' }
    $body = @{
        grant_type    = 'refresh_token'
        refresh_token = $Tokens.refresh_token
        client_id     = $config.clientId
    }
    if ($config.clientSecret) { $body['client_secret'] = $config.clientSecret }
    $resp = Invoke-FormPost 'https://oauth2.googleapis.com/token' $body
    return Update-TokensFromResponse $resp $null
}

function Get-FreshTokens {
    $tokens = Get-Tokens
    if (-not $tokens) { return $null }
    if (Test-TokenExpired $tokens) {
        Write-Log 'Access token expired - refreshing...'
        $tokens = Invoke-Refresh $tokens
        Write-Log 'Refreshed.' 'ok'
    }
    return $tokens
}

function Get-ChannelInfo([string]$AccessToken) {
    try {
        $r = Invoke-RestMethod -Method Get -Uri 'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true' `
             -Headers @{ Authorization = "Bearer $AccessToken" }
        if ($r.items -and $r.items.Count -gt 0) {
            return [pscustomobject]@{
                id          = $r.items[0].id
                title       = $r.items[0].snippet.title
                videoCount  = [int]$r.items[0].statistics.videoCount
            }
        }
    } catch { Write-Log "Could not read channel: $($_.Exception.Message)" 'warn' }
    return $null
}

# ---------------------------------------------------------------- HTTP plumbing

function Add-Cors($Response) {
    $Response.AddHeader('Access-Control-Allow-Origin', '*')
    $Response.AddHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    $Response.AddHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    $Response.AddHeader('Access-Control-Max-Age', '600')
    $Response.AddHeader('Cache-Control', 'no-store')
}

function Send-Response($Context, [string]$Body, [string]$ContentType, [int]$StatusCode = 200) {
    $Response = $Context.Response
    Add-Cors $Response
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Send-Json($Context, $Object, [int]$StatusCode = 200) {
    $json = $Object | ConvertTo-Json -Depth 6 -Compress
    Send-Response $Context $json 'application/json; charset=utf-8' $StatusCode
}

function Send-File($Context, [string]$FullPath) {
    if (-not (Test-Path $FullPath -PathType Leaf)) { Send-Json $Context @{ error = 'not found' } 404; return }
    # Path-traversal guard: the resolved file must live inside $Root.
    $resolved = (Resolve-Path $FullPath).Path
    if (-not $resolved.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
        Send-Json $Context @{ error = 'forbidden' } 403; return
    }
    $ext = [IO.Path]::GetExtension($resolved).ToLowerInvariant()
    $type = switch ($ext) {
        '.html' { 'text/html; charset=utf-8' }
        '.css'  { 'text/css; charset=utf-8' }
        '.js'   { 'application/javascript; charset=utf-8' }
        '.json' { 'application/json; charset=utf-8' }
        '.svg'  { 'image/svg+xml' }
        '.png'  { 'image/png' }
        '.ico'  { 'image/x-icon' }
        default { 'application/octet-stream' }
    }
    $bytes = [IO.File]::ReadAllBytes($resolved)
    $Response = $Context.Response
    Add-Cors $Response
    $Response.StatusCode = 200
    $Response.ContentType = $type
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Read-Body($Context) {
    if (-not $Context.Request.HasEntityBody) { return @{} }
    $reader = New-Object IO.StreamReader($Context.Request.InputStream, [Text.Encoding]::UTF8)
    $raw = $reader.ReadToEnd()
    $reader.Close()
    if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
    try { return ($raw | ConvertFrom-Json) } catch { return @{} }
}

# ---------------------------------------------------------------- routes

function Handle-Status($Context) {
    $config = Get-Config
    $tokens = $null
    try { $tokens = Get-FreshTokens } catch { Write-Log "Token refresh failed: $($_.Exception.Message)" 'warn'; $tokens = Get-Tokens }

    if ($tokens -and $tokens.access_token -and -not $tokens.channel) {
        $ch = Get-ChannelInfo $tokens.access_token
        if ($ch) { $tokens | Add-Member -NotePropertyName channel -NotePropertyValue $ch -Force; Save-Tokens $tokens }
    }

    $chan = $null; $exp = $null; $scp = $null; $redir = $RedirectUri
    if ($tokens) { $chan = $tokens.channel; $exp = $tokens.expires_at; $scp = $tokens.scope }
    if ($config -and $config.redirectUri) { $redir = $config.redirectUri }

    Send-Json $Context @{
        ok          = $true
        configured  = [bool]$config
        signedIn    = [bool]($tokens -and $tokens.access_token)
        channel     = $chan
        expiresAt   = $exp
        hasRefresh  = [bool]($tokens -and $tokens.refresh_token)
        scope       = $scp
        redirectUri = $redir
        version     = '1.0'
    }
}

function Handle-Config($Context, $Body) {
    $clientId = [string]$Body.clientId
    if ([string]::IsNullOrWhiteSpace($clientId)) { Send-Json $Context @{ error = 'clientId is required' } 400; return }
    $redirect = [string]$Body.redirectUri
    if ([string]::IsNullOrWhiteSpace($redirect)) { $redirect = $RedirectUri }
    $secret = ''
    if ($Body.clientSecret) { $secret = ([string]$Body.clientSecret).Trim() }
    $config = [pscustomobject]@{
        clientId     = $clientId.Trim()
        clientSecret = $secret
        redirectUri  = $redirect.Trim()
        scope        = $Scope
        saved_at     = [DateTime]::UtcNow.ToString('o')
    }
    Save-Config $config
    $shown = $config.clientId.Substring(0, [Math]::Min(12, $config.clientId.Length))
    Write-Log "OAuth client saved (${shown}...)" 'ok'
    Send-Json $Context @{ ok = $true; redirectUri = $config.redirectUri }
}

function Handle-Begin($Context, $Body) {
    $config = Get-Config
    if (-not $config) { Send-Json $Context @{ error = 'No OAuth client configured. POST /config first.' } 400; return }

    $redirect = if ($config.redirectUri) { $config.redirectUri } else { $RedirectUri }
    $scope = if ($Body.scope) { [string]$Body.scope } else { $Scope }

    $verifier = New-CodeVerifier
    $challenge = Get-CodeChallenge $verifier
    $state = (New-CodeVerifier).Substring(0, 16)
    $script:Pending[$state] = $verifier

    $params = [ordered]@{
        client_id             = $config.clientId
        redirect_uri          = $redirect
        response_type         = 'code'
        scope                 = $scope
        state                 = $state
        access_type           = 'offline'
        prompt                = 'consent'
        include_granted_scopes = 'true'
        code_challenge        = $challenge
        code_challenge_method = 'S256'
    }
    $query = ($params.GetEnumerator() | ForEach-Object { [uri]::EscapeDataString($_.Key) + '=' + [uri]::EscapeDataString([string]$_.Value) }) -join '&'
    $authUrl = "https://accounts.google.com/o/oauth2/v2/auth?$query"

    Send-Json $Context @{ ok = $true; authUrl = $authUrl; state = $state; redirectUri = $redirect }
}

function Handle-Callback($Context) {
    $q = $Context.Request.QueryString
    $code = [string]$q['code']
    $state = [string]$q['state']
    $err = [string]$q['error']

    $html = @'
<!DOCTYPE html><html><head><meta charset="utf-8"><title>yt-bulk-edits sign-in</title>
<style>body{background:#0f1115;color:#e6e8ee;font:15px/1.6 system-ui,sans-serif;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#171a21;border:1px solid #2a2f3a;border-radius:12px;padding:32px 36px;max-width:520px;text-align:center}
.ok{color:#3fb950;font-size:40px;margin:0 0 8px}.bad{color:#f0553d;font-size:40px;margin:0 0 8px}
code{background:#1e222b;padding:2px 6px;border-radius:4px;font-size:13px;color:#cfe0ff}
.hint{color:#6d7684;font-size:13px;margin-top:12px}</style></head><body><div class="card">
__ICON__<h2 style="margin:0 0 6px;font-size:18px">__TITLE__</h2><p class="hint">__BODY__</p></div></body></html>
'@

    if ($err) {
        $detail = switch ($err) {
            'access_denied' { 'You declined the request, or your Google account is not listed as a <b>Test user</b> on the OAuth consent screen. See SETUP.md step 4.'
            }
            'redirect_uri_mismatch' { "The redirect URI in your OAuth client must be exactly <code>$([uri]::EscapeDataString($RedirectUri))</code>. Fix it in Google Cloud Console, then sign in again."
            }
            default { "Google returned <code>$err</code>." }
        }
        $page = $html.Replace('__ICON__', '<p class="bad">&#10006;</p>').Replace('__TITLE__', 'Sign-in failed').Replace('__BODY__', $detail)
        Send-Response $Context $page 'text/html; charset=utf-8' 400
        Write-Log "Sign-in failed: $err" 'error'
        return
    }

    if ([string]::IsNullOrWhiteSpace($code)) {
        $page = $html.Replace('__ICON__', '<p class="bad">&#10006;</p>').Replace('__TITLE__', 'No code returned').Replace('__BODY__', 'Google redirected here without an authorization code.')
        Send-Response $Context $page 'text/html; charset=utf-8' 400
        return
    }

    $config = Get-Config
    if (-not $config) {
        $page = $html.Replace('__ICON__', '<p class="bad">&#10006;</p>').Replace('__TITLE__', 'Not configured').Replace('__BODY__', 'The helper has no OAuth client yet. Set it in the web UI, then sign in again.')
        Send-Response $Context $page 'text/html; charset=utf-8' 400
        return
    }

    if ([string]::IsNullOrWhiteSpace($state) -or -not $script:Pending.ContainsKey($state)) {
        $page = $html.Replace('__ICON__', '<p class="bad">&#10006;</p>').Replace('__TITLE__', 'State mismatch').Replace('__BODY__', 'This callback did not match a sign-in this helper started. Start again from the web UI.')
        Send-Response $Context $page 'text/html; charset=utf-8' 400
        Write-Log 'Rejected callback: unknown state (possible CSRF)' 'warn'
        return
    }

    $verifier = $script:Pending[$state]
    $script:Pending.Remove($state)

    try {
        $redir = $RedirectUri
        if ($config.redirectUri) { $redir = $config.redirectUri }
        $body = @{
            code          = $code
            client_id     = $config.clientId
            grant_type    = 'authorization_code'
            redirect_uri  = $redir
            code_verifier = $verifier
        }
        if ($config.clientSecret) { $body['client_secret'] = $config.clientSecret }
        $resp = Invoke-FormPost 'https://oauth2.googleapis.com/token' $body
        $tokens = Update-TokensFromResponse $resp $verifier

        if (-not $tokens.refresh_token) {
            Write-Log 'Google did not return a refresh token. If you need long-lived sessions, re-authorise with prompt=consent (the helper already requests it).' 'warn'
        }

        $ch = Get-ChannelInfo $tokens.access_token
        if ($ch) { $tokens | Add-Member -NotePropertyName channel -NotePropertyValue $ch -Force; Save-Tokens $tokens }

        $who = if ($ch) { $ch.title } else { 'your channel' }
        $page = $html.Replace('__ICON__', '<p class="ok">&#10004;</p>').Replace('__TITLE__', "Signed in as $who").Replace('__BODY__', 'You can close this tab and go back to the bulk editor. Your token is stored on this machine only and refreshes automatically.')
        Send-Response $Context $page 'text/html; charset=utf-8' 200
        Write-Log "Signed in as $who" 'ok'
    } catch {
        $page = $html.Replace('__ICON__', '<p class="bad">&#10006;</p>').Replace('__TITLE__', 'Token exchange failed').Replace('__BODY__', [System.Net.WebUtility]::HtmlEncode($_.Exception.Message))
        Send-Response $Context $page 'text/html; charset=utf-8' 500
        Write-Log "Token exchange failed: $($_.Exception.Message)" 'error'
    }
}

function Handle-Token($Context) {
    try {
        $tokens = Get-FreshTokens
        if (-not $tokens) { Send-Json $Context @{ error = 'Not signed in.' } 401; return }
        Send-Json $Context @{
            accessToken = $tokens.access_token
            expiresAt   = ([DateTime]::Parse($tokens.expires_at).ToUniversalTime().Subtract([DateTime]::new(1970,1,1,0,0,0,[DateTimeKind]::Utc)).TotalMilliseconds)
            scope       = $tokens.scope
            channel     = $tokens.channel
        }
    } catch {
        Send-Json $Context @{ error = $_.Exception.Message } 401
    }
}

function Handle-SignOut($Context) {
    Clear-Tokens
    $script:Pending.Clear()
    Write-Log 'Signed out - tokens.json removed. (Revoke the grant at https://myaccount.google.com/permissions)' 'ok'
    Send-Json $Context @{ ok = $true }
}

function Handle-Request($Context) {
    $method = $Context.Request.HttpMethod.ToUpperInvariant()
    $path = $Context.Request.Url.AbsolutePath.TrimEnd('/')
    if ($path -eq '') { $path = '/' }

    if ($method -eq 'OPTIONS') {
        $Response = $Context.Response
        Add-Cors $Response
        $Response.StatusCode = 204
        $Response.OutputStream.Close()
        return
    }

    $body = if ($method -eq 'POST') { Read-Body $Context } else { @{} }

    switch ($path) {
        '/status'  { Handle-Status $Context }
        '/config'  { if ($method -eq 'POST') { Handle-Config $Context $body } else { Send-Json $Context @{ configured = [bool](Get-Config) } } }
        '/begin'   { if ($method -eq 'POST') { Handle-Begin $Context $body } else { Send-Json $Context @{ error = 'POST required' } 405 } }
        '/callback' { Handle-Callback $Context }
        '/token'   { Handle-Token $Context }
        '/signout' { Handle-SignOut $Context }
        '/'        { Send-File $Context (Join-Path $Root 'index.html') }
        '/index.html' { Send-File $Context (Join-Path $Root 'index.html') }
        '/styles.css' { Send-File $Context (Join-Path $Root 'styles.css') }
        default {
            if ($path -match '^/(js|tests)/[A-Za-z0-9._/-]+$') {
                Send-File $Context (Join-Path $Root ($path.TrimStart('/')))
            } else {
                Send-Json $Context @{ error = "No route for $path" } 404
            }
        }
    }
}

# ---------------------------------------------------------------- main

Write-Host ''
Write-Host '  yt-bulk-edits :: local sign-in helper' -ForegroundColor Cyan
Write-Host "  serving $BaseUrl  (localhost only)" -ForegroundColor Gray
Write-Host ''

$listener = New-Object System.Net.HttpListener
try {
    $listener.Prefixes.Add("$BaseUrl/")
    $listener.Start()
} catch {
    if ($_.Exception.Message -match 'conflict|being used|access is denied') {
        Write-Log "Port $Port is already in use or not permitted. Another copy of the helper may be running - open $BaseUrl in your browser. Or retry with: -Port 8790" 'warn'
    } else {
        Write-Log "Could not listen on $BaseUrl : $($_.Exception.Message)" 'error'
    }
    exit 1
}

if (-not (Get-Config)) {
    Write-Log 'No OAuth client yet - open the app, tab "Local sign-in", and paste your client ID/secret. See SETUP.md.' 'warn'
} else {
    Write-Log 'OAuth client loaded.' 'ok'
}
if (Test-Path $TokensPath) { Write-Log 'Found stored tokens; the page will reuse them.' }

if (-not $NoBrowser) {
    try { Start-Process $BaseUrl } catch { Write-Log "Could not open a browser automatically - go to $BaseUrl" 'warn' }
}

Write-Host ''
Write-Host '  Press Ctrl+C to stop.' -ForegroundColor Gray
Write-Host ''

try {
    while ($listener.IsListening) {
        $Context = $listener.GetContext()
        $path = $Context.Request.Url.AbsolutePath
        try {
            Handle-Request $Context
            if ($path -ne '/status' -and $path -ne '/token') { Write-Log "$($Context.Request.HttpMethod) $path" }
        } catch {
            Write-Log "Error handling $path : $($_.Exception.Message)" 'error'
            try { Send-Json $Context @{ error = $_.Exception.Message } 500 } catch { }
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
    Write-Log 'Helper stopped.' 'warn'
}

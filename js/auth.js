/* yt-bulk-edits :: auth.js — three ways to get a YouTube-scoped access token.
 *
 *  A. helper : one-click sign-in via auth-helper.ps1 on http://localhost:8787.
 *              The helper owns the client secret + refresh token. Best UX.
 *  B. token  : paste an access token (e.g. from Google OAuth Playground).
 *              Zero setup, but it expires in ~1 hour.
 *  C. code   : paste-back authorization code with your own OAuth client,
 *              exchanged in-page using PKCE. Gives a refresh token with no
 *              helper process running.
 *
 * SECURITY TRADEOFF (accepted for convenience, tell the user): modes A/C keep
 * tokens in localStorage on this device; the "remember OAuth client" option
 * also stores the client secret there. Sign out wipes them.
 */
(function (global) {
  'use strict';

  var YTBE = global.YTBE = global.YTBE || {};
  var store = YTBE.store;
  var util = YTBE.util;
  var api = YTBE.api;

  var SCOPE = 'https://www.googleapis.com/auth/youtube';
  var AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
  var TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
  var LOOPBACK_REDIRECT = 'http://localhost:64834/callback';

  function helperBase() {
    return String(store.state.settings.helperUrl || 'http://localhost:8787').replace(/\/+$/, '');
  }

  async function helperFetch(path, opts) {
    opts = opts || {};
    var url = helperBase() + path;
    var init = { method: opts.method || 'GET', headers: {}, cache: 'no-store' };
    if (opts.body != null) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    var res = await fetch(url, init);
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      var msg = (data && (data.error || data.message)) || ('helper HTTP ' + res.status);
      throw new Error(msg);
    }
    return data || {};
  }

  /** Is the local helper up? Never throws — returns {available, ...status}. */
  async function helperStatus() {
    try {
      var s = await helperFetch('/status');
      return Object.assign({ available: true }, s);
    } catch (e) {
      return { available: false, error: e.message, url: helperBase() };
    }
  }

  /* ---------- PKCE ---------- */

  function randomVerifier() {
    var bytes = new Uint8Array(64);
    (global.crypto || {}).getRandomValues
      ? crypto.getRandomValues(bytes)
      : bytes.forEach(function (_, i) { bytes[i] = Math.floor(Math.random() * 256); });
    return util.base64url(bytes).slice(0, 64);
  }

  async function sha256Challenge(verifier) {
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return util.base64url(digest);
  }

  function buildAuthUrl(opts) {
    var params = {
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri || LOOPBACK_REDIRECT,
      response_type: 'code',
      scope: opts.scope || SCOPE,
      state: opts.state,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true'
    };
    if (opts.codeChallenge) {
      params.code_challenge = opts.codeChallenge;
      params.code_challenge_method = 'S256';
    }
    return AUTH_ENDPOINT + '?' + api.buildQuery(params).slice(1);
  }

  async function exchangeCode(opts) {
    var body = {
      code: opts.code,
      client_id: opts.clientId,
      grant_type: 'authorization_code',
      redirect_uri: opts.redirectUri || LOOPBACK_REDIRECT
    };
    if (opts.clientSecret) body.client_secret = opts.clientSecret;
    if (opts.codeVerifier) body.code_verifier = opts.codeVerifier;
    return postToken(body);
  }

  async function refreshWithToken(refreshToken, clientId, clientSecret) {
    var body = { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId };
    if (clientSecret) body.client_secret = clientSecret;
    return postToken(body);
  }

  async function postToken(body) {
    var form = Object.keys(body)
      .filter(function (k) { return body[k] != null && body[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(String(body[k])); })
      .join('&');

    var res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: form
    });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      var msg = (data && data.error_description) || (data && data.error) || ('token endpoint HTTP ' + res.status);
      var err = new Error(msg);
      err.tokenError = (data && data.error) || 'unknown';
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------- OAuth client persistence (separate, opt-in) ---------- */

  function loadOAuthClient() { return store.read('oauthClient', null); }
  function saveOAuthClient(c) {
    if (!c) { store.remove('oauthClient'); return null; }
    return store.write('oauthClient', c) ? c : null;
  }

  /* ---------- mode A: helper ---------- */

  async function beginHelperSignIn() {
    var status = await helperStatus();
    if (!status.available) {
      var e = new Error('Local sign-in helper is not running at ' + helperBase() + '. Start it with Start-tool.bat (or: powershell -ExecutionPolicy Bypass -File auth-helper.ps1).');
      e.helperDown = true;
      throw e;
    }
    var begin = await helperFetch('/begin', { method: 'POST', body: { scope: SCOPE } });
    return { authUrl: begin.authUrl, state: begin.state, status: status };
  }

  async function helperPollUntilSignedIn(previousState, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 300000);
    while (Date.now() < deadline) {
      await util.sleep(1200);
      var s = await helperStatus();
      if (s.available && s.signedIn) return s;
      if (!s.available) throw new Error('Helper stopped responding during sign-in.');
      if (s.error) throw new Error(s.error);
    }
    throw new Error('Sign-in timed out. Close the Google tab and try again.');
  }

  async function helperToken() {
    var t = await helperFetch('/token');
    if (!t || !t.accessToken) throw new Error('Helper returned no access token.');
    return {
      mode: 'helper',
      accessToken: t.accessToken,
      expiresAt: t.expiresAt || (Date.now() + 3000 * 1000),
      scope: t.scope || SCOPE,
      channel: t.channel || null
    };
  }

  async function helperSignOut() {
    try { await helperFetch('/signout', { method: 'POST' }); } catch (e) { /* helper may be down already */ }
  }

  /* ---------- mode B: pasted access token ---------- */

  function usePastedToken(raw) {
    var token = String(raw || '').trim();
    if (!token) throw new Error('Paste an access token first.');
    /* Tolerate people pasting the whole "Authorization: Bearer xyz" header. */
    token = token.replace(/^authorization:\s*/i, '').replace(/^bearer\s+/i, '').trim();
    if (token.indexOf('ya29.') !== 0 && token.length < 20) {
      throw new Error('That does not look like a Google access token (expected something starting "ya29.").');
    }
    var auth = { mode: 'token', accessToken: token, expiresAt: null, scope: SCOPE };
    store.saveAuth(auth);
    return auth;
  }

  /* ---------- mode C: pasted authorization code ---------- */

  async function startCodeFlow(clientId, clientSecret, redirectUri) {
    if (!clientId) throw new Error('Enter your OAuth client ID first.');
    var verifier = randomVerifier();
    var challenge = await sha256Challenge(verifier);
    var st = util.randomId('st');
    var pending = {
      mode: 'code',
      clientId: clientId.trim(),
      clientSecret: (clientSecret || '').trim(),
      redirectUri: (redirectUri || LOOPBACK_REDIRECT).trim(),
      verifier: verifier,
      state: st,
      startedAt: Date.now()
    };
    sessionStorage.setItem('ytbe.pendingCode', JSON.stringify(pending));
    return { pending: pending, authUrl: buildAuthUrl({ clientId: pending.clientId, redirectUri: pending.redirectUri, state: st, codeChallenge: challenge, scope: SCOPE }) };
  }

  function pendingCodeFlow() {
    try { return JSON.parse(sessionStorage.getItem('ytbe.pendingCode') || 'null'); } catch (e) { return null; }
  }

  /** Accept either a bare code or the whole redirected URL. */
  function extractCode(pasted) {
    var s = String(pasted || '').trim();
    if (!s) throw new Error('Paste the code (or the whole redirected URL) first.');
    if (s.indexOf('http') === 0) {
      var m = /[?&]code=([^&#]+)/.exec(s);
      if (!m) {
        if (/[?&]error=([^&#]+)/.test(s)) {
          var em = /[?&]error=([^&#]+)/.exec(s);
          throw new Error('Google returned an error instead of a code: ' + decodeURIComponent(em[1]) + '. If it says access_denied, add your Google account as a Test user on the OAuth consent screen.');
        }
        throw new Error('No "code" parameter found in that URL.');
      }
      var stateM = /[?&]state=([^&#]+)/.exec(s);
      return { code: decodeURIComponent(m[1]), state: stateM ? decodeURIComponent(stateM[1]) : null };
    }
    return { code: s.replace(/^code=/, ''), state: null };
  }

  async function finishCodeFlow(pasted) {
    var pending = pendingCodeFlow();
    if (!pending) throw new Error('No sign-in in progress. Click "Start sign-in" again.');
    var got = extractCode(pasted);
    if (got.state && pending.state && got.state !== pending.state) {
      throw new Error('State mismatch — this code did not come from the sign-in this page started. Starting over.');
    }
    var tok = await exchangeCode({
      code: got.code,
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.verifier
    });
    sessionStorage.removeItem('ytbe.pendingCode');
    var auth = {
      mode: 'code',
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || null,
      expiresAt: Date.now() + Number(tok.expires_in || 3600) * 1000,
      scope: tok.scope || SCOPE,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri
    };
    store.saveAuth(auth);
    return auth;
  }

  /* ---------- unified token access ---------- */

  /**
   * Returns a usable access token, refreshing when we can.
   * Throws with .needsAuth when the user must re-authenticate.
   */
  async function ensureToken() {
    var auth = store.state.auth;
    if (!auth || !auth.accessToken) {
      var e = new Error('Not signed in.');
      e.needsAuth = true;
      throw e;
    }

    if (!store.authExpired()) return auth.accessToken;

    if (auth.mode === 'helper') {
      var fresh = await helperToken();
      store.saveAuth(Object.assign({}, auth, fresh));
      return store.state.auth.accessToken;
    }

    if (auth.mode === 'code' && auth.refreshToken) {
      var saved = loadOAuthClient() || {};
      var secret = auth.clientSecret || saved.clientSecret || '';
      try {
        var tok = await refreshWithToken(auth.refreshToken, auth.clientId || saved.clientId, secret);
        store.saveAuth(Object.assign({}, auth, {
          accessToken: tok.access_token,
          expiresAt: Date.now() + Number(tok.expires_in || 3600) * 1000,
          refreshToken: tok.refresh_token || auth.refreshToken
        }));
        return store.state.auth.accessToken;
      } catch (err) {
        var e2 = new Error('Could not refresh the token: ' + err.message);
        e2.needsAuth = true;
        throw e2;
      }
    }

    var e3 = new Error('The pasted access token has expired. Paste a fresh one, or use local sign-in for auto-refresh.');
    e3.needsAuth = true;
    throw e3;
  }

  async function signOut() {
    var auth = store.state.auth;
    if (auth && auth.mode === 'helper') await helperSignOut();
    store.clearAuth();
    sessionStorage.removeItem('ytbe.pendingCode');
  }

  /** Verify a token really works and attach the channel. */
  async function verifyAndLoadChannel() {
    var token = await ensureToken();
    var channel = await api.getChannel(token);
    store.state.channel = channel;
    store.emit('auth', { auth: store.state.auth, channel: channel });
    return channel;
  }

  YTBE.auth = {
    SCOPE: SCOPE,
    TOKEN_ENDPOINT: TOKEN_ENDPOINT,
    AUTH_ENDPOINT: AUTH_ENDPOINT,
    LOOPBACK_REDIRECT: LOOPBACK_REDIRECT,
    PLAYGROUND_URL: 'https://developers.google.com/oauthplayground/?scope=' + encodeURIComponent(SCOPE),
    helperBase: helperBase,
    helperStatus: helperStatus,
    beginHelperSignIn: beginHelperSignIn,
    helperPollUntilSignedIn: helperPollUntilSignedIn,
    helperToken: helperToken,
    helperSignOut: helperSignOut,
    usePastedToken: usePastedToken,
    startCodeFlow: startCodeFlow,
    finishCodeFlow: finishCodeFlow,
    pendingCodeFlow: pendingCodeFlow,
    extractCode: extractCode,
    buildAuthUrl: buildAuthUrl,
    randomVerifier: randomVerifier,
    sha256Challenge: sha256Challenge,
    exchangeCode: exchangeCode,
    refreshWithToken: refreshWithToken,
    loadOAuthClient: loadOAuthClient,
    saveOAuthClient: saveOAuthClient,
    ensureToken: ensureToken,
    signOut: signOut,
    verifyAndLoadChannel: verifyAndLoadChannel
  };
})(typeof window !== 'undefined' ? window : globalThis);

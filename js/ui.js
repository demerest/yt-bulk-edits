/* yt-bulk-edits :: ui.js — rendering, preview, apply pipeline, rollback.
 *
 * Everything that writes to YouTube funnels through applyEdits(); everything
 * that reverses it funnels through restoreEntries(). Both are gated behind an
 * explicit confirmation that states the quota cost.
 */
(function (global) {
  'use strict';

  var YTBE = global.YTBE = global.YTBE || {};
  var util = YTBE.util, store = YTBE.store, api = YTBE.api, auth = YTBE.auth, T = YTBE.transform;
  var $ = util.$, el = util.el, esc = util.escapeHtml;

  var ui = {
    page: 0,
    preview: [],
    running: false,
    stopRequested: false,
    activeTab: 'helper',
    abort: null
  };

  /* ============================ feedback ============================ */

  function toast(msg, kind, ms) {
    var root = $('#toastRoot');
    if (!root) { console[kind === 'error' ? 'error' : 'log'](msg); return; }
    var node = el('div', { class: 'toast ' + (kind || 'info'), text: msg });
    root.appendChild(node);
    setTimeout(function () { node.classList.add('out'); setTimeout(function () { node.remove(); }, 300); }, ms || 4000);
  }

  function setStatus(sel, text, kind) {
    var node = $(sel);
    if (!node) return;
    node.textContent = text || '';
    node.className = 'status' + (kind ? ' ' + kind : '');
  }

  /** Modal confirm. Resolves true/false; never throws. */
  function confirmModal(opts) {
    return new Promise(function (resolve) {
      var root = $('#modalRoot');
      if (!root) { resolve(global.confirm(opts.body)); return; }
      var okBtn = el('button', { class: 'btn ' + (opts.danger ? 'danger' : 'primary'), text: opts.okText || 'Confirm' });
      var cancelBtn = el('button', { class: 'btn', text: opts.cancelText || 'Cancel' });
      var box = el('div', { class: 'modal-box' }, [
        el('h3', { text: opts.title || 'Are you sure?' }),
        el('div', { class: 'modal-body', html: opts.body || '' }),
        opts.requireText ? el('div', { class: 'modal-require' }, [
          el('label', { text: 'Type ' }), el('strong', { text: opts.requireText }), el('label', { text: ' to enable the button:' }),
          el('input', { id: 'modalRequireInput', type: 'text', autocomplete: 'off' })
        ]) : null,
        el('div', { class: 'modal-actions' }, [cancelBtn, okBtn])
      ]);
      var backdrop = el('div', { class: 'modal-backdrop' }, [box]);
      root.appendChild(backdrop);

      function close(val) { backdrop.remove(); global.removeEventListener('keydown', onKey); resolve(val); }
      function onKey(e) { if (e.key === 'Escape') close(false); }
      global.addEventListener('keydown', onKey);
      cancelBtn.addEventListener('click', function () { close(false); });
      okBtn.addEventListener('click', function () { close(true); });
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(false); });

      if (opts.requireText) {
        okBtn.disabled = true;
        var inp = $('#modalRequireInput', backdrop);
        inp.addEventListener('input', function () { okBtn.disabled = inp.value.trim().toUpperCase() !== opts.requireText.toUpperCase(); });
        setTimeout(function () { inp.focus(); }, 30);
      } else {
        setTimeout(function () { okBtn.focus(); }, 30);
      }
    });
  }

  /* ============================ rendering: header ============================ */

  function renderChannel() {
    var chip = $('#channelChip');
    if (!chip) return;
    var c = store.state.channel;
    if (!c) { chip.classList.add('hidden'); chip.innerHTML = ''; return; }
    chip.classList.remove('hidden');
    chip.innerHTML = '';
    if (c.thumbnail) chip.appendChild(el('img', { class: 'chip-thumb', src: c.thumbnail, alt: '' }));
    chip.appendChild(el('span', { class: 'chip-title', text: c.title }));
    if (c.demo) chip.appendChild(el('span', { class: 'badge warn', text: 'DEMO' }));
    else if (c.videoCount != null) chip.appendChild(el('span', { class: 'badge', text: util.fmtNum(c.videoCount) + ' videos' }));
  }

  function renderQuota() {
    var chip = $('#quotaChip');
    if (!chip) return;
    store.rollQuotaDay();
    var used = store.state.quota.units;
    var daily = Number(store.state.settings.dailyQuota) || 10000;
    var pct = Math.min(100, Math.round(used / daily * 100));
    chip.innerHTML = '';
    chip.appendChild(el('span', { text: 'Quota ' + util.fmtNum(used) + ' / ' + util.fmtNum(daily) }));
    var bar = el('div', { class: 'mini-bar' }, [el('div', { class: 'mini-bar-fill', style: { width: pct + '%' } })]);
    chip.appendChild(bar);
    chip.appendChild(el('span', { class: 'chip-sub', text: '\u2248 ' + Math.floor((daily - used) / 50) + ' edits left today' }));
    chip.className = 'chip' + (pct > 85 ? ' danger' : pct > 60 ? ' warn' : '');
  }

  function renderStorage() {
    var node = $('#storageInfo');
    if (!node) return;
    var bytes = store.storageBytes();
    var kb = bytes < 0 ? '?' : Math.round(bytes / 1024);
    node.textContent = kb + ' KB of browser storage used \u00b7 ' + store.state.log.length + ' change records \u00b7 ' + store.state.batches.length + ' batches';
    node.className = 'hint' + (store.state.storageFull ? ' danger' : '');
    if (store.state.storageFull) {
      node.textContent += ' \u2014 STORAGE FULL: rollback history is NOT being saved. Download a backup and prune old batches now.';
    }
  }

  /* ============================ auth panels ============================ */

  function switchTab(mode) {
    ui.activeTab = mode;
    util.$$('#authTabs .tab').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
    ['helper', 'token', 'code'].forEach(function (m) {
      var p = $('#panel-' + m);
      if (p) p.classList.toggle('hidden', m !== mode);
    });
    if (mode === 'helper') refreshHelperStatus();
  }

  var helperRetryTimer = null;
  var helperChecking = false;

  /* The page can only see the helper once it is running, and a user may start
     Start-tool.bat AFTER opening the tab. Probe once at load, then keep retrying
     in the background while it is missing so the panel heals itself instead of
     showing a stale "not running" verdict with a dead button. */
  function scheduleHelperRetry() {
    if (helperRetryTimer) return;
    helperRetryTimer = setInterval(function () {
      auth.helperStatus().then(function (s) {
        if (s.available && helperRetryTimer) {
          clearInterval(helperRetryTimer);
          helperRetryTimer = null;
          refreshHelperStatus();
        }
      });
    }, 4000);
  }

  function stopHelperRetry() {
    if (helperRetryTimer) { clearInterval(helperRetryTimer); helperRetryTimer = null; }
  }

  async function refreshHelperStatus() {
    var box = $('#helperInfo');
    if (!box || helperChecking) return;
    helperChecking = true;
    box.innerHTML = '<span class="hint">checking ' + esc(auth.helperBase()) + ' \u2026</span>';
    var s = await auth.helperStatus();
    helperChecking = false;
    box.innerHTML = '';
    if (!s.available) {
      stopHelperRetry();
      scheduleHelperRetry();
      box.appendChild(el('div', { class: 'status warn', text: 'Helper not running at ' + s.url }));
      box.appendChild(el('div', { class: 'hint', text: 'Double-click Start-tool.bat and KEEP ITS CONSOLE WINDOW OPEN \u2014 the helper lives in that window. This panel re-checks every few seconds and will update itself the moment it appears.' }));
      box.appendChild(el('button', { class: 'btn sm', text: 'Check again now', onclick: function () { refreshHelperStatus(); } }));
      var btn = $('#btnHelperSignin');
      if (btn) btn.disabled = true;
      return;
    }
    stopHelperRetry();
    var btn2 = $('#btnHelperSignin');
    if (!s.configured) {
      box.appendChild(el('div', { class: 'status warn', text: 'Helper is running \u00b7 waiting for your Google OAuth client (SETUP.md steps 1\u20134).' }));
      box.appendChild(el('div', { class: 'hint', html: 'Sign-in stays locked until this exists. Paste your <strong>Client ID</strong> and <strong>Client secret</strong> in the box below and press <strong>Save to helper</strong> \u2014 the button unlocks immediately, no restart needed.' }));
      var cfg = $('#panel-helper-config');
      if (cfg) cfg.classList.remove('hidden');
      if (btn2) btn2.disabled = true;
    } else if (s.signedIn) {
      box.appendChild(el('div', { class: 'status ok', text: 'Signed in' + (s.channel ? ' as ' + s.channel : '') + ' \u00b7 token auto-refreshes' }));
      if (btn2) { btn2.disabled = false; btn2.textContent = 'Reconnect'; }
    } else {
      box.appendChild(el('div', { class: 'status', text: 'Helper ready \u00b7 not signed in yet' }));
      if (btn2) { btn2.disabled = false; btn2.textContent = 'Sign in with Google'; }
    }
  }

  async function saveHelperConfig() {
    var clientId = $('#inpHelperClientId').value.trim();
    var clientSecret = $('#inpHelperClientSecret').value.trim();
    var redirect = $('#inpHelperRedirect').value.trim() || (auth.helperBase() + '/callback');
    if (!clientId) { toast('Enter the OAuth client ID.', 'error'); return; }
    try {
      await auth.helperStatus();
      var res = await fetch(auth.helperBase() + '/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId, clientSecret: clientSecret, redirectUri: redirect })
      });
      if (!res.ok) throw new Error('helper HTTP ' + res.status);
      toast('OAuth client saved to the helper.', 'ok');
      $('#inpHelperClientSecret').value = '';
      refreshHelperStatus();
    } catch (e) {
      toast('Could not save to helper: ' + e.message, 'error', 8000);
    }
  }

  async function doHelperSignIn() {
    setStatus('#authStatus', 'Opening Google sign-in\u2026');
    try {
      var started = await auth.beginHelperSignIn();
      var popup = global.open(started.authUrl, 'ytbeAuth', 'width=560,height=720');
      if (!popup) global.location.href = started.authUrl;
      setStatus('#authStatus', 'Waiting for you to approve access in the popup\u2026');
      await auth.helperPollUntilSignedIn();
      var tok = await auth.helperToken();
      store.saveAuth(tok);
      await afterAuth();
    } catch (e) {
      setStatus('#authStatus', e.message, 'error');
      toast(e.message, 'error', 9000);
      if (e.helperDown) refreshHelperStatus();
    }
  }

  function doPasteToken() {
    try {
      auth.usePastedToken($('#inpToken').value);
      setStatus('#authStatus', 'Token accepted \u00b7 verifying with the API\u2026');
      afterAuth();
    } catch (e) {
      setStatus('#authStatus', e.message, 'error');
    }
  }

  async function doStartCode() {
    try {
      var r = await auth.startCodeFlow($('#inpClientId').value, $('#inpClientSecret').value, $('#inpRedirect').value);
      if ($('#chkRememberClient').checked) {
        auth.saveOAuthClient({ clientId: r.pending.clientId, clientSecret: r.pending.clientSecret, redirectUri: r.pending.redirectUri });
      }
      $('#codeUrlBox').classList.remove('hidden');
      var link = el('a', { href: r.authUrl, target: '_blank', rel: 'noopener', class: 'btn primary', text: 'Open Google sign-in \u2197' });
      var box = $('#codeUrlBox');
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'hint', html: 'After approving, the browser lands on a page that <strong>fails to load</strong> (localhost:64834 is not a real server). That is expected &mdash; copy the <em>entire URL</em> from the address bar and paste it below.' }));
      box.appendChild(link);
      box.appendChild(el('div', { class: 'url-readonly', text: r.authUrl }));
      setStatus('#authStatus', 'Waiting for the authorization code\u2026');
      $('#inpCode').focus();
    } catch (e) {
      setStatus('#authStatus', e.message, 'error');
    }
  }

  async function doFinishCode() {
    try {
      setStatus('#authStatus', 'Exchanging code for tokens\u2026');
      await auth.finishCodeFlow($('#inpCode').value);
      await afterAuth();
    } catch (e) {
      setStatus('#authStatus', e.message, 'error');
      toast(e.message, 'error', 9000);
    }
  }

  async function afterAuth() {
    try {
      var channel = await auth.verifyAndLoadChannel();
      store.state.demo = false;
      setStatus('#authStatus', 'Connected as ' + channel.title + ' (' + channel.id + ')', 'ok');
      renderChannel();
      renderAuthState();
      toast('Connected: ' + channel.title, 'ok');
      loadCategories();
    } catch (e) {
      setStatus('#authStatus', 'Token rejected: ' + e.message, 'error');
      store.clearAuth();
      renderAuthState();
    }
  }

  function renderAuthState() {
    var a = store.state.auth;
    var signed = !!a;
    $('#btnSignout') && $('#btnSignout').classList.toggle('hidden', !signed);
    $('#secLoad') && $('#secLoad').classList.toggle('locked', !signed && !store.state.demo);
    var modes = { helper: 'local sign-in', token: 'pasted access token', code: 'OAuth code (PKCE)' };
    var node = $('#authModeChip');
    if (node) {
      node.textContent = signed ? 'Auth: ' + (modes[a.mode] || a.mode) + (a.expiresAt ? ' \u00b7 expires ' + util.fmtDate(new Date(a.expiresAt).toISOString(), true) : ' \u00b7 no expiry info') : 'Not connected';
      node.className = 'badge ' + (signed ? 'ok' : 'warn');
    }
  }

  var categories = {};
  async function loadCategories() {
    if (store.state.demo) return;
    try {
      var token = await auth.ensureToken();
      categories = await api.listCategories(token, (store.state.channel && store.state.channel.country) || 'US');
    } catch (e) { categories = {}; }
  }
  function categoryName(id) { return categories[String(id)] || ('category ' + id); }

  /* ============================ load videos ============================ */

  async function loadVideos() {
    if (store.state.demo) { toast('Demo data is already loaded.', 'info'); return; }
    var btn = $('#btnLoad');
    btn.disabled = true;
    ui.abort = new AbortController();
    try {
      var token = await auth.ensureToken();
      setStatus('#loadProgress', 'Loading uploads\u2026');
      var videos = await api.listMyVideos({
        token: token,
        /* Reuse the playlist id we already fetched at connect time (saves 1 unit). */
        uploadsPlaylist: store.state.channel && store.state.channel.uploadsPlaylist,
        signal: ui.abort.signal,
        onProgress: function (p) {
          setStatus('#loadProgress', p.phase === 'metadata'
            ? 'Fetching metadata for ' + util.fmtNum(p.loaded) + ' videos\u2026'
            : 'Found ' + util.fmtNum(p.loaded) + ' uploads (' + p.page + ' page' + (p.page === 1 ? '' : 's') + ')\u2026');
        }
      });
      store.state.videos = videos;
      store.state.videosLoadedAt = new Date().toISOString();
      store.state.demo = false;
      store.state.selection = {};
      store.emit('videos', { count: videos.length });
      renderLoadSummary();
      refreshPreview();
      toast('Loaded ' + util.fmtNum(videos.length) + ' videos.', 'ok');
    } catch (e) {
      setStatus('#loadProgress', e.message, e.aborted ? '' : 'error');
      if (e.needsAuth) { toast(e.message, 'error', 8000); renderAuthState(); }
    } finally {
      btn.disabled = false;
      ui.abort = null;
    }
  }

  function renderLoadSummary() {
    var node = $('#loadSummary');
    if (!node) return;
    var n = store.state.videos.length;
    node.innerHTML = '';
    if (!n) { node.appendChild(el('span', { class: 'hint', text: 'No videos loaded yet.' })); return; }
    var when = store.state.videosLoadedAt ? util.fmtDate(store.state.videosLoadedAt, true) : '';
    node.appendChild(el('span', { class: 'badge ok', text: util.fmtNum(n) + ' loaded' }));
    node.appendChild(el('span', { class: 'hint', text: ' at ' + when + (store.state.demo ? ' (sample data)' : '') }));
    var ageMin = store.state.videosLoadedAt ? (Date.now() - new Date(store.state.videosLoadedAt).getTime()) / 60000 : 0;
    if (ageMin > 20 && !store.state.demo) {
      node.appendChild(el('span', { class: 'badge warn', text: 'data is ' + Math.round(ageMin) + ' min old \u2014 reload before applying' }));
    }
  }

  /* ============================ filters ============================ */

  function readFilters() {
    store.state.filters = {
      text: $('#fltText') ? $('#fltText').value : '',
      field: $('#fltField') ? $('#fltField').value : 'title',
      privacy: $('#fltPrivacy') ? $('#fltPrivacy').value : '',
      from: $('#fltFrom') ? $('#fltFrom').value : '',
      to: $('#fltTo') ? $('#fltTo').value : '',
      ids: $('#fltIds') ? $('#fltIds').value : '',
      uneditedOnly: $('#chkFltUnedited') ? $('#chkFltUnedited').checked : false,
      caseSensitive: $('#chkFltCase') ? $('#chkFltCase').checked : false,
      regex: $('#chkFltRegex') ? $('#chkFltRegex').checked : false
    };
    return store.state.filters;
  }

  function videoHaystack(v, field) {
    var sn = v.snippet || {};
    if (field === 'title') return sn.title || '';
    if (field === 'description') return sn.description || '';
    if (field === 'tags') return (sn.tags || []).join('\n');
    if (field === 'id') return v.id || '';
    return [sn.title || '', sn.description || '', (sn.tags || []).join('\n')].join('\n');
  }

  function filteredVideos() {
    var f = readFilters();
    var vids = store.state.videos || [];
    var edited = store.editedVideoIds();
    var re = null;

    if (f.text) {
      try {
        re = new RegExp(f.regex ? f.text : util.escapeRegExp(f.text), f.caseSensitive ? '' : 'i');
      } catch (e) {
        setStatus('#patError', 'Filter regex is invalid: ' + e.message, 'error');
        return [];
      }
    }
    var idSet = null;
    if (f.ids && f.ids.trim()) {
      idSet = {};
      f.ids.split(/[\s,;]+/).filter(Boolean).forEach(function (id) {
        /* accept full watch URLs */
        var m = /[?&]v=([\w-]{11})/.exec(id);
        idSet[m ? m[1] : id.trim()] = true;
      });
    }

    return vids.filter(function (v) {
      if (idSet && !idSet[v.id]) return false;
      if (f.privacy && ((v.status || {}).privacyStatus || '') !== f.privacy) return false;
      if (f.from && String((v.snippet || {}).publishedAt || '') < f.from) return false;
      if (f.to && String((v.snippet || {}).publishedAt || '') > f.to + 'T23:59:59Z') return false;
      if (f.uneditedOnly && edited[v.id]) return false;
      if (re && !re.test(videoHaystack(v, f.field))) return false;
      return true;
    });
  }

  /* ============================ pattern ============================ */

  function readPattern() {
    store.savePattern({
      find: $('#patFind') ? $('#patFind').value : '',
      replace: $('#patReplace') ? $('#patReplace').value : '',
      mode: $('#patMode') ? $('#patMode').value : 'literal',
      caseSensitive: $('#optCase') ? $('#optCase').checked : false,
      wholeWord: $('#optWord') ? $('#optWord').checked : false,
      regexFlags: $('#patFlags') ? $('#patFlags').value : '',
      maxReplacements: $('#optMax') ? Number($('#optMax').value) || 0 : 0,
      fields: {
        title: $('#fldTitle') ? $('#fldTitle').checked : true,
        description: $('#fldDescription') ? $('#fldDescription').checked : false,
        tags: $('#fldTags') ? $('#fldTags').checked : false
      }
    });
    return store.state.pattern;
  }

  function writePatternToForm(p) {
    if ($('#patFind')) $('#patFind').value = p.find || '';
    if ($('#patReplace')) $('#patReplace').value = p.replace || '';
    if ($('#patMode')) $('#patMode').value = p.mode || 'literal';
    if ($('#optCase')) $('#optCase').checked = !!p.caseSensitive;
    if ($('#optWord')) $('#optWord').checked = !!p.wholeWord;
    if ($('#patFlags')) $('#patFlags').value = p.regexFlags || '';
    if ($('#optMax')) $('#optMax').value = p.maxReplacements || 0;
    if ($('#fldTitle')) $('#fldTitle').checked = p.fields.title !== false;
    if ($('#fldDescription')) $('#fldDescription').checked = !!p.fields.description;
    if ($('#fldTags')) $('#fldTags').checked = !!p.fields.tags;
    syncModeUI();
  }

  function syncModeUI() {
    var isRegex = ($('#patMode') && $('#patMode').value === 'regex');
    if ($('#regexOpts')) $('#regexOpts').classList.toggle('hidden', !isRegex);
    if ($('#optWord')) $('#optWord').disabled = isRegex;
    if ($('#patternHelp')) {
      $('#patternHelp').innerHTML = isRegex
        ? 'Regex mode: <code>$1</code> <code>$&amp;</code> <code>$`</code> <code>$\'</code> and <code>$&lt;name&gt;</code> work in the replacement. Flags <code>g</code> is always on; add <code>m</code>/<code>s</code>/<code>u</code> as needed.'
        : 'Literal mode: the text is matched exactly as typed, and <code>$</code> in the replacement stays literal.';
    }
  }

  function applyPreset(name) {
    var f = $('#patFind'), r = $('#patReplace'), m = $('#patMode');
    var cur = f.value;
    switch (name) {
      case 'prefix': m.value = 'literal'; f.value = ''; r.value = cur; $('#optWord').checked = false; break;
      case 'suffix': m.value = 'literal'; f.value = ''; r.value = cur; break;
      case 'strip-prefix': m.value = 'regex'; f.value = '^' + escapeForRegexInput(cur) + '\\s*'; r.value = ''; break;
      case 'strip-suffix': m.value = 'regex'; f.value = '\\s*' + escapeForRegexInput(cur) + '$'; r.value = ''; break;
      case 'trim': m.value = 'regex'; f.value = '^\\s+|\\s+$'; r.value = ''; break;
      case 'collapse': m.value = 'regex'; f.value = '[ \\t]{2,}'; r.value = ' '; break;
      case 'pipe-space': m.value = 'regex'; f.value = '\\s*\\|\\s*'; r.value = ' | '; break;
      case 'emoji-strip': m.value = 'regex'; f.value = '[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}]'; r.value = ''; $('#patFlags').value = 'u'; break;
      default: return;
    }
    if (name === 'prefix' || name === 'suffix') {
      /* prefix/suffix need an anchor regex; literal empty-find is a no-op */
      m.value = 'regex';
      $('#patFlags').value = '';
      if (name === 'prefix') { f.value = '^'; r.value = cur; }
      else { f.value = '$'; r.value = cur; }
      $('#optMax').value = 1;
    } else {
      $('#optMax').value = 0;
    }
    syncModeUI();
    refreshPreview();
  }

  function escapeForRegexInput(s) { return util.escapeRegExp(String(s || '')); }

  function renderQuickTest() {
    var out = $('#patTestOutput');
    if (!out) return;
    var p = readPattern();
    var sample = $('#patTestInput') ? $('#patTestInput').value : '';
    if (!sample) { out.innerHTML = '<span class="hint">Type a sample string to test the pattern.</span>'; return; }
    var r = T.applyToText(sample, p);
    if (r.error) { out.innerHTML = '<span class="status error">' + esc(r.error) + '</span>'; return; }
    out.innerHTML =
      '<div class="kv"><span>before</span><code>' + markSpans(sample, r.inSpans, 'cut') + '</code></div>' +
      '<div class="kv"><span>after</span><code>' + markSpans(r.text, r.outSpans, 'ins') + '</code></div>' +
      '<div class="kv"><span>matches</span><code>' + r.count + '</code></div>';
  }

  /* ============================ preview ============================ */

  /** Escape text and wrap the given spans in <mark class="cls">. */
  function markSpans(text, spans, cls) {
    var s = String(text == null ? '' : text);
    if (!spans || !spans.length) return esc(s);
    var sorted = spans.slice().sort(function (a, b) { return a.start - b.start; });
    var out = '', last = 0;
    sorted.forEach(function (sp) {
      if (sp.start < last) return;
      out += esc(s.slice(last, sp.start));
      out += '<mark class="' + cls + '">' + esc(s.slice(sp.start, sp.end)) + '</mark>';
      last = sp.end;
    });
    out += esc(s.slice(last));
    return out;
  }

  function textBlock(label, before, after, inSpans, outSpans) {
    return '<div class="fb">' +
      '<span class="flabel">' + esc(label) + '</span>' +
      '<div class="frow cut-row"><span class="ftag">before</span><span class="fval mono pre">' + (markSpans(before, inSpans, 'cut') || '<em class="empty">(empty)</em>') + '</span></div>' +
      '<div class="frow ins-row"><span class="ftag">after</span><span class="fval mono pre">' + (markSpans(after, outSpans, 'ins') || '<em class="empty">(empty)</em>') + '</span></div>' +
      '</div>';
  }

  function tagsBlock(before, after, per) {
    function chips(list, changedSet, cls) {
      if (!list.length) return '<em class="empty">(no tags)</em>';
      return list.map(function (t) {
        return '<span class="chip-tag ' + (changedSet[t] ? cls : '') + '">' + esc(t) + '</span>';
      }).join(' ');
    }
    var beforeChanged = {}, afterChanged = {};
    (per || []).forEach(function (p) { beforeChanged[p.before] = true; afterChanged[p.after] = true; });
    return '<div class="fb">' +
      '<span class="flabel">Tags</span>' +
      '<div class="frow cut-row"><span class="ftag">before</span><span class="fval">' + chips(before, beforeChanged, 'cut') + '</span></div>' +
      '<div class="frow ins-row"><span class="ftag">after</span><span class="fval">' + chips(after, afterChanged, 'ins') + '</span></div>' +
      '</div>';
  }

  function computePreview() {
    var p = readPattern();
    var vids = filteredVideos();
    var compiled = T.compilePattern(p);
    var patternError = compiled.ok ? null : compiled.error;
    var noFind = p.mode === 'literal' && !p.find;

    ui.preview = vids.map(function (v) {
      var edits = patternError ? { changes: {}, warnings: [], changed: false, blocked: false, matchCount: 0, error: patternError }
        : T.computeEdits(v, p);
      /* Only an explicit user action (checkbox / Select-* button) writes to the
         selection map. The "select everything that changed" default has to be
         recomputed on every render — persisting it pins rows to whatever they
         were first computed as, so a row that only BECOMES changed after you
         type a pattern would stay unselectable and Apply would stay disabled. */
      var explicit = Object.prototype.hasOwnProperty.call(store.state.selection, v.id);
      var selected = explicit ? !!store.state.selection[v.id] : (edits.changed && !edits.blocked);
      return { video: v, edits: edits, selected: selected };
    });

    if ($('#patError')) {
      $('#patError').textContent = patternError || '';
      $('#patError').className = patternError ? 'status error' : 'status';
    }
    return { patternError: patternError, noFind: noFind };
  }

  function visiblePreview() {
    var only = $('#chkChangedOnly') && $('#chkChangedOnly').checked;
    return ui.preview.filter(function (r) { return !only || r.edits.changed || r.edits.blocked; });
  }

  function refreshPreview() {
    var info = computePreview();
    renderPreviewSummary(info);
    renderPreviewTable();
    renderApplyButton();
  }

  function previewStats() {
    var rows = ui.preview;
    var changed = rows.filter(function (r) { return r.edits.changed; });
    var blocked = rows.filter(function (r) { return r.edits.blocked; });
    var selected = rows.filter(function (r) { return r.selected && r.edits.changed && !r.edits.blocked; });
    var matches = changed.reduce(function (a, r) { return a + r.edits.matchCount; }, 0);
    return { total: rows.length, changed: changed.length, blocked: blocked.length, selected: selected.length, matches: matches, selectedRows: selected };
  }

  function renderPreviewSummary(info) {
    var node = $('#previewSummary');
    if (!node) return;
    var s = previewStats();
    var cost = s.selected * 50;
    var remaining = store.quotaRemaining();
    node.innerHTML = '';

    node.appendChild(el('span', { class: 'badge', text: util.fmtNum(s.total) + ' in filter' }));
    node.appendChild(el('span', { class: 'badge ' + (s.changed ? 'ok' : ''), text: util.fmtNum(s.changed) + ' would change' }));
    node.appendChild(el('span', { class: 'badge', text: util.fmtNum(s.matches) + ' matches' }));
    node.appendChild(el('span', { class: 'badge ' + (s.selected ? 'primary' : ''), text: util.fmtNum(s.selected) + ' selected' }));
    if (s.blocked) node.appendChild(el('span', { class: 'badge danger', text: util.fmtNum(s.blocked) + ' blocked by validation' }));
    node.appendChild(el('span', { class: 'badge ' + (cost > remaining ? 'danger' : 'warn'), text: 'quota cost ' + util.fmtNum(cost) + ' units' }));
    node.appendChild(el('span', { class: 'hint', text: util.fmtNum(remaining) + ' units left today \u2192 ' + Math.floor(remaining / 50) + ' edits' }));

    if (info && info.patternError) {
      node.appendChild(el('div', { class: 'status error', text: info.patternError }));
    } else if (info && info.noFind) {
      node.appendChild(el('div', { class: 'status warn', text: 'Find is empty in literal mode \u2014 nothing will match. Use a regex preset (^ or $) to add a prefix/suffix.' }));
    } else if (cost > remaining) {
      node.appendChild(el('div', { class: 'status error', text: 'This batch needs ' + util.fmtNum(cost) + ' units but only ' + util.fmtNum(remaining) + ' remain today. Select at most ' + Math.floor(remaining / 50) + ' videos, or wait for the Pacific-midnight reset.' }));
    }
  }

  function renderPreviewTable() {
    var body = $('#previewBody');
    if (!body) return;
    var rows = visiblePreview();
    var pageSize = Number(store.state.settings.pageSize) || 50;
    var pages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (ui.page >= pages) ui.page = 0;
    var slice = rows.slice(ui.page * pageSize, ui.page * pageSize + pageSize);

    body.innerHTML = '';
    if (!slice.length) {
      /* Three genuinely different situations — do not blame the wrong control. */
      var msg;
      if (!store.state.videos.length) msg = 'Load videos (or click "Load demo data") to begin.';
      else if (!ui.preview.length) msg = 'No videos match the current filter.';
      else msg = 'Nothing to show — no loaded video is changed by this pattern. Untick "Show changed rows only" to see them all.';
      body.appendChild(el('tr', {}, [el('td', { colspan: '4', class: 'empty-row', text: msg })]));
    }

    var frag = document.createDocumentFragment();
    slice.forEach(function (r) { frag.appendChild(renderRow(r)); });
    body.appendChild(frag);

    var info = $('#pgInfo');
    if (info) info.textContent = rows.length ? ('Page ' + (ui.page + 1) + ' / ' + pages + ' \u00b7 showing ' + slice.length + ' of ' + util.fmtNum(rows.length)) : '';
    if ($('#pgPrev')) $('#pgPrev').disabled = ui.page === 0;
    if ($('#pgNext')) $('#pgNext').disabled = ui.page >= pages - 1;
  }

  function renderRow(r) {
    var v = r.video, e = r.edits;
    var sn = v.snippet || {}, st = v.status || {};
    var thumb = sn.thumbnails && sn.thumbnails.default ? sn.thumbnails.default.url : null;

    var meta = el('div', { class: 'vid-meta' }, [
      el('code', { class: 'vid-id', text: v.id }),
      el('span', { text: util.fmtDate(sn.publishedAt) }),
      el('span', { class: 'badge sm ' + (st.privacyStatus === 'public' ? 'ok' : 'warn'), text: st.privacyStatus || '?' }),
      el('span', { text: util.fmtNum(Number((v.statistics || {}).viewCount || 0)) + ' views' }),
      el('span', { text: categoryName(sn.categoryId) })
    ]);

    var main = el('div', { class: 'vid-main' }, [meta]);
    var blocks = '';
    var ch = e.changes || {};
    if (ch.title) blocks += textBlock('Title', ch.title.before, ch.title.after, ch.title.inSpans, ch.title.outSpans);
    if (ch.description && ch.description.changed) blocks += textBlock('Description', ch.description.before, ch.description.after, ch.description.inSpans, ch.description.outSpans);
    if (ch.tags && ch.tags.changed) blocks += tagsBlock(ch.tags.before, ch.tags.after, ch.tags.per);
    if (!blocks) blocks = '<div class="fb"><span class="flabel">No change</span><div class="frow"><span class="fval mono pre">' + esc(sn.title || '') + '</span></div></div>';

    var blocksWrap = el('div', { class: 'blocks', html: blocks });
    main.appendChild(blocksWrap);

    if (e.warnings && e.warnings.length) {
      var w = el('div', { class: 'warnings' });
      e.warnings.forEach(function (x) { w.appendChild(el('div', { class: 'warn-line ' + x.level, text: (x.level === 'error' ? '\u2716 ' : '\u26a0 ') + x.msg })); });
      main.appendChild(w);
    }
    if (e.error) main.appendChild(el('div', { class: 'warn-line error', text: '\u2716 ' + e.error }));

    var canSelect = e.changed && !e.blocked;
    var check = el('input', { type: 'checkbox', class: 'rowCheck', 'data-id': v.id });
    check.checked = !!r.selected && canSelect;
    check.disabled = !canSelect;
    check.addEventListener('change', function () {
      store.state.selection[v.id] = check.checked;
      r.selected = check.checked;
      renderPreviewSummary();
      renderApplyButton();
    });

    var stateBadge = e.blocked ? el('span', { class: 'badge danger', text: 'blocked' })
      : e.changed ? el('span', { class: 'badge ok', text: e.matchCount + ' change' + (e.matchCount === 1 ? '' : 's') })
        : el('span', { class: 'badge', text: 'unchanged' });

    var row = el('tr', { class: 'prow' + (e.changed ? ' changed' : '') + (e.blocked ? ' blocked' : ''), 'data-id': v.id }, [
      el('td', { class: 'col-check' }, [check]),
      el('td', { class: 'col-thumb' }, [thumb ? el('img', { src: thumb, alt: '', loading: 'lazy' }) : el('div', { class: 'thumb-ph', text: '\u25b6' })]),
      el('td', { class: 'col-main' }, [main]),
      el('td', { class: 'col-state' }, [stateBadge])
    ]);
    return row;
  }

  function setSelection(mode) {
    var rows = visiblePreview();
    rows.forEach(function (r) {
      var can = r.edits.changed && !r.edits.blocked;
      var val = mode === 'all' ? can : mode === 'none' ? false : mode === 'changed' ? can : (!r.selected && can);
      r.selected = val;
      store.state.selection[r.video.id] = val;
    });
    renderPreviewTable();
    renderPreviewSummary();
    renderApplyButton();
  }

  /* ============================ apply ============================ */

  function renderApplyButton() {
    var s = previewStats();
    var btn = $('#btnApply');
    if (!btn) return;
    btn.textContent = s.selected ? ('Apply to ' + util.fmtNum(s.selected) + ' video' + (s.selected === 1 ? '' : 's')) : 'Apply changes';
    btn.disabled = !s.selected || ui.running || !canWrite();
    var hint = $('#applyHint');
    if (hint) {
      if (store.state.demo) hint.textContent = 'Demo mode: applying is simulated, nothing is sent to YouTube.';
      else if (!store.state.auth) hint.textContent = 'Connect an account to apply changes.';
      else if (!s.selected) hint.textContent = 'Select at least one changed row.';
      else hint.textContent = 'Costs ' + util.fmtNum(s.selected * 50) + ' quota units (' + util.fmtNum(s.selected) + ' \u00d7 50).';
    }
  }

  function canWrite() { return store.state.demo || !!store.state.auth; }

  async function applyEdits() {
    if (ui.running) return;
    var s = previewStats();
    if (!s.selected) { toast('Nothing selected.', 'error'); return; }

    var cost = s.selected * 50;
    var remaining = store.quotaRemaining();
    if (!store.state.demo && cost > remaining) {
      toast('Not enough quota: need ' + util.fmtNum(cost) + ', have ' + util.fmtNum(remaining) + '.', 'error', 9000);
      return;
    }

    var fieldNames = Object.keys(store.state.pattern.fields).filter(function (k) { return store.state.pattern.fields[k]; });
    var body =
      '<p>You are about to <strong>permanently change ' + util.plural(s.selected, 'video') + '</strong> on ' +
      esc((store.state.channel && store.state.channel.title) || 'your channel') + '.</p>' +
      '<ul>' +
      '<li>Fields touched: <strong>' + esc(fieldNames.join(', ')) + '</strong></li>' +
      '<li>Total replacements: <strong>' + util.fmtNum(s.matches) + '</strong></li>' +
      '<li>Quota cost: <strong>' + util.fmtNum(cost) + ' units</strong> (' + Math.floor(remaining / 50) + ' edits would remain today)</li>' +
      '<li>A rollback snapshot of every original title/description/tag list is stored before each write, and a backup file is downloaded.</li>' +
      '</ul>' +
      (store.state.demo ? '<p class="ok">Demo mode \u2014 no real API calls will be made.</p>' : '<p>This cannot be undone by YouTube; it can only be undone by this tool\'s rollback.</p>');

    var ok = await confirmModal({ title: 'Apply ' + util.fmtNum(s.selected) + ' edits?', body: body, okText: 'Apply now', danger: true, requireText: s.selected >= 25 ? 'APPLY' : null });
    if (!ok) return;

    ui.running = true;
    ui.stopRequested = false;
    ui.abort = new AbortController();
    var batch = store.startBatch({
      label: findReplaceLabel(),
      pattern: store.state.pattern,
      fields: fieldNames,
      planned: s.selected
    });

    /* Always produce a restorable backup file before touching anything. */
    try { store.exportBackup(); } catch (e) { /* download blocked; log still holds it */ }

    var rows = s.selectedRows;
    var logBox = $('#applyLog');
    if (logBox) logBox.innerHTML = '';
    var done = 0, okCount = 0, failCount = 0;
    var delay = Number(store.state.settings.delayMs) || 0;
    var stopOnError = !!store.state.settings.stopOnError;

    for (var i = 0; i < rows.length; i++) {
      if (ui.stopRequested) { appendApplyLog('Stopped by user after ' + done + ' of ' + rows.length + '.', 'warn'); break; }
      var r = rows[i];
      var v = r.video, e = r.edits;
      setProgress(done, rows.length, 'Writing ' + (i + 1) + ' / ' + rows.length + ': ' + util.truncate(e.changes.title ? e.changes.title.after : v.snippet.title, 60));

      var before = { snippet: util.deepClone(v.snippet), status: util.deepClone(v.status) };
      var bodyJson = T.buildUpdateBody(v, e, { defaultCategoryId: store.state.settings.defaultCategoryId });
      var parts = T.updateParts({});

      try {
        if (store.state.demo) {
          await util.sleep(120); /* simulate latency so the progress UI is exercised */
        } else {
          var token = await auth.ensureToken();
          await api.updateVideo({ token: token, body: bodyJson, parts: parts, signal: ui.abort.signal, retries: store.state.settings.maxRetries,
            onBackoff: function (ms, n) { setProgress(done, rows.length, 'Rate limited \u2014 retry ' + n + ' in ' + Math.round(ms / 1000) + 's\u2026'); } });
        }
        store.addEntry({
          batchId: batch.id, videoId: v.id, videoTitle: v.snippet.title,
          thumb: (v.snippet.thumbnails && v.snippet.thumbnails.default && v.snippet.thumbnails.default.url) || '',
          fields: fieldNames, before: before, after: { snippet: bodyJson.snippet }, result: 'applied'
        });
        /* keep the in-memory copy in sync so a second pass sees fresh data */
        v.snippet = Object.assign({}, v.snippet, bodyJson.snippet);
        okCount++;
        appendApplyLog('\u2713 ' + util.truncate(bodyJson.snippet.title, 70), 'ok');
      } catch (err) {
        failCount++;
        store.addEntry({ batchId: batch.id, videoId: v.id, videoTitle: v.snippet.title, fields: fieldNames, before: before, after: { snippet: bodyJson.snippet }, result: 'failed', error: err.message });
        appendApplyLog('\u2716 ' + util.truncate(v.snippet.title, 50) + ' \u2014 ' + err.message, 'error');
        if (err.quota) { appendApplyLog('Daily quota exhausted \u2014 aborting the rest of the batch.', 'error'); toast('YouTube daily quota exhausted.', 'error', 10000); break; }
        if (err.needsAuth) { appendApplyLog('Authentication failed \u2014 aborting. Reconnect and re-run to continue.', 'error'); toast('Auth failed: ' + err.message, 'error', 10000); break; }
        if (err.aborted) { appendApplyLog('Cancelled.', 'warn'); break; }
        if (stopOnError) { appendApplyLog('Stopping because "stop on first error" is enabled.', 'warn'); break; }
      }
      done++;
      setProgress(done, rows.length, '');
      renderQuota();
      if (delay && i < rows.length - 1) await util.sleep(delay);
    }

    store.finishBatch(batch.id);
    setProgress(rows.length, rows.length, 'Finished: ' + okCount + ' updated, ' + failCount + ' failed.');
    toast('Batch complete: ' + okCount + ' updated, ' + failCount + ' failed.', failCount ? 'warn' : 'ok', 8000);
    ui.running = false;
    ui.abort = null;
    renderHistory();
    renderStorage();
    /* Drop explicit choices so the next pattern starts from a clean
       "everything that changed is selected" default. */
    store.state.selection = {};
    /* Recompute from the (now updated) in-memory videos — re-rendering the old
     * preview would leave the pre-edit values on screen. */
    refreshPreview();
  }

  function findReplaceLabel() {
    var p = store.state.pattern;
    var fields = Object.keys(p.fields).filter(function (k) { return p.fields[k]; }).join('+');
    return (p.mode === 'regex' ? '/' + p.find + '/' : '"' + p.find + '"') + ' \u2192 "' + p.replace + '" [' + fields + ']';
  }

  function setProgress(done, total, msg) {
    var pct = total ? Math.round(done / total * 100) : 0;
    var bar = $('#applyBarFill');
    if (bar) bar.style.width = pct + '%';
    var txt = $('#applyProgress');
    if (txt) txt.textContent = (msg || '') + (total ? '  [' + done + '/' + total + ' \u00b7 ' + pct + '%]' : '');
    var stop = $('#btnStop');
    if (stop) stop.disabled = !ui.running;
  }

  function appendApplyLog(text, kind) {
    var box = $('#applyLog');
    if (!box) return;
    box.appendChild(el('div', { class: 'log-line ' + (kind || ''), text: text }));
    box.scrollTop = box.scrollHeight;
  }

  function stopApply() {
    ui.stopRequested = true;
    toast('Stopping after the current video\u2026', 'warn');
  }

  /* ============================ rollback ============================ */

  function renderHistory() {
    var box = $('#batchList');
    if (!box) return;
    box.innerHTML = '';
    var batches = store.state.batches || [];
    if (!batches.length) {
      box.appendChild(el('div', { class: 'hint', text: 'No changes applied yet. Every batch you apply appears here with a one-click restore.' }));
      return;
    }
    batches.forEach(function (b) {
      var entries = store.entriesForBatch(b.id);
      var restorable = entries.filter(function (e) { return e.result === 'applied' && !e.restoredAt; });
      var card = el('div', { class: 'batch' + (b.restoredAt ? ' restored' : '') });
      card.appendChild(el('div', { class: 'batch-head' }, [
        el('strong', { text: util.fmtDate(b.ts, true) }),
        el('span', { class: 'badge', text: util.plural(b.applied || 0, 'applied') }),
        b.failed ? el('span', { class: 'badge danger', text: b.failed + ' failed' }) : null,
        b.restoredAt ? el('span', { class: 'badge ok', text: 'restored ' + util.fmtDate(b.restoredAt, true) }) : null,
        el('span', { class: 'hint', text: b.label || '' })
      ]));
      var actions = el('div', { class: 'batch-actions' });
      var restoreBtn = el('button', { class: 'btn danger sm', text: 'Restore ' + restorable.length + ' video' + (restorable.length === 1 ? '' : 's') });
      restoreBtn.disabled = !restorable.length || ui.running || !canWrite();
      restoreBtn.addEventListener('click', function () { restoreEntries(restorable, 'Restore batch from ' + util.fmtDate(b.ts, true) + '?'); });
      actions.appendChild(restoreBtn);
      actions.appendChild(el('button', { class: 'btn sm', text: 'Details', onclick: function () { toggleDetails(card, entries); } }));
      actions.appendChild(el('button', { class: 'btn sm', text: 'Delete record', onclick: async function () {
        if (await confirmModal({ title: 'Delete this history record?', body: '<p>This removes the rollback snapshot for ' + util.plural(entries.length, 'video') + '. It does <strong>not</strong> change anything on YouTube, but you will no longer be able to restore this batch from the tool.</p>', okText: 'Delete record', danger: true })) {
          store.pruneBatch(b.id); renderHistory(); renderStorage();
        }
      } }));
      card.appendChild(actions);
      box.appendChild(card);
    });
  }

  function toggleDetails(card, entries) {
    var existing = card.querySelector('.batch-details');
    if (existing) { existing.remove(); return; }
    var wrap = el('div', { class: 'batch-details' });
    entries.slice(0, 200).forEach(function (e) {
      var line = el('div', { class: 'detail-line ' + (e.result === 'applied' ? 'ok' : 'error') + (e.restoredAt ? ' restored' : '') });
      var tBefore = (e.before && e.before.snippet && e.before.snippet.title) || '';
      var tAfter = (e.after && e.after.snippet && e.after.snippet.title) || '';
      line.appendChild(el('code', { class: 'vid-id', text: e.videoId }));
      line.appendChild(el('span', { class: 'mono', text: tBefore === tAfter ? util.truncate(tBefore, 60) : (util.truncate(tBefore, 40) + '  \u2192  ' + util.truncate(tAfter, 40)) }));
      if (e.result !== 'applied') line.appendChild(el('span', { class: 'badge danger', text: 'failed' }));
      if (e.restoredAt) line.appendChild(el('span', { class: 'badge ok', text: 'restored' }));
      if (e.restoreError) line.appendChild(el('span', { class: 'badge danger', text: 'restore failed' }));
      var oneBtn = el('button', { class: 'btn sm', text: 'Restore this', onclick: function () { restoreEntries([e], 'Restore this single video?'); } });
      oneBtn.disabled = !(e.result === 'applied' && !e.restoredAt) || ui.running || !canWrite();
      line.appendChild(oneBtn);
      wrap.appendChild(line);
    });
    if (entries.length > 200) wrap.appendChild(el('div', { class: 'hint', text: 'Showing first 200 of ' + entries.length }));
    card.appendChild(wrap);
  }

  async function restoreEntries(entries, title) {
    if (!entries.length) return;
    var cost = entries.length * 50;
    var remaining = store.quotaRemaining();
    var body = '<p>This writes the <strong>stored original</strong> metadata back to ' + util.plural(entries.length, 'video') + '.</p>' +
      '<ul><li>Restores: title, description, tags (and privacy if it was part of the change)</li>' +
      '<li>Quota cost: <strong>' + util.fmtNum(cost) + ' units</strong> (' + Math.floor(Math.max(0, remaining - cost) / 50) + ' edits would remain today)</li></ul>' +
      (cost > remaining ? '<p class="error">Not enough quota left today for a full restore.</p>' : '');

    var ok = await confirmModal({ title: title || 'Restore previous values?', body: body, okText: 'Restore', danger: true });
    if (!ok) return;

    ui.running = true;
    var batch = store.startBatch({ label: 'ROLLBACK of ' + util.plural(entries.length, 'video'), pattern: {}, fields: ['restore'], planned: entries.length });
    var done = 0, okCount = 0, failCount = 0;
    var delay = Number(store.state.settings.delayMs) || 0;

    for (var i = 0; i < entries.length; i++) {
      if (ui.stopRequested) break;
      var e = entries[i];
      setProgress(done, entries.length, 'Restoring ' + (i + 1) + ' / ' + entries.length + ': ' + util.truncate(e.videoTitle, 50));
      var rb = T.buildRestoreBody(e);
      var parts = T.restoreParts(e);
      try {
        if (store.state.demo) { await util.sleep(100); }
        else {
          var token = await auth.ensureToken();
          await api.updateVideo({ token: token, body: rb, parts: parts, signal: null, retries: store.state.settings.maxRetries });
        }
        store.markRestored([e.id]);
        store.addEntry({ batchId: batch.id, kind: 'restore', videoId: e.videoId, videoTitle: e.videoTitle, fields: ['restore'], before: { snippet: util.deepClone(e.after && e.after.snippet) }, after: { snippet: rb.snippet }, result: 'applied' });
        /* Keep the loaded copy in sync so the preview reflects what YouTube now holds. */
        var live = store.state.videos.filter(function (x) { return x.id === e.videoId; })[0];
        if (live && rb.snippet) live.snippet = Object.assign({}, live.snippet, rb.snippet);
        okCount++;
        appendApplyLog('\u21ba restored ' + util.truncate(e.videoTitle, 60), 'ok');
      } catch (err) {
        failCount++;
        store.markRestoreFailed(e.id, err.message);
        appendApplyLog('\u2716 restore failed for ' + e.videoId + ' \u2014 ' + err.message, 'error');
        if (err.quota || err.needsAuth) break;
      }
      done++;
      setProgress(done, entries.length, '');
      renderQuota();
      if (delay && i < entries.length - 1) await util.sleep(delay);
    }

    store.finishBatch(batch.id);
    var srcBatchIds = {};
    entries.forEach(function (x) { srcBatchIds[x.batchId] = true; });
    Object.keys(srcBatchIds).forEach(function (bid) {
      var b = store.state.batches.filter(function (x) { return x.id === bid; })[0];
      if (b && !store.entriesForBatch(bid, true).length) b.restoredAt = new Date().toISOString();
    });
    store.saveLog();

    setProgress(entries.length, entries.length, 'Restore finished: ' + okCount + ' restored, ' + failCount + ' failed.');
    toast('Restore complete: ' + okCount + ' restored, ' + failCount + ' failed.', failCount ? 'warn' : 'ok', 8000);
    ui.running = false;
    renderHistory();
    renderStorage();
    renderQuota();
    store.state.selection = {};
    refreshPreview();
  }

  /* ============================ init ============================ */

  function bind(id, evt, fn) { var n = $(id); if (n) n.addEventListener(evt, fn); }
  var debouncedPreview = util.debounce(function () { ui.page = 0; refreshPreview(); renderQuickTest(); }, 220);

  function init() {
    if (!$('#app')) return;
    store.init();

    /* settings -> form */
    var st = store.state.settings;
    if ($('#inpHelperUrl')) $('#inpHelperUrl').value = st.helperUrl;
    if ($('#inpDailyQuota')) $('#inpDailyQuota').value = st.dailyQuota;
    if ($('#inpDelay')) $('#inpDelay').value = st.delayMs;
    if ($('#chkStopOnError')) $('#chkStopOnError').checked = !!st.stopOnError;
    if ($('#chkRememberTokens')) $('#chkRememberTokens').checked = st.rememberTokens !== false;

    writePatternToForm(store.state.pattern);
    var oc = auth.loadOAuthClient();
    if (oc) {
      if ($('#inpClientId')) $('#inpClientId').value = oc.clientId || '';
      if ($('#inpRedirect')) $('#inpRedirect').value = oc.redirectUri || auth.LOOPBACK_REDIRECT;
      if ($('#chkRememberClient')) $('#chkRememberClient').checked = true;
    } else if ($('#inpRedirect')) {
      $('#inpRedirect').value = auth.LOOPBACK_REDIRECT;
    }
    if ($('#lnkPlayground')) $('#lnkPlayground').href = auth.PLAYGROUND_URL;

    /* tabs */
    util.$$('#authTabs .tab').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.mode); });
    });

    bind('#btnHelperSignin', 'click', doHelperSignIn);
    bind('#btnSaveHelperConfig', 'click', saveHelperConfig);
    bind('#btnUseToken', 'click', doPasteToken);
    bind('#btnStartCode', 'click', doStartCode);
    bind('#btnFinishCode', 'click', doFinishCode);
    bind('#btnSignout', 'click', async function () {
      if (await confirmModal({ title: 'Sign out?', body: '<p>Removes the stored tokens from this browser. Videos you already edited are <strong>not</strong> affected, and your rollback history stays.</p>', okText: 'Sign out', danger: true })) {
        await auth.signOut();
        renderAuthState(); renderChannel();
        setStatus('#authStatus', 'Signed out.');
        toast('Signed out.', 'ok');
      }
    });

    bind('#btnDemo', 'click', function () {
      YTBE.demo.loadDemo();
      renderChannel(); renderLoadSummary(); refreshPreview(); renderAuthState();
      toast('Loaded 12 sample videos. Applying changes is simulated in demo mode.', 'ok', 6000);
    });

    bind('#btnLoad', 'click', loadVideos);
    bind('#btnClearFilters', 'click', function () {
      ['#fltText', '#fltFrom', '#fltTo', '#fltIds'].forEach(function (s) { if ($(s)) $(s).value = ''; });
      if ($('#fltPrivacy')) $('#fltPrivacy').value = '';
      if ($('#fltField')) $('#fltField').value = 'title';
      if ($('#chkFltUnedited')) $('#chkFltUnedited').checked = false;
      ui.page = 0; refreshPreview();
    });

    ['#fltText', '#fltFrom', '#fltTo', '#fltIds', '#fltPrivacy', '#fltField'].forEach(function (s) { bind(s, 'input', debouncedPreview); bind(s, 'change', debouncedPreview); });
    bind('#chkFltUnedited', 'change', debouncedPreview);
    bind('#chkFltRegex', 'change', debouncedPreview);
    bind('#chkFltCase', 'change', debouncedPreview);

    ['#patFind', '#patReplace', '#patFlags', '#optMax'].forEach(function (s) { bind(s, 'input', debouncedPreview); });
    ['#optCase', '#optWord', '#fldTitle', '#fldDescription', '#fldTags'].forEach(function (s) { bind(s, 'change', debouncedPreview); });
    bind('#patMode', 'change', function () { syncModeUI(); debouncedPreview(); });
    bind('#patTestInput', 'input', renderQuickTest);
    bind('#btnResetPattern', 'click', function () { writePatternToForm(store.resetPattern()); ui.page = 0; refreshPreview(); renderQuickTest(); });

    util.$$('#presets .btn').forEach(function (b) {
      b.addEventListener('click', function () { applyPreset(b.dataset.preset); });
    });

    bind('#btnSelectAll', 'click', function () { setSelection('all'); });
    bind('#btnSelectNone', 'click', function () { setSelection('none'); });
    bind('#btnSelectChanged', 'click', function () { setSelection('changed'); });
    bind('#btnInvert', 'click', function () { setSelection('invert'); });
    bind('#chkChangedOnly', 'change', function () { ui.page = 0; renderPreviewTable(); });
    bind('#pgPrev', 'click', function () { if (ui.page > 0) { ui.page--; renderPreviewTable(); } });
    bind('#pgNext', 'click', function () { ui.page++; renderPreviewTable(); });

    bind('#inpDelay', 'input', function () { store.saveSettings({ delayMs: Math.max(0, Number($('#inpDelay').value) || 0) }); });
    bind('#chkStopOnError', 'change', function () { store.saveSettings({ stopOnError: $('#chkStopOnError').checked }); });
    bind('#inpDailyQuota', 'input', function () { store.saveSettings({ dailyQuota: Math.max(50, Number($('#inpDailyQuota').value) || 10000) }); renderQuota(); refreshPreview(); });
    bind('#inpHelperUrl', 'input', util.debounce(function () { store.saveSettings({ helperUrl: $('#inpHelperUrl').value.trim() || 'http://localhost:8787' }); refreshHelperStatus(); }, 500));
    bind('#chkRememberTokens', 'change', function () { store.saveSettings({ rememberTokens: $('#chkRememberTokens').checked }); });

    bind('#btnApply', 'click', applyEdits);
    bind('#btnStop', 'click', stopApply);
    bind('#btnExportBackup', 'click', function () { toast('Saved ' + store.exportBackup(), 'ok'); });
    bind('#btnImportBackup', 'click', function () { $('#fileImport').click(); });
    bind('#fileImport', 'change', async function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      try {
        var text = await util.readTextFile(f);
        var r = store.importBackup(text);
        if (!r.ok) toast(r.error, 'error', 8000);
        else toast('Imported ' + util.plural(r.added, 'change record') + ' from ' + util.plural(r.addedBatches, 'batch') + '.', 'ok', 7000);
        renderHistory(); renderStorage(); refreshPreview();
      } catch (e) { toast('Import failed: ' + e.message, 'error', 8000); }
      ev.target.value = '';
    });
    bind('#btnPruneRestored', 'click', async function () {
      if (await confirmModal({ title: 'Prune restored records?', body: '<p>Deletes rollback records that have already been restored or that failed. Frees browser storage. Applied-but-not-restored records are kept.</p>', okText: 'Prune', danger: true })) {
        var n = store.pruneRestored();
        toast('Pruned ' + util.plural(n, 'record') + '.', 'ok');
        renderHistory(); renderStorage();
      }
    });

    store.on('quota', renderQuota);
    store.on('storage', renderStorage);
    store.on('log', function () { /* history re-rendered explicitly after batches */ });

    renderChannel();
    renderQuota();
    renderStorage();
    renderAuthState();
    renderHistory();
    renderLoadSummary();
    refreshPreview();
    renderQuickTest();
    switchTab(store.state.auth ? store.state.auth.mode : 'helper');

    /* Resume a previous session if we still hold a token. */
    if (store.state.auth && !store.state.demo) {
      setStatus('#authStatus', 'Restoring previous session\u2026');
      afterAuth();
    }
  }

  YTBE.ui = {
    init: init, refreshPreview: refreshPreview, computePreview: computePreview,
    markSpans: markSpans, previewStats: previewStats, filteredVideos: filteredVideos,
    readPattern: readPattern, applyEdits: applyEdits, restoreEntries: restoreEntries,
    toast: toast, confirmModal: confirmModal, state: ui, renderHistory: renderHistory,
    videoHaystack: videoHaystack
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);

/* yt-bulk-edits :: store.js — persistence: settings, auth, change log, quota.
 *
 * The change log is the rollback mechanism. Every applied write stores the FULL
 * original snippet + status of that video, because videos.update deletes any
 * property you omit — a partial snapshot could not restore losslessly.
 *
 * Storage policy: on localStorage overflow we never silently drop rollback data.
 * We flag storageFull and tell the user to export + prune.
 */
(function (global) {
  'use strict';

  var YTBE = global.YTBE = global.YTBE || {};
  var util = YTBE.util;
  var P = 'ytbe.v1.';

  var DEFAULT_SETTINGS = {
    delayMs: 400,
    stopOnError: false,
    maxRetries: 3,
    dailyQuota: 10000,
    pageLimit: 50,
    helperUrl: 'http://localhost:8787',
    defaultCategoryId: '22',
    rememberTokens: true,
    pageSize: 50
  };

  var DEFAULT_PATTERN = {
    find: '',
    replace: '',
    mode: 'literal',
    caseSensitive: false,
    wholeWord: false,
    regexFlags: '',
    maxReplacements: 0,
    fields: { title: true, description: false, tags: false }
  };

  var state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    pattern: util.deepClone(DEFAULT_PATTERN),
    auth: null,
    channel: null,
    videos: [],
    videosLoadedAt: null,
    selection: {},
    filters: { text: '', field: 'title', privacy: '', from: '', to: '', ids: '', uneditedOnly: false, caseSensitive: false, regex: false },
    batches: [],
    log: [],
    quota: { day: '', units: 0 },
    storageFull: false,
    demo: false
  };

  /* ---------- low-level persistence ---------- */

  function read(key, fallback) {
    try {
      var raw = global.localStorage.getItem(P + key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function write(key, value) {
    try {
      global.localStorage.setItem(P + key, JSON.stringify(value));
      if (state.storageFull) { state.storageFull = false; emit('storage'); }
      return true;
    } catch (e) {
      state.storageFull = true;
      emit('storage');
      return false;
    }
  }

  function remove(key) { try { global.localStorage.removeItem(P + key); } catch (e) { /* ignore */ } }

  function storageBytes() {
    var total = 0;
    try {
      for (var i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (k && k.indexOf(P) === 0) total += k.length + String(global.localStorage.getItem(k) || '').length;
      }
    } catch (e) { return -1; }
    return total * 2; /* UTF-16 */
  }

  /* ---------- events ---------- */

  var listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return function () { off(evt, fn); }; }
  function off(evt, fn) { var a = listeners[evt] || []; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  function emit(evt, payload) { (listeners[evt] || []).forEach(function (fn) { try { fn(payload); } catch (e) { console.error('[ytbe] listener error', e); } }); }

  /* ---------- quota ledger (resets at YouTube's midnight Pacific) ---------- */

  function ptDay(d) {
    d = d || new Date();
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch (e) {
      var p = function (x) { return String(x).padStart(2, '0'); };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
  }

  function rollQuotaDay() {
    var today = ptDay();
    if (state.quota.day !== today) { state.quota = { day: today, units: 0 }; write('quota', state.quota); }
    return state.quota;
  }

  function spendQuota(units, kind) {
    rollQuotaDay();
    state.quota.units += units;
    write('quota', state.quota);
    emit('quota', { units: units, kind: kind, total: state.quota.units });
    return state.quota.units;
  }

  function quotaRemaining() {
    rollQuotaDay();
    return Math.max(0, (Number(state.settings.dailyQuota) || QUOTA_DAILY) - state.quota.units);
  }
  var QUOTA_DAILY = 10000;

  /* ---------- settings ---------- */

  function loadSettings() {
    var s = read('settings', null);
    if (s && typeof s === 'object') state.settings = Object.assign({}, DEFAULT_SETTINGS, s);
    return state.settings;
  }
  function saveSettings(patch) {
    if (patch) state.settings = Object.assign({}, state.settings, patch);
    write('settings', state.settings);
    return state.settings;
  }

  function loadPattern() {
    var p = read('pattern', null);
    if (p && typeof p === 'object') {
      state.pattern = Object.assign(util.deepClone(DEFAULT_PATTERN), p);
      state.pattern.fields = Object.assign({ title: true, description: false, tags: false }, p.fields || {});
    }
    return state.pattern;
  }
  function savePattern(patch) {
    if (patch) {
      if (patch.fields) state.pattern.fields = Object.assign({}, state.pattern.fields, patch.fields);
      Object.keys(patch).forEach(function (k) { if (k !== 'fields') state.pattern[k] = patch[k]; });
    }
    write('pattern', state.pattern);
    return state.pattern;
  }
  function resetPattern() { state.pattern = util.deepClone(DEFAULT_PATTERN); write('pattern', state.pattern); return state.pattern; }

  /* ---------- auth ---------- */

  function loadAuth() {
    if (!state.settings.rememberTokens) return null;
    var a = read('auth', null);
    state.auth = a && a.accessToken ? a : null;
    return state.auth;
  }
  function saveAuth(auth) {
    state.auth = auth;
    if (!auth) { remove('auth'); return null; }
    if (!state.settings.rememberTokens) { remove('auth'); return auth; }
    /* Never persist a pasted secret to disk-backed storage. */
    var copy = Object.assign({}, auth);
    delete copy.clientSecret;
    write('auth', copy);
    return auth;
  }
  function clearAuth() { state.auth = null; state.channel = null; remove('auth'); emit('auth', null); }

  function authExpired() {
    var a = state.auth;
    if (!a || !a.accessToken) return true;
    if (!a.expiresAt) return false; /* pasted token: unknown expiry, assume valid */
    return Date.now() > (a.expiresAt - 60000);
  }

  /* ---------- change log ---------- */

  function loadLog() {
    state.batches = read('batches', []) || [];
    state.log = read('log', []) || [];
    return { batches: state.batches, log: state.log };
  }

  function saveLog() {
    var okB = write('batches', state.batches);
    var okL = write('log', state.log);
    emit('log', { count: state.log.length });
    return okB && okL;
  }

  function startBatch(meta) {
    var batch = {
      id: util.randomId('b'),
      ts: new Date().toISOString(),
      label: meta.label || '',
      pattern: util.deepClone(meta.pattern || {}),
      fields: (meta.fields || []).slice(),
      planned: meta.planned || 0,
      applied: 0,
      failed: 0,
      restoredAt: null
    };
    state.batches.unshift(batch);
    saveLog();
    return batch;
  }

  function finishBatch(batchId) {
    var b = state.batches.filter(function (x) { return x.id === batchId; })[0];
    if (b) { b.finishedAt = new Date().toISOString(); saveLog(); }
    return b;
  }

  /**
   * Record one applied (or failed) write.
   * `before` must be the full original {snippet, status} so restore is lossless.
   */
  function addEntry(entry) {
    var rec = {
      id: util.randomId('e'),
      batchId: entry.batchId,
      kind: entry.kind || 'edit',
      ts: new Date().toISOString(),
      videoId: entry.videoId,
      videoTitle: entry.videoTitle || '',
      thumb: entry.thumb || '',
      fields: (entry.fields || []).slice(),
      before: entry.before || null,
      after: entry.after || null,
      result: entry.result || 'applied',
      error: entry.error || null,
      restoredAt: null
    };
    state.log.unshift(rec);
    var b = state.batches.filter(function (x) { return x.id === rec.batchId; })[0];
    if (b) { if (rec.result === 'applied') b.applied++; else b.failed++; }
    saveLog();
    return rec;
  }

  function markRestored(entryIds) {
    var now = new Date().toISOString();
    var n = 0;
    state.log.forEach(function (e) {
      if (entryIds.indexOf(e.id) !== -1 && e.result === 'applied' && !e.restoredAt) { e.restoredAt = now; e.restoreError = null; n++; }
    });
    saveLog();
    return n;
  }

  function markRestoreFailed(entryId, msg) {
    state.log.forEach(function (e) { if (e.id === entryId) { e.restoreError = String(msg || 'failed'); } });
    saveLog();
  }

  function entriesForBatch(batchId, onlyRestorable) {
    return state.log.filter(function (e) {
      return e.batchId === batchId && (!onlyRestorable || (e.result === 'applied' && !e.restoredAt));
    });
  }

  function entryForVideo(videoId) {
    /* most recent non-restored applied edit for a video */
    return state.log.filter(function (e) { return e.videoId === videoId && e.result === 'applied' && !e.restoredAt; })[0] || null;
  }

  function editedVideoIds() {
    var s = {};
    /* A rollback write puts the video back to its original state, so it must not
     * keep the video flagged as "edited" (the hide-already-edited filter and the
     * per-row badges both depend on this). */
    state.log.forEach(function (e) {
      if (e.kind === 'restore') return;
      if (e.result === 'applied' && !e.restoredAt) s[e.videoId] = true;
    });
    return s;
  }

  function pruneBatch(batchId) {
    state.log = state.log.filter(function (e) { return e.batchId !== batchId; });
    state.batches = state.batches.filter(function (b) { return b.id !== batchId; });
    saveLog();
  }

  function pruneRestored() {
    var before = state.log.length;
    state.log = state.log.filter(function (e) { return !(e.restoredAt || e.result === 'failed'); });
    saveLog();
    return before - state.log.length;
  }

  /* ---------- backup export / import ---------- */

  function exportPayload() {
    return {
      app: 'yt-bulk-edits',
      version: 1,
      exportedAt: new Date().toISOString(),
      channel: state.channel ? { id: state.channel.id, title: state.channel.title } : null,
      batches: state.batches,
      log: state.log
    };
  }

  function exportBackup() {
    var name = 'yt-bulk-edits-backup-' + util.stamp() + '.json';
    util.download(name, JSON.stringify(exportPayload(), null, 2));
    return name;
  }

  /** Merge an exported backup. De-dupes on entry id; returns counts. */
  function importBackup(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return { ok: false, error: 'Not valid JSON: ' + e.message }; }
    if (!data || data.app !== 'yt-bulk-edits' || !Array.isArray(data.log)) {
      return { ok: false, error: 'Not a yt-bulk-edits backup file.' };
    }
    var have = {};
    state.log.forEach(function (e) { have[e.id] = true; });
    var haveB = {};
    state.batches.forEach(function (b) { haveB[b.id] = true; });
    var added = 0, addedB = 0;
    (data.batches || []).forEach(function (b) { if (b && b.id && !haveB[b.id]) { state.batches.push(b); haveB[b.id] = true; addedB++; } });
    data.log.forEach(function (e) { if (e && e.id && !have[e.id]) { state.log.push(e); have[e.id] = true; added++; } });
    state.log.sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
    state.batches.sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
    saveLog();
    return { ok: true, added: added, addedBatches: addedB };
  }

  /* ---------- init ---------- */

  function init() {
    loadSettings();
    loadPattern();
    loadLog();
    rollQuotaDay();
    loadAuth();
  }

  YTBE.store = {
    KEY_PREFIX: P,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_PATTERN: DEFAULT_PATTERN,
    state: state,
    init: init,
    on: on, off: off, emit: emit,
    read: read, write: write, remove: remove, storageBytes: storageBytes,
    loadSettings: loadSettings, saveSettings: saveSettings,
    loadPattern: loadPattern, savePattern: savePattern, resetPattern: resetPattern,
    loadAuth: loadAuth, saveAuth: saveAuth, clearAuth: clearAuth, authExpired: authExpired,
    loadLog: loadLog, saveLog: saveLog,
    startBatch: startBatch, finishBatch: finishBatch, addEntry: addEntry,
    markRestored: markRestored, markRestoreFailed: markRestoreFailed,
    entriesForBatch: entriesForBatch, entryForVideo: entryForVideo, editedVideoIds: editedVideoIds,
    pruneBatch: pruneBatch, pruneRestored: pruneRestored,
    exportPayload: exportPayload, exportBackup: exportBackup, importBackup: importBackup,
    ptDay: ptDay, rollQuotaDay: rollQuotaDay, spendQuota: spendQuota, quotaRemaining: quotaRemaining,
    wipeAll: function () {
      ['settings', 'pattern', 'auth', 'log', 'batches', 'quota'].forEach(remove);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);

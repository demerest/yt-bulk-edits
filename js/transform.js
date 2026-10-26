/* yt-bulk-edits :: transform.js — the find/replace engine.
 *
 * Pure functions only (no DOM, no network) so the whole edit pipeline can be
 * unit-tested headlessly. Every text operation returns the exact match spans in
 * the source AND the exact inserted spans in the output, which is what lets the
 * preview show "this is what will be replaced" rather than a guess.
 */
(function (global) {
  'use strict';

  var YTBE = global.YTBE = global.YTBE || {};
  var escapeRegExp = YTBE.util ? YTBE.util.escapeRegExp : function (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };

  /* YouTube Data API v3 hard limits. Exceeding these makes videos.update return 400. */
  var LIMITS = {
    title: 100,
    description: 5000,
    tagsTotalChars: 500,
    tagsMaxCount: 30
  };

  var QUOTA = { list: 1, update: 50, dailyDefault: 10000 };

  /* Unicode-aware word test, with a safe ES5 fallback if \p{} is unsupported. */
  var WORD_RE = (function () {
    try { return new RegExp('[\\p{L}\\p{N}_]', 'u'); } catch (e) { return /\w/; }
  })();

  function isWordChar(ch) { return !!ch && WORD_RE.test(ch); }

  function isWholeWord(s, start, end) {
    var before = start > 0 ? s[start - 1] : '';
    var after = end < s.length ? s[end] : '';
    /* An empty match can never be "whole word". */
    if (end === start) return false;
    if (isWordChar(before)) return false;
    if (isWordChar(after)) return false;
    return true;
  }

  var VALID_FLAGS = 'gimsuy';

  /**
   * Build the RegExp for a pattern. Returns {ok:true, regex} or {ok:false, error}.
   * `regex === null` means "nothing to find" (empty find string) — not an error.
   */
  function compilePattern(opts) {
    opts = opts || {};
    var find = opts.find == null ? '' : String(opts.find);
    if (find === '') return { ok: true, regex: null, empty: true };

    var flags = 'g';
    function addFlag(f) {
      if (VALID_FLAGS.indexOf(f) === -1) {
        throw new Error('Unknown regex flag "' + f + '". Allowed: ' + VALID_FLAGS.split('').join(' '));
      }
      if (flags.indexOf(f) === -1) flags += f;
    }
    try {
      if (!opts.caseSensitive) addFlag('i');
      var extra = String(opts.regexFlags || '').trim();
      for (var i = 0; i < extra.length; i++) addFlag(extra[i]);
    } catch (flagErr) {
      return { ok: false, error: flagErr.message };
    }

    var src = opts.mode === 'regex' ? find : escapeRegExp(find);

    /* Prefer the unicode flag for correct \d/\w behaviour on non-ASCII text,
     * but fall back if it makes the user's pattern invalid (e.g. legacy escapes).
     * Never add it twice: new RegExp(src, 'guu') is itself a SyntaxError. */
    var attempts = (opts.mode === 'regex' && flags.indexOf('u') === -1) ? [flags + 'u', flags] : [flags];
    var lastErr = null;
    for (var a = 0; a < attempts.length; a++) {
      try { return { ok: true, regex: new RegExp(src, attempts[a]), flags: attempts[a] }; }
      catch (e) { lastErr = e; }
    }
    return { ok: false, error: 'Invalid regular expression: ' + (lastErr ? lastErr.message : 'unknown error') };
  }

  /**
   * All non-overlapping matches of the pattern in `text`, in order.
   * Returns {matches:[{start,end,full,groups,named}], error?}
   */
  function findMatches(text, opts) {
    opts = opts || {};
    var s = text == null ? '' : String(text);
    var compiled = compilePattern(opts);
    if (!compiled.ok) return { matches: [], error: compiled.error };
    if (!compiled.regex) return { matches: [], error: null, empty: true };

    var re = compiled.regex;
    var out = [];
    var guard = 0;
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(s)) !== null) {
      if (++guard > 200000) break;
      var start = m.index;
      var end = start + m[0].length;
      if (!opts.wholeWord || isWholeWord(s, start, end)) {
        out.push({
          start: start,
          end: end,
          full: m[0],
          groups: Array.prototype.slice.call(m, 1),
          named: m.groups || null
        });
      }
      /* A zero-length match (an "a-star" style pattern, or a bare end anchor
         with the multiline flag) never advances lastIndex, so nudge it. */
      re.lastIndex = end === start ? start + 1 : end;
      if (re.lastIndex > s.length) break;
    }

    var max = Number(opts.maxReplacements) || 0;
    if (max > 0 && out.length > max) out = out.slice(0, max);
    return { matches: out, error: null };
  }

  /**
   * Expand a JavaScript replacement template ($&, $1, $`, $', $<name>, $$)
   * for one match. Implemented manually so we can measure the inserted span.
   */
  function expandReplacement(src, m, repl) {
    repl = repl == null ? '' : String(repl);
    var out = '';
    for (var i = 0; i < repl.length; i++) {
      var c = repl[i];
      if (c !== '$') { out += c; continue; }
      var n = repl[i + 1];
      if (n === undefined) { out += '$'; continue; }
      if (n === '$') { out += '$'; i++; }
      else if (n === '&') { out += m.full; i++; }
      else if (n === '`') { out += src.slice(0, m.start); i++; }
      else if (n === "'") { out += src.slice(m.end); i++; }
      else if (n === '<') {
        var close = repl.indexOf('>', i + 2);
        var name = close > i ? repl.slice(i + 2, close) : null;
        if (name && m.named && Object.prototype.hasOwnProperty.call(m.named, name)) {
          out += m.named[name] == null ? '' : m.named[name];
          i = close;
        } else { out += '$'; }
      }
      else if (n >= '1' && n <= '9') {
        var digits = n, next = repl[i + 2];
        if (next >= '0' && next <= '9' && m.groups.length >= Number(n + next)) { digits = n + next; }
        var g = m.groups[Number(digits) - 1];
        out += g == null ? '' : g;
        i += digits.length;
      }
      else { out += '$'; }
    }
    return out;
  }

  /**
   * Apply the pattern to one text value.
   * Returns {text, count, inSpans, outSpans, error?}
   *   inSpans  – ranges in the ORIGINAL string that will be removed
   *   outSpans – ranges in the NEW string that were inserted
   */
  function applyToText(text, opts) {
    opts = opts || {};
    var s = text == null ? '' : String(text);
    var found = findMatches(s, opts);
    if (found.error) return { text: s, count: 0, inSpans: [], outSpans: [], error: found.error };

    var matches = found.matches;
    if (!matches.length) return { text: s, count: 0, inSpans: [], outSpans: [], error: null };

    var replRaw = opts.replace == null ? '' : String(opts.replace);
    var useExpand = opts.mode === 'regex';
    var out = '', last = 0;
    var inSpans = [], outSpans = [];

    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      out += s.slice(last, m.start);
      if (m.end > m.start) inSpans.push({ start: m.start, end: m.end });
      var ins = useExpand ? expandReplacement(s, m, replRaw) : replRaw;
      if (ins.length) outSpans.push({ start: out.length, end: out.length + ins.length });
      out += ins;
      last = m.end;
    }
    out += s.slice(last);
    return { text: out, count: matches.length, inSpans: inSpans, outSpans: outSpans, error: null };
  }

  /**
   * Apply the pattern to a tag array, tag by tag, so a match inside one tag can
   * never splice into its neighbour. Empty results are dropped; duplicates folded.
   */
  function applyToTags(tags, opts) {
    var src = Array.isArray(tags) ? tags.slice() : [];
    var outTags = [], per = [], count = 0, err = null;
    var droppedEmpty = 0;

    for (var i = 0; i < src.length; i++) {
      var r = applyToText(src[i], opts);
      if (r.error) { err = r.error; break; }
      count += r.count;
      var v = r.text.trim();
      if (r.count) per.push({ before: src[i], after: v, inSpans: r.inSpans, outSpans: r.outSpans });
      if (v === '') { if (r.count) droppedEmpty++; continue; }
      outTags.push(v);
    }
    if (err) return { tags: src, count: 0, per: [], error: err };

    var seen = {}, dedup = [], dupes = 0;
    for (var j = 0; j < outTags.length; j++) {
      var key = outTags[j].toLowerCase();
      if (seen[key]) { dupes++; continue; }
      seen[key] = true;
      dedup.push(outTags[j]);
    }
    return { tags: dedup, count: count, per: per, error: null, droppedEmpty: droppedEmpty, duplicatesRemoved: dupes };
  }

  /** Field-level validation against the real API limits. */
  function validateValue(field, value, extra) {
    var out = [];
    var v = value == null ? '' : value;
    if (field === 'title') {
      var t = String(v).trim();
      if (t === '') out.push({ level: 'error', msg: 'Title would be empty — the API requires a non-empty title.' });
      if (t.length > LIMITS.title) out.push({ level: 'error', msg: 'Title is ' + t.length + ' chars; YouTube allows ' + LIMITS.title + '.' });
    } else if (field === 'description') {
      if (String(v).length > LIMITS.description) out.push({ level: 'error', msg: 'Description is ' + String(v).length + ' chars; YouTube allows ' + LIMITS.description + '.' });
    } else if (field === 'tags') {
      var tags = Array.isArray(v) ? v : [];
      var total = tags.reduce(function (a, t) { return a + String(t).length; }, 0) + Math.max(0, tags.length - 1);
      if (total > LIMITS.tagsTotalChars) out.push({ level: 'error', msg: 'Tags total ' + total + ' chars; YouTube allows ' + LIMITS.tagsTotalChars + '.' });
      if (tags.length > LIMITS.tagsMaxCount) out.push({ level: 'warn', msg: tags.length + ' tags (Studio caps at ' + LIMITS.tagsMaxCount + '). The API may still accept it.' });
      for (var i = 0; i < tags.length; i++) {
        if (String(tags[i]).indexOf('\n') !== -1) { out.push({ level: 'warn', msg: 'A tag contains a line break.' }); break; }
      }
      if (extra && extra.droppedEmpty) out.push({ level: 'warn', msg: extra.droppedEmpty + ' tag(s) became empty and will be removed.' });
    }
    return out;
  }

  /**
   * The single entry point used by the preview and the apply loop.
   * Returns the exact before/after for every enabled field, plus match spans,
   * match counts, validation messages, and whether anything actually changes.
   */
  function computeEdits(video, pattern) {
    pattern = pattern || {};
    var fields = pattern.fields || { title: true };
    var sn = (video && video.snippet) || {};
    var changes = {};
    var warnings = [];
    var error = null;
    var changed = false;
    var matchCount = 0;

    if (fields.title) {
      var before = sn.title == null ? '' : String(sn.title);
      var r = applyToText(before, pattern);
      if (r.error && !error) error = r.error;
      matchCount += r.count;
      var tChanged = r.count > 0 && r.text !== before;
      changes.title = { before: before, after: r.text, count: r.count, inSpans: r.inSpans || [], outSpans: r.outSpans || [], changed: tChanged };
      if (tChanged) {
        changed = true;
        warnings = warnings.concat(validateValue('title', r.text));
      }
    }

    if (fields.description) {
      var dBefore = sn.description == null ? '' : String(sn.description);
      var dr = applyToText(dBefore, pattern);
      if (dr.error && !error) error = dr.error;
      matchCount += dr.count;
      var dChanged = dr.count > 0 && dr.text !== dBefore;
      changes.description = { before: dBefore, after: dr.text, count: dr.count, inSpans: dr.inSpans || [], outSpans: dr.outSpans || [], changed: dChanged };
      if (dChanged) {
        changed = true;
        warnings = warnings.concat(validateValue('description', dr.text));
      }
    }

    if (fields.tags) {
      var tagsBefore = Array.isArray(sn.tags) ? sn.tags.slice() : [];
      var tr = applyToTags(tagsBefore, pattern);
      if (tr.error && !error) error = tr.error;
      matchCount += tr.count;
      var sameTags = tr.tags.length === tagsBefore.length && tr.tags.every(function (t, i) { return t === tagsBefore[i]; });
      var tagsChanged = tr.count > 0 && !sameTags;
      changes.tags = { before: tagsBefore, after: tr.tags, count: tr.count, per: tr.per || [], changed: tagsChanged, droppedEmpty: tr.droppedEmpty || 0, duplicatesRemoved: tr.duplicatesRemoved || 0 };
      if (tagsChanged) {
        changed = true;
        warnings = warnings.concat(validateValue('tags', tr.tags, tr));
      }
    }

    var hasError = warnings.some(function (w) { return w.level === 'error'; });
    return { changes: changes, warnings: warnings, changed: changed, blocked: hasError, matchCount: matchCount, error: error };
  }

  /**
   * Build the snippet body for videos.update.
   *
   * The API DELETES any snippet property you omit, so this always echoes back
   * every settable field we know about, overriding only what the user changed.
   * `categoryId` is required by the API whenever `snippet` is in `part`.
   */
  function buildUpdateBody(video, edits, options) {
    options = options || {};
    var sn = (video && video.snippet) || {};
    var ch = (edits && edits.changes) || {};

    var snippet = {
      title: ch.title && ch.title.changed ? ch.title.after : (sn.title == null ? '' : String(sn.title)),
      description: ch.description && ch.description.changed ? ch.description.after : (sn.description == null ? '' : String(sn.description)),
      categoryId: String(sn.categoryId || (options.defaultCategoryId || '22'))
    };
    var tags = ch.tags && ch.tags.changed ? ch.tags.after : (Array.isArray(sn.tags) ? sn.tags.slice() : []);
    /* Never send an empty tags array when the video simply has no tags: harmless,
     * but sending [] on a video that HAD tags is how tags get wiped. */
    if (tags.length) snippet.tags = tags.map(String);

    if (sn.defaultLanguage) snippet.defaultLanguage = sn.defaultLanguage;
    if (sn.defaultAudioLanguage) snippet.defaultAudioLanguage = sn.defaultAudioLanguage;
    if (sn.localized && sn.localized.title) {
      snippet.localized = { language: sn.localized.language, title: sn.localized.title, description: sn.localized.description || '' };
    }

    var body = { id: video.id, snippet: snippet };
    if (options.privacyStatus && video.status) {
      body.status = Object.assign({}, video.status, { privacyStatus: options.privacyStatus });
    }
    return body;
  }

  /** Parts string matching what buildUpdateBody actually sends. */
  function updateParts(options) {
    return (options && options.privacyStatus) ? 'snippet,status' : 'snippet';
  }

  /* Status fields the API accepts on write. Everything else in `status`
   * (uploadStatus, rejectionReason, failureReason, publishedAt, ...) is
   * read-only and sending it back makes videos.update return 400. */
  var STATUS_SETTABLE = ['privacyStatus', 'selfDeclaredMadeForKids', 'madeForKids', 'embeddable', 'publicStatsViewable', 'license', 'restricted'];

  function pickSettableStatus(status) {
    var out = null;
    Object.keys(status || {}).forEach(function (k) {
      if (STATUS_SETTABLE.indexOf(k) === -1) return;
      if (status[k] == null) return;
      out = out || {};
      out[k] = status[k];
    });
    return out;
  }

  /**
   * Rebuild the write body that returns a video to its stored original state.
   * Uses only the snapshot recorded BEFORE the edit, so it is lossless even if
   * the live video has since been changed by something else.
   */
  function buildRestoreBody(entry) {
    var before = (entry && entry.before) || {};
    var sn = before.snippet || {};
    var snippet = {
      title: sn.title == null ? '' : String(sn.title),
      description: sn.description == null ? '' : String(sn.description),
      categoryId: String(sn.categoryId || '22')
    };
    if (Array.isArray(sn.tags) && sn.tags.length) snippet.tags = sn.tags.map(String);
    if (sn.defaultLanguage) snippet.defaultLanguage = sn.defaultLanguage;
    if (sn.defaultAudioLanguage) snippet.defaultAudioLanguage = sn.defaultAudioLanguage;
    if (sn.localized && sn.localized.title) {
      snippet.localized = { language: sn.localized.language, title: sn.localized.title, description: sn.localized.description || '' };
    }

    var body = { id: entry.videoId, snippet: snippet };
    /* Only touch `status` when the batch actually changed it — otherwise a
     * restore could unintentionally flip privacy on a video the user changed
     * in Studio after our edit. */
    var changedStatus = ((entry.fields || []).indexOf('privacy') !== -1) || !!entry.statusChanged;
    if (changedStatus) {
      var st = pickSettableStatus(before.status);
      if (st) body.status = st;
    }
    return body;
  }

  function restoreParts(entry) {
    return buildRestoreBody(entry).status ? 'snippet,status' : 'snippet';
  }

  YTBE.transform = {
    LIMITS: LIMITS,
    QUOTA: QUOTA,
    isWholeWord: isWholeWord,
    compilePattern: compilePattern,
    findMatches: findMatches,
    expandReplacement: expandReplacement,
    applyToText: applyToText,
    applyToTags: applyToTags,
    validateValue: validateValue,
    computeEdits: computeEdits,
    buildUpdateBody: buildUpdateBody,
    updateParts: updateParts,
    STATUS_SETTABLE: STATUS_SETTABLE,
    pickSettableStatus: pickSettableStatus,
    buildRestoreBody: buildRestoreBody,
    restoreParts: restoreParts
  };
})(typeof window !== 'undefined' ? window : globalThis);

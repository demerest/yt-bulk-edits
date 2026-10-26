/* yt-bulk-edits :: tests/tests.js — unit suite, runs headlessly in Chrome.
 *
 * Coverage focus, in priority order:
 *   1. the find/replace engine (spans must be exact — the preview depends on it)
 *   2. the "never wipe a field you didn't touch" guarantee in buildUpdateBody
 *   3. lossless restore via buildRestoreBody
 *   4. API error classification + retry/backoff + quota accounting
 *   5. PKCE (checked against the RFC 7636 Appendix B test vector)
 */
(function (global) {
  'use strict';

  var T = YTBE.transform, store = YTBE.store, api = YTBE.api, auth = YTBE.auth, util = YTBE.util;

  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }

  /* ---------------- assertions ---------------- */

  function deepEq(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;
    if (typeof a !== 'object') return String(a) === String(b) && (a === b || isNaN(a) && isNaN(b));
    return JSON.stringify(a) === JSON.stringify(b);
  }
  function show(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }
  function eq(actual, expected, msg) {
    if (!deepEq(actual, expected)) throw new Error((msg ? msg + ': ' : '') + 'expected ' + show(expected) + ' but got ' + show(actual));
  }
  function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy, got ' + show(v)); }
  function notOk(v, msg) { if (v) throw new Error(msg || 'expected falsy, got ' + show(v)); }
  function has(hay, needle, msg) {
    if (String(hay).indexOf(needle) === -1) throw new Error((msg || 'substring missing') + ': ' + show(needle) + ' not in ' + show(hay));
  }
  function throwsWith(fn, re, msg) {
    var err = null;
    try { fn(); } catch (e) { err = e; }
    if (!err) throw new Error((msg || 'expected a throw') + ' — nothing thrown');
    if (re && !re.test(err.message)) throw new Error((msg || 'wrong error') + ': got "' + err.message + '"');
    return err;
  }

  /* ---------------- fetch stub ---------------- */

  function jsonResponse(obj, status, headers) {
    status = status || 200;
    var h = {};
    Object.keys(headers || {}).forEach(function (k) { h[k.toLowerCase()] = headers[k]; });
    return {
      ok: status >= 200 && status < 300,
      status: status,
      headers: { get: function (k) { return h[String(k).toLowerCase()] || null; } },
      text: function () { return Promise.resolve(obj == null ? '' : JSON.stringify(obj)); }
    };
  }

  function stubFetch(handler) {
    var orig = global.fetch;
    var calls = [];
    global.fetch = function (url, init) {
      calls.push({ url: String(url), init: init || {} });
      try {
        return Promise.resolve(handler(String(url), init || {}, calls));
      } catch (e) { return Promise.reject(e); }
    };
    return {
      calls: calls,
      restore: function () { global.fetch = orig; }
    };
  }

  function errResponse(status, reason, message, headers) {
    return jsonResponse({ error: { code: status, message: message || reason, errors: [{ reason: reason, message: message || reason, domain: 'youtube.v3' }] } }, status, headers);
  }

  function resetQuota() { store.state.quota = { day: '', units: 0 }; store.rollQuotaDay(); }

  function mkVideo(id, title, description, tags, categoryId) {
    return {
      id: id,
      snippet: {
        title: title, description: description || '', tags: tags || [],
        categoryId: String(categoryId || '28'), channelTitle: 'Ch', publishedAt: '2024-01-01T00:00:00Z',
        defaultLanguage: '', defaultAudioLanguage: '', localized: null, thumbnails: null
      },
      status: { privacyStatus: 'public', uploadStatus: 'processed', selfDeclaredMadeForKids: false, embeddable: true, publicStatsViewable: true },
      contentDetails: { duration: 'PT1M0S' },
      statistics: { viewCount: '10' }
    };
  }

  function pat(over) {
    return Object.assign({
      find: '', replace: '', mode: 'literal', caseSensitive: false, wholeWord: false,
      regexFlags: '', maxReplacements: 0, fields: { title: true, description: false, tags: false }
    }, over || {});
  }

  /* ==================================================================
   * 1. literal find & replace
   * ================================================================== */

  test('literal: basic replacement', function () {
    var r = T.applyToText('Part 1 | FULL COURSE', pat({ find: 'FULL COURSE', replace: '' }));
    eq(r.text, 'Part 1 | ');
    eq(r.count, 1);
    eq(r.error, null);
  });

  test('literal: regex metacharacters in Find are treated as text', function () {
    var r = T.applyToText('regex .* (test)', pat({ find: '.* (', replace: 'X' }));
    eq(r.text, 'regex Xtest)');
    eq(r.count, 1);
    eq(r.inSpans[0].start, 6);
    eq(r.inSpans[0].end, 10);
  });

  test('literal: metacharacter escaping (correct expectation)', function () {
    var r = T.applyToText('price is $5.00 (usd)', pat({ find: '$5.00 (', replace: 'EUR 5,00 (' }));
    eq(r.text, 'price is EUR 5,00 (usd)');
    eq(r.count, 1);
  });

  test('literal: case-insensitive by default', function () {
    var r = T.applyToText('Remaster REMASTER remaster', pat({ find: 'remaster', replace: 'REMAKE' }));
    eq(r.count, 3);
    eq(r.text, 'REMAKE REMAKE REMAKE');
  });

  test('literal: case-sensitive when asked', function () {
    var r = T.applyToText('Remaster REMASTER remaster', pat({ find: 'remaster', replace: 'X', caseSensitive: true }));
    eq(r.count, 1);
    eq(r.text, 'Remaster REMASTER X');
  });

  test('literal: multiple occurrences all replaced', function () {
    var r = T.applyToText('a-b-c-d', pat({ find: '-', replace: '+' }));
    eq(r.text, 'a+b+c+d');
    eq(r.count, 3);
    eq(r.inSpans.length, 3);
  });

  test('literal: whole word skips substrings', function () {
    var r = T.applyToText('concatenate cat catalog and cat', pat({ find: 'cat', replace: 'dog', wholeWord: true }));
    eq(r.count, 2);
    eq(r.text, 'concatenate dog catalog and dog');
  });

  test('literal: whole word respects unicode letters', function () {
    var r = T.applyToText('привет мир миров', pat({ find: 'мир', replace: 'X', wholeWord: true }));
    eq(r.count, 1);
    eq(r.text, 'привет X миров');
  });

  test('literal: $ in replacement stays literal (no group expansion)', function () {
    var r = T.applyToText('abc', pat({ find: 'b', replace: '$1' }));
    eq(r.text, 'a$1c');
  });

  test('literal: no match leaves text untouched', function () {
    var r = T.applyToText('hello', pat({ find: 'zzz', replace: 'q' }));
    eq(r.text, 'hello');
    eq(r.count, 0);
    eq(r.inSpans.length, 0);
  });

  test('literal: empty find is a no-op, not an error', function () {
    var r = T.applyToText('hello', pat({ find: '', replace: 'q' }));
    eq(r.text, 'hello');
    eq(r.count, 0);
  });

  test('literal: maxReplacements caps the count', function () {
    var r = T.applyToText('a a a a', pat({ find: 'a', replace: 'b', maxReplacements: 2 }));
    eq(r.text, 'b b a a');
    eq(r.count, 2);
  });

  test('literal: null/undefined text does not throw', function () {
    var r = T.applyToText(null, pat({ find: 'a', replace: 'b' }));
    eq(r.text, '');
    eq(r.count, 0);
  });

  /* ==================================================================
   * 2. regex mode
   * ================================================================== */

  test('regex: ^ anchor adds a prefix', function () {
    var r = T.applyToText('My Title', pat({ mode: 'regex', find: '^', replace: '[NEW] ' }));
    eq(r.text, '[NEW] My Title');
    eq(r.count, 1);
  });

  test('regex: $ anchor adds a suffix', function () {
    var r = T.applyToText('My Title', pat({ mode: 'regex', find: '$', replace: ' | HD' }));
    eq(r.text, 'My Title | HD');
    eq(r.count, 1);
  });

  test('regex: capture groups $1/$2 swap words', function () {
    var r = T.applyToText('John Smith', pat({ mode: 'regex', find: '(\\w+)\\s(\\w+)', replace: '$2, $1' }));
    eq(r.text, 'Smith, John');
  });

  test('regex: named groups $<name>', function () {
    var r = T.applyToText('2024-03-11', pat({ mode: 'regex', find: '(?<y>\\d{4})-(?<m>\\d{2})-(?<d>\\d{2})', replace: '$<d>.$<m>.$<y>' }));
    eq(r.text, '11.03.2024');
  });

  test('regex: $& reinserts the whole match', function () {
    var r = T.applyToText('cat', pat({ mode: 'regex', find: 'cat', replace: '[$&]' }));
    eq(r.text, '[cat]');
  });

  test('regex: $` and $\' insert surrounding text', function () {
    var r = T.applyToText('abcdef', pat({ mode: 'regex', find: 'cd', replace: "$`|$'" }));
    eq(r.text, 'abab|efef');
  });

  test('regex: $$ yields a literal dollar', function () {
    var r = T.applyToText('price', pat({ mode: 'regex', find: 'price', replace: '$$5' }));
    eq(r.text, '$5');
  });

  test('regex: invalid pattern reports an error instead of throwing', function () {
    var r = T.applyToText('abc', pat({ mode: 'regex', find: '([unclosed', replace: 'x' }));
    ok(r.error, 'expected an error');
    has(r.error, 'Invalid regular expression');
    eq(r.text, 'abc');
  });

  test('regex: bad flag is rejected', function () {
    var c = T.compilePattern(pat({ mode: 'regex', find: 'a', regexFlags: 'z' }));
    notOk(c.ok);
    has(c.error, 'Unknown regex flag');
  });

  test('regex: multiline flag makes ^ match every line', function () {
    var r = T.applyToText('one\ntwo\nthree', pat({ mode: 'regex', find: '^', replace: '> ', regexFlags: 'm' }));
    eq(r.text, '> one\n> two\n> three');
    eq(r.count, 3);
  });

  test('regex: zero-length pattern terminates (no infinite loop)', function () {
    var r = T.applyToText('bbb', pat({ mode: 'regex', find: 'a*', replace: '-' }));
    eq(r.count, 4);
    eq(r.text, '-b-b-b-');
  });

  test('regex: strip trailing "| FULL COURSE" from titles', function () {
    var r = T.applyToText('Engine Part 1 | FULL COURSE', pat({ mode: 'regex', find: '\\s*\\|\\s*FULL COURSE\\s*$', replace: '' }));
    eq(r.text, 'Engine Part 1');
  });

  test('regex: emoji strip preset pattern works with u flag', function () {
    var r = T.applyToText('Hello \uD83D\uDE00 world \u2764', pat({ mode: 'regex', find: '[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}]', replace: '', regexFlags: 'u' }));
    eq(r.error, null);
    has(r.text, 'Hello');
    notOk(/\uD83D\uDE00/.test(r.text), 'emoji should be gone');
  });

  /* ==================================================================
   * 3. span exactness (the preview highlights these)
   * ================================================================== */

  test('spans: inSpans point exactly at removed text', function () {
    var src = 'alpha BETA gamma';
    var r = T.applyToText(src, pat({ find: 'BETA', replace: '' }));
    eq(r.inSpans.length, 1);
    eq(src.slice(r.inSpans[0].start, r.inSpans[0].end), 'BETA');
  });

  test('spans: outSpans point exactly at inserted text', function () {
    var r = T.applyToText('alpha BETA gamma', pat({ find: 'BETA', replace: 'DELTA' }));
    eq(r.outSpans.length, 1);
    eq(r.text.slice(r.outSpans[0].start, r.outSpans[0].end), 'DELTA');
  });

  test('spans: multiple matches keep order and stay in bounds', function () {
    var src = 'x-x-x';
    var r = T.applyToText(src, pat({ find: 'x', replace: 'yy' }));
    eq(r.inSpans.length, 3);
    eq(r.outSpans.length, 3);
    for (var i = 0; i < r.inSpans.length; i++) {
      ok(r.inSpans[i].start >= 0 && r.inSpans[i].end <= src.length, 'inSpan ' + i + ' out of bounds');
      if (i > 0) ok(r.inSpans[i].start >= r.inSpans[i - 1].end, 'inSpans out of order');
    }
    eq(r.text, 'yy-yy-yy');
    r.outSpans.forEach(function (s) { eq(r.text.slice(s.start, s.end), 'yy'); });
  });

  test('spans: deletion produces no outSpan, insertion-only produces no inSpan', function () {
    var del = T.applyToText('keep DROP', pat({ find: ' DROP', replace: '' }));
    eq(del.inSpans.length, 1);
    eq(del.outSpans.length, 0);
    var ins = T.applyToText('keep', pat({ mode: 'regex', find: '$', replace: ' MORE' }));
    eq(ins.inSpans.length, 0);
    eq(ins.outSpans.length, 1);
  });

  test('spans: regex replacement spans are measured after $ expansion', function () {
    var r = T.applyToText('2024', pat({ mode: 'regex', find: '(\\d{2})(\\d{2})', replace: '$2/$1' }));
    eq(r.text, '24/20');
    eq(r.text.slice(r.outSpans[0].start, r.outSpans[0].end), '24/20');
  });

  /* ==================================================================
   * 4. tags
   * ================================================================== */

  test('tags: each tag edited independently', function () {
    var r = T.applyToTags(['game engine', 'engine tools', 'coding'], pat({ find: 'engine', replace: 'dev' }));
    eq(r.tags, ['game dev', 'dev tools', 'coding']);
    eq(r.count, 2);
  });

  test('tags: a match cannot spill into the next tag', function () {
    var r = T.applyToTags(['ab', 'cd'], pat({ mode: 'regex', find: 'b.*c', replace: 'X' }));
    eq(r.tags, ['ab', 'cd']);
    eq(r.count, 0);
  });

  test('tags: tags that become empty are dropped', function () {
    var r = T.applyToTags(['keepme', 'FULL'], pat({ find: 'FULL', replace: '' }));
    eq(r.tags, ['keepme']);
    eq(r.droppedEmpty, 1);
  });

  test('tags: duplicates created by the edit are folded', function () {
    var r = T.applyToTags(['tutorial 2024', 'tutorial 2023'], pat({ mode: 'regex', find: '\\d{4}', replace: '' }));
    eq(r.tags, ['tutorial']);
    eq(r.duplicatesRemoved, 1);
  });

  test('tags: unchanged when nothing matches', function () {
    var r = T.applyToTags(['a', 'b'], pat({ find: 'zzz', replace: 'q' }));
    eq(r.tags, ['a', 'b']);
    eq(r.count, 0);
  });

  /* ==================================================================
   * 5. validation against real YouTube limits
   * ================================================================== */

  test('validate: title over 100 chars is an error', function () {
    var w = T.validateValue('title', new Array(102).join('a'));
    eq(w.length, 1);
    eq(w[0].level, 'error');
    has(w[0].msg, '101 chars');
  });

  test('validate: exactly 100 chars is fine', function () {
    eq(T.validateValue('title', new Array(101).join('a')).length, 0);
  });

  test('validate: empty title is an error', function () {
    var w = T.validateValue('title', '   ');
    eq(w.length, 1);
    has(w[0].msg, 'empty');
  });

  test('validate: description over 5000 chars is an error', function () {
    var w = T.validateValue('description', new Array(5002).join('d'));
    eq(w.length, 1);
    eq(w[0].level, 'error');
  });

  test('validate: tags over 500 total chars is an error', function () {
    var tags = [];
    for (var i = 0; i < 30; i++) tags.push('tag-number-' + i + '-padding-padding');
    var w = T.validateValue('tags', tags);
    ok(w.some(function (x) { return x.level === 'error' && /500/.test(x.msg); }), 'expected a 500-char error');
  });

  test('computeEdits: over-long result blocks the row', function () {
    /* NB: new Array(n).join('a') yields n-1 chars — easy off-by-one. */
    var base = new Array(99).join('a');
    eq(base.length, 98, 'sanity: base title length');
    var v = mkVideo('X', base, '', [], '28');
    /* 5 matches x ("a" -> "bb") = +5 chars = 103, which is over the 100 limit. */
    var e = T.computeEdits(v, pat({ find: 'a', replace: 'bb', maxReplacements: 5 }));
    eq(e.changes.title.after.length, 103);
    ok(e.changed, 'should be changed');
    ok(e.blocked, 'should be blocked');
    ok(e.warnings.some(function (w) { return w.level === 'error'; }));
    has(e.warnings[0].msg, '103 chars');
  });

  test('computeEdits: a result exactly at the 100-char limit is allowed', function () {
    var base = new Array(96).join('a'); /* 95 chars */
    var v = mkVideo('X', base, '', [], '28');
    var e = T.computeEdits(v, pat({ find: 'a', replace: 'bb', maxReplacements: 5 }));
    eq(e.changes.title.after.length, 100);
    ok(e.changed);
    notOk(e.blocked, '100 chars is exactly at the limit and must be allowed');
  });

  test('computeEdits: no match means changed=false and no warnings', function () {
    var v = mkVideo('X', 'plain title', 'desc', ['a'], '28');
    var e = T.computeEdits(v, pat({ find: 'NOMATCH', replace: 'q' }));
    notOk(e.changed);
    notOk(e.blocked);
    eq(e.warnings.length, 0);
    eq(e.matchCount, 0);
  });

  test('computeEdits: only enabled fields are touched', function () {
    var v = mkVideo('X', 'aaa title', 'aaa description', ['aaa'], '28');
    var e = T.computeEdits(v, pat({ find: 'aaa', replace: 'bbb', fields: { title: true, description: false, tags: false } }));
    ok(e.changes.title, 'title should be computed');
    notOk(e.changes.description, 'description should not be computed');
    notOk(e.changes.tags, 'tags should not be computed');
    eq(e.matchCount, 1);
  });

  test('computeEdits: all three fields counted together', function () {
    var v = mkVideo('X', 'aaa title', 'aaa description', ['aaa tag'], '28');
    var e = T.computeEdits(v, pat({ find: 'aaa', replace: 'bbb', fields: { title: true, description: true, tags: true } }));
    eq(e.matchCount, 3);
    ok(e.changes.title.changed);
    ok(e.changes.description.changed);
    ok(e.changes.tags.changed);
  });

  /* ==================================================================
   * 6. the anti-wipe guarantee
   * ================================================================== */

  test('buildUpdateBody: description+tags+category survive a title-only edit', function () {
    var v = mkVideo('VID1', 'Old Title', 'A long description\nwith lines', ['tag1', 'tag2'], '27');
    var e = T.computeEdits(v, pat({ find: 'Old', replace: 'New' }));
    var body = T.buildUpdateBody(v, e, {});
    eq(body.id, 'VID1');
    eq(body.snippet.title, 'New Title');
    eq(body.snippet.description, 'A long description\nwith lines', 'description must be echoed back or the API deletes it');
    eq(body.snippet.tags, ['tag1', 'tag2'], 'tags must be echoed back or the API deletes them');
    eq(body.snippet.categoryId, '27', 'categoryId is required by videos.update');
  });

  test('buildUpdateBody: missing categoryId falls back instead of sending undefined', function () {
    var v = mkVideo('VID2', 'T', '', [], null);
    v.snippet.categoryId = '';
    var e = T.computeEdits(v, pat({ find: 'T', replace: 'X' }));
    var body = T.buildUpdateBody(v, e, { defaultCategoryId: '22' });
    eq(body.snippet.categoryId, '22');
  });

  test('buildUpdateBody: no tags property when the video has none', function () {
    var v = mkVideo('VID3', 'abc', 'd', [], '28');
    var e = T.computeEdits(v, pat({ find: 'a', replace: 'z' }));
    var body = T.buildUpdateBody(v, e, {});
    notOk('tags' in body.snippet, 'sending [] would be harmless but omitting is cleaner and safer');
  });

  test('buildUpdateBody: edited tags replace the originals', function () {
    var v = mkVideo('VID4', 'T', 'd', ['old tag', 'keep'], '28');
    var e = T.computeEdits(v, pat({ find: 'old', replace: 'new', fields: { title: false, description: false, tags: true } }));
    var body = T.buildUpdateBody(v, e, {});
    eq(body.snippet.tags, ['new tag', 'keep']);
    eq(body.snippet.title, 'T', 'title must be preserved when not being edited');
  });

  test('buildUpdateBody: localized metadata is preserved', function () {
    var v = mkVideo('VID5', 'EN Title', 'd', [], '28');
    v.snippet.localized = { language: 'en', title: 'EN Title', description: 'd' };
    var e = T.computeEdits(v, pat({ find: 'EN', replace: 'US' }));
    var body = T.buildUpdateBody(v, e, {});
    ok(body.snippet.localized, 'localized must survive');
    eq(body.snippet.localized.language, 'en');
  });

  test('buildUpdateBody: status is only included when privacy is being changed', function () {
    var v = mkVideo('VID6', 'T', 'd', [], '28');
    var e = T.computeEdits(v, pat({ find: 'T', replace: 'X' }));
    notOk('status' in T.buildUpdateBody(v, e, {}));
    ok('status' in T.buildUpdateBody(v, e, { privacyStatus: 'unlisted' }));
    eq(T.buildUpdateBody(v, e, { privacyStatus: 'unlisted' }).status.privacyStatus, 'unlisted');
    eq(T.updateParts({}), 'snippet');
    eq(T.updateParts({ privacyStatus: 'private' }), 'snippet,status');
  });

  /* ==================================================================
   * 7. restore / rollback
   * ================================================================== */

  test('buildRestoreBody: rebuilds the original title/description/tags', function () {
    var v = mkVideo('VID7', 'Original Title', 'Original description', ['t1', 't2'], '27');
    var e = T.computeEdits(v, pat({ find: 'Original', replace: 'Edited' }));
    var body = T.buildUpdateBody(v, e, {});
    var entry = { videoId: v.id, fields: ['title'], before: { snippet: util.deepClone(v.snippet), status: util.deepClone(v.status) }, after: { snippet: body.snippet } };
    var rb = T.buildRestoreBody(entry);
    eq(rb.id, 'VID7');
    eq(rb.snippet.title, 'Original Title');
    eq(rb.snippet.description, 'Original description');
    eq(rb.snippet.tags, ['t1', 't2']);
    eq(rb.snippet.categoryId, '27');
    eq(T.restoreParts(entry), 'snippet');
  });

  test('buildRestoreBody: read-only status fields are never sent back', function () {
    var st = T.pickSettableStatus({ privacyStatus: 'public', uploadStatus: 'processed', rejectionReason: 'x', failureReason: 'y', publishedAt: '2020-01-01', embeddable: true });
    eq(Object.keys(st).sort(), ['embeddable', 'privacyStatus']);
    ok(T.STATUS_SETTABLE.indexOf('uploadStatus') === -1);
  });

  test('buildRestoreBody: includes status only if the batch changed privacy', function () {
    var v = mkVideo('VID8', 'T', 'd', [], '28');
    var entry = { videoId: 'VID8', fields: ['title', 'privacy'], before: { snippet: v.snippet, status: { privacyStatus: 'private', uploadStatus: 'processed' } } };
    var rb = T.buildRestoreBody(entry);
    ok(rb.status, 'status expected when privacy was part of the change');
    eq(rb.status.privacyStatus, 'private');
    notOk('uploadStatus' in rb.status);
    eq(T.restoreParts(entry), 'snippet,status');

    var entry2 = { videoId: 'VID8', fields: ['title'], before: { snippet: v.snippet, status: { privacyStatus: 'private' } } };
    notOk(T.buildRestoreBody(entry2).status, 'status must be omitted so a restore cannot silently change privacy');
  });

  test('restore round-trip: apply then restore returns the byte-identical snippet', function () {
    var v = mkVideo('RT1', '[2024] My | Video', 'Line1\nLine2\n\nhttps://example.com', ['a b', 'c'], '24');
    var original = util.deepClone(v.snippet);
    var e = T.computeEdits(v, pat({ find: '[2024] ', replace: '', fields: { title: true, description: true, tags: true } }));
    ok(e.changed);
    var written = T.buildUpdateBody(v, e, {});
    var entry = { videoId: v.id, fields: ['title'], before: { snippet: original, status: util.deepClone(v.status) }, after: { snippet: written.snippet } };
    var restored = T.buildRestoreBody(entry).snippet;
    eq(restored.title, original.title);
    eq(restored.description, original.description);
    eq(restored.tags, original.tags);
    eq(restored.categoryId, original.categoryId);
  });

  /* ==================================================================
   * 8. API client
   * ================================================================== */

  test('api: buildQuery encodes and skips empty params', function () {
    var q = api.buildQuery({ part: 'snippet,status', mine: 'true', pageToken: '', id: 'a b&c' });
    eq(q, '?part=snippet%2Cstatus&mine=true&id=a%20b%26c');
    eq(api.buildQuery({}), '');
  });

  test('api: classify maps statuses to the right behaviour', function () {
    eq(api.classify(401, 'authError', '').needsAuth, true);
    eq(api.classify(403, 'invalidCredentials', '').needsAuth, true);
    var q = api.classify(403, 'quotaExceeded', 'The quota has been exceeded');
    eq(q.quota, true); eq(q.fatal, true); eq(q.retryable, false);
    eq(api.classify(403, 'rateLimitExceeded', '').retryable, true);
    eq(api.classify(403, 'userRateLimitExceeded', '').retryable, true);
    eq(api.classify(429, '', '').retryable, true);
    eq(api.classify(503, 'backendError', '').retryable, true);
    eq(api.classify(400, 'invalidValue', 'bad').retryable, false);
    eq(api.classify(403, 'forbidden', 'nope').retryable, false);
  });

  test('api: 401 surfaces as needsAuth without retrying', async function () {
    resetQuota();
    var s = stubFetch(function () { return errResponse(401, 'authError', 'Invalid Credentials'); });
    try {
      var err = null;
      try { await api.request('/channels', { params: { mine: 'true' }, token: 'x', cost: 1, retries: 3 }); } catch (e) { err = e; }
      ok(err, 'expected a throw');
      eq(err.needsAuth, true);
      eq(s.calls.length, 1, 'auth errors must not be retried');
    } finally { s.restore(); }
  });

  test('api: quotaExceeded aborts immediately (fatal, no retry)', async function () {
    resetQuota();
    var s = stubFetch(function () { return errResponse(403, 'quotaExceeded', 'The quota has been exceeded.'); });
    try {
      var err = null;
      try { await api.request('/videos', { method: 'PUT', params: { part: 'snippet' }, body: {}, token: 'x', cost: 50 }); } catch (e) { err = e; }
      ok(err);
      eq(err.quota, true);
      eq(err.fatal, true);
      eq(s.calls.length, 1);
    } finally { s.restore(); }
  });

  test('api: transient 500 is retried then succeeds', async function () {
    resetQuota();
    var n = 0;
    var s = stubFetch(function () {
      n++;
      if (n < 3) return errResponse(500, 'backendError', 'boom');
      return jsonResponse({ items: [{ id: 'ok' }] }, 200);
    });
    try {
      var data = await api.request('/videos', { params: { part: 'id' }, token: 'x', cost: 1, retries: 3, onBackoff: function () { } });
      eq(data.items[0].id, 'ok');
      eq(s.calls.length, 3);
    } finally { s.restore(); }
  });

  test('api: 429 honours Retry-After', async function () {
    resetQuota();
    var waits = [];
    var n = 0;
    var s = stubFetch(function () {
      n++;
      if (n === 1) return errResponse(429, 'rateLimitExceeded', 'slow down', { 'Retry-After': '2' });
      return jsonResponse({ ok: true }, 200);
    });
    try {
      await api.request('/videos', { params: {}, token: 'x', cost: 1, retries: 2, onBackoff: function (ms) { waits.push(ms); } });
      eq(waits.length, 1);
      eq(waits[0], 2000);
    } finally { s.restore(); }
  });

  test('api: success charges the declared cost, failure charges 1', async function () {
    resetQuota();
    var s = stubFetch(function () { return jsonResponse({ items: [] }, 200); });
    try {
      await api.request('/videos', { params: {}, token: 'x', cost: 1 });
      eq(store.state.quota.units, 1);
      await api.request('/videos', { method: 'PUT', params: {}, body: {}, token: 'x', cost: 50 });
      eq(store.state.quota.units, 51);
    } finally { s.restore(); }

    resetQuota();
    var s2 = stubFetch(function () { return errResponse(400, 'invalidValue', 'bad'); });
    try {
      try { await api.request('/videos', { method: 'PUT', params: {}, body: {}, token: 'x', cost: 50, retries: 0 }); } catch (e) { }
      eq(store.state.quota.units, 1, 'a rejected call still costs 1 unit');
    } finally { s2.restore(); }
  });

  test('api: listMyVideos walks uploads playlist then videos-by-id, in upload order', async function () {
    resetQuota();
    var s = stubFetch(function (url) {
      if (url.indexOf('/channels') !== -1) {
        return jsonResponse({ items: [{ id: 'UC1', snippet: { title: 'Ch' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } }, statistics: { videoCount: '3' } }] });
      }
      if (url.indexOf('/playlistItems') !== -1) {
        has(url, 'playlistId=UU1');
        if (url.indexOf('pageToken=') === -1) {
          return jsonResponse({ items: [{ contentDetails: { videoId: 'A' } }, { contentDetails: { videoId: 'B' } }], nextPageToken: 'tok2' });
        }
        return jsonResponse({ items: [{ contentDetails: { videoId: 'C' } }] });
      }
      if (url.indexOf('/videos') !== -1) {
        var m = /[?&]id=([^&]+)/.exec(url);
        ok(m, 'videos call must filter by id');
        var ids = decodeURIComponent(m[1]).split(',');
        /* Deliberately return them out of order to prove ordering is restored. */
        return jsonResponse({ items: ids.slice().reverse().map(function (id) { return mkVideo(id, 'title ' + id); }) });
      }
      return jsonResponse({});
    });
    var progress = [];
    try {
      var vids = await api.listMyVideos({ token: 'x', onProgress: function (p) { progress.push(p); } });
      eq(vids.map(function (v) { return v.id; }), ['A', 'B', 'C'], 'upload order must survive the videos-by-id hop');
      eq(vids[0].snippet.title, 'title A');
      has(s.calls[0].url, '/youtube/v3/channels?', 'first call resolves the uploads playlist');
      has(s.calls[1].url, '/youtube/v3/playlistItems?');
      has(s.calls[2].url, 'pageToken=tok2');
      has(s.calls[3].url, '/youtube/v3/videos?');
      has(s.calls[3].url, 'id=A%2CB%2CC');
      eq(store.state.quota.units, 4, 'channel + 2 playlist pages + 1 videos call');
      ok(progress.some(function (p) { return p.phase === 'ids'; }));
      ok(progress.some(function (p) { return p.phase === 'metadata'; }));
    } finally { s.restore(); }
  });

  test('api: videos.list is never sent mine= (regression: Google rejects it)', async function () {
    /* videos.list only accepts chart/id/myRating as filters. Sending mine=true
       yields "No filter selected. Expected one of: chart, id, myRating" - the
       exact error this suite once shipped. */
    resetQuota();
    var s = stubFetch(function (url) {
      if (url.indexOf('/playlistItems') !== -1) return jsonResponse({ items: [{ contentDetails: { videoId: 'A' } }] });
      if (url.indexOf('/videos') !== -1) return jsonResponse({ items: [mkVideo('A', 'a')] });
      return jsonResponse({ items: [{ id: 'UC1', snippet: {}, contentDetails: { relatedPlaylists: { uploads: 'UU1' } }, statistics: {} }] });
    });
    try {
      await api.listMyVideos({ token: 'x' });
      var videoCalls = s.calls.filter(function (c) { return c.url.indexOf('/youtube/v3/videos?') !== -1; });
      ok(videoCalls.length >= 1, 'expected at least one videos call');
      videoCalls.forEach(function (c) {
        notOk(/[?&]mine=/.test(c.url), 'videos.list must never carry mine=: ' + c.url);
        ok(/[?&]id=/.test(c.url), 'videos.list must filter by id: ' + c.url);
      });
    } finally { s.restore(); }
  });

  test('api: listMyVideos skips the channel call when the playlist id is supplied', async function () {
    resetQuota();
    var s = stubFetch(function (url) {
      if (url.indexOf('/playlistItems') !== -1) return jsonResponse({ items: [] });
      return jsonResponse({ items: [] });
    });
    try {
      await api.listMyVideos({ token: 'x', uploadsPlaylist: 'UU9' });
      eq(s.calls.length, 1, 'only the playlist page should be requested');
      has(s.calls[0].url, 'playlistId=UU9');
      eq(store.state.quota.units, 1);
    } finally { s.restore(); }
  });

  test('api: updateVideo issues a PUT with part=snippet and the full body', async function () {
    resetQuota();
    var s = stubFetch(function () { return jsonResponse({ id: 'VID', snippet: {} }, 200); });
    try {
      await api.updateVideo({ token: 'tok', parts: 'snippet', body: { id: 'VID', snippet: { title: 'T', categoryId: '28' } } });
      eq(s.calls.length, 1);
      eq(s.calls[0].init.method, 'PUT');
      has(s.calls[0].url, '/youtube/v3/videos?part=snippet');
      eq(s.calls[0].init.headers['Authorization'], 'Bearer tok');
      eq(JSON.parse(s.calls[0].init.body).snippet.title, 'T');
      eq(store.state.quota.units, 50, 'videos.update costs 50 units');
    } finally { s.restore(); }
  });

  test('api: getChannel rejects a token with no channel', async function () {
    resetQuota();
    var s = stubFetch(function () { return jsonResponse({ items: [] }, 200); });
    try {
      var err = null;
      try { await api.getChannel('x'); } catch (e) { err = e; }
      ok(err);
      has(err.message, 'no channel');
    } finally { s.restore(); }
  });

  test('api: getChannel maps the response', async function () {
    resetQuota();
    var s = stubFetch(function () {
      return jsonResponse({ items: [{ id: 'UC1', snippet: { title: 'My Channel', thumbnails: { default: { url: 'http://x/t.jpg' } }, country: 'GB' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } }, statistics: { videoCount: '42', viewCount: '1000', subscriberCount: '7' } }] }, 200);
    });
    try {
      var c = await api.getChannel('x');
      eq(c.id, 'UC1'); eq(c.title, 'My Channel'); eq(c.videoCount, 42);
      eq(c.uploadsPlaylist, 'UU1'); eq(c.country, 'GB'); eq(c.thumbnail, 'http://x/t.jpg');
    } finally { s.restore(); }
  });

  test('api: abort signal stops the call', async function () {
    resetQuota();
    var ac = new AbortController();
    ac.abort();
    var s = stubFetch(function () { return jsonResponse({}, 200); });
    try {
      var err = null;
      try { await api.request('/videos', { params: {}, token: 'x', signal: ac.signal }); } catch (e) { err = e; }
      ok(err, 'expected abort');
      eq(err.aborted, true);
      eq(s.calls.length, 0, 'must not hit the network when already aborted');
    } finally { s.restore(); }
  });

  /* ==================================================================
   * 9. store: log, quota, backup
   * ================================================================== */

  test('store: quota day is Pacific-formatted and rolls over', function () {
    store.state.quota = { day: '', units: 0 };
    var q = store.rollQuotaDay();
    ok(/^\d{4}-\d{2}-\d{2}$/.test(q.day), 'bad day format: ' + q.day);
    store.spendQuota(150, 'test');
    eq(store.state.quota.units, 150);
    eq(store.quotaRemaining(), (Number(store.state.settings.dailyQuota) || 10000) - 150);
    store.state.quota.day = '2000-01-01';
    store.rollQuotaDay();
    eq(store.state.quota.units, 0, 'a new Pacific day must reset the counter');
  });

  test('store: batch + entries + restore marking', function () {
    store.state.batches = []; store.state.log = [];
    var b = store.startBatch({ label: 'test batch', pattern: pat({ find: 'a' }), fields: ['title'], planned: 2 });
    var v = mkVideo('V1', 'T', 'D', ['x'], '28');
    var e1 = store.addEntry({ batchId: b.id, videoId: 'V1', videoTitle: 'T', fields: ['title'], before: { snippet: util.deepClone(v.snippet) }, after: { snippet: { title: 'X' } }, result: 'applied' });
    store.addEntry({ batchId: b.id, videoId: 'V2', videoTitle: 'T2', fields: ['title'], before: { snippet: {} }, result: 'failed', error: 'boom' });
    eq(b.applied, 1);
    eq(b.failed, 1);
    eq(store.entriesForBatch(b.id).length, 2);
    eq(store.entriesForBatch(b.id, true).length, 1, 'only applied+unrestored are restorable');
    ok(store.entryForVideo('V1'), 'V1 should be restorable');
    notOk(store.entryForVideo('V2'), 'failed entries are not restorable');
    eq(store.markRestored([e1.id]), 1);
    eq(store.entriesForBatch(b.id, true).length, 0);
    notOk(store.entryForVideo('V1'), 'restored entries must not be restorable again');
    eq(store.markRestored([e1.id]), 0, 'restoring twice is a no-op');
  });

  test('store: editedVideoIds reflects applied-but-unrestored edits', function () {
    store.state.batches = []; store.state.log = [];
    var b = store.startBatch({ label: 'x', pattern: {}, fields: ['title'], planned: 1 });
    var e = store.addEntry({ batchId: b.id, videoId: 'AAA', fields: ['title'], before: { snippet: {} }, result: 'applied' });
    store.addEntry({ batchId: b.id, videoId: 'BBB', fields: ['title'], before: { snippet: {} }, result: 'failed' });
    var ids = store.editedVideoIds();
    ok(ids.AAA); notOk(ids.BBB);
    store.markRestored([e.id]);
    notOk(store.editedVideoIds().AAA, 'restored videos leave the edited set');
  });

  test('store: export/import round-trips and de-duplicates', function () {
    store.state.batches = []; store.state.log = [];
    var b = store.startBatch({ label: 'roundtrip', pattern: pat({ find: 'q' }), fields: ['title'], planned: 1 });
    store.addEntry({ batchId: b.id, videoId: 'RT', videoTitle: 'T', fields: ['title'], before: { snippet: { title: 'T', description: 'D', tags: ['t'], categoryId: '28' } }, result: 'applied' });
    var payload = JSON.stringify(store.exportPayload());

    var before = store.state.log.length;
    var r1 = store.importBackup(payload);
    ok(r1.ok);
    eq(r1.added, 0, 'importing the same file twice must not duplicate');
    eq(store.state.log.length, before);

    store.state.batches = []; store.state.log = [];
    var r2 = store.importBackup(payload);
    eq(r2.added, 1);
    eq(r2.addedBatches, 1);
    eq(store.state.log[0].videoId, 'RT');
    eq(store.state.log[0].before.snippet.description, 'D');
    eq(store.entriesForBatch(b.id, true).length, 1, 'imported history must be restorable');
  });

  test('store: import rejects non-backup JSON', function () {
    var r = store.importBackup('{"hello":1}');
    notOk(r.ok);
    has(r.error, 'Not a yt-bulk-edits backup');
    var r2 = store.importBackup('{not json');
    notOk(r2.ok);
    has(r2.error, 'Not valid JSON');
  });

  test('store: saveAuth never persists the client secret', function () {
    store.saveSettings({ rememberTokens: true });
    store.saveAuth({ mode: 'code', accessToken: 'ya29.x', clientSecret: 'SUPERSECRET', refreshToken: 'r' });
    var raw = store.read('auth', null);
    ok(raw, 'auth should be persisted');
    eq(raw.accessToken, 'ya29.x');
    notOk('clientSecret' in raw, 'client secret must not be written with the auth blob');
    ok(JSON.stringify(store.exportPayload()).indexOf('SUPERSECRET') === -1, 'backups must not contain secrets');
    store.clearAuth();
    eq(store.read('auth', null), null);
  });

  test('store: authExpired honours the 60s safety margin', function () {
    store.saveAuth({ mode: 'code', accessToken: 'a', expiresAt: Date.now() + 120000 });
    notOk(store.authExpired());
    store.saveAuth({ mode: 'code', accessToken: 'a', expiresAt: Date.now() + 30000 });
    ok(store.authExpired(), 'within 60s of expiry counts as expired');
    store.saveAuth({ mode: 'token', accessToken: 'a', expiresAt: null });
    notOk(store.authExpired(), 'pasted tokens have unknown expiry');
    store.clearAuth();
    ok(store.authExpired());
  });

  /* ==================================================================
   * 10. auth helpers
   * ================================================================== */

  test('auth: extractCode accepts a full redirected URL', function () {
    var r = auth.extractCode('http://localhost:64834/callback?code=4%2F0AXabc-xyz&state=st-123&scope=x');
    eq(r.code, '4/0AXabc-xyz');
    eq(r.state, 'st-123');
  });

  test('auth: extractCode accepts a bare code and a "code=" prefix', function () {
    eq(auth.extractCode('4/0AX-bare').code, '4/0AX-bare');
    eq(auth.extractCode('code=4/0AX-prefixed').code, '4/0AX-prefixed');
  });

  test('auth: extractCode explains access_denied', function () {
    var err = throwsWith(function () { auth.extractCode('http://localhost:64834/callback?error=access_denied'); }, /Test user/);
    has(err.message, 'access_denied');
  });

  test('auth: extractCode rejects a URL with no code', function () {
    throwsWith(function () { auth.extractCode('http://localhost:64834/callback?scope=x'); }, /No "code" parameter/);
    throwsWith(function () { auth.extractCode('   '); }, /Paste the code/);
  });

  test('auth: PKCE challenge matches the RFC 7636 Appendix B vector', async function () {
    var verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    var challenge = await auth.sha256Challenge(verifier);
    eq(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('auth: verifier is URL-safe and long enough', function () {
    var v = auth.randomVerifier();
    ok(v.length >= 43 && v.length <= 128, 'length out of range: ' + v.length);
    notOk(/[+/=]/.test(v), 'must be base64url');
    notOk(v === auth.randomVerifier(), 'verifiers must be unique');
  });

  test('auth: buildAuthUrl carries PKCE, offline access and consent', function () {
    var url = auth.buildAuthUrl({ clientId: 'CID', redirectUri: 'http://localhost:64834/callback', state: 'st1', codeChallenge: 'CHAL', scope: auth.SCOPE });
    has(url, 'https://accounts.google.com/o/oauth2/v2/auth?');
    has(url, 'client_id=CID');
    has(url, 'code_challenge=CHAL');
    has(url, 'code_challenge_method=S256');
    has(url, 'access_type=offline');
    has(url, 'prompt=consent');
    has(url, 'state=st1');
    has(url, 'redirect_uri=http%3A%2F%2Flocalhost%3A64834%2Fcallback');
    has(url, encodeURIComponent(auth.SCOPE));
  });

  test('auth: usePastedToken strips header noise and rejects junk', function () {
    store.saveSettings({ rememberTokens: false });
    var a = auth.usePastedToken('  Authorization: Bearer ya29.a0AfH6SM-real-looking-token-value  ');
    eq(a.accessToken, 'ya29.a0AfH6SM-real-looking-token-value');
    eq(a.mode, 'token');
    throwsWith(function () { auth.usePastedToken('nope'); }, /does not look like/);
    throwsWith(function () { auth.usePastedToken('   '); }, /Paste an access token/);
    store.clearAuth();
  });

  test('auth: ensureToken throws needsAuth when signed out', async function () {
    store.clearAuth();
    var err = null;
    try { await auth.ensureToken(); } catch (e) { err = e; }
    ok(err); eq(err.needsAuth, true);
  });

  test('auth: ensureToken returns a live token untouched', async function () {
    store.saveSettings({ rememberTokens: false });
    store.saveAuth({ mode: 'token', accessToken: 'ya29.good', expiresAt: null });
    eq(await auth.ensureToken(), 'ya29.good');
    store.clearAuth();
  });

  test('auth: code exchange posts form-encoded PKCE data', async function () {
    var s = stubFetch(function (url, init) {
      return jsonResponse({ access_token: 'ya29.new', refresh_token: 'rr', expires_in: 3599, scope: auth.SCOPE }, 200);
    });
    try {
      var tok = await auth.exchangeCode({ code: 'CODE', clientId: 'CID', clientSecret: 'SEC', redirectUri: 'http://localhost:64834/callback', codeVerifier: 'VER' });
      eq(tok.access_token, 'ya29.new');
      eq(s.calls[0].url, auth.TOKEN_ENDPOINT);
      eq(s.calls[0].init.method, 'POST');
      has(s.calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      has(s.calls[0].init.body, 'grant_type=authorization_code');
      has(s.calls[0].init.body, 'code_verifier=VER');
      has(s.calls[0].init.body, 'client_secret=SEC');
    } finally { s.restore(); }
  });

  test('auth: refresh surfaces Google\'s error description', async function () {
    var s = stubFetch(function () {
      return {
        ok: false, status: 400,
        headers: { get: function () { return null; } },
        text: function () { return Promise.resolve(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })); }
      };
    });
    try {
      var err = null;
      try { await auth.refreshWithToken('r', 'CID', ''); } catch (e) { err = e; }
      ok(err);
      has(err.message, 'Token has been expired or revoked');
      eq(err.tokenError, 'invalid_grant');
    } finally { s.restore(); }
  });

  test('auth: finishCodeFlow requires a started flow', async function () {
    sessionStorage.removeItem('ytbe.pendingCode');
    var err = null;
    try { await auth.finishCodeFlow('4/0AX-code'); } catch (e) { err = e; }
    ok(err);
    has(err.message, 'No sign-in in progress');
  });

  test('auth: helperStatus reports unavailable without throwing', async function () {
    var s = stubFetch(function () { throw new TypeError('Failed to fetch'); });
    try {
      var st = await auth.helperStatus();
      eq(st.available, false);
      ok(st.url);
    } finally { s.restore(); }
  });

  /* ==================================================================
   * 11. demo data + integration through the real engine
   * ================================================================== */

  test('demo: sample data includes the documented edge cases', function () {
    var vids = YTBE.demo.sampleVideos();
    eq(vids.length, 12);
    ok(vids.some(function (v) { return v.snippet.title.length >= 99; }), 'needs a near-limit title');
    ok(vids.some(function (v) { return !v.snippet.tags.length; }), 'needs a tagless video');
    ok(vids.some(function (v) { return /[\u0400-\u04FF]/.test(v.snippet.title); }), 'needs non-ASCII');
    ok(vids.some(function (v) { return v.status.privacyStatus === 'private'; }));
    ok(vids.some(function (v) { return v.snippet.tags.length > 20; }), 'needs a big tag list');
    vids.forEach(function (v) { ok(v.snippet.categoryId, v.id + ' missing categoryId'); });
  });

  test('integration: strip "[2024 REMASTER] " from the demo channel', function () {
    var vids = YTBE.demo.sampleVideos();
    var p = pat({ find: '[2024 REMASTER] ', replace: '' });
    var changed = vids.map(function (v) { return T.computeEdits(v, p); }).filter(function (e) { return e.changed; });
    eq(changed.length, 3);
    eq(changed[0].changes.title.after, 'Building a Game Engine - Part 1 | FULL COURSE');
    changed.forEach(function (e) { notOk(e.blocked, 'none of these should be blocked'); });
  });

  test('integration: removing a suffix can push a row over the 100-char limit', function () {
    var vids = YTBE.demo.sampleVideos();
    var long = vids.filter(function (v) { return v.snippet.title.length >= 99; })[0];
    ok(long, 'sample should contain a long title');
    var p = pat({ mode: 'regex', find: '$', replace: ' (4K REMASTERED EDITION)' });
    var e = T.computeEdits(long, p);
    ok(e.changed);
    ok(e.blocked, 'a 99-char title plus a suffix must be blocked, not sent to the API');
    has(e.warnings[0].msg, 'YouTube allows 100');
  });

  test('integration: description edit preserves the title in the write body', function () {
    var v = YTBE.demo.sampleVideos()[0];
    var p = pat({ find: 'example.shop', replace: 'shop.example', fields: { title: false, description: true, tags: false } });
    var e = T.computeEdits(v, p);
    ok(e.changes.description.changed);
    var body = T.buildUpdateBody(v, e, {});
    eq(body.snippet.title, v.snippet.title, 'title must be sent unchanged');
    has(body.snippet.description, 'shop.example');
    notOk(body.snippet.description.indexOf('example.shop') !== -1);
    eq(body.snippet.tags, v.snippet.tags, 'tags must survive');
  });

  test('integration: full write/restore cycle over demo data is lossless', function () {
    var vids = YTBE.demo.sampleVideos();
    var p = pat({ find: 'Game Engine', replace: 'Renderer', fields: { title: true, description: false, tags: true } });
    var touched = 0;
    vids.forEach(function (v) {
      var original = util.deepClone(v.snippet);
      var e = T.computeEdits(v, p);
      if (!e.changed || e.blocked) return;
      touched++;
      var body = T.buildUpdateBody(v, e, {});
      var entry = { videoId: v.id, fields: ['title', 'tags'], before: { snippet: original, status: util.deepClone(v.status) }, after: { snippet: body.snippet } };
      var back = T.buildRestoreBody(entry).snippet;
      eq(back.title, original.title, 'title restore');
      eq(back.description, original.description, 'description restore');
      eq(back.tags, original.tags, 'tags restore');
      eq(back.categoryId, original.categoryId, 'category restore');
    });
    ok(touched >= 3, 'expected several videos to be touched, got ' + touched);
  });

  /* ==================================================================
   * 12. ui pure helpers (escaping / filtering)
   * ================================================================== */

  test('ui: markSpans escapes HTML so a title can never inject markup', function () {
    var evil = '<img src=x onerror=alert(1)> & "quoted"';
    var html = YTBE.ui.markSpans(evil, null, 'cut');
    notOk(/<img/.test(html), 'raw tag must be escaped');
    has(html, '&lt;img');
    has(html, '&amp;');
    has(html, '&quot;');
  });

  test('ui: markSpans wraps exactly the matched range', function () {
    var html = YTBE.ui.markSpans('aXbXc', [{ start: 1, end: 2 }, { start: 3, end: 4 }], 'cut');
    eq(html, 'a<mark class="cut">X</mark>b<mark class="cut">X</mark>c');
  });

  test('ui: markSpans sorts unsorted spans', function () {
    var html = YTBE.ui.markSpans('abcdef', [{ start: 4, end: 5 }, { start: 1, end: 2 }], 'ins');
    eq(html, 'a<mark class="ins">b</mark>cd<mark class="ins">e</mark>f');
  });

  test('ui: markSpans skips spans that overlap an earlier one', function () {
    var html = YTBE.ui.markSpans('abcdef', [{ start: 1, end: 3 }, { start: 2, end: 4 }], 'ins');
    eq(html, 'a<mark class="ins">bc</mark>def');
  });

  test('ui: videoHaystack picks the right field', function () {
    var v = mkVideo('VID9', 'My Title', 'My Description', ['tagA', 'tagB'], '28');
    eq(YTBE.ui.videoHaystack(v, 'title'), 'My Title');
    eq(YTBE.ui.videoHaystack(v, 'description'), 'My Description');
    eq(YTBE.ui.videoHaystack(v, 'tags'), 'tagA\ntagB');
    eq(YTBE.ui.videoHaystack(v, 'id'), 'VID9');
    has(YTBE.ui.videoHaystack(v, 'all'), 'tagB');
  });

  /* ---------------- runner ---------------- */

  async function run() {
    var lines = [];
    var pass = 0, fail = 0;
    var failures = [];

    /* Scope the reset to this app's keys only. A blanket localStorage.clear() on
       a file:// origin is shared by every local page and would be a footgun. */
    try { YTBE.store.wipeAll(); } catch (e) { }
    store.init();

    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      try {
        await t.fn();
        pass++;
        lines.push('PASS  ' + t.name);
      } catch (e) {
        fail++;
        var detail = (e && e.message) ? e.message : String(e);
        lines.push('FAIL  ' + t.name + '\n        ' + detail);
        failures.push(t.name + ' :: ' + detail);
        if (e && e.stack) lines.push('        ' + String(e.stack).split('\n').slice(1, 3).join('\n        '));
      }
      var out = document.getElementById('results');
      if (out) out.textContent = 'RUNNING ' + (i + 1) + '/' + tests.length + '\n' + lines.join('\n');
    }

    var res = document.getElementById('results');
    var sum = document.getElementById('summary');
    var text = lines.join('\n') + '\n\n' + (failures.length ? 'FAILURES:\n' + failures.join('\n') + '\n\n' : '') +
      'SUMMARY pass=' + pass + ' fail=' + fail + ' total=' + tests.length;
    if (res) res.textContent = text;
    if (sum) sum.textContent = 'SUMMARY pass=' + pass + ' fail=' + fail + ' total=' + tests.length;
    document.title = (fail ? 'FAILED ' : 'OK ') + pass + '/' + tests.length;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})(typeof window !== 'undefined' ? window : globalThis);

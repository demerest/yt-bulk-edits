/* yt-bulk-edits :: tests/autotest.js — end-to-end DOM driver.
 *
 * Loaded only by index.html?autotest=1. Drives the real page: boot, demo data,
 * pattern entry, preview rendering (including the diff markup and XSS escaping),
 * the apply pipeline and the rollback path. Writes are simulated because demo
 * mode is on, so nothing touches YouTube.
 */
(function (global) {
  'use strict';

  var results = [];
  var pass = 0, fail = 0;
  var downloads = [];
  var outPre = null;
  var currentStep = '(none)';

  /* Render progress live: if the browser dumps the DOM mid-run (or a step
     hangs), the partial output still says exactly where it stopped. */
  function flush(marker) {
    try {
      if (!outPre) {
        outPre = document.createElement('pre');
        outPre.id = 'autotest-results';
        document.body.appendChild(outPre);
      }
      outPre.textContent = results.join('\n') + (marker ? '\n\n' + marker : '');
    } catch (e) { /* reporting must never break the run */ }
  }

  /* Reset every control that influences the preview. Called before each step so
     a failure (which skips the rest of that step's cleanup) cannot poison the
     next one — that cascade cost a full debugging round. */
  function resetUi() {
    ['#fltText', '#fltFrom', '#fltTo', '#fltIds', '#patFind', '#patReplace', '#patFlags'].forEach(function (s) {
      var n = $(s);
      if (n && n.value !== '') { n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    var sel = { '#fltPrivacy': '', '#fltField': 'title', '#patMode': 'literal' };
    Object.keys(sel).forEach(function (s) {
      var n = $(s);
      if (n && n.value !== sel[s]) { n.value = sel[s]; n.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    var mx = $('#optMax');
    if (mx && Number(mx.value) !== 0) { mx.value = 0; mx.dispatchEvent(new Event('input', { bubbles: true })); }
    setCheck('#chkChangedOnly', true);
    setCheck('#chkFltUnedited', false);
    setCheck('#chkFltRegex', false);
    setCheck('#chkFltCase', false);
    setCheck('#optCase', false);
    setCheck('#optWord', false);
    setCheck('#fldTitle', true);
    setCheck('#fldDescription', false);
    setCheck('#fldTags', false);
  }

  function step(name, fn) {
    currentStep = name;
    flush('RUNNING  ' + name);
    /* Promise.resolve().then(fn) so a synchronous throw inside fn is reported as
       a normal step failure instead of aborting the whole run. */
    return Promise.resolve().then(function () { resetUi(); return wait(320); }).then(fn).then(function () {
      pass++;
      results.push('PASS  ' + name);
      flush();
    }, function (e) {
      fail++;
      results.push('FAIL  ' + name + '\n        ' + ((e && e.message) || e));
      if (e && e.stack) results.push('        ' + String(e.stack).split('\n').slice(1, 3).join('\n        '));
      flush();
    });
  }

  function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy, got ' + JSON.stringify(v)); }
  function eq(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a));
  }
  function has(hay, needle, msg) {
    if (String(hay == null ? '' : hay).indexOf(needle) === -1) throw new Error((msg || 'missing substring') + ': "' + needle + '" not in "' + String(hay).slice(0, 200) + '"');
  }
  function notHas(hay, needle, msg) {
    if (String(hay == null ? '' : hay).indexOf(needle) !== -1) throw new Error((msg || 'unexpected substring') + ': "' + needle + '" found in "' + String(hay).slice(0, 200) + '"');
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitFor(pred, timeout, what) {
    var deadline = Date.now() + (timeout || 15000);
    return new Promise(function (resolve, reject) {
      (function poll() {
        var v = null;
        try { v = pred(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() > deadline) return reject(new Error('timed out waiting for ' + (what || 'condition')));
        setTimeout(poll, 60);
      })();
    });
  }

  function $(s) { return document.querySelector(s); }
  function $all(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function text(s) { var n = $(s); return n ? n.textContent : null; }

  function setVal(sel, value) {
    var n = $(sel);
    if (!n) throw new Error('no element ' + sel);
    n.value = value;
    n.dispatchEvent(new Event('input', { bubbles: true }));
    n.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setCheck(sel, on) {
    var n = $(sel);
    if (!n) throw new Error('no element ' + sel);
    if (n.checked !== on) { n.checked = on; n.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  function click(sel) {
    var n = $(sel);
    if (!n) throw new Error('no element ' + sel);
    if (n.disabled) throw new Error(sel + ' is disabled');
    n.click();
    return n;
  }
  function rows() { return $all('#previewBody tr.prow'); }
  function confirmModalButton() {
    var b = $('#modalRoot .modal-actions .btn.danger') || $('#modalRoot .modal-actions .btn.primary');
    if (!b) throw new Error('modal confirm button not found');
    if (b.disabled) throw new Error('modal confirm button is disabled');
    return b;
  }

  async function run() {
    /* Keep tests from writing files into the user's Downloads folder. */
    YTBE.util.download = function (filename, content, mime) {
      downloads.push({ filename: filename, bytes: String(content || '').length, mime: mime });
    };

    /* ---------- 1. boot ---------- */
    await step('app boots: ui.init rendered the header widgets', function () {
      has(text('#quotaChip'), 'Quota 0 /');
      has(text('#quotaChip'), '10,000');
      eq(text('#authModeChip').trim(), 'Not connected');
      has(text('#previewBody'), 'Load videos');
      ok($('#btnApply').disabled, 'Apply must start disabled');
      has(text('#storageInfo'), 'KB of browser storage used');
      return Promise.resolve();
    });

    await step('app boots: no auth panel is left blank', function () {
      ok($('#panel-helper') && !$('#panel-helper').classList.contains('hidden'), 'helper panel should be the default tab');
      ok($('#panel-token').classList.contains('hidden'));
      ok($('#panel-code').classList.contains('hidden'));
      eq($all('#authTabs .tab').length, 3);
      return Promise.resolve();
    });

    await step('auth tabs switch panels', function () {
      click('#authTabs .tab[data-mode="token"]');
      ok(!$('#panel-token').classList.contains('hidden'));
      ok($('#panel-helper').classList.contains('hidden'));
      ok($('#lnkPlayground').href.indexOf('oauthplayground') !== -1, 'playground link must be wired');
      has($('#lnkPlayground').href, encodeURIComponent(YTBE.auth.SCOPE));
      click('#authTabs .tab[data-mode="code"]');
      ok(!$('#panel-code').classList.contains('hidden'));
      eq($('#inpRedirect').value, YTBE.auth.LOOPBACK_REDIRECT, 'redirect URI should be pre-filled');
      click('#authTabs .tab[data-mode="helper"]');
      ok(!$('#panel-helper').classList.contains('hidden'));
      return Promise.resolve();
    });

    /* ---------- 2. demo data ---------- */
    await step('demo mode loads 12 sample videos and renders the preview', async function () {
      click('#btnDemo');
      has(text('#channelChip'), 'Demo Channel');
      has(text('#loadSummary'), '12 loaded');
      eq(YTBE.store.state.videos.length, 12);
      has(text('#previewBody'), 'Nothing to show', 'with no pattern and changed-only on, the table should be empty');
      has(text('#applyHint'), 'Demo mode');
    });

    /* ---------- 3. literal find & replace preview ---------- */
    await step('literal pattern previews 3 changes with exact diff markup', async function () {
      setVal('#patFind', '[2024 REMASTER] ');
      setVal('#patReplace', '');
      await waitFor(function () { return rows().length === 3; }, 5000, '3 preview rows');

      has(text('#previewSummary'), '3 would change');
      has(text('#previewSummary'), '3 selected');
      has(text('#previewSummary'), 'quota cost 150 units');
      has($('#btnApply').textContent, 'Apply to 3 videos');
      ok(!$('#btnApply').disabled, 'Apply should be enabled');

      var first = rows()[0];
      eq(first.querySelectorAll('mark.cut').length, 1, 'exactly one removed span');
      eq(first.querySelector('mark.cut').textContent, '[2024 REMASTER] ', 'the struck-through text must be the literal match');
      eq(first.querySelectorAll('mark.ins').length, 0, 'deleting leaves nothing inserted');
      has(first.querySelector('.cut-row .fval').textContent, 'Building a Game Engine - Part 1');
      eq(first.querySelector('.ins-row .fval').textContent, 'Building a Game Engine - Part 1 | FULL COURSE');
      ok(first.classList.contains('changed'));
      has(first.querySelector('.col-state').textContent, '1 change');
    });

    await step('filtering by text narrows the preview', async function () {
      setVal('#patFind', '[2024 REMASTER] ');
      setVal('#patReplace', '');
      await waitFor(function () { return rows().length === 3; }, 6000, '3 rows');
      setVal('#fltText', 'Part 2');
      /* Wait on content, not just the row count: the count is already 1 from the
         previous state, so a count-only predicate would pass on stale DOM. */
      await waitFor(function () {
        return rows().length === 1 && /Part 2/.test(rows()[0].textContent);
      }, 6000, '1 filtered row showing Part 2');
      setVal('#fltText', '');
      await waitFor(function () { return rows().length === 3; }, 6000, '3 rows again');
    });

    await step('privacy filter narrows to the matching videos', async function () {
      /* Turn off changed-only so the filter is tested directly, not through the
         pattern — with it on, an unchanged row would look identical to no match. */
      setCheck('#chkChangedOnly', false);
      setVal('#fltPrivacy', 'private');
      await waitFor(function () {
        return rows().length === 1 && /Private draft/.test(rows()[0].textContent);
      }, 6000, 'exactly one private video');
      has(text('#previewSummary'), '1 in filter');

      setVal('#fltPrivacy', 'unlisted');
      await waitFor(function () {
        return rows().length === 1 && /Unlisted experiment/.test(rows()[0].textContent);
      }, 6000, 'exactly one unlisted video');

      setVal('#fltPrivacy', 'public');
      await waitFor(function () { return rows().length === 10; }, 6000, 'ten public videos');
      has(text('#previewSummary'), '10 in filter');
    });

    /* ---------- 4. description + tags ---------- */
    await step('description field can be targeted independently', async function () {
      setVal('#patFind', 'example.shop');
      setVal('#patReplace', 'shop.example');
      setCheck('#fldTitle', false);
      setCheck('#fldDescription', true);
      await waitFor(function () {
        return rows().length > 0 && $('#previewBody').querySelector('.fb .flabel').textContent === 'Description';
      }, 5000, 'description rows');
      ok(rows().length >= 4, 'several demo videos mention the shop, got ' + rows().length);
      var labels = $all('#previewBody .flabel').map(function (n) { return n.textContent; });
      ok(labels.indexOf('Description') !== -1, 'Description block should render');
      eq(labels.indexOf('Title'), -1, 'Title must not be edited when its checkbox is off');
      has($('#previewBody').querySelector('mark.cut').textContent, 'example.shop');
      setCheck('#fldDescription', false);
      setCheck('#fldTitle', true);
    });

    await step('tags are edited per tag and rendered as chips', async function () {
      setVal('#patFind', '2024');
      setVal('#patReplace', '2025');
      setCheck('#fldTitle', false);
      setCheck('#fldTags', true);
      await waitFor(function () { return $all('#previewBody .chip-tag').length > 0; }, 5000, 'tag chips');
      var changedChips = $all('#previewBody .chip-tag.cut');
      ok(changedChips.length > 0, 'some tags should be marked as changed');
      eq(changedChips[0].textContent, '2024 remaster', 'the whole tag is struck, not just the match');
      var ins = $all('#previewBody .chip-tag.ins');
      ok(ins.some(function (n) { return n.textContent === '2025 remaster'; }), 'new tag chip expected');
      setCheck('#fldTags', false);
      setCheck('#fldTitle', true);
    });

    /* ---------- 5. regex mode ---------- */
    await step('regex mode with capture groups previews correctly', async function () {
      click('#patMode') && setVal('#patMode', 'regex');
      $('#patMode').value = 'regex';
      $('#patMode').dispatchEvent(new Event('change', { bubbles: true }));
      setVal('#patFind', '^(\\[\\d{4} REMASTER\\])\\s');
      setVal('#patReplace', '$1 ::');
      await waitFor(function () { return rows().length === 3; }, 5000, '3 regex rows');
      ok(!$('#regexOpts').classList.contains('hidden'), 'regex options should appear');
      has(rows()[0].querySelector('.ins-row .fval').textContent, '[2024 REMASTER] ::Building');
      setVal('#patFind', '');
      setVal('#patReplace', '');
    });

    await step('an invalid regex is reported, not thrown', async function () {
      $('#patMode').value = 'regex';
      $('#patMode').dispatchEvent(new Event('change', { bubbles: true }));
      setVal('#patFind', '([unclosed');
      await waitFor(function () { return /Invalid regular expression/.test(text('#patError')); }, 5000, 'regex error');
      has(text('#previewSummary'), 'Invalid regular expression');
      ok($('#btnApply').disabled, 'Apply must stay disabled on an invalid pattern');
      $('#patMode').value = 'literal';
      $('#patMode').dispatchEvent(new Event('change', { bubbles: true }));
      setVal('#patFind', '');
    });

    /* ---------- 6. validation blocking ---------- */
    await step('a result over the 100-char title limit is blocked, not selected', async function () {
      $('#patMode').value = 'regex';
      $('#patMode').dispatchEvent(new Event('change', { bubbles: true }));
      setVal('#patFind', '$');
      setVal('#patReplace', ' (4K REMASTERED EDITION)');
      await waitFor(function () { return $('#previewBody').querySelector('tr.blocked'); }, 5000, 'a blocked row');
      has(text('#previewSummary'), 'blocked by validation');
      var blocked = $('#previewBody tr.blocked');
      has(blocked.textContent, 'YouTube allows 100');
      has(blocked.querySelector('.col-state').textContent, 'blocked');
      ok(blocked.querySelector('.rowCheck').disabled, 'blocked rows must not be selectable');
      notHas(text('#btnApply').textContent, 'Apply to 13', 'blocked rows must be excluded from the apply count');
      $('#patMode').value = 'literal';
      $('#patMode').dispatchEvent(new Event('change', { bubbles: true }));
      setVal('#patFind', '');
      setVal('#patReplace', '');
    });

    /* ---------- 7. apply + rollback ---------- */
    await step('apply pipeline: confirm modal, simulated writes, history entry', async function () {
      setVal('#patFind', '[2024 REMASTER] ');
      setVal('#patReplace', '');
      await waitFor(function () { return rows().length === 3; }, 5000, '3 rows');

      downloads.length = 0;
      click('#btnApply');
      var modal = await waitFor(function () { return $('#modalRoot .modal-backdrop'); }, 4000, 'confirm modal');
      has(modal.textContent, 'permanently change 3 videos');
      has(modal.textContent, '150 units');
      has(modal.textContent, 'Demo mode');
      has(modal.textContent, 'title');

      confirmModalButton().click();
      await waitFor(function () { return /Batch complete/.test(text('#applyProgress')) || $all('#applyLog .log-line.ok').length >= 3; }, 20000, 'apply to finish');
      await wait(400);

      eq($all('#applyLog .log-line.ok').length, 3, 'three successes logged');
      eq($all('#applyLog .log-line.error').length, 0, 'no failures');
      eq(YTBE.store.state.log.length, 3, 'three change records stored');
      eq(YTBE.store.state.batches.length, 1, 'one batch created');
      ok(downloads.length >= 1, 'a backup file must be produced before writing');
      has(downloads[0].filename, 'yt-bulk-edits-backup-');
      ok(downloads[0].bytes > 200, 'backup should contain real data, got ' + downloads[0].bytes + ' bytes');

      has(text('#batchList'), '3 applied');
      has(text('#batchList'), 'Restore 3 videos');

      /* the in-memory copies moved forward */
      var edited = YTBE.store.state.videos.filter(function (v) { return v.id === 'DEMO0001aaa'; })[0];
      eq(edited.snippet.title, 'Building a Game Engine - Part 1 | FULL COURSE');
      /* and the snapshot kept the original */
      eq(YTBE.store.state.log.filter(function (e) { return e.videoId === 'DEMO0001aaa'; })[0].before.snippet.title, '[2024 REMASTER] Building a Game Engine - Part 1 | FULL COURSE');
      /* changed-only preview is now empty because nothing else matches */
      has(text('#previewBody'), 'Nothing to show');
    });

    await step('rollback: restoring the batch returns the original titles', async function () {
      var restoreBtn = $all('#batchList .batch-actions .btn.danger')[0];
      ok(restoreBtn, 'restore button must exist');
      has(restoreBtn.textContent, 'Restore 3 videos');
      restoreBtn.click();

      var modal = await waitFor(function () { return $('#modalRoot .modal-backdrop'); }, 4000, 'restore modal');
      has(modal.textContent, 'stored original');
      has(modal.textContent, '150 units');
      confirmModalButton().click();

      await waitFor(function () { return /Restore finished/.test(text('#applyProgress')); }, 20000, 'restore to finish');
      await wait(300);

      var v = YTBE.store.state.videos.filter(function (x) { return x.id === 'DEMO0001aaa'; })[0];
      ok(v, 'video should still be loaded');
      eq(v.snippet.title, '[2024 REMASTER] Building a Game Engine - Part 1 | FULL COURSE', 'the loaded copy must be synced back too');
      eq(v.snippet.tags, ['game engine', 'coding tutorial', '2024 remaster', 'c++'], 'tags must survive the round-trip');
      var entry = YTBE.store.state.log.filter(function (e) { return e.videoId === 'DEMO0001aaa' && e.restoredAt; })[0];
      ok(entry, 'the original entry must be marked restored');
      eq(entry.before.snippet.title, '[2024 REMASTER] Building a Game Engine - Part 1 | FULL COURSE');

      /* The rollback itself is recorded as a new (newest-first) batch, so locate
         the restored card by its badge rather than by position. */
      var restoredCard = $all('#batchList .batch').filter(function (c) {
        return /restored/.test(c.querySelector('.batch-head').textContent);
      })[0];
      ok(restoredCard, 'a restored badge should be shown');
      ok(restoredCard.querySelector('.batch-actions .btn.danger').disabled, 'a restored batch must not be restorable again');
      eq(YTBE.store.editedVideoIds()['DEMO0001aaa'], undefined, 'restored videos leave the edited set');
      ok(YTBE.store.state.log.filter(function (e) { return e.kind === 'restore'; }).length === 3, 'rollback writes are recorded as kind=restore');
    });

    /* ---------- 8. backup round-trip ---------- */
    await step('backup export/import round-trips through the UI', function () {
      var payload = JSON.stringify(YTBE.store.exportPayload());
      var keep = YTBE.store.state.log.length;
      var dup = YTBE.store.importBackup(payload);
      ok(dup.ok);
      eq(dup.added, 0, 're-importing the same file must not duplicate');
      eq(YTBE.store.state.log.length, keep);

      YTBE.store.state.log = [];
      YTBE.store.state.batches = [];
      var r = YTBE.store.importBackup(payload);
      ok(r.added >= 3, 'cleared history should come back, got ' + r.added);
      YTBE.ui.renderHistory();
      has(text('#batchList'), 'applied');
      var bad = YTBE.store.importBackup('{"nope":true}');
      ok(!bad.ok, 'foreign JSON must be rejected');
      return Promise.resolve();
    });

    /* ---------- 9. XSS ---------- */
    await step('a hostile title is escaped in the preview, never injected', async function () {
      YTBE.demo.loadDemo();
      YTBE.store.state.videos.push({
        id: 'XSS00000001',
        snippet: {
          title: 'SAFE<img src=x onerror="window.__pwned=1"> & "quoted" <script>window.__pwned=2;<\/script>',
          description: '<b onmouseover="window.__pwned=3">hover</b>',
          tags: ['<script>alert(1)<\/script>'], categoryId: '28', channelTitle: 'x',
          publishedAt: '2024-01-01T00:00:00Z', defaultLanguage: '', defaultAudioLanguage: '', localized: null, thumbnails: null
        },
        status: { privacyStatus: 'public' }, contentDetails: { duration: 'PT1M' }, statistics: { viewCount: '1' }
      });
      setVal('#patFind', 'SAFE');
      setVal('#patReplace', '');
      await waitFor(function () { return $('#previewBody tr[data-id="XSS00000001"]'); }, 5000, 'xss row');

      var row = $('#previewBody tr[data-id="XSS00000001"]');
      var html = row.innerHTML;
      notHas(html, '<img', 'raw <img> must never reach the DOM');
      notHas(html, '<script', 'raw <script> must never reach the DOM');
      /* The escaped TEXT still contains "onerror=" as inert characters, which is
         correct — what must never exist is a live element carrying the attribute. */
      eq(row.querySelectorAll('[onerror]').length, 0, 'no element may carry an onerror attribute');
      eq(row.querySelectorAll('*[onload]').length, 0, 'no element may carry an onload attribute');
      has(html, '&lt;img', 'the tag must be escaped in the markup');
      has(html, '&amp;', 'the ampersand must be escaped in the markup');
      /* NB: innerHTML re-serialises text nodes and does NOT escape a double
         quote there, so assert on textContent for the quote case. */
      has(row.textContent, '"quoted"', 'quotes must survive as inert text');
      has(row.textContent, '<img src=x onerror=', 'the tag must survive as inert text');
      eq(global.__pwned, undefined, 'no injected handler may have run');
      eq(row.querySelectorAll('img').length, 0, 'no live img elements');
      eq(row.querySelectorAll('script').length, 0, 'no live script elements');
      eq(row.querySelector('.cut-row mark.cut').textContent, 'SAFE', 'the matched text is still marked for removal');
    });

    /* ---------- report ---------- */
    var summary = 'AUTOTEST pass=' + pass + ' fail=' + fail + ' total=' + (pass + fail);
    flush(summary);
    var s2 = document.createElement('pre');
    s2.id = 'autotest-summary';
    s2.textContent = summary;
    document.body.appendChild(s2);
    document.title = (fail ? 'AUTOTEST-FAILED ' : 'AUTOTEST-OK ') + pass + '/' + (pass + fail);
  }

  function start() {
    setTimeout(function () {
      run().catch(function (e) {
        results.push('FATAL ' + ((e && e.message) || e) + '\n' + ((e && e.stack) || ''));
        flush('FATAL during ' + currentStep);
      });
    }, 250);
  }

  /* Do not depend on `load`: a dynamically-inserted script can miss it under
     headless virtual time. DOMContentLoaded is enough — ui.js registered its
     own listener earlier in the document, so init() has already run. */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window !== 'undefined' ? window : globalThis);

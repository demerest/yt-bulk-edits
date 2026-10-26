/* yt-bulk-edits :: api.js — YouTube Data API v3 client.
 *
 * Verified on this machine: googleapis.com answers CORS preflights with
 * Access-Control-Allow-Origin: null / Allow-Headers: authorization, so these
 * calls work straight from a file:// page (probe returned 401 authError).
 *
 * Error handling is the important part: rate limits must back off and retry,
 * quota exhaustion must abort the whole batch immediately, and 401s must
 * surface as "re-authenticate" rather than a generic failure.
 */
(function (global) {
  'use strict';

  var YTBE = global.YTBE = global.YTBE || {};
  var store = YTBE.store;
  var util = YTBE.util;

  var BASE = 'https://www.googleapis.com/youtube/v3';

  /* Google is inconsistent about the casing of `reason`, so every set is stored
   * lowercase and compared case-insensitively (this used to be a real bug:
   * 'invalidCredentials' never matched and was mis-reported as a plain failure). */
  var RETRY_REASONS = ['ratelimitexceeded', 'userratelimitexceeded', 'quotaexceededfornow', 'backenderror', 'internalerror', 'serviceunavailable'];
  var AUTH_REASONS = ['autherror', 'invalidcredentials', 'expired_token', 'invalid_token', 'unauthorized', 'authtoken_expired', 'invalidauthentication'];
  var QUOTA_REASONS = ['quotaexceeded', 'dailylimitexceeded', 'userratelimitexceededforwrite', 'dailywritelimitexceeded', 'dailylimitexceededunregulate'];

  function inReasonList(list, reason) {
    return list.indexOf(String(reason == null ? '' : reason).toLowerCase()) !== -1;
  }

  function ApiError(message, info) {
    var e = new Error(message);
    e.name = 'ApiError';
    Object.assign(e, info || {});
    return e;
  }

  function classify(status, reason, message) {
    var info = { status: status, reason: reason || 'unknown', retryable: false, fatal: false, needsAuth: false, quota: false };
    /* Quota first: a 403 quotaExceeded must abort the batch, not trigger a re-auth prompt. */
    if (inReasonList(QUOTA_REASONS, reason) || /quota/i.test(message || '')) { info.quota = true; info.fatal = true; return info; }
    if (status === 401 || inReasonList(AUTH_REASONS, reason)) { info.needsAuth = true; return info; }
    if (status === 429 || inReasonList(RETRY_REASONS, reason)) { info.retryable = true; return info; }
    if (status >= 500) { info.retryable = true; return info; }
    return info;
  }

  function buildQuery(params) {
    var qs = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return qs.length ? '?' + qs.join('&') : '';
  }

  /**
   * One API call with retry/backoff. Costs are charged to the quota ledger.
   * opts: {method, params, body, token, cost, retries, signal, onRetry}
   */
  async function request(path, opts) {
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    var url = BASE + path + buildQuery(opts.params);
    var maxRetries = opts.retries == null ? (store ? store.state.settings.maxRetries : 3) : opts.retries;
    var token = opts.token;
    var lastErr = null;

    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      if (opts.signal && opts.signal.aborted) throw ApiError('Cancelled', { aborted: true });

      var res, text = '';
      try {
        res = await fetch(url, {
          method: method,
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: opts.body == null ? undefined : JSON.stringify(opts.body),
          signal: opts.signal
        });
        text = await res.text();
      } catch (netErr) {
        if (netErr && netErr.name === 'AbortError') throw ApiError('Cancelled', { aborted: true });
        lastErr = ApiError('Network error: ' + netErr.message, { retryable: true, status: 0, network: true });
        if (attempt >= maxRetries) throw lastErr;
        await backoff(attempt, 0, opts);
        continue;
      }

      var data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }

      if (res.ok) {
        if (opts.cost) store.spendQuota(opts.cost, path);
        return data;
      }

      /* Failed requests still cost at least 1 quota unit. */
      store.spendQuota(1, path + ' (error)');

      var errObj = (data && data.error) || {};
      var first = (errObj.errors && errObj.errors[0]) || {};
      var reason = first.reason || '';
      var message = first.message || errObj.message || ('HTTP ' + res.status);
      var info = classify(res.status, reason, message);
      var err = ApiError(message, Object.assign({ title: first.message }, info));

      if (!info.retryable || attempt >= maxRetries) throw err;
      lastErr = err;
      var retryAfter = Number(res.headers.get('Retry-After') || 0);
      if (opts.onRetry) opts.onRetry({ attempt: attempt + 1, reason: reason, message: message });
      await backoff(attempt, retryAfter, opts);
    }
    throw lastErr || ApiError('Request failed', {});
  }

  function backoff(attempt, retryAfterSec, opts) {
    var ms = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.min(30000, 1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 400);
    if (opts.onBackoff) opts.onBackoff(ms, attempt + 1);
    return util.sleep(ms);
  }

  /* ---------- endpoints ---------- */

  /** Who am I? Used to validate a token and show the channel in the header. */
  async function getChannel(token, signal) {
    var data = await request('/channels', { params: { part: 'snippet,contentDetails,statistics', mine: 'true' }, token: token, cost: 1, signal: signal });
    var item = (data && data.items && data.items[0]) || null;
    if (!item) throw ApiError('Token is valid but no channel is attached to it.', { needsAuth: true, status: 200 });
    return {
      id: item.id,
      title: item.snippet && item.snippet.title,
      description: item.snippet && item.snippet.description,
      thumbnail: item.snippet && item.snippet.thumbnails && item.snippet.thumbnails.default && item.snippet.thumbnails.default.url,
      country: item.snippet && item.snippet.country,
      uploadsPlaylist: item.contentDetails && item.contentDetails.relatedPlaylists && item.contentDetails.relatedPlaylists.uploads,
      videoCount: item.statistics && Number(item.statistics.videoCount || 0),
      viewCount: item.statistics && Number(item.statistics.viewCount || 0),
      subscriberCount: item.statistics && Number(item.statistics.subscriberCount || 0)
    };
  }

  /**
   * Every upload on the authenticated channel.
   *
   * videos.list has NO `mine` filter — its only filters are chart/id/myRating, so
   * sending mine=true makes Google answer "No filter selected. Expected one of:
   * chart, id, myRating". The supported route is:
   *   channels(mine) -> contentDetails.relatedPlaylists.uploads
   *   -> playlistItems (ids, upload order) -> videos?id= (full metadata)
   * Cost: 1 (channel, skipped if the playlist id is passed in) + 1 per 50
   * playlist page + 1 per 50 videos.
   */
  async function listMyVideos(opts) {
    opts = opts || {};
    var token = opts.token, signal = opts.signal;
    var maxPages = opts.maxPages || 400;

    var playlistId = opts.uploadsPlaylist;
    if (!playlistId) {
      var channel = await getChannel(token, signal);
      playlistId = channel.uploadsPlaylist;
    }
    if (!playlistId) throw ApiError('This channel exposes no uploads playlist, so there is nothing to list.', { status: 200 });

    var ids = [];
    var pageToken = '';
    var page = 0;
    while (true) {
      if (signal && signal.aborted) throw ApiError('Cancelled', { aborted: true });
      var data = await request('/playlistItems', {
        params: { part: 'contentDetails', playlistId: playlistId, maxResults: 50, pageToken: pageToken || undefined },
        token: token, cost: 1, signal: signal
      });
      page++;
      ((data && data.items) || []).forEach(function (it) {
        var vid = it.contentDetails && it.contentDetails.videoId;
        if (vid) ids.push(vid);
      });
      if (opts.onProgress) opts.onProgress({ loaded: ids.length, page: page, phase: 'ids' });
      pageToken = (data && data.nextPageToken) || '';
      if (!pageToken || page >= maxPages) break;
    }

    var byId = {};
    for (var i = 0; i < ids.length; i += 50) {
      if (signal && signal.aborted) throw ApiError('Cancelled', { aborted: true });
      var chunk = ids.slice(i, i + 50);
      var vd = await request('/videos', {
        params: { part: 'snippet,status,contentDetails,statistics', id: chunk.join(',') },
        token: token, cost: 1, signal: signal
      });
      ((vd && vd.items) || []).forEach(function (v) { byId[v.id] = normalizeVideo(v); });
      if (opts.onProgress) opts.onProgress({ loaded: Object.keys(byId).length, page: Math.ceil((i + chunk.length) / 50), phase: 'metadata' });
    }

    /* playlistItems returns upload order (newest first); videos.list does not
       promise to echo the requested order, so restore it explicitly. */
    var out = [];
    ids.forEach(function (id) { if (byId[id]) out.push(byId[id]); });
    return out;
  }

  /** Fetch specific videos by id (max 50 per call). */
  async function listVideosByIds(ids, token, signal) {
    var out = [];
    for (var i = 0; i < ids.length; i += 50) {
      var chunk = ids.slice(i, i + 50);
      var data = await request('/videos', { params: { part: 'snippet,status,contentDetails,statistics', id: chunk.join(',') }, token: token, cost: 1, signal: signal });
      ((data && data.items) || []).forEach(function (v) { out.push(normalizeVideo(v)); });
    }
    return out;
  }

  function normalizeVideo(v) {
    var sn = v.snippet || {};
    return {
      id: v.id,
      snippet: {
        title: sn.title == null ? '' : String(sn.title),
        description: sn.description == null ? '' : String(sn.description),
        tags: Array.isArray(sn.tags) ? sn.tags.slice() : [],
        categoryId: sn.categoryId == null ? '' : String(sn.categoryId),
        channelTitle: sn.channelTitle,
        publishedAt: sn.publishedAt,
        defaultLanguage: sn.defaultLanguage || '',
        defaultAudioLanguage: sn.defaultAudioLanguage || '',
        localized: sn.localized || null,
        thumbnails: sn.thumbnails || null
      },
      status: v.status || {},
      contentDetails: v.contentDetails || {},
      statistics: v.statistics || {}
    };
  }

  /**
   * The write. `part` must match what the body contains, and the body must carry
   * the COMPLETE snippet or the API deletes the fields we omitted.
   */
  async function updateVideo(opts) {
    return request('/videos', {
      method: 'PUT',
      params: { part: opts.parts || 'snippet' },
      body: opts.body,
      token: opts.token,
      cost: 50,
      signal: opts.signal,
      retries: opts.retries,
      onRetry: opts.onRetry,
      onBackoff: opts.onBackoff
    });
  }

  /** Category id -> name, so the preview can show "Science & Technology" not "28". */
  async function listCategories(token, regionCode, signal) {
    var data = await request('/videoCategories', { params: { part: 'snippet', regionCode: regionCode || 'US' }, token: token, cost: 1, signal: signal });
    var map = {};
    ((data && data.items) || []).forEach(function (c) { if (c.id && c.snippet) map[String(c.id)] = c.snippet.title; });
    return map;
  }

  YTBE.api = {
    BASE: BASE,
    ApiError: ApiError,
    classify: classify,
    buildQuery: buildQuery,
    request: request,
    getChannel: getChannel,
    listMyVideos: listMyVideos,
    listVideosByIds: listVideosByIds,
    updateVideo: updateVideo,
    listCategories: listCategories,
    normalizeVideo: normalizeVideo
  };
})(typeof window !== 'undefined' ? window : globalThis);

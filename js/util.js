/* yt-bulk-edits :: util.js — DOM/format helpers. No app logic lives here. */
(function (global) {
  'use strict';

  var YTBE = global.YTBE = global.YTBE || {};

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      });
    }
    (Array.isArray(children) ? children : children == null ? [] : [children]).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms || 200);
    };
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function fmtNum(n) {
    return String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function fmtDate(iso, withTime) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var p = function (x) { return String(x).padStart(2, '0'); };
    var date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return withTime ? date + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) : date;
  }

  function fmtDuration(iso8601) {
    if (!iso8601) return '';
    var m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso8601);
    if (!m) return iso8601;
    var d = Number(m[1] || 0), h = Number(m[2] || 0), mi = Number(m[3] || 0), s = Number(m[4] || 0);
    h += d * 24;
    var p = function (x) { return String(x).padStart(2, '0'); };
    return (h ? p(h) + ':' : '') + p(h ? mi : mi) + ':' + p(s);
  }

  function stamp() {
    var d = new Date(), p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename, style: { display: 'none' } });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  function readTextFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(new Error('Could not read file')); };
      fr.readAsText(file);
    });
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  }

  function base64url(bytes) {
    var bin = '';
    var arr = new Uint8Array(bytes);
    for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomId(prefix) {
    var rnd = (global.crypto && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
    return (prefix || 'id') + '-' + rnd;
  }

  function deepClone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  YTBE.util = {
    $: $, $$: $$, el: el, escapeHtml: escapeHtml, escapeRegExp: escapeRegExp,
    debounce: debounce, sleep: sleep, fmtNum: fmtNum, fmtDate: fmtDate,
    fmtDuration: fmtDuration, stamp: stamp, download: download, readTextFile: readTextFile,
    truncate: truncate, base64url: base64url, randomId: randomId, deepClone: deepClone, plural: plural
  };
})(typeof window !== 'undefined' ? window : globalThis);

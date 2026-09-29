/* Fuzzy card-name matching: turns messy OCR lines into a Scryfall card name.
   Browser: window.CardMatch. Node: module.exports (for tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardMatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function compact(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, '');
  }

  function trigrams(key) {
    var p = '^' + key + '$';
    var out = [];
    for (var i = 0; i + 3 <= p.length; i++) out.push(p.substr(i, 3));
    return out;
  }

  function lev(a, b) {
    if (a === b) return 0;
    var n = a.length, m = b.length;
    if (!n) return m; if (!m) return n;
    var prev = new Array(m + 1), cur = new Array(m + 1), i, j;
    for (j = 0; j <= m; j++) prev[j] = j;
    for (i = 1; i <= n; i++) {
      cur[0] = i;
      for (j = 1; j <= m; j++) {
        var c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[m];
  }

  function similarity(a, b) {
    var L = Math.max(a.length, b.length);
    return L ? 1 - lev(a, b) / L : 0;
  }

  // names: array of Scryfall card names (may contain " // " for multi-face cards).
  function buildIndex(names) {
    var keys = [], owner = [];
    names.forEach(function (name, idx) {
      var seen = {};
      [name].concat(name.indexOf(' // ') !== -1 ? name.split(' // ') : []).forEach(function (part) {
        var k = compact(part);
        if (k.length >= 2 && !seen[k]) { seen[k] = 1; keys.push(k); owner.push(idx); }
      });
    });
    var post = Object.create(null), tcount = new Uint8Array(keys.length);
    keys.forEach(function (k, i) {
      var tg = trigrams(k); tcount[i] = Math.min(tg.length, 255);
      var uniq = {};
      tg.forEach(function (t) {
        if (uniq[t]) return; uniq[t] = 1;
        (post[t] || (post[t] = [])).push(i);
      });
    });
    return { names: names, keys: keys, owner: owner, post: post, tcount: tcount,
             hits: new Uint16Array(keys.length) };
  }

  // Best match for one already-compacted query. Returns {name, sim} or null.
  function bestFor(index, q) {
    if (q.length < 3) return null;
    var tg = trigrams(q), touched = [], hits = index.hits, uniq = {};
    tg.forEach(function (t) {
      if (uniq[t]) return; uniq[t] = 1;
      var list = index.post[t]; if (!list) return;
      for (var i = 0; i < list.length; i++) {
        var id = list[i];
        if (hits[id] === 0) touched.push(id);
        hits[id]++;
      }
    });
    var cand = touched.map(function (id) {
      return { id: id, dice: 2 * hits[id] / (tg.length + index.tcount[id]) };
    }).sort(function (a, b) { return b.dice - a.dice; }).slice(0, 25);
    touched.forEach(function (id) { hits[id] = 0; });
    var best = null;
    cand.forEach(function (c) {
      var s = similarity(q, index.keys[c.id]);
      if (!best || s > best.sim) best = { name: index.names[index.owner[c.id]], sim: s, key: index.keys[c.id] };
    });
    return best;
  }

  // Mana symbols on the title bar often come out as stray "words" like O, OO, (Q, @@, 0O0.
  function isJunkWord(w) {
    var raw = w.text || '';
    var t = raw.replace(/[^A-Za-z]/g, '');
    if (t.length <= 2) return true;
    if (/^[^A-Za-z0-9]*[OoQq0()@\u00a9\u00ae&]{2,}[^A-Za-z0-9]*$/.test(raw)) return true;
    return w.confidence !== undefined && w.confidence < 45;
  }

  // Extra query strings with trailing symbol-lookalike letters removed ("sculptorqooo" -> "sculptor").
  function tailVariants(q) {
    var out = [];
    for (var k = 1; k <= 5 && q.length - k >= 3; k++) {
      if (/^[oq0cg6e]+$/.test(q.slice(q.length - k))) out.push(q.slice(0, q.length - k));
    }
    return out;
  }

  // Join OCR fragments that sit on the same row (rotated cards split titles like "Lightnin" + "g Bolt").
  function mergeRows(lines) {
    var sorted = lines.slice().sort(function (a, b) { return a.y0 - b.y0; });
    var rows = [];
    sorted.forEach(function (l) {
      var placed = false;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var ov = Math.min(r.y1, l.y1) - Math.max(r.y0, l.y0);
        var h = Math.min(r.y1 - r.y0, l.y1 - l.y0);
        if (h > 0 && ov / h > 0.5) { r.parts.push(l); r.y0 = Math.min(r.y0, l.y0); r.y1 = Math.max(r.y1, l.y1); placed = true; break; }
      }
      if (!placed) rows.push({ y0: l.y0, y1: l.y1, parts: [l] });
    });
    var out = [];
    rows.forEach(function (r) {
      if (r.parts.length < 2) return;
      var words = [];
      r.parts.forEach(function (p) { p.words.forEach(function (w) { words.push(w); }); });
      words.sort(function (a, b) { return (a.x0 || 0) - (b.x0 || 0); });
      out.push({ text: words.map(function (w) { return w.text; }).join(' '), words: words, y0: r.y0, y1: r.y1, merged: true });
    });
    return out;
  }

  // Variants of a line: the whole thing, plus copies with junk words trimmed off the edges
  // (mana symbols often OCR as stray one/two character "words").
  function variants(words) {
    var out = [], n = words.length, i, j;
    if (!n) return out;
    var lo = 0, hi = n;
    out.push(words.slice(0, n));
    // trim junk from the right, then left, one word at a time
    while (hi - lo > 1 && isJunkWord(words[hi - 1])) { hi--; out.push(words.slice(lo, hi)); }
    while (hi - lo > 1 && isJunkWord(words[lo])) { lo++; out.push(words.slice(lo, hi)); }
    return out;
  }

  // lines: [{text, words:[{text,confidence}], y0, y1}] from OCR.
  // Returns {name, sim, line} or null. Only lines near the top of the visible text are considered,
  // so card names mentioned inside rules text don't win.
  function pick(index, lines) {
    var real = lines.filter(function (l) { return l.words && l.words.length && /[A-Za-z]{3}/.test(l.text); });
    if (!real.length) return null;
    var extra = mergeRows(real);
    var yTop = Math.min.apply(null, real.map(function (l) { return l.y0; }));
    var yBot = Math.max.apply(null, real.map(function (l) { return l.y1; }));
    var span = Math.max(yBot - yTop, 1);
    var best = null;
    function consider(m, q, l, penalty) {
      if (!m) return;
      m.sim = m.sim - penalty;
      m.qlen = q.length; m.line = l.text;
      if (!best || m.sim > best.sim + 1e-9 || (Math.abs(m.sim - best.sim) < 1e-9 && m.qlen > best.qlen)) best = m;
    }
    real.concat(extra).forEach(function (l) {
      var relTop = (l.y0 - yTop) / span;
      if (real.length > 3 && relTop > 0.3) return;
      variants(l.words).forEach(function (v) {
        var q = compact(v.map(function (w) { return w.text; }).join(' '));
        consider(bestFor(index, q), q, l, 0);
        tailVariants(q).forEach(function (t) { consider(bestFor(index, t), t, l, 0.03); });
      });
    });
    return best;
  }

  return { mergeRows: mergeRows, compact: compact, lev: lev, similarity: similarity, buildIndex: buildIndex, bestFor: bestFor, pick: pick };
});

/* Card finding + flattening + art hashing, using OpenCV.js (loaded on demand).
   Everything is optional: if OpenCV fails to load the app falls back to plain full-frame OCR. */
(function (root) {
  'use strict';
  var cv = null, loading = null;

  // ---- reference constants (must match mtg-scanner-art-index image_hash.py, algo_version 1) ----
  var ART = { top: 0.16, bottom: 0.50, left: 0.14, right: 0.86 };
  var OFFSETS = [[0, 0], [0, -0.02], [0, 0.02], [0, 0.04], [-0.011, 0], [0.011, 0]];
  var OUT_W = 488, OUT_H = 680;                       // flattened card size (Scryfall "normal")
  var TITLE = { top: 0.024, bottom: 0.102, left: 0.04, right: 0.84 };

  function pyRound(x) { // Python round(): half to even
    var f = Math.floor(x), d = x - f;
    if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
    return Math.round(x);
  }

  function load(baseUrl) {
    if (loading) return loading;
    loading = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.async = true;
      s.src = baseUrl + 'vendor/opencv.js';
      s.onerror = function () { resolve(false); };
      s.onload = function () {
        var c = root.cv;
        Promise.resolve(c && typeof c.then === 'function' ? c : (c && c.Mat ? c : new Promise(function (r) { c.onRuntimeInitialized = function () { r(c); }; })))
          .then(function (m) { cv = m; if (cv && typeof cv.then === 'function') delete cv.then; resolve(!!(cv && cv.Mat)); })
          .catch(function () { resolve(false); });
      };
      document.head.appendChild(s);
    });
    return loading;
  }

  function orderPoints(p) { // -> tl, tr, br, bl
    var sums = p.map(function (q) { return q.x + q.y; });
    var diffs = p.map(function (q) { return q.y - q.x; });
    var tl = p[sums.indexOf(Math.min.apply(null, sums))];
    var br = p[sums.indexOf(Math.max.apply(null, sums))];
    var tr = p[diffs.indexOf(Math.min.apply(null, diffs))];
    var bl = p[diffs.indexOf(Math.max.apply(null, diffs))];
    return [tl, tr, br, bl];
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function polyArea(p) {
    var a = 0;
    for (var i = 0; i < p.length; i++) { var j = (i + 1) % p.length; a += p[i].x * p[j].y - p[j].x * p[i].y; }
    return Math.abs(a) / 2;
  }

  // Score a quad as a "card": area times how close the aspect ratio is to 63x88 mm.
  function scoreQuad(pts, frameArea) {
    var o = orderPoints(pts);
    var w = (dist(o[0], o[1]) + dist(o[3], o[2])) / 2, h = (dist(o[0], o[3]) + dist(o[1], o[2])) / 2;
    if (!w || !h) return null;
    var ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio < 1.25 || ratio > 1.58) return null;
    var area = polyArea(o);
    if (area < frameArea * 0.03) return null;
    if (area > frameArea * 0.9) return null; // that's the whole picture, not a card
    var fit = 1 - Math.min(Math.abs(ratio - 1.395) / 0.5, 0.8);
    return { pts: o, score: area * fit, ratio: ratio };
  }

  function findCandidates(bin, frameArea) {
    var contours = new cv.MatVector(), hier = new cv.Mat(), best = null;
    try {
      cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (var i = 0; i < contours.size(); i++) {
        var cnt = contours.get(i), hull = new cv.Mat(), approx = new cv.Mat();
        try {
          var area = cv.contourArea(cnt);
          if (area < frameArea * 0.03) continue;
          cv.convexHull(cnt, hull, false, true);
          var peri = cv.arcLength(hull, true), pts = null;
          var eps = [0.02, 0.03, 0.045, 0.065];
          for (var k = 0; k < eps.length; k++) {
            cv.approxPolyDP(hull, approx, eps[k] * peri, true);
            if (approx.rows === 4) {
              pts = []; for (var q = 0; q < 4; q++) pts.push({ x: approx.data32S[q * 2], y: approx.data32S[q * 2 + 1] });
              break;
            }
          }
          if (!pts) {
            var r = cv.minAreaRect(hull), corners = cv.RotatedRect.points(r);
            var ra = r.size.width * r.size.height;
            if (ra > 0 && cv.contourArea(hull) / ra > 0.86) pts = corners.map(function (c) { return { x: c.x, y: c.y }; });
          }
          if (pts) { var s = scoreQuad(pts, frameArea); if (s && (!best || s.score > best.score)) best = s; }
        } finally { cnt.delete(); hull.delete(); approx.delete(); }
      }
    } finally { contours.delete(); hier.delete(); }
    return best;
  }

  // Find the card in a canvas. Returns {pts:[tl,tr,br,bl], score, ratio, how} in canvas pixels, or null.
  function detect(canvas) {
    if (!cv) return null;
    var src = cv.imread(canvas), gray = new cv.Mat(), blur = new cv.Mat(), bin = new cv.Mat(), k = cv.Mat.ones(3, 3, cv.CV_8U);
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      var area = src.cols * src.rows, best = null;
      function consider(r, how) { if (r && (!best || r.score > best.score)) { best = r; best.how = how; } }
      cv.Canny(blur, bin, 40, 120);
      cv.dilate(bin, bin, k, new cv.Point(-1, -1), 2);
      consider(findCandidates(bin, area), 'canny');
      if (best && best.score > area * 0.2) return best;       // big clean card: done
      cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      consider(findCandidates(bin, area), 'otsu');
      cv.bitwise_not(bin, bin);
      consider(findCandidates(bin, area), 'otsu-inv');
      cv.adaptiveThreshold(blur, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 8);
      cv.dilate(bin, bin, k, new cv.Point(-1, -1), 2);
      consider(findCandidates(bin, area), 'adaptive');
      return best;
    } finally { src.delete(); gray.delete(); blur.delete(); bin.delete(); k.delete(); }
  }

  // Flatten the quad to an upright-or-upside-down portrait card (RGBA Mat, caller deletes).
  function warp(canvas, pts, scale) {
    var o = pts.map(function (p) { return { x: p.x * scale, y: p.y * scale }; });
    var w = (dist(o[0], o[1]) + dist(o[3], o[2])) / 2, h = (dist(o[0], o[3]) + dist(o[1], o[2])) / 2;
    if (w > h) o = [o[3], o[0], o[1], o[2]]; // make the long side vertical
    var src = cv.imread(canvas), dst = new cv.Mat();
    var a = cv.matFromArray(4, 1, cv.CV_32FC2, [o[0].x, o[0].y, o[1].x, o[1].y, o[2].x, o[2].y, o[3].x, o[3].y]);
    var b = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, OUT_W, 0, OUT_W, OUT_H, 0, OUT_H]);
    var M = cv.getPerspectiveTransform(a, b);
    try { cv.warpPerspective(src, dst, M, new cv.Size(OUT_W, OUT_H), cv.INTER_LINEAR, cv.BORDER_REPLICATE); }
    finally { src.delete(); a.delete(); b.delete(); M.delete(); }
    return dst;
  }

  function rotated(mat, flip) {
    if (!flip) return mat;
    var out = new cv.Mat(); cv.rotate(mat, out, cv.ROTATE_180); return out;
  }

  // Title bar crop as a stretched-contrast grayscale canvas, ready for single-line OCR.
  function titleCanvas(warped, flip, dy) {
    dy = dy || 0;
    var m = rotated(warped, flip);
    try {
      var x0 = Math.round(OUT_W * TITLE.left), x1 = Math.round(OUT_W * TITLE.right);
      var y0 = Math.max(0, Math.round(OUT_H * (TITLE.top + dy))), y1 = Math.min(OUT_H, Math.round(OUT_H * (TITLE.bottom + dy)));
      var roi = m.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0)), gray = new cv.Mat(), big = new cv.Mat();
      try {
        cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
        // percentile stretch
        var d = gray.data, n = d.length, hist = new Uint32Array(256), i;
        for (i = 0; i < n; i++) hist[d[i]]++;
        var lo = 0, hi = 255, acc = 0;
        while (lo < 254 && acc + hist[lo] < n * 0.02) { acc += hist[lo]; lo++; }
        acc = 0; while (hi > 1 && acc + hist[hi] < n * 0.02) { acc += hist[hi]; hi--; }
        var k = 255 / Math.max(hi - lo, 40);
        for (i = 0; i < n; i++) { var v = (d[i] - lo) * k; d[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
        cv.resize(gray, big, new cv.Size(gray.cols * 2, gray.rows * 2), 0, 0, cv.INTER_CUBIC);
        var c = document.createElement('canvas'); cv.imshow(c, big);
        return c;
      } finally { roi.delete(); gray.delete(); big.delete(); }
    } finally { if (m !== warped) m.delete(); }
  }

  // ---- art hash (bit-exact port of image_hash.py) ----
  function dhashPlane(plane) { // plane: single-channel Mat
    var small = new cv.Mat();
    try {
      cv.resize(plane, small, new cv.Size(17, 16), 0, 0, cv.INTER_AREA);
      var d = small.data, out = new Uint8Array(32), bit = 0;
      for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
        if (d[y * 17 + x + 1] > d[y * 17 + x]) out[bit >> 3] |= 0x80 >> (bit & 7);
        bit++;
      }
      return out;
    } finally { small.delete(); }
  }
  function artCrop(bgr, dx, dy) {
    var h = bgr.rows, w = bgr.cols;
    var top = Math.max(0, pyRound(h * (ART.top + dy))), bottom = Math.min(h, pyRound(h * (ART.bottom + dy)));
    var left = Math.max(0, pyRound(w * (ART.left + dx))), right = Math.min(w, pyRound(w * (ART.right + dx)));
    return bgr.roi(new cv.Rect(left, top, right - left, bottom - top));
  }
  function hashBgr(bgr) { // 3-channel BGR Mat -> 128 bytes
    var gray = new cv.Mat(), planes = new cv.MatVector(), out = new Uint8Array(128);
    try {
      cv.cvtColor(bgr, gray, cv.COLOR_BGR2GRAY);
      out.set(dhashPlane(gray), 0);
      cv.split(bgr, planes);
      for (var c = 0; c < 3; c++) { var p = planes.get(c); try { out.set(dhashPlane(p), 32 * (c + 1)); } finally { p.delete(); } }
      return out;
    } finally { gray.delete(); planes.delete(); }
  }
  // Six framing-offset hashes of a flattened card (RGBA Mat).
  function artHashes(warped, flip) {
    var m = rotated(warped, flip), bgr = new cv.Mat();
    try {
      cv.cvtColor(m, bgr, cv.COLOR_RGBA2BGR);
      return OFFSETS.map(function (o) { var roi = artCrop(bgr, o[0], o[1]); try { var c = roi.clone(); try { return hashBgr(c); } finally { c.delete(); } } finally { roi.delete(); } });
    } finally { bgr.delete(); if (m !== warped) m.delete(); }
  }

  // ---- index of reference hashes ----
  function popcount32(x) { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
  function parseIndex(buf) {
    var dv = new DataView(buf), magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'ART1') throw new Error('bad art index');
    var n = dv.getUint32(4, true), ids = new Map(), u8 = new Uint8Array(buf);
    for (var i = 0; i < n; i++) {
      var o = 8 + i * 16, s = '';
      for (var j = 0; j < 16; j++) { var b = u8[o + j]; s += (b < 16 ? '0' : '') + b.toString(16); }
      ids.set(s, i);
    }
    return { n: n, ids: ids, hashes: new Uint32Array(buf, 8 + n * 16, n * 32) };
  }
  function uuidKey(u) { return String(u).replace(/-/g, '').toLowerCase(); }
  // Min distance over offsets between the scan hashes and the given illustration ids. null if none indexed.
  function distanceTo(index, queries, illustrationIds) {
    var best = null, q32 = queries.map(function (q) { return new Uint32Array(q.buffer, q.byteOffset, 32); });
    illustrationIds.forEach(function (id) {
      var i = index.ids.get(uuidKey(id)); if (i === undefined) return;
      var base = i * 32;
      q32.forEach(function (q) {
        var d = 0; for (var k = 0; k < 32; k++) d += popcount32((index.hashes[base + k] ^ q[k]) >>> 0);
        if (best === null || d < best) best = d;
      });
    });
    return best;
  }

  root.Vision = {
    load: load, detect: detect, warp: warp, titleCanvas: titleCanvas, artHashes: artHashes,
    parseIndex: parseIndex, distanceTo: distanceTo, isReady: function () { return !!cv; },
    cvRef: function () { return cv; }, OUT_W: OUT_W, OUT_H: OUT_H, hashBgr: hashBgr, pyRound: pyRound
  };
})(typeof self !== 'undefined' ? self : this);

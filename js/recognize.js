/* Recognize: lighting-robust card finding and title reading (uses Vision's OpenCV). */
(function (root) {
  'use strict';
  var V = root.Vision;
  function cv() { return V.cvRef(); }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function orderPoints(p) {
    var s = p.map(function (q) { return q.x + q.y; }), d = p.map(function (q) { return q.y - q.x; });
    return [p[s.indexOf(Math.min.apply(0, s))], p[d.indexOf(Math.min.apply(0, d))], p[s.indexOf(Math.max.apply(0, s))], p[d.indexOf(Math.max.apply(0, d))]];
  }
  function polyArea(p) { var a = 0; for (var i = 0; i < p.length; i++) { var j = (i + 1) % p.length; a += p[i].x * p[j].y - p[j].x * p[i].y; } return Math.abs(a) / 2; }

  // Fraction of points along the quad's edges that sit on an edge pixel (edge map already dilated).
  function support(pts, edge) {
    var hit = 0, n = 0, W = edge.cols, H = edge.rows, d = edge.data;
    for (var i = 0; i < 4; i++) {
      var a = pts[i], b = pts[(i + 1) % 4], L = dist(a, b), steps = Math.max(8, Math.round(L / 4));
      for (var k = 1; k < steps; k++) {
        var x = Math.round(a.x + (b.x - a.x) * k / steps), y = Math.round(a.y + (b.y - a.y) * k / steps);
        if (x < 0 || y < 0 || x >= W || y >= H) { continue; } // off-frame edge: neither for nor against
        n++; if (d[y * W + x]) hit++;
      }
    }
    return n < 12 ? 0 : hit / n;
  }
  function scoreQuad(pts, frameArea, edge) {
    var o = orderPoints(pts);
    var w = (dist(o[0], o[1]) + dist(o[3], o[2])) / 2, h = (dist(o[0], o[3]) + dist(o[1], o[2])) / 2;
    if (!w || !h) return null;
    var ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio < 1.25 || ratio > 1.58) return null;
    var area = polyArea(o);
    if (area < frameArea * 0.03 || area > frameArea * 0.9) return null;
    var sup = support(o, edge);
    if (sup < 0.5) return null;
    var st = 0; for (var q = 0; q < 4; q++) st += stepFrac(o[q], o[(q + 1) % 4]); if (st / 4 < 0.5) return null; sup = Math.min(sup, st / 4 + 0.15);
    var fit = 1 - Math.min(Math.abs(ratio - 1.395) / 0.5, 0.8);
    return { pts: o, score: area * fit * sup * sup, ratio: ratio, support: sup };
  }
  function candidates(bin, edge, frameArea, consider, tag) {
    var c = cv(), contours = new c.MatVector(), hier = new c.Mat();
    try {
      c.findContours(bin, contours, hier, c.RETR_LIST, c.CHAIN_APPROX_SIMPLE);
      for (var i = 0; i < contours.size(); i++) {
        var cnt = contours.get(i), hull = new c.Mat(), approx = new c.Mat();
        try {
          if (c.contourArea(cnt) < frameArea * 0.03) continue;
          c.convexHull(cnt, hull, false, true);
          var peri = c.arcLength(hull, true), got = [], eps = [0.02, 0.03, 0.045, 0.065];
          for (var k = 0; k < eps.length; k++) {
            c.approxPolyDP(hull, approx, eps[k] * peri, true);
            if (approx.rows === 4) { var pts = []; for (var q = 0; q < 4; q++) pts.push({ x: approx.data32S[q * 2], y: approx.data32S[q * 2 + 1] }); got.push(pts); break; }
          }
          var r = c.minAreaRect(hull), ra = r.size.width * r.size.height;
          if (ra > 0 && c.contourArea(hull) / ra > 0.8) got.push(c.RotatedRect.points(r).map(function (p) { return { x: p.x, y: p.y }; }));
          got.forEach(function (pts) { consider(scoreQuad(pts, frameArea, edge), tag); });
        } finally { cnt.delete(); hull.delete(); approx.delete(); }
      }
    } finally { contours.delete(); hier.delete(); }
  }

  // Flat-field: divide by a heavily blurred copy so uneven light and shadows cancel out.
  function flat(gray, sigma) {
    var c = cv(), f = new c.Mat(), sm = new c.Mat(), bg = new c.Mat(), out = new c.Mat();
    try {
      gray.convertTo(f, c.CV_32F);
      var q = 8;                                                 // estimate the light on a small copy: far cheaper
      c.resize(f, sm, new c.Size(Math.max(4, Math.round(gray.cols / q)), Math.max(4, Math.round(gray.rows / q))), 0, 0, c.INTER_AREA);
      c.GaussianBlur(sm, sm, new c.Size(0, 0), sigma / q);
      c.resize(sm, bg, new c.Size(gray.cols, gray.rows), 0, 0, c.INTER_LINEAR);
      bg.convertTo(bg, c.CV_32F, 1, 8);
      c.divide(f, bg, f, 128);
      f.convertTo(out, c.CV_8U);
      return out;
    } finally { f.delete(); sm.delete(); bg.delete(); }
  }


  // Card from straight lines: find long edge segments, pair parallels, cross two pairs into quads.
  var CUR = null; // smoothed, light-flattened grey of the frame being scanned
  // Fraction of a side where brightness really steps across it (same direction, clearly above noise).
  function stepFrac(a, b) {
    var W = CUR.cols, H = CUR.rows, d = CUR.data, L = dist(a, b), steps = Math.max(8, Math.round(L / 3));
    var nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L, pos = 0, neg = 0, n = 0, off = 3;
    for (var k = 1; k < steps; k++) {
      var x = a.x + (b.x - a.x) * k / steps, y = a.y + (b.y - a.y) * k / steps;
      var x1 = Math.round(x + nx * off), y1 = Math.round(y + ny * off), x2 = Math.round(x - nx * off), y2 = Math.round(y - ny * off);
      if (x1 < 0 || x2 < 0 || y1 < 0 || y2 < 0 || x1 >= W || x2 >= W || y1 >= H || y2 >= H) continue;
      n++; var df = d[y1 * W + x1] - d[y2 * W + x2];
      if (df > 7) pos++; else if (df < -7) neg++;
    }
    return n < 6 ? 0 : Math.max(pos, neg) / n;
  }
  function sideSup(a, b, edge) {
    var hit = 0, n = 0, W = edge.cols, H = edge.rows, d = edge.data, L = dist(a, b), steps = Math.max(8, Math.round(L / 3));
    for (var k = 1; k < steps; k++) {
      var x = Math.round(a.x + (b.x - a.x) * k / steps), y = Math.round(a.y + (b.y - a.y) * k / steps);
      if (x < 0 || y < 0 || x >= W || y >= H) continue; n++; if (d[y * W + x]) hit++;
    }
    return n < 6 ? 0 : hit / n;
  }
  function scoreLineQuad(pts, frameArea, edge) {
    var o = orderPoints(pts);
    var w = (dist(o[0], o[1]) + dist(o[3], o[2])) / 2, h = (dist(o[0], o[3]) + dist(o[1], o[2])) / 2;
    if (!w || !h) return null;
    var ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio < 1.28 || ratio > 1.55) return null;
    var area = polyArea(o);
    if (area < frameArea * 0.03 || area > frameArea * 0.9) return null;
    var mn = 1, sum = 0;
    for (var i = 0; i < 4; i++) { var v = Math.min(sideSup(o[i], o[(i + 1) % 4], edge), stepFrac(o[i], o[(i + 1) % 4]) + 0.15); mn = Math.min(mn, v); sum += v; }
    var mean = sum / 4;
    if (mn < 0.6 || mean < 0.78) return null;
    var fit = 1 - Math.min(Math.abs(ratio - 1.395) / 0.5, 0.8);
    return { pts: o, score: area * fit * Math.pow(mean, 4), ratio: ratio, support: mean };
  }
  function lineQuads(thin, edge, area, consider) {
    var c = cv(), lines = new c.Mat(), W = edge.cols, H = edge.rows, minDim = Math.min(W, H);
    try {
      c.HoughLinesP(thin, lines, 1, Math.PI / 180, 28, Math.max(24, minDim * 0.09), Math.max(6, minDim * 0.02));
      var L = [];
      for (var i = 0, nl = lines.data32S.length / 4; i < nl; i++) {
        var x1 = lines.data32S[i * 4], y1 = lines.data32S[i * 4 + 1], x2 = lines.data32S[i * 4 + 2], y2 = lines.data32S[i * 4 + 3];
        var len = Math.hypot(x2 - x1, y2 - y1), th = Math.atan2(y2 - y1, x2 - x1); if (th < 0) th += Math.PI; if (th >= Math.PI) th -= Math.PI;
        var nx = -Math.sin(th), ny = Math.cos(th), rho = x1 * nx + y1 * ny;
        L.push({ th: th, rho: rho, len: len, nx: nx, ny: ny, x1: x1, y1: y1 });
      }
      L.sort(function (a, b) { return b.len - a.len; });
      var U = [], bins = {};
      L.forEach(function (l) {
        for (var k = 0; k < U.length; k++) {
          var d = Math.abs(U[k].th - l.th); d = Math.min(d, Math.PI - d);
          var rr = d < 0.06 ? Math.abs((U[k].rho - l.rho)) : 1e9;
          if (d > Math.PI / 2 - 0.06) rr = 1e9;
          if (d < 0.06 && Math.abs(U[k].th - l.th) > 1) rr = Math.abs(U[k].rho + l.rho);
          if (rr < 5) { U[k].len += l.len * 0.3; return; }
        }
        var bin = Math.floor(l.th / (Math.PI / 12));
        bins[bin] = (bins[bin] || 0) + 1;
        if (bins[bin] <= 9) U.push(l);
      });
      function ang(a, b) { var d = Math.abs(a.th - b.th); return Math.min(d, Math.PI - d); }
      function sep(a, b) { // distance between roughly parallel lines
        var s = (a.nx * b.nx + a.ny * b.ny) >= 0 ? 1 : -1; return Math.abs(a.rho - s * b.rho + 0) ; }
      function inter(a, b) {
        var det = a.nx * b.ny - a.ny * b.nx; if (Math.abs(det) < 1e-3) return null;
        return { x: (a.rho * b.ny - b.rho * a.ny) / det, y: (a.nx * b.rho - b.nx * a.rho) / det };
      }
      var P = [];
      for (var i2 = 0; i2 < U.length; i2++) for (var j = i2 + 1; j < U.length; j++) {
        if (ang(U[i2], U[j]) > 0.26) continue;
        var s = sep(U[i2], U[j]); if (s < minDim * 0.1 || s > Math.max(W, H) * 0.95) continue;
        P.push({ a: U[i2], b: U[j], th: (U[i2].th + U[j].th) / 2, w: U[i2].len + U[j].len });
      }
      P.sort(function (x, y) { return y.w - x.w; }); if (P.length > 220) P.length = 220;
      for (var p = 0; p < P.length; p++) for (var q = p + 1; q < P.length; q++) {
        var d = Math.abs(P[p].th - P[q].th); d = Math.min(d, Math.PI - d);
        if (d < 1.05 || d > Math.PI / 2 + 0.1) continue;
        var A = inter(P[p].a, P[q].a), B = inter(P[p].a, P[q].b), C = inter(P[p].b, P[q].b), D = inter(P[p].b, P[q].a);
        if (!A || !B || !C || !D) continue;
        var pts = [A, B, C, D];
        if (pts.some(function (t) { return t.x < -W * 0.3 || t.x > W * 1.3 || t.y < -H * 0.3 || t.y > H * 1.3; })) continue;
        var r = scoreLineQuad(pts, area, edge); if (r) consider(r, 'lines');
      }
    } finally { lines.delete(); }
  }

  // Up to two more, clearly different, card-like quads (other cards in view), best first.
  function distinct(all, best, diag) {
    var picked = [best];
    all.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (r) {
      if (picked.length >= 3) return;
      var a = center(r.pts);
      for (var i = 0; i < picked.length; i++) {
        var b = center(picked[i].pts), ar = polyArea(r.pts) / Math.max(1, polyArea(picked[i].pts));
        if (Math.hypot(a.x - b.x, a.y - b.y) < 0.08 * diag || (ar > 0.6 && ar < 1.6 && Math.hypot(a.x - b.x, a.y - b.y) < 0.15 * diag)) return;
      }
      picked.push(r);
    });
    return picked.slice(1);
  }

  function detectNew(canvas) {
    var c = cv(); if (!c) return null;
    var src = c.imread(canvas), rgb = new c.Mat(), gray = new c.Mat(), best = null, area = src.cols * src.rows;
    var k = c.Mat.ones(3, 3, c.CV_8U), tmp = [];
    function keep(m) { tmp.push(m); return m; }
    var all = [], cxF = src.cols / 2, cyF = src.rows / 2, halfDiag = Math.hypot(src.cols, src.rows) / 2;
    function consider(r, how) {
      if (!r) return;
      var m = center(r.pts); r.score *= 1 - 0.3 * Math.min(1, Math.hypot(m.x - cxF, m.y - cyF) / halfDiag); // slight lean to the middle of the picture
      r.how = how; all.push(r);
      if (!best || r.score > best.score) best = r;
    }
    try {
      c.cvtColor(src, rgb, c.COLOR_RGBA2RGB); c.cvtColor(src, gray, c.COLOR_RGBA2GRAY);
      var sig = Math.max(src.cols, src.rows) / 14;
      var ff = keep(flat(gray, sig)), ffb = keep(new c.Mat());
      c.GaussianBlur(ff, ffb, new c.Size(5, 5), 0); CUR = ffb;
      // 1) Canny on the light-normalised image, 2) Canny on each colour channel, OR-ed together
      var edge = keep(new c.Mat()), tmpE = keep(new c.Mat());
      // Canny with thresholds taken from this image's own gradient distribution (works dim or bright).
      function pcanny(m, out, pct) {
        var gx = new c.Mat(), gy = new c.Mat(), ax = new c.Mat(), ay = new c.Mat(), mag = new c.Mat();
        try {
          c.Sobel(m, gx, c.CV_16S, 1, 0, 3); c.Sobel(m, gy, c.CV_16S, 0, 1, 3);
          c.convertScaleAbs(gx, ax); c.convertScaleAbs(gy, ay); c.add(ax, ay, mag);
          var d = mag.data, n = d.length, hist = new Uint32Array(256), i, acc = 0, hi = 255;
          for (i = 0; i < n; i++) hist[d[i]]++;
          for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * pct) { hi = i; break; } }
          hi = Math.max(hi, 14);
          c.Canny(m, out, Math.max(6, hi * 0.45), hi);
        } finally { gx.delete(); gy.delete(); ax.delete(); ay.delete(); mag.delete(); }
      }
      var T0 = performance.now(), TT = {}; pcanny(ffb, edge, 0.93); TT.gray = performance.now() - T0;
      var ch = new c.MatVector(); c.split(rgb, ch);
      try {
        for (var i = 0; i < 3; i++) {
          var chn = ch.get(i), chf = keep(flat(chn, sig)), b = keep(new c.Mat());
          c.GaussianBlur(chf, b, new c.Size(5, 5), 0);
          pcanny(b, tmpE, 0.93); c.bitwise_or(edge, tmpE, edge); chn.delete();
        }
      } finally { ch.delete(); }
      var dil = keep(new c.Mat()), dil2 = keep(new c.Mat());
      c.dilate(edge, dil, k, new c.Point(-1, -1), 1);
      c.dilate(edge, dil2, k, new c.Point(-1, -1), 2);
      TT.chan = performance.now() - T0;
      lineQuads(edge, dil, area, consider); TT.lines = performance.now() - T0;
      candidates(dil2, dil2, area, consider, 'edge'); TT.cand = performance.now() - T0; root.__tt = TT;
      // fill: closed edges -> solid blobs also help when only the outline is continuous
      var closed = keep(new c.Mat()); c.morphologyEx(dil2, closed, c.MORPH_CLOSE, c.Mat.ones(5, 5, c.CV_8U));
      candidates(closed, dil2, area, consider, 'edge-closed');
      if (!best || best.score < area * 0.12) {
        // luminance blobs on the flattened image
        var bin = keep(new c.Mat());
        c.adaptiveThreshold(ffb, bin, 255, c.ADAPTIVE_THRESH_GAUSSIAN_C, c.THRESH_BINARY_INV, 31, 6);
        c.dilate(bin, bin, k, new c.Point(-1, -1), 2);
        candidates(bin, dil2, area, consider, 'adaptive');
        c.threshold(ffb, bin, 0, 255, c.THRESH_BINARY | c.THRESH_OTSU);
        candidates(bin, dil2, area, consider, 'otsu');
        c.bitwise_not(bin, bin); candidates(bin, dil2, area, consider, 'otsu-inv');
      }
      if (best) best.others = distinct(all, best, Math.hypot(src.cols, src.rows));
      return best;
    } finally { src.delete(); rgb.delete(); gray.delete(); k.delete(); tmp.forEach(function (m) { m.delete(); }); }
  }

  function center(p) { return { x: (p[0].x + p[1].x + p[2].x + p[3].x) / 4, y: (p[0].y + p[1].y + p[2].y + p[3].y) / 4 }; }
  // Main answer from the lighting-robust finder; the older finder's answer rides along as `alt` when it disagrees
  // (it copes with low-contrast edges, e.g. a dark card on a dark card in a fan).
  function detect(canvas) {
    var r = detectNew(canvas), o = null;
    try { o = V.detect(canvas); } catch (e) { o = null; }
    if (!r) return o;
    if (o) {
      var a = center(r.pts), b = center(o.pts), diag = Math.hypot(canvas.width, canvas.height);
      var ar = polyArea(r.pts) / Math.max(1, polyArea(o.pts));
      if (Math.hypot(a.x - b.x, a.y - b.y) > 0.06 * diag || ar < 0.8 || ar > 1.25) r.others = (r.others || []).concat([o]);
    }
    return r;
  }

  // Title strip, lighting-flattened, contrast-stretched, upscaled 2x, as a canvas for OCR.
  function titleCanvas(warped, flip, dy, mode) {
    var c = cv(), m = warped;
    if (flip) { m = new c.Mat(); c.rotate(warped, m, c.ROTATE_180); }
    try {
      var W = V.OUT_W, H = V.OUT_H;
      var x0 = Math.round(W * 0.03), x1 = Math.round(W * 0.86);
      var y0 = Math.max(0, Math.round(H * (0.012 + dy))), y1 = Math.min(H, Math.round(H * (0.112 + dy)));
      var roi = m.roi(new c.Rect(x0, y0, x1 - x0, y1 - y0)), gray = new c.Mat(), f = new c.Mat(), bg = new c.Mat(), big = new c.Mat(), out = new c.Mat();
      try {
        c.cvtColor(roi, gray, c.COLOR_RGBA2GRAY);
        // Knock down sensor noise before stretching contrast, but only as much as the real resolution can afford.
        var sh = warped.srcH || 600, sg = sh >= 520 ? 1.4 : sh >= 380 ? 0.9 : 0;
        if (sg) c.GaussianBlur(gray, gray, new c.Size(sg > 1 ? 5 : 3, sg > 1 ? 5 : 3), sg);
        gray.convertTo(f, c.CV_32F);
        c.GaussianBlur(f, bg, new c.Size(0, 0), 12);            // local brightness
        c.subtract(f, bg, f);                                    // text = deviation from local background
        f.convertTo(gray, c.CV_8U, 1, 128);
        var d = gray.data, n = d.length, hist = new Uint32Array(256), i;
        for (i = 0; i < n; i++) hist[d[i]]++;
        var lo = 0, hi = 255, acc = 0;
        while (lo < 254 && acc + hist[lo] < n * 0.01) { acc += hist[lo]; lo++; }
        acc = 0; while (hi > 1 && acc + hist[hi] < n * 0.01) { acc += hist[hi]; hi--; }
        var span = Math.max(hi - lo, 30), kk = 255 / span;
        for (i = 0; i < n; i++) { var v = (d[i] - lo) * kk; d[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
        // Text is the minority; make it dark on light so OCR always sees the same polarity.
        var dark = 0; for (i = 0; i < n; i++) if (d[i] < 100) dark++;
        var light = 0; for (i = 0; i < n; i++) if (d[i] > 156) light++;
        if (light < dark) for (i = 0; i < n; i++) d[i] = 255 - d[i];
        c.resize(gray, big, new c.Size(gray.cols * 2, gray.rows * 2), 0, 0, c.INTER_CUBIC);
        if (mode === 'b') { // hard black/white, decided per neighbourhood
          c.GaussianBlur(big, big, new c.Size(3, 3), 0);
          c.adaptiveThreshold(big, big, 255, c.ADAPTIVE_THRESH_GAUSSIAN_C, c.THRESH_BINARY, 41, 12);
        }
        var cvs = document.createElement('canvas'); c.imshow(cvs, big);
        return cvs;
      } finally { roi.delete(); gray.delete(); f.delete(); bg.delete(); big.delete(); out.delete(); }
    } finally { if (m !== warped) m.delete(); }
  }

  function extract(data) {
    var o = [];
    (data.blocks || []).forEach(function (b) { (b.paragraphs || []).forEach(function (p) { (p.lines || []).forEach(function (l) {
      var words = (l.words || []).map(function (w) { return { text: w.text, confidence: w.confidence, x0: w.bbox ? w.bbox.x0 : 0 }; }).filter(function (w) { return w.text && w.text.trim(); });
      if (words.length) o.push({ text: words.map(function (w) { return w.text; }).join(' '), words: words, y0: l.bbox.y0, y1: l.bbox.y1 });
    }); }); });
    return o;
  }

  function readTitle(worker, warped, flip, dy, mode) {
    var cvs = titleCanvas(warped, flip, dy, mode);
    return worker.setParameters({ tessedit_pageseg_mode: '7' }).then(function () { return worker.recognize(cvs, {}, { blocks: true }); }).then(function (r) { return extract(r.data); });
  }

  root.Recognize = { VARIANTS: [[0, false], [0, true], [-0.02, false], [0.02, false], [-0.02, true], [0.02, true]], PER_MODE: [[0, false, 'g'], [0, true, 'g'], [0, false, 'b'], [0, true, 'b'], [-0.02, false, 'g'], [0.02, false, 'g'], [-0.02, true, 'g'], [0.02, true, 'g'], [-0.02, false, 'b'], [0.02, false, 'b']], detect: detect, titleCanvas: titleCanvas, readTitle: readTitle, extract: extract };
})(typeof self !== 'undefined' ? self : this);

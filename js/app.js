(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    video: $('video'), status: $('status'), banner: $('banner'), stage: $('stage'), readout: $('readout'),
    readName: $('readName'), readText: $('readText'), btnRepeat: $('btnRepeat'), btnPause: $('btnPause'),
    btnSlower: $('btnSlower'), btnFaster: $('btnFaster'), btnReminder: $('btnReminder'), btnTorch: $('btnTorch'),
    btnType: $('btnType'), btnAbout: $('btnAbout'), typeBox: $('typeBox'), typeInput: $('typeInput'),
    typeClose: $('typeClose'), about: $('about'), aboutClose: $('aboutClose'), fatal: $('fatal'),
    sr: $('sr'), debug: $('debug'), fatalTitle: $('fatalTitle'), fatalBody: $('fatalBody'), btnRetry: $('btnRetry')
  };

  var API = 'https://api.scryfall.com';
  var RATES = [0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0];
  var T_HIGH = 0.9, T_LOW = 0.74;
  var MODES = ['3', '6']; // Tesseract page-segmentation modes, alternated scan to scan
  var state = {
    rateIdx: 3, reminder: false, paused: false, index: null, worker: null, stream: null, track: null,
    torch: false, current: null, lastSeenAt: 0, pending: { name: null, t: 0 }, voiceLocked: false,
    pendingSpeech: null, announceToken: 0, misses: 0, lastHelp: 0, modeIdx: 0, ready: false, welcomed: false,
    swallowClick: false, wake: null, suppressUntil: 0
  };

  /* ---------- settings ---------- */
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem('cardreader') || '{}');
      if (typeof s.rateIdx === 'number' && s.rateIdx >= 0 && s.rateIdx < RATES.length) state.rateIdx = s.rateIdx;
      if (typeof s.reminder === 'boolean') state.reminder = s.reminder;
    } catch (e) {}
  }
  function saveSettings() {
    try { localStorage.setItem('cardreader', JSON.stringify({ rateIdx: state.rateIdx, reminder: state.reminder })); } catch (e) {}
  }

  /* ---------- status + speech ---------- */
  function setStatus(t) { el.status.textContent = t; }

  var synth = window.speechSynthesis;
  var keepAlive = [];
  function speakNow(segs) {
    if (!synth) return;
    try { synth.cancel(); } catch (e) {}
    keepAlive = [];
    setTimeout(function () {
      segs.forEach(function (t) {
        var u = new SpeechSynthesisUtterance(t);
        u.lang = 'en-US';
        u.rate = RATES[state.rateIdx];
        u.onerror = function (ev) {
          if (ev.error === 'not-allowed') lockVoice(segs);
        };
        keepAlive.push(u);
        synth.speak(u);
      });
    }, 60);
  }
  function lockVoice(segs) {
    state.voiceLocked = true;
    state.pendingSpeech = segs;
    el.banner.hidden = false;
    el.sr.textContent = 'Tap the screen once to turn on voice.';
    try { synth.cancel(); } catch (e) {}
  }
  function needsActivation() {
    return !!(navigator.userActivation && !navigator.userActivation.hasBeenActive);
  }
  function say(segs) {
    if (!synth) { setStatus('Speech is not available in this browser.'); return; }
    if (state.voiceLocked || needsActivation()) { lockVoice(segs); return; }
    speakNow(segs);
  }
  function unlockVoice() {
    if (!state.voiceLocked) return;
    state.voiceLocked = false;
    el.banner.hidden = true;
    el.sr.textContent = '';
    var p = state.pendingSpeech; state.pendingSpeech = null;
    state.swallowClick = true; setTimeout(function () { state.swallowClick = false; }, 500);
    speakNow(p || ['Ready. Hold a card upright, with its name at the top.']);
  }
  ['pointerup', 'touchend', 'click', 'keydown'].forEach(function (evt) {
    document.addEventListener(evt, unlockVoice, true);
  });

  /* ---------- Scryfall (cached) ---------- */
  function fetchJson(url) {
    return fetch(url, { headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' } });
  }
  function openCache(name) { return window.caches ? caches.open(name) : Promise.resolve(null); }

  function loadNames() {
    var KEY = 'https://api.scryfall.com/catalog/card-names';
    var MAX_AGE = 14 * 86400 * 1000;
    return openCache('cardreader-data-v1').then(function (cache) {
      var fromCache = cache ? cache.match(KEY) : Promise.resolve(null);
      return fromCache.then(function (hit) {
        var age = Infinity, cached = null;
        var readHit = hit ? hit.clone().json().then(function (j) {
          cached = j.data; age = Date.now() - (j.fetchedAt || 0);
        }).catch(function () {}) : Promise.resolve();
        return readHit.then(function () {
          if (cached && age < MAX_AGE) return cached;
          return fetchJson(KEY).then(function (r) {
            if (!r.ok) throw new Error('catalog ' + r.status);
            return r.json();
          }).then(function (j) {
            if (cache) cache.put(KEY, new Response(JSON.stringify({ fetchedAt: Date.now(), data: j.data }), { headers: { 'Content-Type': 'application/json' } }));
            return j.data;
          }).catch(function (err) {
            if (cached) return cached;
            throw err;
          });
        });
      });
    });
  }

  function getCard(name) {
    var exact = API + '/cards/named?exact=' + encodeURIComponent(name);
    var fuzzy = API + '/cards/named?fuzzy=' + encodeURIComponent(name);
    return openCache('cardreader-cards-v1').then(function (cache) {
      function lookup(url) {
        return (cache ? cache.match(url) : Promise.resolve(null)).then(function (hit) {
          if (hit) return hit.json();
          return fetchJson(url).then(function (r) {
            if (!r.ok) return null;
            if (cache) cache.put(url, r.clone());
            return r.json();
          });
        });
      }
      return lookup(exact).then(function (c) { return c || lookup(fuzzy); });
    }).catch(function () { return null; });
  }

  /* ---------- rendering + announcing ---------- */
  function currentSegments() {
    return state.current ? CardScript.build(state.current.card, { reminder: state.reminder }) : null;
  }
  function render() {
    var segs = currentSegments();
    if (!segs) { el.readout.hidden = true; return; }
    el.readout.hidden = false;
    el.readName.textContent = state.current.card.name;
    el.readText.textContent = '';
    segs.forEach(function (s, i) {
      if (i === 0 && s === state.current.card.name + '.') return;
      var p = document.createElement('p');
      if (/^(Front face|Back face|Left half|Right half|Top half|Flipped half|Main card|Adventure|First half|Aftermath half|Side \w+)\.$/.test(s)) p.className = 'label';
      p.textContent = s;
      el.readText.appendChild(p);
    });
    el.readout.scrollTop = 0;
  }

  function announce(name) {
    var token = ++state.announceToken;
    setStatus('Found ' + name + '…');
    return getCard(name).then(function (card) {
      if (token !== state.announceToken) return;
      if (!card) {
        var msg = 'I found ' + name + ' but could not look it up. Check your connection.';
        setStatus(msg); say([msg]); return;
      }
      state.current = { name: name, card: card };
      state.lastSeenAt = Date.now();
      render();
      setStatus(card.name);
      try { navigator.vibrate && navigator.vibrate(40); } catch (e) {}
      say(currentSegments());
    });
  }

  function repeat() {
    var segs = currentSegments();
    if (segs) say(segs);
    else say(['No card yet. Hold a card upright, with its name at the top.']);
  }

  /* ---------- camera ---------- */
  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject({ name: 'Unsupported' });
    }
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    }).then(function (stream) {
      state.stream = stream;
      state.track = stream.getVideoTracks()[0];
      el.video.srcObject = stream;
      var caps = (state.track.getCapabilities && state.track.getCapabilities()) || {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
        state.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
      }
      el.btnTorch.hidden = !caps.torch;
      state.track.addEventListener('ended', function () { state.stream = null; if (!document.hidden) restartCamera(); });
      return el.video.play().catch(function () {});
    });
  }
  function restartCamera() {
    startCamera().catch(function () {});
  }
  function requestWake() {
    try {
      if (navigator.wakeLock && !state.wake) {
        navigator.wakeLock.request('screen').then(function (l) {
          state.wake = l; l.addEventListener('release', function () { state.wake = null; });
        }).catch(function () {});
      }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      requestWake();
      if (!state.track || state.track.readyState === 'ended') restartCamera();
    }
  });

  /* ---------- OCR ---------- */
  function initWorker() {
    var base = new URL('.', location.href).href;
    return Tesseract.createWorker('eng', 1, {
      workerPath: base + 'vendor/worker.min.js',
      corePath: base + 'vendor/core',
      langPath: base + 'vendor/lang',
      gzip: true,
      cacheMethod: 'none',
      logger: function (m) {
        if (m && typeof m.progress === 'number' && !state.ready && /loading/.test(m.status || '')) {
          setStatus('Loading reader… ' + Math.round(m.progress * 100) + '%');
        }
      }
    });
  }

  var grab = document.createElement('canvas');
  function grabFrame() {
    var vw = el.video.videoWidth, vh = el.video.videoHeight;
    if (!vw || !vh) return null;
    var scale = Math.min(1, 1400 / Math.max(vw, vh));
    var w = Math.round(vw * scale), h = Math.round(vh * scale);
    grab.width = w; grab.height = h;
    var ctx = grab.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(el.video, 0, 0, w, h);
    var img = ctx.getImageData(0, 0, w, h), d = img.data, n = w * h, i;
    var hist = new Uint32Array(256);
    for (i = 0; i < n; i++) {
      var g = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
      d[i * 4] = g; hist[g]++;
    }
    var lo = 0, hi = 255, acc = 0;
    while (lo < 255 && acc + hist[lo] < n * 0.02) { acc += hist[lo]; lo++; }
    acc = 0;
    while (hi > 0 && acc + hist[hi] < n * 0.02) { acc += hist[hi]; hi--; }
    var range = Math.max(hi - lo, 40), k = 255 / range;
    for (i = 0; i < n; i++) {
      var v = (d[i * 4] - lo) * k; v = v < 0 ? 0 : v > 255 ? 255 : v;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return grab;
  }

  function extractLines(data) {
    var out = [];
    (data.blocks || []).forEach(function (b) {
      (b.paragraphs || []).forEach(function (p) {
        (p.lines || []).forEach(function (l) {
          var words = (l.words || []).map(function (w) {
            return { text: w.text, confidence: w.confidence, x0: w.bbox ? w.bbox.x0 : 0 };
          }).filter(function (w) { return w.text && w.text.trim(); });
          if (!words.length) return;
          out.push({ text: words.map(function (w) { return w.text; }).join(' '), words: words, y0: l.bbox.y0, y1: l.bbox.y1 });
        });
      });
    });
    return out;
  }

  function decide(m) {
    var now = Date.now();
    // A miss doesn't cancel a pending guess: the two page modes often disagree scan to scan.
    if (!m || m.sim < T_LOW) return null;
    var strong = m.sim >= T_HIGH && (m.key.length >= 5 || m.sim >= 0.999);
    if (strong) return m.name;
    if (state.pending.name === m.name && now - state.pending.t < 10000) { state.pending = { name: null, t: 0 }; return m.name; }
    state.pending = { name: m.name, t: now };
    return null;
  }

  var DEBUG = /[?&]debug/.test(location.search);
  function showDebug(mode, lines, m, ms) {
    el.debug.hidden = false;
    el.debug.textContent = 'psm ' + mode + '  ' + ms + ' ms  lines ' + lines.length + '\nmatch: ' + (m ? m.name + ' (' + m.sim.toFixed(2) + ') from "' + m.line + '"' : 'none') + '\n' + lines.slice(0, 6).map(function (l) { return '> ' + l.text; }).join('\n');
  }

  function scanOnce() {
    var frame = grabFrame();
    if (!frame) return Promise.resolve();
    var t0 = Date.now();
    var mode = MODES[state.modeIdx++ % MODES.length];
    return state.worker.setParameters({ tessedit_pageseg_mode: mode }).then(function () {
      return state.worker.recognize(frame, {}, { blocks: true });
    }).then(function (res) {
      var lines = extractLines(res.data);
      var m = CardMatch.pick(state.index, lines);
      state.debug = { mode: mode, lines: lines.map(function (l) { return l.text; }).slice(0, 12), match: m ? { name: m.name, sim: m.sim, line: m.line } : null };
      if (DEBUG) showDebug(mode, lines, m, Date.now() - t0);
      var name = decide(m);
      var now = Date.now();
      if (now < state.suppressUntil) name = null;
      if (m && state.current && m.name === state.current.name && m.sim >= T_LOW) state.lastSeenAt = now;
      if (name) {
        state.misses = 0;
        var same = state.current && state.current.name === name;
        if (same && now - state.lastSeenAt < 4500) { state.lastSeenAt = now; return; }
        return announce(name);
      }
      var textual = lines.filter(function (l) { return /[A-Za-z]{4}/.test(l.text); }).length;
      if (textual >= 4) state.misses++;
      if (state.misses >= 6 && now - state.lastHelp > 25000) {
        state.misses = 0; state.lastHelp = now;
        say(["I can't read a card. Try more light, and hold the card flat and steady with the name at the top."]);
      }
    });
  }

  function loop() {
    if (!state.ready) return;
    if (state.paused || document.hidden || !state.stream) { setTimeout(loop, 400); return; }
    scanOnce().catch(function () {}).then(function () { setTimeout(loop, 200); });
  }

  /* ---------- controls ---------- */
  function changeRate(delta) {
    var next = Math.max(0, Math.min(RATES.length - 1, state.rateIdx + delta));
    if (next === state.rateIdx) { say([delta > 0 ? 'Fastest speed.' : 'Slowest speed.']); return; }
    state.rateIdx = next; saveSettings();
    say(['Speed ' + (next + 1) + ' of ' + RATES.length + '.']);
  }
  el.btnSlower.addEventListener('click', function () { changeRate(-1); });
  el.btnFaster.addEventListener('click', function () { changeRate(1); });
  el.btnRepeat.addEventListener('click', function () { if (!state.swallowClick) repeat(); });
  el.stage.addEventListener('click', function () { if (!state.swallowClick) repeat(); });
  el.stage.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); repeat(); } });

  el.btnPause.addEventListener('click', function () {
    state.paused = !state.paused;
    el.btnPause.setAttribute('aria-pressed', String(state.paused));
    el.btnPause.textContent = state.paused ? 'Resume scanning' : 'Pause scanning';
    setStatus(state.paused ? 'Paused' : 'Scanning…');
    if (!state.swallowClick) say([state.paused ? 'Scanning paused.' : 'Scanning.']);
  });

  function syncReminderButton() {
    el.btnReminder.textContent = 'Reminder text: ' + (state.reminder ? 'on' : 'off');
    el.btnReminder.setAttribute('aria-pressed', String(state.reminder));
  }
  el.btnReminder.addEventListener('click', function () {
    state.reminder = !state.reminder; saveSettings(); syncReminderButton();
    if (state.current) { render(); say(currentSegments()); }
    else say(['Reminder text ' + (state.reminder ? 'on' : 'off') + '.']);
  });

  el.btnTorch.addEventListener('click', function () {
    if (!state.track) return;
    var on = !state.torch;
    state.track.applyConstraints({ advanced: [{ torch: on }] }).then(function () {
      state.torch = on;
      el.btnTorch.setAttribute('aria-pressed', String(on));
      el.btnTorch.textContent = 'Light: ' + (on ? 'on' : 'off');
      say(['Light ' + (on ? 'on' : 'off') + '.']);
    }).catch(function () { say(['This phone would not turn the light on.']); });
  });

  function showType(open) {
    el.typeBox.hidden = !open;
    if (open) { el.typeInput.value = ''; setTimeout(function () { el.typeInput.focus(); }, 50); }
  }
  el.btnType.addEventListener('click', function () { showType(true); });
  el.typeClose.addEventListener('click', function () { showType(false); });
  el.typeBox.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = CardMatch.compact(el.typeInput.value);
    if (!state.index || q.length < 3) { say(['Please type at least three letters of the card name.']); return; }
    var m = CardMatch.bestFor(state.index, q);
    if (m && m.sim >= 0.6) { showType(false); state.suppressUntil = Date.now() + 20000; announce(m.name); }
    else say(['No card found for that name.']);
  });

  el.btnAbout.addEventListener('click', function () { el.about.hidden = false; $('aboutClose').focus(); });
  el.aboutClose.addEventListener('click', function () { el.about.hidden = true; });

  /* ---------- startup ---------- */
  function fatal(title, body) {
    el.fatalTitle.textContent = title; el.fatalBody.textContent = body; el.fatal.hidden = false;
    setStatus(title);
    try { if (!needsActivation() && synth) speakNow([title + '. ' + body]); } catch (e) {}
    el.btnRetry.focus();
  }
  el.btnRetry.addEventListener('click', function () { location.reload(); });

  function init() {
    loadSettings(); syncReminderButton();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
    requestWake();
    setStatus('Starting camera…');
    startCamera().then(function () {
      setStatus('Loading reader…');
      return Promise.all([initWorker(), loadNames()]);
    }, function (err) {
      var name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        fatal('Camera is blocked', 'Allow camera access for this page in your browser settings, then tap Try again.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        fatal('No camera found', 'This phone did not offer a camera to the browser.');
      } else if (name === 'Unsupported') {
        fatal('Camera not supported', 'Open this page in Chrome on your phone using a secure web address.');
      } else {
        fatal('Camera problem', 'The camera could not start. Close other apps that use it and tap Try again.');
      }
      throw err;
    }).then(function (r) {
      state.worker = r[0];
      setStatus('Preparing card list…');
      return new Promise(function (res) { setTimeout(function () { res(r[1]); }, 30); });
    }).then(function (names) {
      state.index = CardMatch.buildIndex(names);
      state.ready = true;
      setStatus('Scanning… hold a card up');
      if (!state.welcomed) {
        state.welcomed = true;
        say(['Ready. Hold a card upright, with its name at the top.']);
      }
      loop();
    }).catch(function (err) {
      if (!el.fatal.hidden) return;
      var offline = navigator.onLine === false;
      fatal(offline ? 'You are offline' : 'Could not start the reader',
        offline ? 'The first launch needs the internet to download the card list. Connect and tap Try again.'
                : 'Something went wrong while loading. Check your connection and tap Try again.');
    });
  }

  window.__reader = state; // handy for testing
  init();
})();

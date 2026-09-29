/* Turns a Scryfall card object into short, spoken-friendly "game info" segments.
   Works in the browser (window.CardScript) and in Node (module.exports) for tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardScript = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLORS = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless', S: 'snow' };
  var ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

  function numWord(n) { return String(n); }

  // One mana/cost symbol (the text inside the braces) -> words.
  function symbolWords(inner, costMode) {
    var s = inner.toUpperCase();
    if (s === 'T') return 'tap';
    if (s === 'Q') return 'untap';
    if (s === 'E') return 'energy';
    if (s === 'CHAOS') return 'chaos';
    if (s === 'PW') return 'planeswalker';
    if (s === 'TK') return 'ticket';
    if (s === 'A') return 'acorn';
    if (s === 'X' || s === 'Y' || s === 'Z') return s;
    if (s === 'S') return 'snow';
    if (s === 'C') return 'colorless';
    if (/^\d+$/.test(s)) {
      if (s === '0') return 'zero';
      return costMode ? s + ' generic' : s;
    }
    if (COLORS[s]) return COLORS[s];
    if (s.indexOf('/') !== -1) {
      var parts = s.split('/');
      var phy = parts.indexOf('P') !== -1;
      var words = parts.filter(function (p) { return p !== 'P'; }).map(function (p) {
        if (/^\d+$/.test(p)) return p + ' generic';
        return COLORS[p] || p.toLowerCase();
      });
      return (phy ? 'Phyrexian ' : '') + words.join(' or ');
    }
    if (s === 'HW' || s === 'HR' || s === 'HG' || s === 'HU' || s === 'HB') return 'half ' + (COLORS[s.charAt(1)] || '');
    return inner.toLowerCase();
  }

  function symbolGroup(group, costMode) {
    var out = [];
    group.replace(/\{([^}]+)\}/g, function (_, inner) { out.push(symbolWords(inner, costMode)); return ''; });
    return out.join(', ');
  }

  function spokenCost(manaCost) {
    return symbolGroup(manaCost, true);
  }

  function calcMV(manaCost) {
    var total = 0;
    (manaCost || '').replace(/\{([^}]+)\}/g, function (_, inner) {
      var s = inner.toUpperCase();
      if (/^\d+$/.test(s)) total += parseInt(s, 10);
      else if (s === 'X' || s === 'Y' || s === 'Z') total += 0;
      else if (/^H/.test(s) && s.length === 2) total += 0.5;
      else if (/^\d+\//.test(s)) total += parseInt(s, 10);
      else total += 1;
      return '';
    });
    return total;
  }

  // Power / toughness / loyalty / defense values like "3", "*", "1+*", "-1".
  function speakStat(v) {
    return String(v).replace(/\*/g, 'star').replace(/\+/g, ' plus ').replace(/^[−–-]/, 'minus ').replace(/\s+/g, ' ').trim();
  }

  function stripReminders(text) {
    var prev;
    do { prev = text; text = text.replace(/\s*\([^()]*\)/g, ''); } while (text !== prev);
    return text;
  }

  function signWord(sign) {
    if (sign === '+') return 'plus ';
    if (sign) return 'minus ';
    return '';
  }

  // Digits/star pairs like 2/2, +1/+1, -1/-1, */* -> "2 slash 2" (stops TTS reading dates).
  function fixSlashes(t) {
    return t.replace(/([+−–-]?)(\d+|X|\*)\/([+−–-]?)(\d+|X|\*)(?![\w/])/g, function (m, s1, a, s2, b) {
      return signWord(s1) + (a === '*' ? 'star' : a) + ' slash ' + signWord(s2) + (b === '*' ? 'star' : b);
    });
  }

  function fixSigns(t) {
    t = t.replace(/(^|[\s(])\+(?=\d|X)/g, '$1plus ');
    t = t.replace(/(^|[\s(])[−–-](?=\d|X)/g, '$1minus ');
    return t;
  }

  function endPunct(s) {
    s = s.trim();
    if (!s) return s;
    return /[.:!?"')]$/.test(s) ? s : s + '.';
  }

  function romanList(str) {
    return str.split(/,\s*/).map(function (r) { return ROMAN[r] || r; });
  }

  function joinNums(nums) {
    if (nums.length === 1) return String(nums[0]);
    return nums.slice(0, -1).join(', ') + ' and ' + nums[nums.length - 1];
  }

  // Turn one face's rules text into an array of spoken lines.
  function rulesLines(face, opts) {
    var text = face.oracle_text || '';
    var type = face.type_line || '';
    var isBasic = /Basic Land/.test(type);
    var isSaga = /\bSaga\b/.test(type);
    var isPW = /Planeswalker/.test(type);
    var lines = text.split('\n');
    var keepReminder = opts.reminder || isBasic;
    if (!keepReminder) {
      lines = lines.map(stripReminders);
      // If reminder text was all there was, fall back to it so we never say "nothing".
      if (!lines.some(function (l) { return l.trim(); }) && text.trim()) lines = text.split('\n');
    }
    var out = [];
    var bulletN = 0;
    lines.forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      if (keepReminder && /^\([^()]*\)$/.test(line)) line = line.slice(1, -1);
      var prefix = '';
      var m;
      if (line.charAt(0) === '•') {
        bulletN += 1;
        prefix = 'Option ' + bulletN + ': ';
        line = line.replace(/^•\s*/, '');
      } else {
        bulletN = 0;
        if (isSaga && (m = line.match(/^((?:[IVX]+)(?:,\s*[IVX]+)*)\s*—\s*(.*)$/))) {
          var nums = romanList(m[1]);
          prefix = (nums.length > 1 ? 'Chapters ' : 'Chapter ') + joinNums(nums) + ': ';
          line = m[2];
        } else if (isPW && (m = line.match(/^([+−–-]?)(\d+|X):\s*(.*)$/))) {
          var sign = m[1];
          var word = sign === '+' ? 'Plus ' : (sign ? 'Minus ' : '');
          var n = m[2] === '0' && !sign ? 'Zero' : m[2];
          prefix = word + n + ': ';
          line = m[3];
        }
      }
      line = line.replace(/(?:\{[^}]+\})+/g, function (g) { return symbolGroup(g, false); });
      line = fixSlashes(line);
      line = fixSigns(line);
      line = line.replace(/\s*—\s*$/, ':').replace(/\s*—\s*/g, ', ');
      out.push(endPunct(prefix + line));
    });
    return out;
  }

  function faceSegments(face, opts, ctx) {
    var segs = [];
    var name = face.name;
    segs.push(name + '.');
    var type = (face.type_line || '').replace(/\s*—\s*/g, ', ');
    if (type) segs.push(type + '.');

    var isLand = /\bLand\b/.test(face.type_line || '');
    var cost = face.mana_cost;
    if (cost) {
      var mv = ctx.mv;
      if (mv === undefined || mv === null) mv = calcMV(cost);
      segs.push('Mana cost: ' + spokenCost(cost) + '. Mana value ' + numWord(mv) + '.');
    } else if (!isLand && !ctx.backFace) {
      segs.push('No mana cost.');
    }

    if (face.power !== undefined && face.toughness !== undefined && face.power !== null) {
      segs.push(speakStat(face.power) + ' power, ' + speakStat(face.toughness) + ' toughness.');
    }
    if (face.loyalty !== undefined && face.loyalty !== null) segs.push('Starting loyalty ' + speakStat(face.loyalty) + '.');
    if (face.defense !== undefined && face.defense !== null) segs.push('Defense ' + speakStat(face.defense) + '.');

    var lines = rulesLines(face, opts);
    if (lines.length) segs = segs.concat(lines);
    else if (!isLand) segs.push('No rules text.');
    return segs;
  }

  var LABELS = {
    transform: ['Front face.', 'Back face.'],
    modal_dfc: ['Front face.', 'Back face.'],
    double_faced_token: ['Front face.', 'Back face.'],
    reversible_card: ['Front face.', 'Back face.'],
    split: ['Left half.', 'Right half.'],
    flip: ['Top half.', 'Flipped half.'],
    adventure: ['Main card.', 'Adventure.'],
    aftermath: ['First half.', 'Aftermath half.']
  };

  var BACKFACE_NO_COST = { transform: 1, flip: 1, double_faced_token: 1 };

  function build(card, opts) {
    opts = opts || {};
    var faces = card.card_faces;
    // Some single-faced cards still list one face; treat as normal.
    if (faces && faces.length > 1 && !(card.oracle_text)) {
      var labels = LABELS[card.layout] || ['Side one.', 'Side two.'];
      var segs = [];
      faces.forEach(function (f, i) {
        segs.push(labels[i] || 'Side ' + (i + 1) + '.');
        // Fill in missing type line for faces that omit it (rare).
        var face = f;
        var ctx = { backFace: i > 0 && !!BACKFACE_NO_COST[card.layout] };
        segs = segs.concat(faceSegments(face, opts, ctx));
      });
      return segs;
    }
    return faceSegments(card, opts, { mv: card.cmc });
  }

  return { build: build, spokenCost: spokenCost, calcMV: calcMV, symbolGroup: symbolGroup, speakStat: speakStat };
});

'use strict';
// AI Animation score: mood music and sound effects for a film.
// Music follows each scene's mood; the sound
// effects the animator listed per scene:
//   scene.sfx = [[lineIndex, secondsAfterLineStart, kind], ...]
// kinds: pop thud whoosh chime sparkle drip splash thunder bird cheer magic step knock bell
// Everything is synthesised with Web Audio and seeded (hash), so a film's
// sound is the same every render, and there is nothing licensed in it.

function score(ac, t0, dest) {
  const list = typeof SCENES !== 'undefined' ? SCENES : [];
  let acc = 0;
  const parts = PLAY.map((p) => { const sc = list.find((s) => s.name === p.name) || null; const part = {p, sc, start: acc, dur: p.dur}; acc += p.dur; return part; });
  const END = acc;

  // ---- mix bus: master fade, gentle compression, a small echo room ----
  const out = ac.createGain();
  out.gain.setValueAtTime(0, t0); out.gain.linearRampToValueAtTime(.85, t0 + 1.5);
  out.gain.setValueAtTime(.85, t0 + Math.max(1.6, END - 3)); out.gain.linearRampToValueAtTime(0, t0 + END - .2);
  const comp = ac.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3; out.connect(comp); comp.connect(dest);
  const dry = ac.createGain(); dry.connect(out);
  for (const [dt, fbv] of [[.23, .28], [.37, .22]]) {
    const d = ac.createDelay(1), fb = ac.createGain(), lp = ac.createBiquadFilter();
    d.delayTime.value = dt; fb.gain.value = fbv; lp.type = 'lowpass'; lp.frequency.value = 2400;
    dry.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(out);
  }
  const sfxBus = ac.createGain(); sfxBus.gain.value = 1; sfxBus.connect(out);

  const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
  const env = (g, t, a, d, v) => { g.gain.setValueAtTime(0, t0 + t); g.gain.linearRampToValueAtTime(v, t0 + t + a); g.gain.exponentialRampToValueAtTime(.0004, t0 + t + a + d); };
  const osc = (type, f, t, d, v, a = .008, to = dry) => { if (t < 0 || t > END) return; const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.value = f; env(g, t, a, d, v); o.connect(g); g.connect(to); o.start(t0 + t); o.stop(t0 + t + a + d + .05); };
  const padLP = ac.createBiquadFilter(); padLP.type = 'lowpass'; padLP.frequency.value = 1100; padLP.connect(dry);
  const pad = (t, d, notes, v) => {
    for (const n of notes) for (const det of [-4, 4]) {
      const o = ac.createOscillator(), g = ac.createGain(); o.type = 'triangle'; o.frequency.value = hz(n); o.detune.value = det;
      g.gain.setValueAtTime(0, t0 + t); g.gain.linearRampToValueAtTime(v, t0 + t + Math.min(.9, d / 3)); g.gain.setValueAtTime(v, t0 + t + d - .5); g.gain.linearRampToValueAtTime(0, t0 + t + d + .3);
      o.connect(g); g.connect(padLP); o.start(t0 + t); o.stop(t0 + t + d + .4);
    }
  };
  const pluck = (t, n, v) => { osc('sine', hz(n), t, 1.3, v); osc('sine', hz(n) * 2, t, .5, v * .25); osc('sine', hz(n) * 3.01, t, .2, v * .08); };
  const bass = (t, n, d, v) => osc('sine', hz(n - 24), t, d, v, .02);
  // Xianxia voices (window.FILM_GENRE = 'xianxia', set by xianxia.js):
  // a guzheng-like pluck (bright attack, slight downward bend, long ring),
  // a bamboo flute (breathy sine with vibrato), a low war drum.
  const XIANXIA = typeof window !== 'undefined' && window.FILM_GENRE === 'xianxia';
  const zheng = (t, n, v) => {
    if (t < 0 || t > END) return;
    for (const [type, mult, vol, d] of [['triangle', 1, 1, 1.8], ['sawtooth', 1, .18, .35], ['sine', 2, .3, .9]]) {
      const o = ac.createOscillator(), g = ac.createGain(), f = hz(n) * mult;
      o.type = type; o.frequency.setValueAtTime(f * 1.012, t0 + t); o.frequency.exponentialRampToValueAtTime(f, t0 + t + .08);
      env(g, t, .004, d, v * vol); o.connect(g); g.connect(dry); o.start(t0 + t); o.stop(t0 + t + d + .1);
    }
  };
  const flute = (t, n, d, v) => {
    if (t < 0 || t > END) return;
    const o = ac.createOscillator(), lfo = ac.createOscillator(), lg = ac.createGain(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = hz(n); lfo.frequency.value = 5.2; lg.gain.value = hz(n) * .008; lfo.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0, t0 + t); g.gain.linearRampToValueAtTime(v, t0 + t + .12); g.gain.setValueAtTime(v * .85, t0 + t + d * .7); g.gain.linearRampToValueAtTime(0, t0 + t + d);
    o.connect(g); g.connect(dry); o.start(t0 + t); lfo.start(t0 + t); o.stop(t0 + t + d + .05); lfo.stop(t0 + t + d + .05);
    noise(t, d * .6, v * .25, 'bandpass', hz(n) * 2, 2, n);
  };
  const drum = (t, v) => { sweep(t, 110, 42, .45, v); noise(t, .15, v * .4, 'lowpass', 300, .7, 31); };

  // ---- moods: key, scale, chord loop, tempo, how busy ----
  const MAJOR = [0, 2, 4, 7, 9], MINOR = [0, 3, 5, 7, 10];
  const PROFILES = {
    bright: {root: 60, scale: MAJOR, chords: [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]], beat: .42, busy: .7, pad: .016, pluck: .05},
    calm: {root: 65, scale: MAJOR, chords: [[0, 4, 7], [5, 9, 12], [-3, 0, 4], [7, 11, 14]], beat: .55, busy: .45, pad: .018, pluck: .04},
    tense: {root: 57, scale: MINOR, chords: [[0, 3, 7], [-4, 0, 3], [-2, 2, 5], [0, 3, 7]], beat: .5, busy: .35, pad: .02, pluck: .035},
    night: {root: 57, scale: MINOR, chords: [[0, 3, 7], [5, 8, 12], [-4, 0, 3], [-2, 2, 5]], beat: .7, busy: .25, pad: .016, pluck: .03},
    triumph: {root: 62, scale: MAJOR, chords: [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]], beat: .36, busy: .85, pad: .018, pluck: .055},
  };
  const moodOf = (sc) => (sc && typeof sc.mood === 'string' ? sc.mood : 'warm');
  const profileFor = (mood) => ({storm: 'tense', dust: 'tense', fire: 'tense', red: 'tense', night: 'night', sea: 'calm', green: 'calm', forest: 'calm', paper: 'calm', stone: 'calm', gold: 'triumph', saffron: 'triumph'})[mood] || 'bright';

  let seed = 1;
  for (const part of parts) {
    const isEnd = !part.sc;
    const prof = PROFILES[isEnd ? 'calm' : profileFor(moodOf(part.sc))];
    const bar = prof.beat * 4;
    const s0 = part.start, s1 = part.start + part.dur;
    let chordIndex = 0;
    for (let t = s0; t < s1 - .3; t += bar, chordIndex++) {
      const len = Math.min(bar, s1 - t);
      const chord = prof.chords[chordIndex % prof.chords.length].map((n) => n + prof.root);
      pad(t, len, chord, XIANXIA ? prof.pad * .8 : prof.pad);
      if (XIANXIA && !isEnd && (profileFor(moodOf(part.sc)) === 'tense' || profileFor(moodOf(part.sc)) === 'triumph')) { drum(t, .14); if (hash(seed++, 23) > .4) drum(t + prof.beat * 2, .09); }
      bass(t, chord[0], Math.min(len, bar) * .9, .05);
      // a light tune over the chord, seeded so every render sounds the same
      for (let k = 0; k < 4; k++) {
        const bt = t + k * prof.beat;
        if (bt > s1 - .4 || hash(seed++, 11) > prof.busy) continue;
        const step = prof.scale[Math.floor(hash(seed++, 13) * prof.scale.length)];
        const note = prof.root + 12 + step + (hash(seed++, 17) > .8 ? 12 : 0);
        if (!XIANXIA) pluck(bt, note, prof.pluck);
        // Xianxia: the guzheng carries the rhythm, the flute sometimes sings a long note over it.
        else if (k === 0 && hash(seed++, 29) > .45) flute(bt, note + 12, bar * .9, prof.pluck * .7);
        else zheng(bt, note, prof.pluck * 1.1);
      }
    }
    // weather under stormy scenes
    if (!isEnd && moodOf(part.sc) === 'storm') rain(s0 + .3, part.dur - .6, .025);
    if (isEnd) { pluck(s0 + .4, prof.root + 12, .06); pluck(s0 + .9, prof.root + 16, .05); pluck(s0 + 1.4, prof.root + 19, .05); pluck(s0 + 2.2, prof.root + 24, .06); }
  }

  // ---- sound effects ----
  function sweep(t, f0, f1, d, v, type = 'sine') { if (t < 0 || t > END) return; const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.setValueAtTime(f0, t0 + t); o.frequency.exponentialRampToValueAtTime(f1, t0 + t + d); env(g, t, .004, d, v); o.connect(g); g.connect(sfxBus); o.start(t0 + t); o.stop(t0 + t + d + .05); }
  function noise(t, d, v, type, f, q = .8, k = 1) {
    if (t < 0 || t > END) return;
    const n = Math.max(1, Math.ceil(ac.sampleRate * d)), buf = ac.createBuffer(1, n, ac.sampleRate), data = buf.getChannelData(0), r = rng(k * 7919 + 3);
    for (let i = 0; i < n; i++) { const fade = 1 - i / n; data[i] = (r() * 2 - 1) * fade; }
    const src = ac.createBufferSource(), flt = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = buf; flt.type = type; flt.frequency.value = f; flt.Q.value = q; g.gain.value = v;
    src.connect(flt); flt.connect(g); g.connect(sfxBus); src.start(t0 + t);
  }
  function rain(t, d, v) { for (let x = 0; x < d; x += .09) { const k = (t * 100 + x * 100) | 0, fade = Math.min(1, x / 1, (d - x) / 1); noise(t + x + hash(k, 5) * .05, .3, v * fade, 'bandpass', 3200, .6, k); } }
  const FX = {
    pop: (t) => sweep(t, 480, 1300, .09, .09),
    thud: (t) => { sweep(t, 150, 50, .25, .2); noise(t, .12, .08, 'lowpass', 400, .7, 3); },
    whoosh: (t) => noise(t, .45, .12, 'bandpass', 1400, .9, 5),
    chime: (t) => { for (const [k, n] of [[0, 84], [1, 88], [2, 91]]) osc('sine', hz(n), t + k * .08, 1.2, .045, .004, sfxBus); },
    sparkle: (t) => { for (let k = 0; k < 6; k++) osc('sine', hz(84 + [0, 4, 7, 12, 16, 19][k]), t + k * .06, .5, .03, .003, sfxBus); },
    drip: (t) => sweep(t, 1700, 750, .07, .05),
    splash: (t) => { noise(t, .5, .14, 'highpass', 1800, .7, 9); sweep(t, 600, 200, .15, .05); },
    thunder: (t) => { noise(t, 2.2, .3, 'lowpass', 220, .5, 13); noise(t + .05, .4, .15, 'bandpass', 900, .6, 17); },
    bird: (t) => { sweep(t, 3200, 4400, .07, .035); sweep(t + .12, 3400, 4700, .06, .03); sweep(t + .3, 3000, 4200, .08, .03); },
    cheer: (t) => { for (let k = 0; k < 5; k++) noise(t + k * .08, 1.1, .05, 'bandpass', 900 + k * 260, 1.4, 21 + k); pluck(t + .1, 72, .04); pluck(t + .3, 76, .04); pluck(t + .5, 79, .05); },
    magic: (t) => { sweep(t, 400, 1600, .6, .05, 'triangle'); for (let k = 0; k < 5; k++) osc('sine', hz(88 + k * 2), t + .2 + k * .07, .6, .025, .003, sfxBus); },
    step: (t) => noise(t, .08, .06, 'lowpass', 700, .8, 29),
    knock: (t) => { sweep(t, 300, 120, .08, .12); sweep(t + .18, 300, 120, .08, .12); },
    bell: (t) => { osc('sine', hz(76), t, 2.5, .06, .004, sfxBus); osc('sine', hz(76) * 2.76, t, 1.2, .02, .004, sfxBus); },
  };
  for (const part of parts) {
    if (!part.sc || !Array.isArray(part.sc.sfx)) continue;
    const lines = part.p.S ? part.p.S.lines : [];
    for (const item of part.sc.sfx) {
      if (!Array.isArray(item)) continue;
      const [line, offset, kind] = item;
      const fx = FX[kind];
      if (!fx) continue;
      const lineStart = lines.length ? lines[Math.max(0, Math.min(lines.length - 1, line | 0))].t0 : (line | 0) * 2;
      fx(part.start + lineStart + (+offset || 0));
    }
  }
}

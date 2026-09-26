'use strict';
// Xianxia (仙侠, Chinese immortal-cultivation) props, headwear and effects.
// Everything is drawn with the kit's own sh()/mk()/ell()/curve(), so each look
// (pencil, wash, haze, paper, marker) styles it like the rest of the film.
// Loaded after props.js/action.js; all names start with xx so they cannot
// clash with the kit or a film's own helpers.

window.FILM_GENRE = 'xianxia';

// ---- hair and headwear for cultivators (added to the kit's HATS) ----
HATS.topknot = (c, r) => { HATS.hair(c, r); sh(c, circ(0, -r * 1.12, r * .3, 14), '#2a211c', {w: 4}); mk(c, [[-r * .5, -r * 1.12], [r * .5, -r * 1.12]], {w: 3.6, color: T.gold}); };
HATS.crown = (c, r) => { HATS.hair(c, r); sh(c, circ(0, -r * 1.1, r * .3, 14), '#2a211c', {w: 4}); sh(c, [[-r * .3, -r * 1.05, 1], [-r * .22, -r * 1.42, 1], [0, -r * 1.3, 1], [r * .22, -r * 1.42, 1], [r * .3, -r * 1.05, 1]], T.gold, {w: 3.4}); mk(c, [[-r * .62, -r * 1.12], [r * .62, -r * 1.12]], {w: 3.6, color: T.gold}); };
HATS.longhair = (c, r) => { sh(c, [[-r * 1, -r * .1, 1], [-r * 1.05, r * 1.6], [-r * .6, r * 1.9], [-r * .3, r * .2], [r * .3, r * .2], [r * .6, r * 1.9], [r * 1.05, r * 1.6], [r * 1, -r * .1, 1], [r * .9, -r * .7], [0, -r * 1.02], [-r * .9, -r * .7]], '#2a211c', {w: 4}); };
HATS.veil = (c, r) => { HATS.bun(c, r); sh(c, [[-r * 1.05, -r * .5, 1], [r * 1.05, -r * .5, 1], [r * 1.2, r * .9], [-r * 1.2, r * .9]], '#f4efe6', {w: 2.4, al: .55}); };
HATS.guan = (c, r) => { HATS.hair(c, r); sh(c, rr(-r * .42, -r * 1.5, r * .84, r * .52, 4), '#2a211c', {w: 3.6}); mk(c, [[-r * .9, -r * 1.3], [r * .9, -r * 1.3]], {w: 3, color: T.gold}); };

// ---- landscape ----
/** A tall misty karst peak (Zhangjiajie / Huangshan). y = foot, h = height. */
function xxPeak(c, x, y, h, w = h * .32, {col = T.greenDk, snow = false, seed = 1} = {}) {
  const pts = [[x - w / 2, y, 1]];
  for (let k = 1; k < 6; k++) { const f = k / 6; pts.push([x - w / 2 + (w * .18) * f + wobble(k, seed) * w * .06, y - h * f]); }
  pts.push([x - w * .08, y - h, 1], [x + w * .1, y - h * .98, 1]);
  for (let k = 5; k >= 1; k--) { const f = k / 6; pts.push([x + w / 2 - (w * .2) * f + wobble(k + 9, seed) * w * .06, y - h * f]); }
  pts.push([x + w / 2, y, 1]);
  sh(c, pts, col, {w: 3});
  if (snow) sh(c, [[x - w * .12, y - h * .9, 1], [x - w * .08, y - h, 1], [x + w * .1, y - h * .98, 1], [x + w * .14, y - h * .88, 1]], '#f7f4ee', {w: 2});
  for (const [px, py, s] of [[x - w * .12, y - h * .62, .8], [x + w * .1, y - h * .4, .7]]) xxPine(c, px, py, 38 * s);
}
/** A small crooked pine clinging to a cliff. */
function xxPine(c, x, y, s = 40) {
  mk(c, [[x, y], [x + s * .1, y - s * .5], [x - s * .05, y - s]], {w: Math.max(2, s * .08), color: T.brown});
  for (const [dx, dy, r] of [[-.35, -.95, .42], [.25, -.75, .36], [-.1, -.55, .3]]) sh(c, ell(x + dx * s, y + dy * s, r * s, r * s * .45, 16), T.greenDk, {w: 2.4});
}
/** A band of drifting cloud sea at height y (moves slowly with tau). */
function xxCloudSea(c, y, tau = 0, {col = '#f5f2ea', al = .9, speed = 12, seed = 3} = {}) {
  for (let k = 0; k < 9; k++) {
    const x = ((k * 260 + tau * speed + hash(k, seed) * 120) % 2400) - 240;
    sh(c, ell(x, y + wobble(k * 1.7, seed) * 18, 170 + hash(k, seed + 1) * 90, 46 + hash(k, seed + 2) * 20, 24), col, {w: 2, al});
  }
}
/** A waterfall down a cliff face. */
function xxWaterfall(c, x, y0, y1, w = 40, tau = 0) {
  sh(c, rectP(x - w / 2, y0, w, y1 - y0), T.water, {w: 2.4, al: .9});
  for (let k = 0; k < 4; k++) { const yy = y0 + ((tau * 180 + k * (y1 - y0) / 4) % (y1 - y0)); mk(c, [[x - w * .3, yy], [x - w * .3, yy + 40]], {w: 2.4, color: '#ffffff', al: .8}); mk(c, [[x + w * .2, yy + 20], [x + w * .2, yy + 60]], {w: 2, color: '#ffffff', al: .7}); }
  sh(c, ell(x, y1, w * 1.4, w * .35, 18), '#ffffff', {w: 2, al: .7});
}

// ---- architecture ----
/** An upturned Chinese roof: w wide, eaves at y, ridge h above. */
function xxRoof(c, x, y, w, h, col = T.navy) {
  const tip = w * .08;
  sh(c, [[x - w / 2 - tip, y - tip * .9, 1], [x - w / 2 + w * .06, y, 1], [x + w / 2 - w * .06, y, 1], [x + w / 2 + tip, y - tip * .9, 1], [x + w * .32, y - h * .55], [x + w * .22, y - h, 1], [x - w * .22, y - h, 1], [x - w * .32, y - h * .55]], col, {w: 3.4});
  mk(c, [[x - w * .24, y - h], [x + w * .24, y - h]], {w: 5});
  for (const sg of [-1, 1]) mk(c, [[x + sg * w * .22, y - h], [x + sg * w * .3, y - h - 12]], {w: 4});
}
/** A pavilion / hall: platform, red pillars, upturned roof. s = scale (1 ≈ 360 wide). */
function xxPavilion(c, x, y, s = 1, {roof = T.navy, wall = T.red, tiers = 1} = {}) {
  const w = 360 * s, h = 190 * s;
  sh(c, rectP(x - w * .6, y - 24 * s, w * 1.2, 24 * s), T.stone, {w: 3});
  for (const f of [-.42, -.14, .14, .42]) sh(c, rectP(x + f * w - 9 * s, y - 24 * s - h, 18 * s, h), wall, {w: 2.6});
  sh(c, rectP(x - w * .46, y - 24 * s - h, w * .92, 16 * s), T.gold, {w: 2.4});
  let top = y - 24 * s - h;
  for (let t = 0; t < tiers; t++) { const k = 1 - t * .22; xxRoof(c, x, top, w * k * 1.1, 90 * s * k, roof); top -= 90 * s * k * .75; }
}
/** A multi-tier pagoda. */
function xxPagoda(c, x, y, s = 1, {tiers = 5, roof = T.navy, wall = '#e9dcc3'} = {}) {
  let yy = y, w = 170 * s;
  for (let t = 0; t < tiers; t++) {
    const bh = 70 * s * (1 - t * .06);
    sh(c, rectP(x - w * .36, yy - bh, w * .72, bh), wall, {w: 2.6});
    sh(c, rectP(x - 10 * s, yy - bh * .75, 20 * s, bh * .55), T.red, {w: 2});
    xxRoof(c, x, yy - bh, w, 40 * s, roof);
    yy -= bh + 30 * s; w *= .84;
  }
  mk(c, [[x, yy + 10 * s], [x, yy - 60 * s]], {w: 5, color: T.gold});
}
/** A sect gate (paifang) with a name board. */
function xxGate(c, x, y, s = 1, text = '', {col = T.red} = {}) {
  const w = 420 * s, h = 300 * s;
  for (const f of [-.45, .45]) sh(c, rectP(x + f * w - 14 * s, y - h, 28 * s, h), col, {w: 3});
  sh(c, rectP(x - w * .5, y - h - 10 * s, w, 34 * s), col, {w: 3});
  xxRoof(c, x, y - h - 10 * s, w * 1.15, 70 * s);
  if (text) { sh(c, rectP(x - 90 * s, y - h + 36 * s, 180 * s, 54 * s), T.gold, {w: 2.6}); c.save(); c.font = `700 ${34 * s}px ${FONT.serif}`; c.textAlign = 'center'; c.fillStyle = '#3a2418'; c.fillText(text, x, y - h + 74 * s); c.restore(); }
}
/** A hanging red lantern (sways with tau). */
function xxLantern(c, x, y, s = 1, tau = 0) {
  const a = Math.sin(tau * 1.6 + x) * .06;
  c.save(); c.translate(x, y); c.rotate(a);
  mk(c, [[0, -40 * s], [0, 0]], {w: 2});
  sh(c, ell(0, 30 * s, 26 * s, 32 * s, 20), T.red, {w: 2.6});
  sh(c, rectP(-12 * s, -2 * s, 24 * s, 8 * s), T.gold, {w: 2}); sh(c, rectP(-12 * s, 58 * s, 24 * s, 8 * s), T.gold, {w: 2});
  mk(c, [[0, 66 * s], [0, 90 * s]], {w: 2, color: T.gold});
  c.restore();
}

// ---- cultivation ----
/** A glowing flying sword; angle in radians, glow 0..1. */
function xxSword(c, x, y, s = 1, angle = 0, {glow = .8, col = '#dfe9f2'} = {}) {
  if (glow > 0) glowLight(c, x, y, 90 * s, '#bfe3ff', glow);
  c.save(); c.translate(x, y); c.rotate(angle);
  sh(c, [[-70 * s, -5 * s, 1], [60 * s, -5 * s], [86 * s, 0, 1], [60 * s, 5 * s], [-70 * s, 5 * s, 1]], col, {w: 2.4});
  sh(c, rectP(-82 * s, -12 * s, 10 * s, 24 * s), T.gold, {w: 2});
  sh(c, rectP(-108 * s, -4 * s, 26 * s, 8 * s), T.brown, {w: 2});
  c.restore();
}
/** Swirling qi around a cultivator (tau animates it). */
function xxAura(c, x, y, r = 120, tau = 0, {col = '#a7e3ff', k = 1} = {}) {
  glowLight(c, x, y, r * 1.2, col, .7 * k);
  for (let i = 0; i < 3; i++) {
    const a0 = tau * (1.4 + i * .3) + i * 2.1;
    mk(c, ell(x, y, r * (.8 + i * .15), r * (.35 + i * .08), 14, a0, a0 + 2.4), {w: 3, color: col, al: .75 * k});
  }
}
/** A sword-qi slash: a bright crescent from a to b that draws on over d s. */
function xxSlash(c, tau, t0, a, b, {d = .35, col = '#cfefff', w = 14} = {}) {
  const u = clamp((tau - t0) / d, 0, 1), fade = 1 - clamp((tau - t0 - d) / .4, 0, 1);
  if (u <= 0 || fade <= 0) return;
  const mid = [(a[0] + b[0]) / 2 + (b[1] - a[1]) * .25, (a[1] + b[1]) / 2 - (b[0] - a[0]) * .25];
  const pts = cutAt(curve([a, mid, b]), u);
  if (pts.length > 1) { mk(c, pts, {w: w * 1.8, color: col, al: .35 * fade}); mk(c, pts, {w, color: '#ffffff', al: .9 * fade}); }
}
/** A breakthrough: a pillar of light and lightning on a cultivator. */
function xxBreakthrough(c, tau, t0, x, y, {d = 2.2, col = '#fff2b8'} = {}) {
  const u = clamp((tau - t0) / d, 0, 1);
  if (u <= 0 || u >= 1) return;
  const a = Math.sin(u * Math.PI);
  glowLight(c, x, y - 200, 260, col, a);
  sh(c, rectP(x - 40 * a, -200, 80 * a, y + 200), col, {w: 0, al: .45 * a, line: false});
  for (let k = 0; k < 3; k++) { const seed = Math.floor((tau - t0) * 10) + k * 7; const pts = [[x + (hash(seed, 1) - .5) * 300, -60]]; for (let j = 1; j <= 5; j++) pts.push([x + (hash(seed + j, 2) - .5) * 160 * (1 - j / 6), -60 + (y - 80) * j / 5]); mk(c, pts, {w: 4, color: '#fffbe0', al: a}); }
}
/** A paper talisman (with a red rune stroke). */
function xxTalisman(c, x, y, s = 1, angle = 0) {
  c.save(); c.translate(x, y); c.rotate(angle);
  sh(c, rectP(-16 * s, -40 * s, 32 * s, 80 * s), '#f2d65a', {w: 2});
  mk(c, [[-6 * s, -28 * s], [6 * s, -16 * s], [-6 * s, -2 * s], [6 * s, 12 * s], [0, 28 * s]], {w: 3, color: T.red});
  c.restore();
}
/** A lotus flower (spirit herb / pond). */
function xxLotus(c, x, y, s = 1) {
  sh(c, ell(x, y + 6 * s, 50 * s, 12 * s, 18), T.greenDk, {w: 2});
  for (const [a, k] of [[-.9, .8], [-.45, 1], [0, 1.15], [.45, 1], [.9, .8]]) { c.save(); c.translate(x, y); c.rotate(a); sh(c, [[0, 0, 1], [-10 * s, -22 * s * k], [0, -40 * s * k, 1], [10 * s, -22 * s * k]], T.pink, {w: 2}); c.restore(); }
}

/** A cultivator: pp() in a robe with a topknot, optional sword on the back,
 * a qi aura, and flying (feet off the ground, robe trailing).
 * o: all of pp's options, plus {sword, aura, flying, tau}. */
function xxCultivator(c, x, y, s, o = {}) {
  const {sword = false, aura = 0, flying = false, tau = 0} = o;
  const bob = flying ? Math.sin(tau * 2.2 + x * .01) * 8 : 0;
  if (aura > 0) xxAura(c, x, y + bob - 120 * s * PPK, 110 * s, tau, {k: aura});
  if (flying) for (let k = 0; k < 3; k++) mk(c, [[x - 20 * s + k * 20 * s, y + bob - 8], [x - 60 * s + k * 20 * s + Math.sin(tau * 5 + k) * 8, y + bob + 30 * s]], {w: 3, color: o.body || T.white, al: .7});
  if (sword) { c.save(); c.translate(x, y + bob); c.scale(s * PPK * (o.dir || 1), s * PPK); xxSword(c, -6, -80, .55, -1.2, {glow: 0}); c.restore(); }
  pp(c, x, y + bob, s, {hat: 'topknot', ...o, robe: true});
}

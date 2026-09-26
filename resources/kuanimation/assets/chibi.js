'use strict';
// Chibi fantasy characters for Kuanimation: a big-headed, big-eyed, finely
// dressed cultivator drawn in clean anime line + soft shading, with a
// reusable identity (defineChibi), an expression set, always-on idle life
// (breathing, blinking, hair / sleeve / tassel sway) and acting states
// (CHIBI_ACT) that combine like cinema.js's ACT.
//
//   const YUE = defineChibi({id: 'yue', name: 'Yue Lan', ...});
//   chibi(c, x, y, s, YUE, chibiState(CHIBI_ACT.idle(tau), CHIBI_ACT.wave(tau, 1)), tau);
//
// Local units: feet at (0, 0), up is negative y; at s = 1 a character is
// ≈ 400 units tall (head ≈ 55% of it). Everything is a pure function of tau.

// ---------- identity ----------
const CHIBI_DEFAULT = {
  id: 'chibi', name: 'Chibi', scale: 1,
  skin: '#fde9df', skinShade: '#f3cfc2', blush: '#f59aa8', line: '#3b3044',
  hair: '#f4f5fb', hairShade: '#cdd2ea', hairDeep: '#a9acd0', hairLine: '#8b8fb5',
  eyes: {top: '#27336d', mid: '#3f6fd8', bottom: '#8fd6ff', ring: '#1d2350', glow: '#9fe7ff'},
  robe: '#2b2a3a', robeShade: '#1d1c29', robeTrim: '#cfd6e6', inner: '#f5f6fa', innerShade: '#d9dde8',
  sash: '#dfe3ee', jade: '#7fd9c4', gem: '#6fb8ff',
  hairStyle: 'topknot', crown: true, hairpin: true, mark: 'crescent', pendant: true,
  weapon: 'staff', weaponColor: '#e8ecf5', aura: '#a9e4ff',
};
/** A character identity: every scene draws it from here, so face, hair and costume never drift. */
function defineChibi(def) {
  if (!def || !def.id) throw new Error('defineChibi needs an id');
  return Object.freeze({...CHIBI_DEFAULT, ...def, eyes: {...CHIBI_DEFAULT.eyes, ...(def.eyes || {})}});
}

// ---------- expressions ----------
// eye: open | happy (^ ^) | closed | narrow | wide; open 0..1; pupil scale;
// brow: inner-end lift (+ worried, - angry); mouth: smile grin open o frown flat smirk wavy cat.
const CHIBI_EXPR = Object.freeze({
  neutral:   {eye: 'open', open: 1, pupil: 1, brow: 0, browY: 0, mouth: 'flat', blush: .25, tilt: 0},
  happy:     {eye: 'happy', open: 1, pupil: 1, brow: .15, browY: -2, mouth: 'grin', blush: .75, tilt: .06, sparkle: true},
  serious:   {eye: 'narrow', open: .72, pupil: .95, brow: -.35, browY: 4, mouth: 'flat', blush: 0, tilt: 0},
  angry:     {eye: 'narrow', open: .7, pupil: .85, brow: -.9, browY: 6, mouth: 'frown', blush: 0, tilt: -.03, anger: true},
  surprised: {eye: 'wide', open: 1.15, pupil: .6, brow: .6, browY: -10, mouth: 'o', blush: .15, tilt: 0, sweat: true},
  sad:       {eye: 'open', open: .85, pupil: 1.05, brow: .9, browY: -2, mouth: 'frown', blush: .2, tilt: .05, tears: true},
  battle:    {eye: 'narrow', open: .78, pupil: .9, brow: -.55, browY: 5, mouth: 'flat', blush: 0, tilt: 0, glow: 1},
  shy:       {eye: 'open', open: .78, pupil: 1.05, brow: .5, browY: 0, mouth: 'wavy', blush: 1, tilt: .1, look: -.7, shyLines: true},
  confident: {eye: 'narrow', open: .85, pupil: 1, brow: -.15, browY: 2, mouth: 'smirk', blush: .3, tilt: -.05, sparkle: true},
});
/** Blend two expressions (u = 0..1): numbers ease, shapes switch at the midpoint. */
function chibiExpr(a, b = null, u = 0) {
  const A = typeof a === 'string' ? CHIBI_EXPR[a] || CHIBI_EXPR.neutral : a;
  if (!b) return A;
  const B = typeof b === 'string' ? CHIBI_EXPR[b] || CHIBI_EXPR.neutral : b, out = {};
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const va = A[k], vb = B[k];
    out[k] = typeof va === 'number' || typeof vb === 'number' ? lerp(va || 0, vb || 0, u) : (u < .5 ? va : vb);
  }
  return out;
}

// ---------- acting state ----------
// Fields: dx dy lean squash (added up) | armL armR weaponAngle look lookY headTilt
// wind aura glow float step expr weapon castGlow dir (last one wins).
const CHIBI_ADD = new Set(['dx', 'dy', 'lean', 'squash', 'headTilt', 'wind']);
function chibiState(...parts) {
  const out = {dx: 0, dy: 0, lean: 0, squash: 0, headTilt: 0, wind: 0};
  for (const p of parts) { if (!p) continue; for (const k in p) out[k] = CHIBI_ADD.has(k) ? (out[k] || 0) + (p[k] || 0) : p[k]; }
  return out;
}
const chibiPulse = (tau, t0, d) => { const u = clamp((tau - t0) / d, 0, 1); return Math.sin(u * Math.PI); };

const CHIBI_ACT = Object.freeze({
  idle(tau, seed = 1) { return {headTilt: Math.sin(tau * .9 + seed) * .025, look: Math.sin(tau * .37 + seed * 2) * .25, armL: .12 + Math.sin(tau * 1.7 + seed) * .03, armR: .12 + Math.sin(tau * 1.7 + seed + .6) * .03}; },
  walk(tau, t0, t1, a, b, {ease = easeInOutSine, stride = 70} = {}) { const p = travel(tau, t0, t1, a, b, ease), moving = tau > t0 && tau < t1; return {dx: p[0], dy: p[1] - (moving ? Math.abs(Math.sin(p[0] / stride * Math.PI)) * 7 : 0), step: moving ? p[0] / stride : null, dir: Math.sign(b[0] - a[0]) || 1, armL: moving ? .1 + Math.sin(p[0] / stride * Math.PI) * .25 : .12, armR: moving ? .1 - Math.sin(p[0] / stride * Math.PI) * .25 : .12}; },
  run(tau, t0, t1, a, b, {stride = 55} = {}) { const p = travel(tau, t0, t1, a, b, linear), moving = tau > t0 && tau < t1; return {dx: p[0], dy: p[1] - (moving ? Math.abs(Math.sin(p[0] / stride * Math.PI)) * 14 : 0), step: moving ? p[0] / stride * 1.4 : null, lean: moving ? .16 : 0, wind: moving ? .7 : 0, armL: moving ? -.5 : .12, armR: moving ? -.5 : .12, dir: Math.sign(b[0] - a[0]) || 1}; },
  float(tau, {height = 46, seed = 1} = {}) { return {dy: -height + Math.sin(tau * 2.1 + seed) * 8, float: true, wind: .15 + Math.sin(tau * 1.3) * .1, armL: .35, armR: .35}; },
  dash(tau, t0, t1, a, b) { const u = clamp((tau - t0) / (t1 - t0), 0, 1), p = lerp2(a, b, easeOutExpo(u)), live = u > 0 && u < 1; return {dx: p[0], dy: p[1], lean: live ? .38 * (1 - u * .5) : 0, squash: live ? -.08 * Math.sin(u * Math.PI) : 0, wind: live ? 1 : 0, armL: live ? -.9 : .12, armR: live ? -.4 : .12, dir: Math.sign(b[0] - a[0]) || 1, dashing: live}; },
  jump(tau, t0, d = .8, h = 140) { const u = clamp((tau - t0) / d, 0, 1), air = u > 0 && u < 1; return {dy: -h * Math.sin(u * Math.PI), squash: air ? (u < .12 ? -.1 : u > .88 ? .1 : -.05) : 0, armL: air ? 1.4 : .12, armR: air ? 1.4 : .12, wind: air ? .4 : 0}; },
  land(tau, t0, d = .35) { const k = chibiPulse(tau, t0, d); return {squash: .14 * k, dy: 6 * k, armL: .12 + .5 * k, armR: .12 + .5 * k}; },
  turnHead(tau, t0, from = -1, to = 1, d = .5) { return {look: lerp(from, to, span(t0, t0 + d, tau)), headTilt: .05 * chibiPulse(tau, t0, d) * Math.sign(to - from)}; },
  lookAt(fromX, targetX) { const q = Math.sign(targetX - fromX); return {look: q * .9, dir: q || 1}; },
  nod(tau, t0, d = .7) { const u = clamp((tau - t0) / d, 0, 1); return {headTilt: Math.sin(u * TAU * 2) * .06 * Math.sin(u * Math.PI), lookY: .3 * Math.sin(u * Math.PI)}; },
  point(k = 1) { return {armR: lerp(.12, 1.5, k)}; },
  wave(tau, t0 = 0, d = 1.6) { const k = span(t0, t0 + .3, tau) * (1 - span(t0 + d - .3, t0 + d, tau)); return {armR: lerp(.12, 2.4 + Math.sin(tau * 12) * .25, k), headTilt: .06 * k}; },
  holdWeapon(k = 1) { return {armR: lerp(.12, .95, k), weaponAngle: lerp(.05, .06, k)}; },
  castSpell(tau, t0, d = 1.4) { const k = span(t0, t0 + .35, tau) * (1 - span(t0 + d - .3, t0 + d, tau)); return {armR: lerp(.95, 1.7, k), armL: lerp(.12, 1.1, k), weaponAngle: lerp(.06, .7, k), lean: -.05 * k, aura: k, castGlow: k, expr: k > .3 ? 'battle' : undefined, wind: .35 * k}; },
  attack(tau, t0, d = .55) { const u = clamp((tau - t0) / d, 0, 1), live = u > 0 && u < 1, swing = easeOutExpo(u); return {armR: live ? lerp(2.7, .3, swing) : .95, weaponAngle: live ? lerp(-.6, 1.9, swing) : .06, lean: live ? .28 * Math.sin(u * Math.PI) : 0, dx: live ? 40 * Math.sin(u * Math.PI) : 0, expr: live ? 'battle' : undefined, swinging: live, swingU: u}; },
  defend(k = 1) { return {armR: lerp(.12, 1.25, k), armL: lerp(.12, 1.2, k), weaponAngle: lerp(0, 1.2, k), lean: -.1 * k, expr: 'serious'}; },
  dodge(tau, t0, d = .45, dist = 120) { const k = chibiPulse(tau, t0, d); return {dx: -dist * Math.sin(clamp((tau - t0) / d, 0, 1) * Math.PI / 2), lean: -.25 * k, dy: -30 * k, wind: -.6 * k}; },
  knockback(tau, t0, d = .6, dist = 140) { const u = clamp((tau - t0) / d, 0, 1), k = Math.sin(u * Math.PI); return {dx: -dist * easeOutExpo(u), lean: -.3 * k, squash: .08 * k, expr: u > 0 && u < 1 ? 'surprised' : undefined, armL: 1.2 * k + .12, armR: 1 * k + .12}; },
  recover(tau, t0, d = .8) { const k = 1 - span(t0, t0 + d, tau, easeOutBack); return {lean: -.12 * k, dy: 10 * k, expr: tau > t0 + d * .5 ? 'confident' : 'serious'}; },
  hug(k = 1) { return {armL: lerp(.12, 1.25, k), armR: lerp(.12, 1.25, k), expr: 'happy'}; },
  reactShock(tau, t0, d = .8) { const k = chibiPulse(tau, t0, d); return {expr: tau >= t0 && tau < t0 + d * 1.6 ? 'surprised' : undefined, dy: -26 * k, armL: .12 + 1.6 * k, armR: .12 + 1.6 * k, squash: -.06 * k}; },
  reactCute(tau, t0, d = 1.2) { const k = span(t0, t0 + .25, tau) * (1 - span(t0 + d - .25, t0 + d, tau)); return {expr: k > .1 ? 'happy' : undefined, headTilt: .14 * k, dy: -Math.abs(Math.sin((tau - t0) * 9)) * 8 * k, armL: .12 + .85 * k, armR: .12 + .85 * k, hands: k > .5 ? 'together' : undefined}; },
  reactAngry(tau, t0, d = 1) { const k = span(t0, t0 + .2, tau) * (1 - span(t0 + d - .2, t0 + d, tau)); return {expr: k > .1 ? 'angry' : undefined, dx: Math.sin(tau * 60) * 3 * k, armL: .12 - .1 * k, armR: .12 - .1 * k, aura: .5 * k, auraColor: '#ff7a8a'}; },
});

// ---------- drawing helpers (clean anime line, soft fills) ----------
function chibiPath(pts, close = true, step = 2.5) { return polyPath(curve(pts, close, step), close); }
function chibiFill(c, pts, fill, line, w = 3, close = true) {
  const p = chibiPath(pts, close);
  if (fill) { c.fillStyle = fill; c.fill(p); }
  if (line && w > 0) { c.lineWidth = w; c.strokeStyle = line; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke(p); }
  return p;
}
function chibiLine(c, pts, color, w = 3) { const p = polyPath(curve(pts, false, 2.5), false); c.lineWidth = w; c.strokeStyle = color; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke(p); }
function vgradFill(c, y0, y1, a, b) { const g = c.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, a); g.addColorStop(1, b); return g; }

// Blink: a short close every ~3.6 s (seeded, never Math.random).
function chibiBlink(tau, seed = 1) {
  const period = 3.1 + hash(Math.floor((tau + seed) / 3.6), seed) * 1.4, ph = (tau + seed * .7) % period;
  return ph < .16 ? Math.sin(ph / .16 * Math.PI) : 0;
}

// ---------- the character ----------
const CHIBI_HC = -245;   // head centre
/** Draw a chibi character. def: from defineChibi; st: from chibiState; tau: scene time. */
function chibi(c, x, y, s, def, st = {}, tau = 0) {
  const D = def || CHIBI_DEFAULT, e = chibiExpr(st.expr || D.expr || 'neutral'), dir = st.dir || 1, seed = hash(D.id.length * 13 + D.id.charCodeAt(0), 3) * 10;
  const breath = Math.sin(tau * 1.9 + seed), blink = st.blink ?? chibiBlink(tau, seed), wind = st.wind || 0;
  const sway = Math.sin(tau * 1.5 + seed) * 1 + wind * -2.2;   // hair / cloth trail (+ = right in local space)
  const squash = st.squash || 0;
  c.save();
  c.translate(x + (st.dx || 0), y);
  // ground shadow: stays on the ground, smaller the higher the body goes
  if (!st.noShadow) { const lift = clamp(-(st.dy || 0) / 200, 0, 1); c.save(); c.globalAlpha = .2 * (1 - lift * .6); c.fillStyle = '#1a1424'; c.beginPath(); c.ellipse(0, 2 * s, 72 * s * (1 - lift * .35), 13 * s * (1 - lift * .35), 0, 0, TAU); c.fill(); c.restore(); }
  c.translate(0, st.dy || 0);
  c.scale(s * dir, s * (1 - squash + breath * .006));
  c.rotate((st.lean || 0));
  if (squash) c.scale(1 + squash * .6, 1);
  // aura behind
  const aura = Math.max(st.aura || 0, D.idleAura || 0);
  if (aura > 0 && typeof fxAura === 'function') fxAura(c, 0, -200, 240, tau, {col: st.auraColor || D.aura, k: aura});
  // far arm + back hair + weapon behind
  chibiBackHair(c, D, sway, tau, seed);
  chibiArm(c, D, -1, st.armL ?? .12, tau, seed, sway, st, false);
  chibiBody(c, D, st, tau, seed, sway, breath);
  // head
  c.save();
  c.translate(0, -150 + breath * 1.2);
  c.rotate((e.tilt || 0) + (st.headTilt || 0));
  c.translate(0, 150);
  chibiHead(c, D, e, st, tau, seed, sway, blink);
  c.restore();
  chibiArm(c, D, 1, st.armR ?? .12, tau, seed, sway, st, true);
  c.restore();
}

function chibiBackHair(c, D, sway, tau, seed) {
  const HC = CHIBI_HC, tips = [];
  for (let k = 0; k <= 6; k++) { const f = k / 6, xx = lerp(-108, 108, f); tips.push([xx + sway * (8 + 10 * Math.abs(f - .5) * 2) + Math.sin(tau * 1.3 + k) * 3, -40 - Math.sin(f * Math.PI) * 20 + (k % 2) * 16]); }
  const pts = [[-96, HC - 20], [-112, HC + 60], [-118, -120], ...tips, [118, -120], [112, HC + 60], [96, HC - 20], [0, HC - 108]];
  c.save();
  chibiFill(c, pts, vgradFill(c, HC - 100, -40, D.hair, D.hairShade), D.hairLine, 3);
  for (const k of [-3, -1.5, 0, 1.5, 3]) chibiLine(c, [[k * 22, HC + 20], [k * 26 + sway * 4, -160], [k * 30 + sway * 9, -70]], D.hairDeep, 1.6);
  c.restore();
}

function chibiBody(c, D, st, tau, seed, sway, breath) {
  const L = D.line, step = st.step, hemSway = sway * 5 + (st.float ? Math.sin(tau * 2.4) * 5 : 0);
  // feet
  for (const sg of [-1, 1]) {
    const ph = step == null ? 0 : Math.sin(step * Math.PI + (sg > 0 ? Math.PI : 0)), lift = step == null ? 0 : Math.max(0, ph) * 12, fx = sg * 18 + (step == null ? 0 : ph * 8);
    const hang = st.float ? 10 : 0;
    chibiFill(c, [[fx - 15, -4 - lift + hang, 1], [fx + 13, -6 - lift + hang], [fx + 17, 2 - lift + hang, 1], [fx - 14, 3 - lift + hang, 1]], D.robeShade, L, 2.6);
  }
  // outer robe: flared, hem sways
  const robe = [[-40, -148, 1], [-58, -110], [-74, -50], [-84 + hemSway, -4, 1], [-40 + hemSway * .8, 4], [0 + hemSway * .6, 0], [40 + hemSway * .8, 4], [84 + hemSway, -4, 1], [74, -50], [58, -110], [40, -148, 1]];
  chibiFill(c, robe, vgradFill(c, -150, 0, D.robe, D.robeShade), L, 3.2);
  // inner white front panel
  chibiFill(c, [[-20, -140, 1], [20, -140, 1], [26 + hemSway * .6, -2, 1], [-26 + hemSway * .6, -2, 1]], vgradFill(c, -150, 0, D.inner, D.innerShade), L, 2.2);
  // cross collar (left over right)
  chibiFill(c, [[-30, -150, 1], [0, -112, 1], [12, -96, 1], [-4, -96], [-36, -140, 1]], D.inner, L, 2.4);
  chibiFill(c, [[30, -150, 1], [4, -120, 1], [-6, -108, 1], [34, -140, 1]], D.innerShade, L, 2);
  for (const sg of [-1, 1]) chibiLine(c, [[sg * 30, -148], [sg * 6, -112]], D.robeTrim, 3);
  // silver trim on the robe edges + cloud embroidery at the hem
  chibiLine(c, [[-26, -130], [-30 + hemSway * .6, -4]], D.robeTrim, 2.4);
  chibiLine(c, [[26, -130], [30 + hemSway * .6, -4]], D.robeTrim, 2.4);
  for (const sg of [-1, 1]) {
    const bx = sg * 58 + hemSway * .8;
    c.save(); c.strokeStyle = D.robeTrim; c.lineWidth = 2; c.globalAlpha = .85;
    c.beginPath(); c.arc(bx, -26, 9, Math.PI * .1, Math.PI * 1.6); c.stroke();
    c.beginPath(); c.arc(bx + sg * 12, -20, 6, Math.PI * .8, Math.PI * 2.2); c.stroke();
    c.restore();
  }
  // sash + jade pendant
  chibiFill(c, [[-46, -92, 1], [46, -92, 1], [48, -76, 1], [-48, -76, 1]], D.sash, L, 2.4);
  chibiLine(c, [[-40, -84], [40, -84]], D.gem, 1.6);
  if (D.pendant) {
    const pa = Math.sin(tau * 2.2 + seed) * .12 + (st.wind || 0) * -.35;
    c.save(); c.translate(16, -78); c.rotate(pa);
    chibiLine(c, [[0, 0], [0, 26]], D.robeTrim, 1.8);
    chibiFill(c, [[-9, 26, 1], [9, 26, 1], [9, 40, 1], [-9, 40, 1]], D.jade, L, 1.8);
    for (const k of [-3, 0, 3]) chibiLine(c, [[k, 41], [k * 1.4, 60]], D.gem, 1.6);
    c.restore();
  }
}

/** One sleeve + hand. side: -1 far (left), 1 near (right). a: 0 = hanging, larger = raised outward/up. */
function chibiArm(c, D, side, a, tau, seed, sway, st, near) {
  const L = D.line, sx = side * 40, sy = -138, len = 64;
  const wx = sx + side * Math.sin(a) * len, wy = sy + Math.cos(a) * len;
  const nx = Math.cos(a), ny = -Math.sin(a) * side;   // across the sleeve
  const drop = 30 + 10 * Math.cos(a), sw = Math.sin(tau * 1.8 + seed + side) * 4 + sway * 4;
  const cuffA = [wx + side * nx * 26, wy + ny * 26 * side], cuffB = [wx - side * nx * 26, wy - ny * 26 * side];
  const sleeve = [[sx - side * 14, sy - 6, 1], [sx + side * 18, sy + 6], cuffA, [wx + side * 8 + sw, wy + drop, 1], [wx - side * 12 + sw, wy + drop - 6, 1], cuffB];
  // weapon held in this hand (drawn behind the sleeve for the far side)
  const holds = near && ('weapon' in st ? st.weapon : D.weapon);
  const hand = [wx + side * Math.sin(a) * 8, wy + Math.cos(a) * 8];
  if (st.hands === 'together') { hand[0] = side * 8; hand[1] = -96; }
  if (holds) chibiWeapon(c, D, holds, hand, st.weaponAngle ?? .05, tau, seed, st);
  chibiFill(c, sleeve, vgradFill(c, sy, wy + drop, D.robe, D.robeShade), L, 3);
  chibiFill(c, [cuffA, [wx + side * 6 + sw * .6, wy + drop * .55], cuffB], D.inner, L, 2);
  chibiLine(c, [cuffA, cuffB], D.robeTrim, 2.6);
  c.fillStyle = D.skin; c.strokeStyle = L; c.lineWidth = 2.4;
  c.beginPath(); c.arc(hand[0], hand[1], 11, 0, TAU); c.fill(); c.stroke();
}

function chibiWeapon(c, D, kind, hand, angle, tau, seed, st) {
  const glow = st.castGlow || 0;
  c.save(); c.translate(hand[0], hand[1]); c.rotate(angle);
  if (kind === 'staff') {
    // shaft
    chibiFill(c, [[-5, -250, 1], [5, -250, 1], [6, 110, 1], [-6, 110, 1]], vgradFill(c, -250, 110, D.weaponColor, '#9aa6bd'), D.line, 2.4);
    for (const yy of [-190, -120, 60]) chibiLine(c, [[-7, yy], [7, yy]], D.gem, 3);
    // crescent head with a floating orb
    c.save(); c.translate(0, -280);
    c.fillStyle = D.weaponColor; c.strokeStyle = D.line; c.lineWidth = 2.4;
    c.beginPath(); c.arc(0, 0, 44, Math.PI * .15, Math.PI * 1.85, false); c.arc(10, 0, 34, Math.PI * 1.8, Math.PI * .2, true); c.closePath(); c.fill(); c.stroke();
    const orbY = Math.sin(tau * 2.4 + seed) * 5, r = 15 + glow * 4;
    const g = c.createRadialGradient(4, orbY - 4, 2, 6, orbY, r * 3.2);
    g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(.25, D.eyes.glow); g.addColorStop(1, 'rgba(120,200,255,0)');
    c.fillStyle = g; c.beginPath(); c.arc(6, orbY, r * 3.2, 0, TAU); c.fill();
    c.fillStyle = D.gem; c.beginPath(); c.arc(6, orbY, r, 0, TAU); c.fill(); c.stroke();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(1, orbY - 5, 4, 0, TAU); c.fill();
    // ribbons
    for (const sg of [-1, 1]) chibiLine(c, [[sg * 6, 36], [sg * 16 + Math.sin(tau * 2 + sg) * 8, 90], [sg * 10 + Math.sin(tau * 2.3 + sg) * 12, 140]], D.gem, 3);
    c.restore();
  } else if (kind === 'sword') {
    chibiFill(c, [[-7, -230, 1], [0, -262, 1], [7, -230, 1], [6, -30, 1], [-6, -30, 1]], vgradFill(c, -260, -30, '#ffffff', '#b9c4d8'), D.line, 2.2);
    chibiFill(c, [[-26, -30, 1], [26, -30, 1], [22, -18, 1], [-22, -18, 1]], D.robeTrim, D.line, 2);
    chibiFill(c, [[-5, -18, 1], [5, -18, 1], [5, 30, 1], [-5, 30, 1]], D.robeShade, D.line, 2);
    if (glow > 0) { c.save(); c.globalCompositeOperation = 'lighter'; c.globalAlpha = glow * .6; chibiLine(c, [[0, -250], [0, -40]], D.eyes.glow, 14); c.restore(); }
  }
  c.restore();
}

function chibiHead(c, D, e, st, tau, seed, sway, blink) {
  const HC = CHIBI_HC, L = D.line;
  // face: round, softer at the chin
  const face = [];
  for (let k = 0; k < 36; k++) { const a = k / 36 * TAU, sy = Math.sin(a), narrow = sy > 0 ? 1 - .2 * sy * sy : 1; face.push([Math.cos(a) * 90 * narrow, HC + 6 + sy * (sy > 0 ? 88 : 96)]); }
  chibiFill(c, face, vgradFill(c, HC - 90, HC + 95, D.skin, D.skinShade), L, 3.2);
  // blush
  const bl = e.blush || 0;
  if (bl > 0) for (const sg of [-1, 1]) {
    const g = c.createRadialGradient(sg * 56, HC + 58, 2, sg * 56, HC + 58, 26);
    g.addColorStop(0, alpha(D.blush, .55 * bl)); g.addColorStop(1, alpha(D.blush, 0));
    c.fillStyle = g; c.beginPath(); c.ellipse(sg * 56, HC + 58, 28, 16, 0, 0, TAU); c.fill();
    if (e.shyLines) for (let k = 0; k < 3; k++) chibiLine(c, [[sg * 44 + k * 8 - 8, HC + 50], [sg * 44 + k * 8 - 2, HC + 40]], alpha(D.blush, .9), 1.6);
  }
  // eyes
  const look = clamp((st.look ?? 0) + (e.look || 0), -1, 1), lookY = st.lookY || 0;
  for (const sg of [-1, 1]) chibiEye(c, D, e, sg, sg * 40, HC + 30, look, lookY, blink, tau, seed);
  // brows
  for (const sg of [-1, 1]) {
    const by = HC - 22 + (e.browY || 0), inner = (e.brow || 0) * 10;
    chibiLine(c, [[sg * 18, by - inner], [sg * 36, by - 5 - inner * .3], [sg * 56, by + 1]], L, 3);
  }
  // mouth
  chibiMouth(c, D, e.mouth || 'flat', HC + 70);
  // forehead mark
  if (D.mark === 'crescent') { c.save(); c.fillStyle = D.gem; c.beginPath(); c.arc(0, HC - 42, 7, Math.PI * .2, Math.PI * 1.8); c.arc(3, HC - 42, 5, Math.PI * 1.75, Math.PI * .25, true); c.closePath(); c.fill(); c.restore(); }
  // mood marks
  if (e.anger) { c.save(); c.strokeStyle = '#e0445c'; c.lineWidth = 3.4; c.translate(70, HC - 64); for (let k = 0; k < 4; k++) { c.rotate(Math.PI / 2); c.beginPath(); c.moveTo(4, -4); c.quadraticCurveTo(12, -4, 12, -12); c.stroke(); } c.restore(); }
  if (e.sweat) { c.save(); c.fillStyle = '#9ad7ff'; c.strokeStyle = L; c.lineWidth = 2; c.beginPath(); c.moveTo(-84, HC - 40); c.quadraticCurveTo(-72, HC - 20, -80, HC - 10); c.quadraticCurveTo(-92, HC - 18, -84, HC - 40); c.fill(); c.stroke(); c.restore(); }
  if (e.tears) for (const sg of [-1, 1]) { const ty = HC + 44 + ((tau * 40) % 30); c.save(); c.globalAlpha = .75; c.fillStyle = '#bfe8ff'; c.beginPath(); c.ellipse(sg * 44, ty, 4, 7, 0, 0, TAU); c.fill(); c.restore(); }
  // side locks (in front of the face edge, down to the chest)
  for (const sg of [-1, 1]) {
    const tip = [sg * 92 + sway * 7, -60 + Math.sin(tau * 1.6 + sg) * 3];
    chibiFill(c, [[sg * 70, HC - 40, 1], [sg * 96, HC + 10], [sg * 100, HC + 90], tip, [sg * 80, HC + 110], [sg * 74, HC + 30], [sg * 62, HC - 20]], vgradFill(c, HC - 40, -60, D.hair, D.hairShade), D.hairLine, 2.6);
  }
  // bangs: center part, sweeping to both sides with pointed tips
  const bangs = [[-92, HC + 20, 1], [-98, HC - 58], [-60, HC - 104], [0, HC - 112], [60, HC - 104], [98, HC - 58], [92, HC + 20, 1],
    [84, HC - 14], [74, HC + 12, 1], [64, HC - 26], [50, HC - 4, 1], [40, HC - 38], [24, HC - 30, 1], [14, HC - 56], [3, HC - 72, 1], [0, HC - 76, 1], [-3, HC - 72, 1], [-14, HC - 56], [-24, HC - 30, 1], [-40, HC - 38], [-50, HC - 4, 1], [-64, HC - 26], [-74, HC + 12, 1], [-84, HC - 14]];
  chibiFill(c, bangs, vgradFill(c, HC - 112, HC + 20, D.hair, D.hairShade), D.hairLine, 2.8);
  for (const [a, b] of [[[-30, HC - 98], [-44, HC - 20]], [[-64, HC - 84], [-66, HC - 8]], [[30, HC - 98], [42, HC - 22]], [[64, HC - 84], [68, HC - 6]], [[-12, HC - 104], [-18, HC - 48]], [[12, HC - 104], [18, HC - 48]]]) chibiLine(c, [a, [(a[0] + b[0]) / 2 + 3, (a[1] + b[1]) / 2], b], D.hairDeep, 1.5);
  // hair shine
  c.save(); c.globalAlpha = .7; chibiLine(c, [[-54, HC - 78], [-30, HC - 92], [-8, HC - 96]], '#ffffff', 5); chibiLine(c, [[14, HC - 94], [40, HC - 88]], '#ffffff', 4); c.restore();
  chibiLine(c, [[0, HC - 110], [-2, HC - 70]], D.hairLine, 2);
  // topknot, crown, hairpin with a swaying tassel
  if (D.hairStyle === 'topknot') {
    chibiFill(c, [[-34, HC - 102, 1], [-38, HC - 132], [0, HC - 160], [38, HC - 132], [34, HC - 102, 1]], vgradFill(c, HC - 160, HC - 100, D.hair, D.hairShade), D.hairLine, 2.6);
    chibiLine(c, [[-22, HC - 134], [0, HC - 148], [20, HC - 132]], D.hairDeep, 1.6);
    if (D.crown) {
      chibiFill(c, [[-30, HC - 110, 1], [-26, HC - 138, 1], [-12, HC - 126, 1], [0, HC - 150, 1], [12, HC - 126, 1], [26, HC - 138, 1], [30, HC - 110, 1]], vgradFill(c, HC - 150, HC - 110, '#ffffff', D.robeTrim), L, 2.4);
      c.fillStyle = D.gem; c.beginPath(); c.arc(0, HC - 122, 6, 0, TAU); c.fill(); c.strokeStyle = L; c.lineWidth = 1.8; c.stroke();
      c.fillStyle = '#fff'; c.beginPath(); c.arc(-2, HC - 124, 2, 0, TAU); c.fill();
    }
    if (D.hairpin) {
      chibiLine(c, [[-58, HC - 108], [54, HC - 140]], D.robeTrim, 4);
      const ta = Math.sin(tau * 2.3 + seed) * .25 + (st.wind || 0) * -.5;
      c.save(); c.translate(54, HC - 140); c.rotate(ta);
      chibiLine(c, [[0, 0], [2, 34]], D.robeTrim, 1.6);
      c.fillStyle = D.gem; c.beginPath(); c.arc(2, 38, 5, 0, TAU); c.fill();
      for (const k of [-3, 0, 3]) chibiLine(c, [[2 + k, 42], [2 + k * 1.6, 66]], D.gem, 1.4);
      c.restore();
    }
  }
}

function chibiEye(c, D, e, sg, ex, ey, look, lookY, blink, tau, seed) {
  const L = D.line, E = D.eyes, kind = e.eye || 'open';
  const closed = kind === 'happy' || kind === 'closed' || blink > .85;
  if (closed) {
    if (kind === 'happy') chibiLine(c, [[ex - 19, ey + 6], [ex, ey - 10], [ex + 19, ey + 6]], L, 4);
    else chibiLine(c, [[ex - 20, ey + 2], [ex, ey + 9], [ex + 20, ey + 2]], L, 4);
    return;
  }
  const open = (e.open ?? 1) * (1 - blink), hw = 21 * (kind === 'wide' ? 1.08 : 1), hh = 28 * open * (kind === 'narrow' ? .82 : 1);
  const top = ey - hh, lid = kind === 'narrow' ? 6 * sg : 0;
  const shape = [[ex - hw, ey + 2 - lid * .3, 1], [ex - hw * .7, top + 4 + lid * .6], [ex, top], [ex + hw * .7, top + 4 - lid * .6], [ex + hw, ey + 2 + lid * .3, 1], [ex + hw * .6, ey + hh * .95], [ex, ey + hh], [ex - hw * .6, ey + hh * .95]];
  const clip = chibiPath(shape, true, 2);
  c.save();
  c.fillStyle = '#ffffff'; c.fill(clip);
  c.clip(clip);
  // iris: dark top, bright bottom, pupil, ring
  const ix = ex + look * 6 + sg * 1.5, iy = ey + 4 + lookY * 4, ir = 18, irY = 23;
  const g = c.createLinearGradient(0, iy - irY, 0, iy + irY);
  g.addColorStop(0, E.top); g.addColorStop(.45, E.mid); g.addColorStop(1, E.bottom);
  c.fillStyle = g; c.beginPath(); c.ellipse(ix, iy, ir, irY, 0, 0, TAU); c.fill();
  c.strokeStyle = E.ring; c.lineWidth = 2; c.stroke();
  const ps = e.pupil ?? 1;
  c.fillStyle = E.ring; c.beginPath(); c.ellipse(ix, iy - 1, 8 * ps, 12 * ps, 0, 0, TAU); c.fill();
  if (e.glow) { c.save(); c.globalCompositeOperation = 'lighter'; c.globalAlpha = .5 * e.glow; c.fillStyle = E.glow; c.beginPath(); c.ellipse(ix, iy + 8, ir * .8, irY * .45, 0, 0, TAU); c.fill(); c.restore(); }
  // the lid's shadow on the eye
  c.fillStyle = 'rgba(40,30,70,.22)'; c.fillRect(ex - hw, top - 2, hw * 2, 7);
  // highlights (glossy)
  c.fillStyle = '#ffffff';
  c.beginPath(); c.ellipse(ix - 6, iy - 9, 7, 9, -.3, 0, TAU); c.fill();
  c.beginPath(); c.arc(ix + 7, iy + 10, 3.5, 0, TAU); c.fill();
  if (e.sparkle) { c.globalAlpha = .9; c.beginPath(); c.arc(ix + 7, iy - 11, 2.2, 0, TAU); c.fill(); }
  c.restore();
  // upper lash line with a small wing, lower lash
  c.save(); c.strokeStyle = L; c.lineCap = 'round';
  chibiLine(c, [[ex - hw - 2, ey + 1 - lid * .3], [ex - hw * .6, top + 2 + lid * .6], [ex + hw * .5, top + 1 - lid * .6], [ex + hw + 3, ey - 2 + lid * .3]], L, 4.4);
  chibiLine(c, [[ex + sg * (hw + 1), ey - 3], [ex + sg * (hw + 8), ey - 8]], L, 2.6);
  c.globalAlpha = .7; chibiLine(c, [[ex - hw * .5, ey + hh + 1], [ex + hw * .4, ey + hh + 1]], L, 1.8);
  c.restore();
}

function chibiMouth(c, D, kind, my) {
  const L = D.line;
  c.save(); c.lineCap = 'round';
  if (kind === 'smile') chibiLine(c, [[-9, my - 2], [0, my + 4], [9, my - 2]], L, 2.6);
  else if (kind === 'grin') { chibiFill(c, [[-12, my - 4, 1], [12, my - 4, 1], [6, my + 9], [0, my + 11], [-6, my + 9]], '#a8434f', L, 2.4); c.fillStyle = '#f59aa8'; c.beginPath(); c.ellipse(0, my + 6, 5, 3, 0, 0, TAU); c.fill(); }
  else if (kind === 'open') chibiFill(c, [[-9, my - 3, 1], [9, my - 3, 1], [7, my + 10], [-7, my + 10]], '#a8434f', L, 2.4);
  else if (kind === 'o') { c.fillStyle = '#a8434f'; c.strokeStyle = L; c.lineWidth = 2.4; c.beginPath(); c.ellipse(0, my + 2, 6, 8, 0, 0, TAU); c.fill(); c.stroke(); }
  else if (kind === 'frown') chibiLine(c, [[-9, my + 4], [0, my - 2], [9, my + 4]], L, 2.6);
  else if (kind === 'smirk') chibiLine(c, [[-8, my + 1], [2, my + 3], [11, my - 4]], L, 2.6);
  else if (kind === 'wavy') chibiLine(c, [[-10, my + 2], [-5, my - 1], [0, my + 2], [5, my - 1], [10, my + 2]], L, 2.2);
  else if (kind === 'cat') chibiLine(c, [[-10, my - 2], [-5, my + 3], [0, my - 1], [5, my + 3], [10, my - 2]], L, 2.4);
  else chibiLine(c, [[-7, my + 1], [7, my + 1]], L, 2.4);
  c.restore();
}

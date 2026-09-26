'use strict';
// Demo: "Yue Lan" -- an original chibi cultivator (chibi.js) in a living
// xianxia world (xianxia.js + fx.js): arrival, a threat, a short battle.
// Every frame is a pure function of tau. Floor line: y = 900.

const YUE = defineChibi({
  id: 'yue', name: 'Yue Lan',
  eyes: {top: '#2a2f78', mid: '#4a6fe0', bottom: '#9ee3ff', ring: '#1c2152', glow: '#a6ecff'},
  robe: '#26263a', robeShade: '#17172a', robeTrim: '#d3dcef', gem: '#76c3ff', jade: '#86e0cb',
  weapon: 'staff', aura: '#a9e4ff',
});
const FLOOR = 900;

// ---------- the world, in layers ----------
function sky(c, tau, {night = 0} = {}) {
  resetT(c);
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, mix('#3a4f9a', '#141836', night)); g.addColorStop(.55, mix('#8f87d6', '#3b2f6e', night)); g.addColorStop(1, mix('#f3c9d9', '#6a4a8a', night));
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  // aurora ribbons
  c.save(); c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) { c.strokeStyle = alpha(['#9fe7ff', '#c8a8ff', '#a8ffd9'][i], .12); c.lineWidth = 60 - i * 12; c.beginPath(); for (let x = -50; x <= W + 50; x += 40) { const y = 170 + i * 50 + Math.sin(x * .004 + tau * .3 + i) * 40; x === -50 ? c.moveTo(x, y) : c.lineTo(x, y); } c.stroke(); }
  c.restore();
  // stars
  c.save(); for (let i = 0; i < 60; i++) { const tw = .5 + .5 * Math.sin(tau * 2 + i * 1.3); c.fillStyle = alpha('#ffffff', (.25 + .55 * night) * tw); c.beginPath(); c.arc(hash(i, 1) * W, hash(i, 2) * 420, 1 + hash(i, 3) * 1.6, 0, TAU); c.fill(); } c.restore();
}
function worldBack(c, tau, cam) {
  parallax(c, cam, .25, (g) => { xxPeak(g, 150, 760, 640, 260, {col: '#6d7fb4', snow: true, seed: 2}); xxPeak(g, 520, 760, 520, 230, {col: '#7584ba', seed: 5}); xxPeak(g, 1500, 760, 700, 280, {col: '#6879b0', snow: true, seed: 7}); xxPeak(g, 1880, 760, 560, 240, {col: '#7584ba', seed: 9}); });
  parallax(c, cam, .4, (g) => { fxMist(g, tau, 560, {al: .45, speed: 10}); xxCloudSea(g, 640, tau, {col: '#eef0fb', al: .85}); });
  parallax(c, cam, .6, (g) => {
    // sect on the cliffs, a bridge, stairs, lanterns
    xxPeak(g, 1380, 820, 380, 360, {col: '#5b6aa0', seed: 11});
    xxPagoda(g, 1380, 450, .8, {tiers: 5, roof: '#2d3566'});
    xxPeak(g, 330, 830, 330, 330, {col: '#56669c', seed: 13});
    xxPavilion(g, 330, 505, .75, {tiers: 2, roof: '#2d3566', wall: '#b84a4a'});
    g.save(); g.strokeStyle = '#3a2f4a'; g.lineWidth = 6; g.beginPath(); g.moveTo(470, 520); g.quadraticCurveTo(870, 600, 1230, 480); g.stroke(); g.lineWidth = 2; for (let k = 0; k <= 12; k++) { const u = k / 12, x = lerp(470, 1230, u), y = (1 - u) * (1 - u) * 520 + 2 * (1 - u) * u * 600 + u * u * 480; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - 26); g.stroke(); } g.restore();
    for (let k = 0; k < 3; k++) { const u = ((tau * .05 + k * .33) % 1), x = lerp(470, 1230, u), y = (1 - u) * (1 - u) * 520 + 2 * (1 - u) * u * 600 + u * u * 480; pp(g, x, y, .32, {body: ['#3b5ba5', '#b84a4a', '#2b2b3a'][k], hat: 'topknot', robe: true, walk: stepPhase(x, 20), mood: 'happy'}); }
    xxLantern(g, 560, 470, .7, tau); xxLantern(g, 1150, 440, .7, tau + 1);
  });
}
function ground(c, tau) {
  // stone platform with carved runes
  c.save();
  const g = c.createLinearGradient(0, FLOOR - 40, 0, H + 200);
  g.addColorStop(0, '#8d86b2'); g.addColorStop(1, '#4b4570');
  c.fillStyle = g; c.beginPath(); c.moveTo(-400, FLOOR - 10); c.quadraticCurveTo(960, FLOOR - 50, 2320, FLOOR - 10); c.lineTo(2320, H + 400); c.lineTo(-400, H + 400); c.closePath(); c.fill();
  c.strokeStyle = 'rgba(210,225,255,.35)'; c.lineWidth = 3; c.beginPath(); c.ellipse(960, FLOOR + 30, 520, 60, 0, 0, TAU); c.stroke();
  c.restore();
  xxLotus(c, 260, FLOOR + 40, 1.2); xxLotus(c, 1700, FLOOR + 50, 1.1);
}
function foreground(c, tau, cam) {
  parallax(c, cam, 1.25, (g) => { xxPine(g, -40, 1120, 420); xxPine(g, 1990, 1140, 380); });
  fxPetals(c, tau, [-100, 100, 2000, 1100], {n: 18});
  fxMotes(c, tau, [0, 200, 1920, 1000], {n: 36});
}

// ---------- the shadow demon ----------
function demon(c, x, y, s, tau, {k = 1, hit = 0, dissolve = 0} = {}) {
  if (k <= 0 || dissolve >= 1) return;
  c.save(); c.translate(x + Math.sin(tau * 40) * 6 * hit, y); c.scale(s, s); c.globalAlpha = k * (1 - dissolve);
  fxGlow(c, 0, -170, 260, '#8a3cff', .6);
  const body = [[-130, 0], [-150, -120], [-110, -250], [-60, -300], [0, -310], [60, -300], [110, -250], [150, -120], [130, 0]];
  for (let i = 0; i < body.length; i++) body[i] = [body[i][0] + Math.sin(tau * 2 + i) * 8, body[i][1] + Math.cos(tau * 1.7 + i) * 6];
  chibiFill(c, body, vgradFill(c, -310, 0, '#3b1d5e', '#120a22'), '#0a0612', 4);
  for (const sg of [-1, 1]) chibiFill(c, [[sg * 50, -290, 1], [sg * 100, -390, 1], [sg * 80, -280, 1]], '#1a0f2e', '#0a0612', 3);
  for (const sg of [-1, 1]) { fxGlow(c, sg * 42, -200, 46, '#ff3355', 1); c.fillStyle = '#ff5a6e'; c.beginPath(); c.ellipse(sg * 42, -200, 16, 8, sg * .3, 0, TAU); c.fill(); }
  c.fillStyle = '#1a0a18'; c.beginPath(); c.moveTo(-40, -130); c.lineTo(40, -130); c.lineTo(0, -100 + Math.sin(tau * 6) * 8); c.closePath(); c.fill();
  for (let i = 0; i < 6; i++) { const ph = (tau * .6 + i / 6) % 1; c.fillStyle = alpha('#6b2fb0', .5 * (1 - ph)); c.beginPath(); c.arc(-120 + i * 48, -ph * 260, 10 + ph * 16, 0, TAU); c.fill(); }
  c.restore();
}

const TITLE = (c, tau) => { const a = span(.4, 1.4, tau) * (1 - span(3.4, 4.2, tau)); if (a <= 0) return; c.save(); resetT(c); txt(c, '月澜 · Yue Lan', W / 2, 170, {size: 76, color: '#ffffff', al: a, reveal: span(.4, 1.6, tau), shadow: 'rgba(80,90,200,.8)'}); txt(c, 'the Moon-Tide Immortal', W / 2, 230, {size: 30, italic: true, color: '#e8e6ff', al: a * .9}); c.restore(); };

// ---------- scenes ----------
const CAM1 = shotTrack([
  {at: 0, x: 960, y: 520, zoom: .92},      // establishing
  {at: 2.8, x: 900, y: 600, zoom: 1.0},    // wide on the landing
  {at: 4.2, x: 820, y: 680, zoom: 1.35},   // medium: the cute moment
  {at: 6.6, x: 900, y: 660, zoom: 1.3},
  {at: 8, x: 1000, y: 640, zoom: 1.15},    // she turns: something is there
]);
const CAM2 = shotTrack([
  {at: 0, x: 1080, y: 620, zoom: 1.2},     // over her shoulder at the demon
  {at: 1.8, x: 1150, y: 600, zoom: 1.28},
  {at: 2.6, x: 760, y: 620, zoom: 1.4},    // back on her: serious, charging
  {at: 4.2, x: 720, y: 560, zoom: 2.1},    // close-up: battle focus
  {at: 6, x: 780, y: 600, zoom: 1.6},
], [{at: 1.2, amp: 10, d: .6}]);
const CAM3 = shotTrack([
  {at: 0, x: 900, y: 620, zoom: 1.2},      // dynamic framing for the dash
  {at: .7, x: 1120, y: 620, zoom: 1.25},
  {at: 1.6, x: 1140, y: 610, zoom: 1.2},
  {at: 2.4, x: 1000, y: 620, zoom: 1.15},  // the spell
  {at: 3.6, x: 1120, y: 620, zoom: 1.15},
  {at: 5, x: 900, y: 640, zoom: 1.45},     // recovery close
  {at: 7, x: 960, y: 560, zoom: .95},      // pull back wide
], [{at: 1.3, amp: 16, d: .45}, {at: 3.1, amp: 22, d: .6}]);

const SCENES = [
  {
    name: 'arrival', dur: 8.4, mood: (c, tau) => sky(c, tau), camera: CAM1,
    sfx: [[0, 2.7, 'thud'], [0, 2.75, 'chime'], [0, 4.4, 'sparkle'], [0, 5.3, 'pop'], [0, 7.5, 'whoosh']],
    set(c, tau, S) {
      const cam = CAM1(tau);
      worldBack(c, tau, cam); ground(c, tau);
      const land = 2.6, desc = span(0, land, tau, easeOutExpo);
      const st = chibiState(
        CHIBI_ACT.idle(tau),
        tau < land ? {dy: lerp(-560, 0, desc), float: true, wind: -.4, armL: .5, armR: .5, aura: .9} : null,
        tau >= land ? CHIBI_ACT.land(tau, land) : null,
        tau >= land ? CHIBI_ACT.holdWeapon(span(land, land + .6, tau)) : {weapon: 'staff', weaponAngle: .2},
        {aura: tau < land + 1 ? .9 * (1 - span(land, land + 1.2, tau)) : .15, expr: 'neutral'},
        tau > 3.8 && tau < 5.6 ? CHIBI_ACT.reactCute(tau, 3.9, 1.6) : null,
        tau > 5.2 && tau < 6.8 ? CHIBI_ACT.wave(tau, 5.2, 1.5) : null,
        tau > 6.4 && tau < 7.3 ? {expr: 'shy'} : null,
        tau > 7.2 ? CHIBI_ACT.turnHead(tau, 7.2, 0, 1, .4) : null,
        tau > 7.6 ? CHIBI_ACT.reactShock(tau, 7.6, .7) : null,
      );
      if (tau >= land && tau < land + 1.4) fxSmoke(c, tau, land, 760, FLOOR, {r: 90, col: '#dcdff0'});
      fxAura(c, 760, FLOOR - 200, 200, tau, {k: tau < land ? .8 : 0});
      chibi(c, 760, FLOOR, 1.05, YUE, st, tau);
      if (tau > 7.4) demon(c, 1500, FLOOR + 20, .8, tau, {k: span(7.4, 8.4, tau) * .6});
      foreground(c, tau, cam);
      TITLE(c, tau);
    },
  },
  {
    name: 'threat', dur: 6.4, mood: (c, tau) => sky(c, tau, {night: span(0, 2, tau) * .6}), camera: CAM2,
    sfx: [[0, .9, 'thunder'], [0, 2.8, 'bell'], [0, 3.4, 'magic'], [0, 4.6, 'magic']],
    set(c, tau, S) {
      const cam = CAM2(tau);
      worldBack(c, tau, cam); ground(c, tau);
      const rise = span(.3, 1.6, tau, easeOutBack);
      demon(c, 1380, FLOOR + 20, .8 + rise * .35, tau, {k: .6 + .4 * rise});
      if (tau > 1 && tau < 2.2) fxLightning(c, tau, [1300, 60], [1360, FLOOR - 320], {col: '#d6b8ff'});
      const charge = span(2.8, 4.8, tau);
      fxMagicCircle(c, 760, FLOOR + 6, 220, tau, {u: charge, tilt: .28, col: '#9fe7ff'});
      const st = chibiState(
        CHIBI_ACT.idle(tau), CHIBI_ACT.lookAt(760, 1380), {dir: 1},
        tau < 2.6 ? {expr: tau < 1.4 ? 'surprised' : 'serious'} : null,
        CHIBI_ACT.holdWeapon(1),
        tau > 2.6 ? CHIBI_ACT.castSpell(tau, 2.6, 4) : null,
        {aura: .3 + charge * .7, wind: charge * .4},
      );
      chibi(c, 760, FLOOR, 1.05, YUE, st, tau);
      fxMotes(c, tau, [500, 400, 1000, 950], {n: 26, col: '#bff0ff', seed: 41});
      foreground(c, tau, cam);
    },
  },
  {
    name: 'strike', dur: 9, mood: (c, tau) => sky(c, tau, {night: .6 - span(4, 8, tau) * .5}), camera: CAM3,
    sfx: [[0, .1, 'whoosh'], [0, 1.2, 'thud'], [0, 1.25, 'splash'], [0, 2.1, 'magic'], [0, 3.05, 'thunder'], [0, 3.1, 'thud'], [0, 5.2, 'chime'], [0, 6.6, 'sparkle']],
    set(c, tau, S) {
      const cam = CAM3(tau);
      worldBack(c, tau, cam); ground(c, tau);
      const A = [620, FLOOR], B = [980, FLOOR];
      // the demon: hit by the slash, then the beam, then gone
      const beamHit = 3.05, dissolve = span(beamHit + .1, beamHit + 1.4, tau);
      const knock = tau > 1.25 ? 40 * chibiPulse(tau, 1.25, .5) : 0;
      demon(c, 1480 + knock + (tau > beamHit ? 90 * easeOutExpo(clamp((tau - beamHit) / .6, 0, 1)) : 0), FLOOR + 20, 1.15, tau, {k: 1, hit: chibiPulse(tau, 1.25, .4) + chibiPulse(tau, beamHit, .5), dissolve});
      if (dissolve > 0 && dissolve < 1) fxSparks(c, tau, beamHit + .2, 1560, FLOOR - 160, {col: '#c9a8ff', n: 40, speed: 380, d: 1.2, seed: 9});
      // Yue: dash in, slash, cast, recover
      const dash = CHIBI_ACT.dash(tau, 0, .6, A, B);
      const pos = tau < .6 ? [dash.dx, dash.dy] : B;
      const back = tau > 3.4 ? CHIBI_ACT.dodge(tau, 3.4, .6, 180) : null;
      const st = chibiState(
        CHIBI_ACT.idle(tau), {dir: 1, weapon: 'staff'},
        tau < .6 ? {...dash, dx: 0, dy: 0} : CHIBI_ACT.holdWeapon(1),
        tau > .7 && tau < 1.4 ? CHIBI_ACT.attack(tau, .75, .55) : null,
        tau > 1.7 && tau < 3.5 ? CHIBI_ACT.castSpell(tau, 1.7, 1.9) : null,
        back, tau > 4 ? CHIBI_ACT.recover(tau, 4, .9) : null,
        tau > 5.6 && tau < 7.6 ? CHIBI_ACT.reactCute(tau, 5.8, 1.6) : null,
        {aura: tau < 3.6 ? .6 : .6 * (1 - span(3.6, 5, tau))},
      );
      const px = pos[0], py = pos[1];
      // afterimages + trail while dashing
      if (tau > 0 && tau < .75) {
        for (let k = 1; k <= 4; k++) { const tt = tau - k * .06; if (tt < 0) continue; const d = CHIBI_ACT.dash(tt, 0, .6, A, B); c.save(); c.globalAlpha = .22 * (1 - k / 5); chibi(c, d.dx, d.dy, 1.05, YUE, chibiState({...d, dx: 0, dy: 0, weapon: 'staff', noShadow: true}), tt); c.restore(); }
        speedLines(c, px - 60, FLOOR - 220, -1, {n: 7, len: 260, spread: 160, al: .8});
      }
      fxEnergyTrail(c, [[620, FLOOR - 200], [800, FLOOR - 260], [980, FLOOR - 220]], span(0, .6, tau), {k: 1 - span(.8, 1.4, tau)});
      chibi(c, px, py, 1.05, YUE, st, tau);
      // slash + impact
      if (tau > .8 && tau < 1.6) xxSlash(c, tau, .85, [1090, FLOOR - 430], [1360, FLOOR - 60], {d: .3, col: '#bfefff', w: 18});
      fxImpact(c, tau, 1.25, 1380, FLOOR - 180, {r: 170});
      fxSparks(c, tau, 1.25, 1380, FLOOR - 180, {n: 30});
      fxSmoke(c, tau, 1.3, 1400, FLOOR - 40, {r: 110, col: '#b9b2d8'});
      // spell: circle at the staff tip, then the beam
      const tip = [px + 150 + (back ? back.dx : 0), FLOOR - 520 + (back ? back.dy || 0 : 0)];
      fxMagicCircle(c, tip[0] + 60, tip[1] + 60, 120, tau, {u: span(1.9, 2.4, tau) * (1 - span(3.3, 3.7, tau)), tilt: 1, col: '#a6ecff'});
      if (tau > 2.5 && tau < 3.6) fxBeam(c, tau, [tip[0] + 60, tip[1] + 60], [1520, FLOOR - 200], span(2.5, 3.05, tau), {k: 1 - span(3.2, 3.6, tau)});
      fxImpact(c, tau, beamHit, 1520, FLOOR - 200, {r: 260, d: .8});
      fxSmoke(c, tau, beamHit + .1, 1520, FLOOR - 60, {r: 160, n: 12, col: '#c8c0e6'});
      fxMotes(c, tau, [300, 200, 1700, 1000], {n: 30, col: '#bff0ff', seed: 51});
      foreground(c, tau, cam);
      fxHitFlash(c, tau, 1.25, {d: .12, k: .6});
      fxHitFlash(c, tau, beamHit, {d: .22, k: .85, col: '#e8f7ff'});
    },
  },
];

'use strict';
// Layered magic / combat effects, parallax and a continuous shot track for
// Kuanimation. Glows use additive blending so they light what is under them
// without hiding it; everything is seeded and a pure function of tau.
//   fxAura fxMagicCircle fxLightning fxEnergyTrail fxBeam fxImpact fxSparks
//   fxSmoke fxHitFlash fxMotes fxPetals fxMist | parallax shotTrack

function fxGlow(c, x, y, r, col, k = 1) {
  if (k <= 0 || r <= 0) return;
  c.save(); c.globalCompositeOperation = 'lighter';
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, alpha(col, .55 * k)); g.addColorStop(.4, alpha(col, .22 * k)); g.addColorStop(1, alpha(col, 0));
  c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.restore();
}

/** A soft aura with rising motes around (x, y); k = strength 0..1. */
function fxAura(c, x, y, r, tau, {col = '#a9e4ff', k = 1, seed = 1} = {}) {
  if (k <= 0) return;
  fxGlow(c, x, y, r * (1 + Math.sin(tau * 3) * .04), col, .8 * k);
  c.save(); c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 14; i++) {
    const ph = (tau * (.35 + hash(i, seed) * .3) + hash(i, seed + 1)) % 1, a = hash(i, seed + 2) * TAU;
    const px = x + Math.cos(a) * r * .55 * (.4 + hash(i, seed + 3) * .6), py = y + r * .6 - ph * r * 1.5;
    c.fillStyle = alpha(col, .8 * k * Math.sin(ph * Math.PI)); c.beginPath(); c.arc(px, py, 2 + hash(i, 9) * 3, 0, TAU); c.fill();
  }
  for (let i = 0; i < 2; i++) { const a0 = tau * (1.2 + i * .5) + i * 2.4; c.strokeStyle = alpha(col, .45 * k); c.lineWidth = 3; c.beginPath(); c.ellipse(x, y + r * .2, r * (.7 + i * .12), r * (.22 + i * .05), 0, a0, a0 + 2.2); c.stroke(); }
  c.restore();
}

/** A rotating magic circle; tilt < 1 flattens it onto the ground. u = 0..1 grows it in. */
function fxMagicCircle(c, x, y, r, tau, {col = '#9fe7ff', u = 1, tilt = 1, k = 1, seed = 2} = {}) {
  if (u <= 0 || k <= 0) return;
  const R = r * easeOutBack(clamp(u, 0, 1));
  c.save(); c.translate(x, y); c.scale(1, tilt); c.globalCompositeOperation = 'lighter';
  fxGlow(c, 0, 0, R * 1.3, col, .5 * k);
  c.strokeStyle = alpha(col, .9 * k); c.lineWidth = 3;
  c.beginPath(); c.arc(0, 0, R, 0, TAU); c.stroke();
  c.lineWidth = 2; c.beginPath(); c.arc(0, 0, R * .82, 0, TAU); c.stroke();
  c.save(); c.rotate(tau * .8);
  for (let i = 0; i < 2; i++) { c.beginPath(); for (let j = 0; j <= 3; j++) { const a = i * Math.PI / 3 + j * TAU / 3; j ? c.lineTo(Math.cos(a) * R * .8, Math.sin(a) * R * .8) : c.moveTo(Math.cos(a) * R * .8, Math.sin(a) * R * .8); } c.stroke(); }
  c.restore();
  c.save(); c.rotate(-tau * .5);
  for (let i = 0; i < 16; i++) { const a = i / 16 * TAU; c.save(); c.rotate(a); c.translate(0, -R * .91); c.fillStyle = alpha(col, .9 * k); const w = 3 + hash(i, seed) * 5; c.fillRect(-w / 2, -5, w, 10); c.restore(); }
  c.restore();
  c.beginPath(); c.arc(0, 0, R * .3, 0, TAU); c.stroke();
  c.restore();
}

/** A jagged lightning bolt from a to b; re-seeds 12x a second so it flickers. */
function fxLightning(c, tau, a, b, {col = '#d8f4ff', w = 4, k = 1, seed = 5, segments = 9} = {}) {
  if (k <= 0) return;
  const s = seed + Math.floor(tau * 12), pts = [a];
  for (let i = 1; i < segments; i++) { const f = i / segments, nx = -(b[1] - a[1]), ny = b[0] - a[0], n = Math.hypot(nx, ny) || 1, off = (hash(i, s) - .5) * 60; pts.push([lerp(a[0], b[0], f) + nx / n * off, lerp(a[1], b[1], f) + ny / n * off]); }
  pts.push(b);
  c.save(); c.globalCompositeOperation = 'lighter'; c.lineJoin = 'round'; c.lineCap = 'round';
  for (const [lw, al] of [[w * 4, .18], [w * 2, .4], [w, 1]]) { c.strokeStyle = lw === w ? alpha('#ffffff', k) : alpha(col, al * k); c.lineWidth = lw; c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.stroke(); }
  c.restore();
}

/** A glowing ribbon along the path (points), drawn up to u (0..1), fading tail. */
function fxEnergyTrail(c, points, u, {col = '#9fe7ff', w = 16, k = 1, tail = .45} = {}) {
  if (u <= 0 || k <= 0) return;
  const pts = smoothLine(points, 6, false), n = pts.length, end = Math.max(2, Math.round(n * clamp(u, 0, 1))), start = Math.max(0, Math.round(end - n * tail));
  c.save(); c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
  for (let i = start + 1; i < end; i++) {
    const f = (i - start) / Math.max(1, end - start);
    c.strokeStyle = alpha(col, .5 * f * k); c.lineWidth = w * (0.3 + f); c.beginPath(); c.moveTo(pts[i - 1][0], pts[i - 1][1]); c.lineTo(pts[i][0], pts[i][1]); c.stroke();
    c.strokeStyle = alpha('#ffffff', .8 * f * k); c.lineWidth = w * .25 * (0.3 + f); c.stroke();
  }
  c.restore();
}

/** An energy beam from a toward b, extending over u (0..1), flickering. */
function fxBeam(c, tau, a, b, u, {col = '#9fe7ff', w = 36, k = 1} = {}) {
  if (u <= 0 || k <= 0) return;
  const e = [lerp(a[0], b[0], clamp(u, 0, 1)), lerp(a[1], b[1], clamp(u, 0, 1))], flick = 1 + Math.sin(tau * 40) * .12;
  c.save(); c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
  for (const [lw, cl, al] of [[w * 2.2, col, .2], [w * flick, col, .55], [w * .35, '#ffffff', 1]]) { c.strokeStyle = alpha(cl, al * k); c.lineWidth = lw; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(e[0], e[1]); c.stroke(); }
  c.restore();
  fxGlow(c, a[0], a[1], w * 2.5, col, k); fxGlow(c, e[0], e[1], w * 2, col, k);
}

/** An impact: flash, expanding ring, spikes; t0 = moment of the hit. */
function fxImpact(c, tau, t0, x, y, {col = '#bdf0ff', r = 160, d = .55, k = 1} = {}) {
  const u = (tau - t0) / d;
  if (u < 0 || u > 1 || k <= 0) return;
  const fade = 1 - u;
  fxGlow(c, x, y, r * (.6 + u), col, fade * k * 1.4);
  c.save(); c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
  c.strokeStyle = alpha('#ffffff', fade * k); c.lineWidth = 8 * fade + 1; c.beginPath(); c.arc(x, y, r * easeOutExpo(u), 0, TAU); c.stroke();
  for (let i = 0; i < 12; i++) { const a = i / 12 * TAU + hash(i, 7) * .3, r0 = r * (.2 + u * .6), r1 = r0 + r * (.35 + hash(i, 8) * .4) * fade; c.strokeStyle = alpha(col, fade * k); c.lineWidth = 5 * fade + 1; c.beginPath(); c.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0); c.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1); c.stroke(); }
  c.restore();
}

/** Sparks flying from (x, y) at t0 (seeded particles with gravity). */
function fxSparks(c, tau, t0, x, y, {col = '#e8fbff', n = 26, speed = 520, d = .9, seed = 3} = {}) {
  const t = tau - t0;
  if (t < 0 || t > d) return;
  c.save(); c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const a = hash(i, seed) * TAU, v = speed * (.3 + hash(i, seed + 1) * .7), px = x + Math.cos(a) * v * t, py = y + Math.sin(a) * v * t + 420 * t * t, f = 1 - t / d;
    c.strokeStyle = alpha(col, f); c.lineWidth = 3 * f + .5; c.beginPath(); c.moveTo(px, py); c.lineTo(px - Math.cos(a) * 18 * f, py - Math.sin(a) * 18 * f); c.stroke();
  }
  c.restore();
}

/** Soft smoke / dust puffs spreading from (x, y) at t0. */
function fxSmoke(c, tau, t0, x, y, {col = '#cfd3de', n = 9, r = 70, d = 1.4, seed = 4} = {}) {
  const t = tau - t0;
  if (t < 0 || t > d) return;
  const u = t / d;
  c.save();
  for (let i = 0; i < n; i++) {
    const a = hash(i, seed) * TAU, dist = r * (.4 + hash(i, seed + 1)) * easeOutExpo(u), rr = r * (.35 + .5 * u) * (.6 + hash(i, seed + 2) * .5);
    const g = c.createRadialGradient(x + Math.cos(a) * dist, y + Math.sin(a) * dist * .5 - u * 30, 0, x + Math.cos(a) * dist, y + Math.sin(a) * dist * .5 - u * 30, rr);
    g.addColorStop(0, alpha(col, .45 * (1 - u))); g.addColorStop(1, alpha(col, 0));
    c.fillStyle = g; c.beginPath(); c.arc(x + Math.cos(a) * dist, y + Math.sin(a) * dist * .5 - u * 30, rr, 0, TAU); c.fill();
  }
  c.restore();
}

/** A full-screen flash at t0 (screen space, drawn over everything). */
function fxHitFlash(c, tau, t0, {d = .18, col = '#ffffff', k = .85} = {}) {
  const u = (tau - t0) / d;
  if (u < 0 || u > 1) return;
  c.save(); resetT(c); c.globalAlpha = (1 - u) * k; c.fillStyle = col; c.fillRect(0, 0, W, H); c.restore();
}

/** Drifting glowing motes over an area [x0, y0, x1, y1] (world space). */
function fxMotes(c, tau, [x0, y0, x1, y1], {col = '#fff3c4', n = 40, seed = 11, size = 3} = {}) {
  c.save(); c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const ph = (tau * (.03 + hash(i, seed) * .05) + hash(i, seed + 1)) % 1;
    const px = x0 + (x1 - x0) * ((hash(i, seed + 2) + Math.sin(tau * .5 + i) * .02) % 1), py = y1 - (y1 - y0) * ph;
    const tw = .5 + .5 * Math.sin(tau * 3 + i * 1.7);
    c.fillStyle = alpha(col, .75 * tw * Math.sin(ph * Math.PI)); c.beginPath(); c.arc(px, py, size * (.6 + hash(i, seed + 3)), 0, TAU); c.fill();
  }
  c.restore();
}

/** Falling petals / leaves drifting across [x0, y0, x1, y1]. */
function fxPetals(c, tau, [x0, y0, x1, y1], {col = '#f6c4d8', n = 16, seed = 21} = {}) {
  for (let i = 0; i < n; i++) {
    const ph = (tau * (.06 + hash(i, seed) * .05) + hash(i, seed + 1)) % 1;
    const px = x0 + ((hash(i, seed + 2) + ph * .35 + Math.sin(tau * 1.2 + i) * .02) % 1) * (x1 - x0), py = y0 + ph * (y1 - y0), a = tau * 2 + i;
    c.save(); c.translate(px, py); c.rotate(a); c.scale(1, .55 + .45 * Math.sin(tau * 3 + i));
    c.fillStyle = col; c.globalAlpha = .85; c.beginPath(); c.ellipse(0, 0, 7, 4, 0, 0, TAU); c.fill(); c.restore();
  }
}

/** Slow bands of mist drifting at height y (world space). */
function fxMist(c, tau, y, {col = '#ffffff', al = .35, n = 6, speed = 14, seed = 31, h = 60} = {}) {
  for (let i = 0; i < n; i++) {
    const x = ((i * 420 + tau * speed * (.6 + hash(i, seed) * .8) + hash(i, seed + 1) * 300) % 2800) - 440, w = 360 + hash(i, seed + 2) * 260;
    const g = c.createRadialGradient(x, y, 0, x, y, w / 2);
    g.addColorStop(0, alpha(col, al)); g.addColorStop(1, alpha(col, 0));
    c.save(); c.translate(x, y); c.scale(1, h / (w / 2)); c.translate(-x, -y); c.fillStyle = g; c.beginPath(); c.arc(x, y, w / 2, 0, TAU); c.fill(); c.restore();
  }
}

/** Draw a layer at a depth: 0 = fixed to the screen, 1 = moves with the world.
 * cam is the scene's camera {x, y, zoom} (call the same camera function in set). */
function parallax(c, cam, depth, draw) {
  c.save();
  c.translate((cam.x - W / 2) * (1 - depth), (cam.y - H / 2) * (1 - depth) * .6);
  draw(c);
  c.restore();
}

/** A continuous shot track: keys [{at, x, y, zoom}] eased into each other
 * (push-ins, pans, tracking) -- never a random cut -- plus impact shakes
 * [{at, amp, d}]. Returns a director camera function (tau, S) => view. */
function shotTrack(track, shakes = []) {
  const k = [...track].sort((a, b) => a.at - b.at);
  const kx = k.map((p) => [p.at, p.x, p.ease || easeInOutSine]), ky = k.map((p) => [p.at, p.y, p.ease || easeInOutSine]), kz = k.map((p) => [p.at, p.zoom ?? (SHOTS[p.shot] || 1), p.ease || easeInOutSine]);
  return (tau) => {
    let dx = 0, dy = 0;
    for (const s of shakes) { const h = shake(tau, s.at, s.amp ?? 12, s.d ?? .4); dx += h.dx; dy += h.dy; }
    return {x: keys(tau, kx), y: keys(tau, ky), zoom: keys(tau, kz), dx, dy};
  };
}

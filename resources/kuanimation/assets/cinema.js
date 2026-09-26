'use strict';
// Declarative cinematic layer for longer stories. It sits above cast.js/action.js and
// below director.js: character identity, reusable acting, shot presets and event cues.

// ---------- character continuity ----------
function defineCharacters(list) {
  const out = {};
  for (const raw of list || []) {
    if (!raw?.id) throw new Error('Every character needs an id');
    if (out[raw.id]) throw new Error(`Duplicate character id: ${raw.id}`);
    out[raw.id] = Object.freeze({name: raw.id, gender: null, age: null, body: T.red, skin: T.skin, hat: 'hair', scale: 1, mood: 'happy', voice: null, accessories: [], ...raw});
  }
  return Object.freeze(out);
}
const actorState = (...parts) => Object.assign({x: 0, y: STG.floorY, scale: 1, dir: 1, t: 0}, ...parts.filter(Boolean));

// Draw one registered identity with a temporary acting state. The wrapper provides
// whole-body transforms that pp() intentionally does not own (lean, breathing, crouch).
function drawActor(c, def, state = {}) {
  if (!def) throw new Error('drawActor needs a character definition');
  const s = actorState({scale: def.scale || 1, mood: def.mood || 'happy'}, state), opt = {...def, ...s};
  c.save(); c.translate(s.x + (s.dx || 0), s.y + (s.dy || 0)); c.rotate(s.rotation || 0); c.scale(s.scaleX || 1, s.scaleY || 1);
  pp(c, 0, 0, s.scale, {body: opt.body, skin: opt.skin, hat: opt.hat, mood: opt.mood, arms: opt.arms, walk: opt.walk ?? null, t: opt.t, dir: opt.dir, mouth: opt.mouth || 0, robe: !!opt.robe, skirt: !!opt.skirt, prop: opt.prop || null, look: opt.look || 0, blink: !!opt.blink});
  c.restore();
}

// ---------- reusable performance ----------
// Each ACT method returns actor state. Combine simultaneous beats with actorState(),
// putting the most specific state last: actorState(ACT.idle(...), ACT.speak(...)).
const ACT = Object.freeze({
  idle(tau, {x = 0, y = STG.floorY, dir = 1, scale = 1, seed = 1} = {}) {
    return {x, y, dir, scale, t: tau, dy: Math.sin(tau * 1.8 + seed) * 1.5, scaleY: 1 + Math.sin(tau * 1.8 + seed) * .006, blink: loopPhase(tau + seed * .37, 3.8) < .035};
  },
  walk(tau, t0, t1, a, b, opt = {}) {
    const p = travel(tau, t0, t1, a, b, opt.ease || easeInOutSine), dir = opt.dir || Math.sign(b[0] - a[0]) || 1;
    return {x: p[0], y: p[1], dir, scale: opt.scale || 1, t: tau, walk: stepPhase(p[0], opt.stride || 80)};
  },
  run(tau, t0, t1, a, b, opt = {}) {
    const p = travel(tau, t0, t1, a, b, opt.ease || easeInOutSine), dir = opt.dir || Math.sign(b[0] - a[0]) || 1;
    return {x: p[0], y: p[1], dir, scale: opt.scale || 1, t: tau * 1.8, walk: stepPhase(p[0], opt.stride || 48), rotation: Math.sin(tau * 12) * .015};
  },
  fly(tau, t0, t1, points, opt = {}) {
    const p = followPath(tau, t0, t1, points, opt.ease || easeInOutSine), dir = opt.dir || (Math.cos(p.angle) < 0 ? -1 : 1);
    return {x: p.x, y: p.y + Math.sin(tau * 5) * (opt.float || 6), dir, scale: opt.scale || 1, t: tau, rotation: clamp(p.angle, -.35, .35), arms: opt.arms || 'up'};
  },
  turnHead(tau, t0, from = -1, to = 1, d = .5) { return {look: lerp(from, to, span(t0, t0 + d, tau))}; },
  lookAt(fromX, targetX) { const q = Math.sign(targetX - fromX); return {look: q, dir: q || 1}; },
  nod(tau, t0, d = .8) { const u = clamp((tau - t0) / d, 0, 1); return {rotation: Math.sin(u * TAU * 2) * .045 * Math.sin(u * Math.PI)}; },
  bow(tau, t0, d = 1) { const u = span(t0, t0 + d / 2, tau) * (1 - span(t0 + d / 2, t0 + d, tau)); return {rotation: .32 * u, dy: 8 * u, arms: 'pray'}; },
  sit(tau, t0, d = .6) { const u = span(t0, t0 + d, tau); return {dy: 32 * u, scaleY: 1 - .14 * u}; },
  stand(tau, t0, d = .6) { const u = 1 - span(t0, t0 + d, tau); return {dy: 32 * u, scaleY: 1 - .14 * u}; },
  point(dir = 1) { return {arms: 'point', dir}; },
  hug(dir = 1) { return {arms: 'hold', dir, mood: 'happy'}; },
  attack(tau, t0, {dir = 1, distance = 85, d = .45} = {}) { const u = clamp((tau - t0) / d, 0, 1), lunge = Math.sin(u * Math.PI); return {dx: dir * distance * lunge, rotation: dir * -.12 * lunge, arms: 'point', mood: 'angry', dir}; },
  shocked() { return {mood: 'shock', arms: 'up', mouth: 1}; },
  angry() { return {mood: 'angry', arms: 'point'}; },
  smile() { return {mood: 'happy'}; },
  speak(tau, t0, t1, amp = null) { const live = tau >= t0 && tau <= t1; return {mouth: live ? (amp == null ? .25 + .75 * Math.abs(Math.sin(tau * 11)) : clamp(amp * 7, 0, 1)) : 0}; },
  idleBreathing(tau, seed = 1) { return {t: tau, dy: Math.sin(tau * 1.7 + seed) * 1.4, scaleY: 1 + Math.sin(tau * 1.7 + seed) * .007, blink: loopPhase(tau + seed, 4.1) < .03}; },
});

// ---------- storyboard and event timeline ----------
function defineStoryboard(plans) {
  const ids = new Set();
  return (plans || []).map((p, i) => {
    const sceneId = p.sceneId || `scene-${String(i + 1).padStart(2, '0')}`;
    if (ids.has(sceneId)) throw new Error(`Duplicate sceneId: ${sceneId}`); ids.add(sceneId);
    return {sceneId, duration: p.duration || 6, location: p.location || 'unspecified', timeOfDay: p.timeOfDay || 'day', background: p.background || null, characters: p.characters || [], props: p.props || [], actions: p.actions || [], narration: p.narration || [], dialogue: p.dialogue || [], subtitles: p.subtitles || [], camera: p.camera || {shot: 'wide'}, transition: p.transition || 'cut', soundEffects: p.soundEffects || [], ambience: p.ambience || null, ...p};
  });
}
const eventProgress = (tau, ev) => clamp((tau - ev.at) / Math.max(1e-6, ev.dur ?? .001), 0, 1);
function runEvents(c, tau, S, events, handlers) {
  for (const ev of events || []) { if (tau < ev.at || tau > ev.at + (ev.dur ?? .001)) continue; const fn = handlers?.[ev.type]; if (fn) fn(c, ev, eventProgress(tau, ev), S); }
}

// ---------- cinematic camera ----------
const SHOTS = Object.freeze({establishing: .72, wide: .86, medium: 1.12, close: 1.55, extremeClose: 2.15, overShoulder: 1.38, reaction: 1.65});
function cinematicCamera({shot = 'wide', x = W / 2, y = 520, move = 'push', amount = .08, fromX = x, fromY = y, toX = x, toY = y, shakeAt = null, shakeAmp = 10} = {}) {
  return (tau, S) => {
    const u = span(0, S.dur, tau, easeInOutSine), base = SHOTS[shot] || (typeof shot === 'number' ? shot : 1), zoom = move === 'push' ? base * lerp(1, 1 + amount, u) : move === 'pull' ? base * lerp(1 + amount, 1, u) : base;
    const q = move === 'pan' || move === 'tilt' || move === 'track' ? u : 0, hit = shakeAt == null ? {dx: 0, dy: 0} : shake(tau, shakeAt, shakeAmp);
    return {x: lerp(fromX, toX, q), y: lerp(fromY, toY, q), zoom, dx: hit.dx, dy: hit.dy};
  };
}
function cutCamera(tau, S, cuts) {
  const ordered = [...cuts].sort((a, b) => a.at - b.at); let pick = ordered[0] || {};
  for (const cut of ordered) if (tau >= cut.at) pick = cut;
  return cinematicCamera(pick)(Math.max(0, tau - (pick.at || 0)), {...S, dur: pick.dur || Math.max(.001, S.dur - (pick.at || 0))});
}

// Fade and wipe overlays. Crossfades require both scenes on canvas and remain a custom
// scene concern; these transitions are safe with the existing one-scene director.
function transitionOverlay(c, tau, dur, {type = 'fade', inDur = .45, outDur = .45, color = '#120c08'} = {}) {
  const a = Math.max(1 - clamp(tau / inDur, 0, 1), clamp((tau - dur + outDur) / outDur, 0, 1)); if (a <= 0) return;
  c.save(); resetT(c); c.fillStyle = color;
  if (type === 'wipe') { const entering = tau < inDur, u = entering ? 1 - tau / inDur : (tau - dur + outDur) / outDur; c.fillRect(entering ? W * (1 - u) : 0, 0, W * u, H); }
  else { c.globalAlpha = easeInOutSine(a); c.fillRect(0, 0, W, H); }
  c.restore();
}

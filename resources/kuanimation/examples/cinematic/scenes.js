'use strict';
// Small source-free demo of continuity, reusable acting, timeline cues and shot changes.
const CAST = defineCharacters([
  {id: 'elder', name: 'លោកយាយ', gender: 'female', age: 'elder', body: '#553b78', skin: '#d5a27f', hat: 'bun', robe: true, scale: 1.22, mood: 'neutral', voice: 'elder-kh'},
  {id: 'yan', name: 'យ៉ានយ៉ាន', gender: 'female', age: 'young adult', body: '#b33951', skin: '#e3ad86', hat: 'hair', skirt: true, scale: 1.05, mood: 'happy', voice: 'young-kh'},
]);

const STORYBOARD = defineStoryboard([
  {sceneId: 'sect', duration: 7, location: 'Mountain sect', timeOfDay: 'dawn', characters: ['disciples'], camera: {shot: 'establishing', move: 'pan'}, transition: 'fade', ambience: 'wind'},
  {sceneId: 'arrival', duration: 8, location: 'Fourth Peak courtyard', characters: ['elder', 'yan'], actions: ['fly', 'hug'], camera: {shot: 'wide', move: 'track'}, transition: 'cut', soundEffects: ['flying', 'footstep']},
  {sceneId: 'wish', duration: 8, location: 'Fourth Peak courtyard', characters: ['elder', 'yan'], dialogue: ['marriage wish'], camera: {shot: 'medium', move: 'reaction'}, transition: 'fade'},
]);

function peakHall(c, x, y, s = 1) {
  c.save(); c.translate(x, y); c.scale(s, s);
  sh(c, [[-250, 0, 1], [250, 0, 1], [210, -220, 1], [-210, -220, 1]], '#b9a680', {w: 6});
  sh(c, [[-290, -220, 1], [0, -330, 1], [290, -220, 1], [230, -190], [-230, -190]], '#4c5962', {w: 7});
  sh(c, rr(-58, -150, 116, 150, 8), '#42352e', {w: 6});
  for (const sg of [-1, 1]) sh(c, rr(sg * 120 - 34, -154, 68, 92, 6), '#d7c48e', {w: 5});
  c.restore();
}

const SCENES = [
  {name: STORYBOARD[0].sceneId, mood: 'dawn', dur: STORYBOARD[0].duration,
    captions: [{t0: .6, t1: 6.4, text: 'នៅលើកំពូលភ្នំ សាលាបុរាណភ្ញាក់ឡើងជាមួយពន្លឺថ្ងៃ។'}],
    camera: cinematicCamera({shot: 'establishing', move: 'pan', fromX: 760, toX: 1120, y: 500}),
    set(c, tau) {
      stageFloor(c, 'dawn');
      for (let k = 0; k < 7; k++) mountainT(c, 120 + k * 300, 700, .7 + hash(k, 8) * .35, k + 2);
      peakHall(c, 960, 770, 1.15);
      for (let k = 0; k < 5; k++) { const p = ACT.walk(tau, .4 + k * .18, 6.3, [-100 + k * 100, 930 + (k % 2) * 40], [2050 - k * 80, 930 + (k % 2) * 40], {scale: .62}); drawActor(c, {id: `disciple-${k}`, body: k % 2 ? '#60745a' : '#687485', skin: T.skin, hat: 'hair', scale: .62}, p); }
      windLines(c, tau, {n: 6, al: .18, speed: 100, spread: 520});
    }},
  {name: STORYBOARD[1].sceneId, mood: 'warm', dur: STORYBOARD[1].duration,
    captions: [{t0: .5, t1: 3.8, text: 'យ៉ានយ៉ានហោះចូលទីធ្លាយ៉ាងរីករាយ។'}, {t0: 4.1, t1: 7.5, text: 'នាងរត់ទៅឱបដៃលោកយាយ។'}],
    camera: (tau, S) => cutCamera(tau, S, [{at: 0, shot: 'wide', x: 1000, y: 560, move: 'push', amount: .06}, {at: 4.1, shot: 'medium', x: 1050, y: 650, move: 'push', amount: .04}]),
    set(c, tau) {
      stageFloor(c, 'warm');
      peakHall(c, 960, 780, 1.05);
      const elder = actorState(ACT.idle(tau, {x: 1120, y: 920, dir: -1, scale: CAST.elder.scale, seed: 2}), tau > 4 ? ACT.hug(-1) : null); drawActor(c, CAST.elder, elder);
      const path = smoothLine([[-160, 530], [260, 420], [650, 650], [940, 900]], 24), flying = ACT.fly(tau, .4, 4.2, path, {scale: CAST.yan.scale, arms: 'up'}), yan = actorState(flying, tau > 4 ? {x: 1015, y: 920, rotation: 0, arms: 'hold', mood: 'happy', dir: 1} : null);
      afterimages(c, tau, .5, 3.7, t => ACT.fly(t, .4, 4.2, path, {scale: CAST.yan.scale}), (g, p, al) => drawActor(g, CAST.yan, {...p, scale: CAST.yan.scale, arms: 'up'}), {n: 4, al: .22});
      drawActor(c, CAST.yan, yan); if (tau > 4.2) emote(c, tau, 4.2, 1060, 690, 'heart', {t1: 6.5});
    }},
  {name: STORYBOARD[2].sceneId, mood: 'warm', dur: STORYBOARD[2].duration,
    captions: [{t0: .5, t1: 4, text: 'យ៉ានយ៉ាន៖ លោកយាយ ខ្ញុំចង់រៀបការ!'}, {t0: 4.2, t1: 7.5, text: 'លោកយាយភ្ញាក់ផ្អើល ហើយសម្លឹងមើលនាង។'}],
    camera: (tau, S) => cutCamera(tau, S, [{at: 0, shot: 'medium', x: 1000, y: 650, move: 'push', amount: .03}, {at: 4.1, shot: 'reaction', x: 1120, y: 760, move: 'push', amount: .05}]),
    set(c, tau, S) {
      stageFloor(c, 'warm');
      peakHall(c, 960, 780, 1.05);
      const yan = actorState(ACT.idle(tau, {x: 940, y: 920, dir: 1, scale: CAST.yan.scale, seed: 4}), ACT.speak(tau, .8, 3.8), tau < 4 ? ACT.smile() : null); drawActor(c, CAST.yan, yan);
      const elder = actorState(ACT.idle(tau, {x: 1120, y: 920, dir: -1, scale: CAST.elder.scale, seed: 2}), tau >= 4.1 ? ACT.shocked() : ACT.lookAt(1120, 940)); drawActor(c, CAST.elder, elder);
      bubble(c, tau, .8, 3.8, 940, 650, 'រៀបការ!', {w: 270, h: 110, size: 34, tail: [20, 110]});
      if (tau >= 4.1) { impact(c, tau, 4.1, 1120, 710, {r: 55}); emote(c, tau, 4.1, 1120, 650, '!', {t1: 6.4}); }
      transitionOverlay(c, tau, S.dur, {type: 'fade'});
    }},
];

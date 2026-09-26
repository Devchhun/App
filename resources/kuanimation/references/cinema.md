# Cinematic stories

Read this reference for a long-form story, novel adaptation or dialogue-heavy film. The
cinematic layer is optional; short explainers can continue using `action.js` directly.

## Plan before drawing

Create a compact `defineStoryboard([...])` plan before `SCENES`. Keep only facts supplied
by the source in narration and dialogue. Camera angles, entrances, reactions and ambient
motion may be visual interpretation, but must not change the plot.

Each plan can record `sceneId`, `duration`, `location`, `timeOfDay`, `background`,
`characters`, `props`, `actions`, `narration`, `dialogue`, `subtitles`, `camera`,
`transition`, `soundEffects` and `ambience`. Split when the location, dramatic beat,
speaker focus or required camera framing changes; do not mechanically make one scene per
paragraph.

## Character continuity

Define identities once and reuse them:

```js
const CAST = defineCharacters([
  {id: 'mei', name: 'Mei', body: '#7b3353', skin: '#d8a17d', hat: 'bun', robe: true,
   scale: 1.1, mood: 'calm', voice: 'km-KH-SreymomNeural'},
]);
```

Use `drawActor(c, CAST.mei, state)`. It merges the fixed identity with temporary acting
state, so hair, clothes, body colour and scale remain consistent across scenes.

## Reusable acting

`ACT` provides `idle`, `walk`, `run`, `fly`, `turnHead`, `lookAt`, `nod`, `bow`, `sit`,
`stand`, `point`, `hug`, `attack`, `shocked`, `angry`, `smile`, `speak` and
`idleBreathing`. Combine simultaneous states with `actorState`; later states win:

```js
const state = actorState(
  ACT.idle(tau, {x: 900, y: 920, dir: -1}),
  ACT.lookAt(900, heroX),
  ACT.speak(tau, L(0), S.lines[0].t1, speaking(S, tau)?.amp),
);
drawActor(c, CAST.mei, state);
```

Every speaking character should have mouth motion, a small head/body change and an
appropriate gesture or expression. Keep breathing/blinking on quiet characters so the
film does not become a slideshow.

## Shots and timeline

Use `cinematicCamera(...)` for establishing, wide, medium, close, extreme close,
over-shoulder and reaction shots. Prefer one slow movement per shot. Use `cutCamera` when
a scene needs a motivated change such as dialogue to reaction:

```js
camera: (tau, S) => cutCamera(tau, S, [
  {at: 0, shot: 'medium', x: 820, y: 650, move: 'push'},
  {at: L(1), shot: 'reaction', x: 1150, y: 720, move: 'push'},
])
```

For dense choreography, store `{at, dur, type, ...}` cues and dispatch them with
`runEvents(c,tau,S,events,handlers)`. Keep voice timing from `director.js` authoritative;
use `L(i)` or line durations instead of duplicating audio seconds.

`transitionOverlay` supports restrained fade and wipe overlays. True crossfades need both
scenes rendered together and should be implemented locally when the story needs one.

Study [the cinematic demo](../examples/cinematic/README.md) for a complete small film.

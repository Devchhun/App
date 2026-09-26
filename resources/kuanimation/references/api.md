# API

## kuanimation.js (runtime)
`W H S TAU` · `lerp clamp lerp2` · `parseColor mix tint shade alpha` · `rng(seed)() hash(k,seed) wobble(x,seed)` ·
`linear easeIO easeIn easeOut easeInOutSine easeOutExpo easeOutBack` · `span(a,b,t,ease)` 0..1 between times ·
`keys(t, [[time, value | [values], ease?],…])` · `onTwos(t)` · `smoothLine(pts,step,close)` · `polyPath(pts,close)` · `twoBone(root,target,a,b,bend)` ·
`resetT(c) cam(c,x,y,zoom,rot) layer() blit(c,L)` · `sprite(id,[x,y,w,h],draw,res) blitS(c,sp,al)` cached drawings ·
`txt(c,s,x,y,{size,font,color,align,weight,italic,al,reveal,shadow})` · `tone hiss` for scores ·
`defineFilm({timeline:[{name,dur,fn(c,tau)}], score, fps, width})`. Page hooks: `DT.frame(i) DT.grid(n) DT.strip(a,n) DT.wav() DT.cues DT.dur`.

## brush.js
`FONT.serif/khmer/hand/ui` · vectors `add sub mul len norm rot xf(pts,x,y,s,a,flipX)` · shapes `rectP ell circ rr(x,y,w,h,r)` ·
`curve(pts,close)` (third value 1 = corner) · `cutAt(q,u)` · `profile(keys)` · `strip(pts,widthFn)` ·
`sh(c,pts,fill,{w,tex,line,al,color})` filled cut-out with outline · `mk(c,pts,{w,color,al,close})` open stroke ·
`inkLine` low level · `vgrad(top,bottom) hgrad(a,b)` fill functions · `texture(c,path,k)` · `INK LINE` defaults ·
`useStyle('pencil'|'wash'|'haze'|'paper'|'marker')` (default pencil) · `celShade(c,path,q,k)` haze shading · `mottle(c,path,k)` watercolour grain · `STYLE` · `deckle(q,amp)` torn edge · `pin(c,[x,y],r)` brass split-pin (paper only) · `sh(...,{lift})` shadow depth ·
pencil: `hatchPattern(c,col,{dens,ang,len,seed})` coloured-pencil strokes · `graphitePattern(c,col)` · `toothPattern(c)` paper grain · `pencilLine(c,pts,{w,color,al,close})` · `jitterLine(q,amp,seed,ext)` · `scribble(c,x,y,rx,ry,{n,col,al,w,seed})` · `BOIL` line-boil seed (set per frame by the director).

## stage.js
`T` palette (set from `PALETTES.wash|haze|pencil|paper|marker` by `useStyle`) · `WASH_MOODS` · `HAZE_MOODS` · `PENCIL_MOODS` · `MOODS` (paper, marker) · `STG {floorY:760}` ·
`stageBack(c,mood)` · `stageFloor(c,mood)` · `stageFront(c,open)` frame + scene transition · `subtitle(c,l1,l2,u,al,{font1,font2})` (line 1 in any language: the style's lettering with script-font fallback) ·
wash: `washLandscape(mood,seed)` `washGround` `softFade` `washSubtitle` `pool(g,pts,col)` · haze: `hazeLandscape(mood,seed)` `hazeGround` `hazeFront(c,open)` `clump(g,x,y,r,{base,lit,dk,inkAl,lw,seed})` `canopyBand(g,{y0,y1,r0,r1,base,haze,glow,k,seed,roll})` · pencil: `pencilLandscape(mood,seed)` `pencilGround(c,mood)` (grass + cut-away soil) `pencilFront(c,open)` `pencilSubtitle` `hatchRect(g,col,x,y,w,h,al,o)` · paper: `paperLandscape(mood,seed)` `paperGround` `shadowBox` `tearShutter(c,open)` · marker: `washLayer` `sideCurtains` `valance` `mainCurtain`.
Characters stand on y ≈ 760..1060 (front of stage ≈ 900–1030).

## cast.js
`face(c,r,{mood,mouth,blink,look,cheeks})` · `grandpa(c,x,y,s,{mouth,blink,look,gesture,gp,walk,t,dir})` the built-in narrator ·
`pp(c,x,y,s,{body,skin,hat,mood,arms,walk,t,dir,mouth,robe,skirt,prop:{draw(c,handR,handL),behind}})` player ·
`HATS` · `PROPS.spear/parasol/bowl/oar/scroll/shield` · `elephantT(c,x,y,s,phase,{cloth,rider,walk,gold})` · `apsaraT(c,x,y,s,t,{body})` (Khmer dancer).
A new narrator is a function with `grandpa`'s signature; pass it as `buildPlay(SCENES,{narrator})`.

## props.js
`waveRoller(c,y,t,{col,dk,amp,ph,h})` · `signBoard(c,x,y,w,h,text,{font,size,fill,col,drop})` · `onStick(c,x,y,draw,p)` ·
general: `sunBurst cloudT palmT treeT stiltHouse mountainT boatT shipT fireT crocT confetti throneT blockT hangingMap(c,x,y,w,h,drop,draw(g,w,h))` ·
from the Angkor example: `budTower angkorFlat bayonT brickTowerT buddhaT gateT flagT` (Cambodia's flag) ·
lettering and pointers (any style, made for pencil): `handText(c,text,x,y,size,reveal,{col,al,align,halo})` written-on handwriting · `arrowT(c,a,b,u,{bow,w})` bowed arrow drawing itself on · `pathArrow(c,pts,u,{w})` arrow along any path · `sparkle(c,x,y,s,al)`.
The sunflower example's `flora.js` adds `seedT rootT shootT plantT headT beeT birdT canProp UMBRELLA HATS.sunhat`.

## action.js
`travel(tau,t0,t1,a,b,ease)` → [x,y] · `hop(tau,t0,t1,a,b,h)` arc jump · `stepPhase(x,stride)` walk phase from distance ·
`pathPoint(points,u)` distance-balanced point on a polyline · `followPath(tau,t0,t1,points,ease)` → `{x,y,angle,u}` ·
`spring(tau,t0,d,{bounces,decay})` overshooting entrance progress · `loopPhase(tau,d,phase)` repeating 0..1 clock · `stagger(tau,t0,index,gap,d,ease)` per-item entrance progress ·
`shake(tau,t0,amp,d)` → {dx,dy} camera offset · `bubble(c,tau,t0,t1,x,y,content,{w,h,tail,think,size})` speech/thought (text or draw fn) ·
`emote(c,tau,t0,x,y,kind,{s,t1})` kinds `! ? heart sweat anger zzz idea` · `impact(c,tau,t0,x,y,{r,col,d})` ·
`speedLines(c,x,y,dir,{n,len,spread})` · `dust(c,tau,t0,x,y,{n,s,d})` ·
`afterimages(c,tau,t0,t1,position,draw,{n,gap,al})` motion ghosts · `particleBurst(c,tau,t0,x,y,{n,speed,gravity,d,size,colors,seed,draw})` deterministic particles ·
`rain(c,tau,{n,al,slant,speed,len,col})` screen-space rain · `snow(c,tau,{n,al,speed,drift,size,col})` layered snow · `windLines(c,tau,{n,al,speed,len,spread,col,seed})` gust marks · `glowLight(c,x,y,r,col,k)` lamp/sun bloom.

## director.js
`timing(V,{pre,post,holds})` · `speaking(S,tau)` → `{i,l,u,amp}` · `L_(S)(i)` line start · `pop(tau,t0,d)` · `rise(c,p,draw)` ·
`buildPlay(SCENES,{narrator=null,style='pencil'|'wash'|'haze'|'paper'|'marker',frame='stage'|'full',subtitles,end})` → timeline (+ `window.DT.cues`) · `endCard(lines,{dur})` ·
`DEFAULT_CAMERA` slow push-in · `applyCamera(c,{x,y,zoom,dx,dy})` · `dipCut` · `performNarrator` (presenter mode).
Scene fields: `name mood set(c,tau,S) holds pre post dur beats camera captions curtainOpen`; presenter-only: `gx gy gs dir gestures special`.
`S.beats(i)` = start of voice line i (or `beats[i]` for a voiceless scene).

## cinema.js
`defineCharacters(list)` → stable character registry · `actorState(...states)` merges performance states · `drawActor(c,definition,state)` ·
`ACT.idle/walk/run/fly/turnHead/lookAt/nod/bow/sit/stand/point/hug/attack/shocked/angry/smile/speak/idleBreathing` ·
`defineStoryboard(plans)` normalises cinematic scene plans · `eventProgress(tau,event)` · `runEvents(c,tau,S,events,handlers)` ·
`SHOTS` · `cinematicCamera(options)` → director camera function · `cutCamera(tau,S,cuts)` · `transitionOverlay(c,tau,dur,options)`.

## Tools
`node render.mjs film.html [--grid N | --strip A,N | --only a,b] [--width px] [--out dir]` ·
`node mix.mjs film.html` → `out/mix.wav` (score ducked under voice, −16 LUFS) ·
`tts_gemini.py --voice --style --per` · `tts_edge.py --voice --rate --pitch`.

## Exact values and signatures

Generated from the kit's own source. An AI writer should use only these; the
kit forgives the most common slips (an unknown `arms` falls back to `'hold'`
with a prop or `'down'` without; a bare `PROPS.spear` becomes a prop; a shape
with fewer than two points is skipped; `ell`'s `n` below 3 means 28) so a
wrong guess costs a detail, never the whole film.

```
EXACT VALUES THE KIT ACCEPTS (anything else is silently wrong or crashes):
- pp(...) arms: 'down', 'up', 'pray', 'point', 'hold', 'row', 'cheer'. There is NO 'idle', 'walk', 'run', 'reach', 'wave' or 'dance': for walking pass walk: stepPhase(x) with arms 'down'; to hold a prop use 'hold'; to reach or wave use 'up' or 'point'.
- pp(...) hat: 'mokot', 'tiara', 'hair', 'bun', 'band', 'cham', 'bald', 'futou', 'helmet'.
- PROPS.<name>(c, hand): spear, parasol, bowl, oar, scroll, shield. These are drawing functions, not props: hand one to a player as prop: {draw: (c, r) => PROPS.spear(c, r)}. Your own prop is {draw(c, handR, handL), behind?}; check the hand is not null before using it.
- face / pp mood: 'happy', 'star', 'sad', 'shock', 'neutral' (anything else draws plain dot eyes).
- emote kinds: '!', '?', 'heart', 'sweat', 'anger', 'zzz', 'idea'.
- palette T.<color>: ol, curtain, curtainDk, gold, goldDk, floor, floorDk, skin, skinDk, white, red, orange, pink, blue, navy, teal, green, greenDk, yellow, brown, grey, greyDk, stone, stoneDk, saffron, purple, sky, water, waterDk. Any other colour: write it as a '#rrggbb' string.
- EXACT SIGNATURES (argument order and meaning matter; ell/circ take a point COUNT n, not an angle -- rotate shapes with xf(pts, x, y, s, angle)):
  xf(pts, x, y, s = 1, a = 0, fx = 1)
  rectP(x, y, w, h)
  ell(cx, cy, rx, ry, n = 28, a0 = 0, a1 = TAU)
  circ(x, y, r, n = 26)
  rr(x, y, w, h, r = 12)
  curve(pts, close = false, step = 2.5)
  strip(pts, wf, smooth = true, step = 2.5)
  sh(c, pts, fill, {w = LINE, tex = true, line = true, al = 1, color = INK, lift = 1} = {})
  mk(c, pts, {w = LINE, color = INK, al = 1, close = false, raw = false} = {})
  pp(c, x, y, s, o = {})
  face(c, r, {mood = 'happy', mouth = 0, blink = false, look = 0, cheeks = true} = {})
  handText(c, s, x, y, size, reveal = 1, {col = '#2f2d2a', al = 1, align = 'center', halo = true} = {})
  txt(c, s, x, y, {size = 40, font = 'Georgia, serif', color = '#000', align = 'center', weight = '', italic = false, al = 1, reveal = 1, shadow = null} = {})
  bubble(c, tau, t0, t1, x, y, content, {w = 260, h = 120, tail = [-40, 90], think = false, font = FONT.serif, size = 36, fill = '#fffaf0'} = {})
  emote(c, tau, t0, x, y, kind, {s = 1, t1 = t0 + 1.6} = {})
  impact(c, tau, t0, x, y, {r = 70, col = T.yellow, d = .45} = {})
  dust(c, tau, t0, x, y, {n = 5, s = 1, d = .8} = {})
  particleBurst(c, tau, t0, x, y, {n = 18, speed = 260, gravity = 360, d = 1, size = 8, colors = [T.yellow, T.red, T.sky], seed = 1, draw = null} = {})
  confetti(c, x, y, t, t0, {n = 60, spread = 700, seed = 3} = {})
  sunBurst(c, x, y, r, t, {col = T.yellow, rays = true} = {})
  glowLight(c, x, y, r, col = '#ffe7a8', k = 1)
  rain(c, tau, {n = 140, al = .55, slant = .08, speed = 1400, len = 60, col = '#dfe6f5'} = {})
  snow(c, tau, {n = 100, al = .8, speed = 90, drift = 35, size = 5, col = '#fffaf0'} = {})
  windLines(c, tau, {n = 12, al = .55, speed = 280, len = 150, spread = H, col = INK, seed = 1} = {})
  sparkle(c, x, y, s = 1, al = 1)
  arrowT(c, a, b, u, {bow = .18, w = 4} = {})
  signBoard(c, x, y, w, h, text, {font = FONT.serif, size = 44, fill = '#9b6a3e', col = '#f6ecd6', drop = 1} = {})
  treeT(c, x, y, h, {col = T.green} = {})
  palmT(c, x, y, h, {lean = 0} = {})
  stiltHouse(c, x, y, s, {col = T.orange, roof = T.red} = {})
  boatT(c, x, y, s, t, {side = 'khmer', rowers = 5, crew = 2, dir = 1} = {})
  fireT(c, x, y, s, t, seed = 1)
  cloudT(c, x, y, s, {col = T.white} = {})
  travel(tau, t0, t1, a, b, e = easeInOutSine)
  hop(tau, t0, t1, a, b, h = 120)
  stepPhase(x, stride = 80)
  followPath(tau, t0, t1, points, e = easeInOutSine)
  spring(tau, t0, d = .7, {bounces = 2.5, decay = 6} = {})
  stagger(tau, t0, index, gap = .12, d = .45, e = easeOutBack)
  shake(tau, t0, amp = 14, d = .5)
  span(from, to, t, ease = easeIO)
  keys(t, frames, ease = easeIO)
  pop(tau, t0, d = .5)
  rise(c, p, draw)

XIANXIA KIT (loaded; all of it drawn with sh/mk so it takes the film's look):
  xxPeak(c, x, y, h, w = h * .32, {col = T.greenDk, snow = false, seed = 1} = {})  -- A tall misty karst peak (Zhangjiajie / Huangshan). y = foot, h = height.
  xxPine(c, x, y, s = 40)  -- A small crooked pine clinging to a cliff.
  xxCloudSea(c, y, tau = 0, {col = '#f5f2ea', al = .9, speed = 12, seed = 3} = {})  -- A band of drifting cloud sea at height y (moves slowly with tau).
  xxWaterfall(c, x, y0, y1, w = 40, tau = 0)  -- A waterfall down a cliff face.
  xxRoof(c, x, y, w, h, col = T.navy)  -- An upturned Chinese roof: w wide, eaves at y, ridge h above.
  xxPavilion(c, x, y, s = 1, {roof = T.navy, wall = T.red, tiers = 1} = {})  -- A pavilion / hall: platform, red pillars, upturned roof. s = scale (1 ≈ 360 wide).
  xxPagoda(c, x, y, s = 1, {tiers = 5, roof = T.navy, wall = '#e9dcc3'} = {})  -- A multi-tier pagoda.
  xxGate(c, x, y, s = 1, text = '', {col = T.red} = {})  -- A sect gate (paifang) with a name board.
  xxLantern(c, x, y, s = 1, tau = 0)  -- A hanging red lantern (sways with tau).
  xxSword(c, x, y, s = 1, angle = 0, {glow = .8, col = '#dfe9f2'} = {})  -- A glowing flying sword; angle in radians, glow 0..1.
  xxAura(c, x, y, r = 120, tau = 0, {col = '#a7e3ff', k = 1} = {})  -- Swirling qi around a cultivator (tau animates it).
  xxSlash(c, tau, t0, a, b, {d = .35, col = '#cfefff', w = 14} = {})  -- A sword-qi slash: a bright crescent from a to b that draws on over d s.
  xxBreakthrough(c, tau, t0, x, y, {d = 2.2, col = '#fff2b8'} = {})  -- A breakthrough: a pillar of light and lightning on a cultivator.
  xxTalisman(c, x, y, s = 1, angle = 0)  -- A paper talisman (with a red rune stroke).
  xxLotus(c, x, y, s = 1)  -- A lotus flower (spirit herb / pond).
  xxCultivator(c, x, y, s, o = {})  -- A cultivator: pp() in a robe with a topknot, optional sword on the back, a qi aura, and flying (feet off the ground, robe trailing). o: all of pp's options, plus {sword, aura, flying, tau}.
  new hats for pp/xxCultivator: 'topknot', 'crown', 'longhair', 'veil', 'guan'
```

## score.js (music + sound effects)
`score(ac, t0, dest)` renders a mood score under the whole film: each scene's
`mood` picks a key, chords and tempo (bright, calm, tense, night, triumph);
storm scenes add rain. When `xianxia.js` is loaded (`window.FILM_GENRE =
'xianxia'`) the voices become a guzheng-like pluck, a bamboo flute and a war
drum on the Chinese pentatonic scale.
Scene field `sfx: [[lineIndex, secondsAfterLineStart, kind], ...]`, kinds:
`pop thud whoosh chime sparkle drip splash thunder bird cheer magic step knock bell`.

## Long films (chapters)
`film.html` may load `<script>const SCENES = [];</script>`, then a shared
`film-cast.js` (`const CAST = {...}` of pp/xxCultivator options plus `fx*`
helpers) and `chapter-N.js` files, each shaped
`(() => { ...local helpers...; SCENES.push({...}, ...); })();` so helpers of
different chapters never collide.

## Page hooks
`DT.draw(i)` draws frame i without encoding it (read the canvas yourself);
`DT.frame(i)` returns a PNG data URL as before.

## chibi.js (chibi fantasy characters)
`defineChibi({id, name, skin, blush, hair, hairShade, eyes: {top, mid, bottom, ring, glow}, robe, robeShade, robeTrim, inner, sash, jade, gem, hairStyle: 'topknot', crown, hairpin, mark: 'crescent', pendant, weapon: 'staff'|'sword'|null, aura})` -> frozen identity (draw every scene from it) ·
`chibi(c, x, y, s, def, state, tau)` feet at (x, y); s = 1 ≈ 400 units tall; always alive (breathing, blinking, look drift, hair / sleeve / tassel / pendant sway) ·
`chibiState(...parts)` merges acting states (dx dy lean squash headTilt wind add up; the rest: last wins) ·
state fields: `dx dy lean squash armL armR (0 = hanging, 1.6 = level, 2.7 = overhead) weapon weaponAngle look lookY headTilt wind aura auraColor castGlow float step expr hands:'together' dir noShadow` ·
`CHIBI_EXPR` / `chibiExpr(a, b, u)`: neutral happy serious angry surprised sad battle shy confident (eyes, brows, mouth, blush, tilt, marks) ·
`CHIBI_ACT`: idle(tau) walk(tau,t0,t1,a,b) run float(tau) dash(tau,t0,t1,a,b) jump(tau,t0,d,h) land(tau,t0) turnHead(tau,t0,from,to) lookAt(fromX,targetX) nod(tau,t0) point(k) wave(tau,t0,d) holdWeapon(k) castSpell(tau,t0,d) attack(tau,t0,d) defend(k) dodge(tau,t0,d,dist) knockback(tau,t0,d,dist) recover(tau,t0,d) hug(k) reactShock(tau,t0) reactCute(tau,t0,d) reactAngry(tau,t0,d) ·
helpers: `chibiFill(c, pts, fill, line, w)` `chibiLine(c, pts, color, w)` `vgradFill(c, y0, y1, a, b)` (clean anime line; `[x, y, 1]` = corner).

## fx.js (layered effects, parallax, shot track)
`fxGlow(c,x,y,r,col,k)` · `fxAura(c,x,y,r,tau,{col,k})` · `fxMagicCircle(c,x,y,r,tau,{col,u,tilt,k})` (tilt .28 = on the ground) · `fxLightning(c,tau,a,b,{col,w,k})` · `fxEnergyTrail(c,points,u,{col,w,k,tail})` · `fxBeam(c,tau,a,b,u,{col,w,k})` · `fxImpact(c,tau,t0,x,y,{col,r,d})` · `fxSparks(c,tau,t0,x,y,{col,n,speed,d})` · `fxSmoke(c,tau,t0,x,y,{col,n,r,d})` · `fxHitFlash(c,tau,t0,{d,col,k})` (screen space) · `fxMotes(c,tau,[x0,y0,x1,y1],{col,n})` · `fxPetals(c,tau,area,{col,n})` · `fxMist(c,tau,y,{col,al})` ·
`parallax(c, cam, depth, draw)` (depth 0 = screen, 1 = world, > 1 = foreground; pass the scene's camera value) ·
`shotTrack([{at, x, y, zoom | shot}], [{at, amp, d}])` -> a camera that eases between shots (push, pan, track) with impact shakes -- no random cuts.
Example: examples/chibi-xianxia (a full 3-scene demo).

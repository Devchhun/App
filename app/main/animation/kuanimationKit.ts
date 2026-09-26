import type { AnimationCaption, AnimationStyle } from '@shared/aiAnimation'
import { secondsToSrtTimestamp } from '@shared/srt'

/** Pure helpers around the bundled Kuanimation kit (resources/kuanimation):
 * everything the AI Animation pipeline writes into a film folder, kept free
 * of Electron/fs so it can be tested. */

/** The runtime scripts film.html loads, in order (film-template.html). */
export const RUNTIME_SCRIPTS = ['kuanimation.js', 'brush.js', 'stage.js', 'cast.js', 'props.js', 'action.js', 'cinema.js', 'fx.js', 'chibi.js', 'director.js']

const MOOD_TABLE: Record<AnimationStyle, string> = { pencil: 'PENCIL_MOODS', wash: 'WASH_MOODS', haze: 'HAZE_MOODS', paper: 'MOODS', marker: 'MOODS' }

/** The backdrop moods a style knows, read from stage.js itself so a newer
 * kit's moods are picked up without touching this code. */
export function stageMoods(stageSource: string, style: AnimationStyle): string[] {
  const table = MOOD_TABLE[style]
  const start = stageSource.search(new RegExp(`\\bconst ${table}\\s*=\\s*\\{`))
  if (start < 0) return ['warm']
  let depth = 0
  let end = start
  for (let i = stageSource.indexOf('{', start); i < stageSource.length; i++) {
    if (stageSource[i] === '{') depth++
    else if (stageSource[i] === '}' && --depth === 0) { end = i; break }
  }
  const body = stageSource.slice(stageSource.indexOf('{', start) + 1, end)
  const moods = [...body.matchAll(/(?:^|[\s,{])([a-z][a-zA-Z]*)\s*:\s*\[/g)].map((m) => m[1])
  return moods.length ? [...new Set(moods)] : ['warm']
}

/** kuanimation.js with one extra page hook: DT.draw(i) draws frame i
 * without the PNG encode DT.frame does, so the app can read the canvas as
 * a JPEG (several times faster to move and to encode). */
export function patchRuntime(runtimeSource: string): string {
  // The bundled kit has DT.draw built in; older copies get it added.
  if (runtimeSource.includes('window.DT.draw = ')) return runtimeSource
  const hook = '  window.DT.frame = i => {'
  if (!runtimeSource.includes(hook)) throw new Error('This Kuanimation runtime is not the version the app knows (DT.frame not found).')
  return runtimeSource.replace(hook, '  window.DT.draw = i => { const name = draw(i); last = -1; return name; };\n' + hook)
}

/** The names the kit's drawing functions actually accept, read from its
 * source. Gemini guessed ones that are not there (arms: 'idle', 'run',
 * 'reach'): pp() then draws a player with no arms, and a prop held in that
 * missing hand crashes the film. */
export interface KitVocabulary {
  arms: string[]
  hats: string[]
  props: string[]
  faceMoods: string[]
  emotes: string[]
  colors: string[]
  /** Exact parameter lists of the drawing helpers Gemini calls most. */
  signatures: string[]
}

function objectKeys(source: string, declaration: string): string[] {
  const start = source.indexOf(declaration)
  if (start < 0) return []
  const end = source.indexOf('\n};', start)
  const body = source.slice(start + declaration.length, end > start ? end : undefined)
  return [...body.matchAll(/^ {2}([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1])
}

/** The helpers whose argument order Gemini has to get right: ell's fifth
 * argument is the number of points, not an angle -- ell(x, y, 8, 12, 0.5)
 * made an empty shape and crashed a real film. */
const SIGNATURE_NAMES = ['xf', 'rectP', 'ell', 'circ', 'rr', 'curve', 'strip', 'sh', 'mk', 'pp', 'face', 'handText', 'txt', 'bubble', 'emote', 'impact', 'dust', 'particleBurst', 'confetti', 'sunBurst', 'glowLight', 'rain', 'snow', 'windLines', 'sparkle', 'arrowT', 'signBoard', 'treeT', 'palmT', 'stiltHouse', 'boatT', 'fireT', 'cloudT', 'travel', 'hop', 'stepPhase', 'followPath', 'spring', 'stagger', 'shake', 'span', 'keys', 'pop', 'rise']

/** `name(params)` exactly as declared in the kit's source (const arrow or
 * function), default values included. */
export function signatureOf(source: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\n)(?:const ${name} = \\(|function ${name}\\()`).exec(source)
  if (!match) return null
  const open = match.index + match[0].length - 1
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')' && --depth === 0) return `${name}${source.slice(open, i + 1).replace(/\s+/g, ' ')}`
  }
  return null
}

export function kitVocabulary(sources: { cast: string; action: string; stage: string; brush?: string; props?: string; runtime?: string; director?: string }): KitVocabulary {
  const armsLine = /const H = \{([^\n]*)\}\[arms\]/.exec(sources.cast)?.[1] ?? ''
  const arms = [...armsLine.matchAll(/(?:^|[\s,])(\w+):\s*\{\s*l:/g)].map((m) => m[1])
  const faceStart = sources.cast.indexOf('function face(')
  const faceBody = faceStart >= 0 ? sources.cast.slice(faceStart, sources.cast.indexOf('\n}', faceStart)) : ''
  const faceMoods = ['happy', ...[...faceBody.matchAll(/mood === '(\w+)'/g)].map((m) => m[1])]
  const emotes = [...sources.action.matchAll(/kind === '([^']+)'/g)].map((m) => m[1])
  const colors = [...sources.stage.matchAll(/^PALETTES\.\w+ = \{([\s\S]*?)\n\};/gm)].flatMap((m) => [...m[1].matchAll(/([A-Za-z]\w*):\s*'#/g)].map((k) => k[1]))
  const unique = (list: string[]): string[] => [...new Set(list)]
  return {
    arms: unique(arms.length ? arms : ['down', 'up', 'hold']),
    hats: unique(objectKeys(sources.cast, 'const HATS = {')),
    props: unique(objectKeys(sources.cast, 'const PROPS = {')),
    faceMoods: unique(faceMoods),
    emotes: unique(emotes),
    colors: unique(colors),
    signatures: SIGNATURE_NAMES.map((name) => [sources.brush, sources.cast, sources.props, sources.action, sources.runtime, sources.director].map((src) => (src ? signatureOf(src, name) : null)).find(Boolean) ?? null).filter((s): s is string => Boolean(s))
  }
}

/** The vocabulary as a prompt section. */
export function vocabularyText(v: KitVocabulary): string {
  return `EXACT VALUES THE KIT ACCEPTS (anything else is silently wrong or crashes):
- pp(...) arms: ${v.arms.map((a) => `'${a}'`).join(', ')}. There is NO 'idle', 'walk', 'run', 'reach', 'wave' or 'dance': for walking pass walk: stepPhase(x) with arms 'down'; to hold a prop use 'hold'; to reach or wave use 'up' or 'point'.
- pp(...) hat: ${v.hats.map((h) => `'${h}'`).join(', ')}.
- PROPS.<name>(c, hand): ${v.props.join(', ')}. These are drawing functions, not props: hand one to a player as prop: {draw: (c, r) => PROPS.spear(c, r)}. Your own prop is {draw(c, handR, handL), behind?}; check the hand is not null before using it.
- face / pp mood: ${v.faceMoods.map((m) => `'${m}'`).join(', ')} (anything else draws plain dot eyes).
- emote kinds: ${v.emotes.map((e) => `'${e}'`).join(', ')}.
- palette T.<color>: ${v.colors.join(', ')}. Any other colour: write it as a '#rrggbb' string.${v.signatures.length ? `\n- EXACT SIGNATURES (argument order and meaning matter; ell/circ take a point COUNT n, not an angle -- rotate shapes with xf(pts, x, y, s, angle)):\n${v.signatures.map((s) => `  ${s}`).join('\n')}` : ''}`
}

const escapeJsString = (text: string): string => JSON.stringify(text)

/** film.html from film-template.html: the chosen look and the film's title
 * on the end card. (Unknown arm poses, bare-function props, empty shapes and
 * Windows' Khmer fonts are handled by the kit itself: cast.js, brush.js.) */
export function buildFilmHtml(template: string, { style, title, khmer, subtitles = true, chapters = 0, xianxia = false }: { style: AnimationStyle; title: string; khmer: boolean; subtitles?: boolean; chapters?: number; xianxia?: boolean }): string {
  // A copy saved with Windows line endings must still match the "\n" below.
  let html = template.replace(/\r\n/g, '\n').replace(/<title>[^<]*<\/title>/, `<title>${title.replace(/[<&>]/g, '')}</title>`)
  html = html.replace(/style:\s*'pencil',/, `style: '${style}',`)
  if (!subtitles) html = html.replace(/frame:\s*'stage',/, `frame: 'stage',\n  subtitles: false,`)
  html = html.replace(/end:\s*endCard\(\[[^\n]*\]\),/, `end: endCard([{text: ${escapeJsString(title)}, size: ${khmer ? 72 : 80}, font: ${khmer ? 'FONT.khmer' : 'undefined'}, color: T.gold}, {text: 'Made with AI Animation', italic: true, size: 30}]),`)
  // Genre props (the kit's xianxia.js).
  if (xianxia) html = html.replace('<script src="action.js"></script>\n', '<script src="action.js"></script>\n<script src="xianxia.js"></script>\n')
  // Chapter films: SCENES starts empty, film-cast.js holds the shared cast
  // and helpers, each chapter file pushes its own scenes.
  if (chapters > 0) {
    const files = ['<script>const SCENES = [];</script>', '<script src="film-cast.js"></script>', ...Array.from({ length: chapters }, (_, i) => `<script src="chapter-${i + 1}.js"></script>`)]
    html = html.replace('<script src="scenes.js"></script>', files.join('\n'))
  }
  return html
}

export interface VoiceLine {
  file: string
  dur: number
  sub: string
  sub2: string
  env: number[]
}

export interface VoiceScene {
  scene: string
  lines: VoiceLine[]
}

/** voice.js exactly as the kit's tts scripts write it. */
export function buildVoiceJs(scenes: VoiceScene[]): string {
  return `'use strict';\n// Written by Creative AI Editor (Edge TTS): narrator lines, durations (s), 24 fps loudness envelopes.\nconst VOICE = ${JSON.stringify(scenes)};\n`
}

/** Loudness per 1000 samples of 24 kHz mono PCM (= one value per frame at
 * 24 fps), as tts_edge.py computes it; the director uses it for lip-sync. */
export function loudnessEnvelope(samples: Int16Array): number[] {
  const out: number[] = []
  for (let k = 0; k + 1000 <= samples.length; k += 1000) {
    let sum = 0
    for (let i = k; i < k + 1000; i++) sum += samples[i] * samples[i]
    out.push(Math.round((Math.sqrt(sum / 1000) / 32768) * 1000) / 1000)
  }
  return out
}

/** The JavaScript Gemini wrote, without Markdown fences or chatter. */
export function extractCode(text: string): string {
  const fenced = [...text.matchAll(/```(?:javascript|js)?\s*\n([\s\S]*?)```/g)].map((m) => m[1])
  const code = fenced.length ? fenced.sort((a, b) => b.length - a.length)[0] : text
  return code.trim() + '\n'
}

/** Scene names become file names and JS keys: lowercase, dashes, unique. */
export function sceneSlugs(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((name, index) => {
    let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || `scene-${index + 1}`
    const base = slug
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`
    used.add(slug)
    return slug
  })
}

/** The lines of a film file a stack trace points at, so a repair request
 * shows Gemini the failing code itself, not only a line number. */
export function failingLines(code: string, stack: string, fileName = 'scenes.js'): string {
  const lines = code.split('\n')
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const hits = [...new Set([...stack.matchAll(new RegExp(`${escaped}:(\\d+):\\d+`, 'g'))].map((m) => Number(m[1])))].slice(0, 3)
  if (hits.length === 0) return ''
  return `\n\nThe failing code (${fileName}):\n` + hits.map((line) => {
    const from = Math.max(1, line - 3)
    const to = Math.min(lines.length, line + 3)
    return lines.slice(from - 1, to).map((text, i) => `${from + i === line ? '>>' : '  '} ${from + i}: ${text}`).join('\n')
  }).join('\n...\n')
}

/** The narrator's lines as captions, in film time: each voice cue the
 * director placed (DT.cues: clip file + start) matched to its line. */
export function captionsFromCues(cues: Array<{ file: string; t: number }>, voice: VoiceScene[]): AnimationCaption[] {
  const byFile = new Map(voice.flatMap((scene) => scene.lines.map((line) => [line.file, line] as const)))
  return cues.flatMap((cue) => {
    const line = byFile.get(cue.file)
    if (!line || !line.sub.trim()) return []
    // Edge TTS clips open with ~0.25 s of silence (measured on a real film):
    // start and end on the speech itself, found in the loudness envelope
    // (one value per 1/24 s).
    const peak = Math.max(0, ...line.env)
    const voiced = line.env.map((level) => peak > 0 && level >= peak * 0.08)
    const first = voiced.indexOf(true)
    const last = voiced.lastIndexOf(true)
    const onset = first > 0 ? first / 24 : 0
    const offset = last >= 0 ? Math.min(line.dur, (last + 1) / 24 + 0.1) : line.dur
    return [{ startTime: +(cue.t + onset).toFixed(3), endTime: +(cue.t + Math.max(offset, onset + 0.3)).toFixed(3), text: line.sub.trim(), text2: line.sub2.trim() }]
  }).sort((a, b) => a.startTime - b.startTime)
}

/** An SRT of the captions' own text, or of their translation. */
export function captionsToSrt(captions: AnimationCaption[], which: 'text' | 'text2' = 'text'): string {
  const rows = captions.filter((caption) => caption[which])
  return rows.map((caption, i) => `${i + 1}\n${secondsToSrtTimestamp(caption.startTime)} --> ${secondsToSrtTimestamp(caption.endTime)}\n${caption[which]}`).join('\n\n') + (rows.length ? '\n' : '')
}

/** Which of the film's own files an error comes from (the first one in the
 * stack): a chapter, or the shared cast file. null = the kit itself. */
export function failingFile(stack: string): string | null {
  return /\b((?:chapter-\d+|film-cast|scenes)\.js):\d+/.exec(stack)?.[1] ?? null
}

/** Consecutive scenes grouped into chapters of about `target` seconds (at
 * most `maxScenes` each): small enough for one Gemini answer to animate
 * well, big enough to keep a story beat together. */
export function groupChapters(sceneSeconds: number[], target = 150, maxScenes = 8): number[][] {
  const chapters: number[][] = []
  let current: number[] = []
  let total = 0
  sceneSeconds.forEach((seconds, index) => {
    if (current.length && (total + seconds > target * 1.15 || current.length >= maxScenes)) {
      chapters.push(current)
      current = []
      total = 0
    }
    current.push(index)
    total += seconds
  })
  if (current.length) chapters.push(current)
  // A last chapter far shorter than the rest joins the one before it.
  if (chapters.length > 1) {
    const last = chapters[chapters.length - 1].reduce((n, i) => n + sceneSeconds[i], 0)
    const before = chapters[chapters.length - 2]
    if (last < target * .35 && before.length + chapters[chapters.length - 1].length <= maxScenes + 2) chapters.splice(-2, 2, [...before, ...chapters[chapters.length - 1]])
  }
  return chapters
}

/** How a scene lasts in the director's timing (director.js): pre, each line
 * plus a 0.55 s gap, post. */
export function sceneSeconds(lineSeconds: number[], pre = 1.2, post = 1.5): number {
  return pre + lineSeconds.reduce((n, d) => n + d + 0.55, 0) - (lineSeconds.length ? 0.55 : 0) + post
}

const comparable = (text: string): string => text.normalize('NFC').replace(/[\s\p{P}\p{S}\u200b\u200c\u200d]/gu, '')

/** How faithfully the planned lines keep the user's own script: the share
 * of script text they cover, and the share of lines found word for word in
 * the script. Gemini must split the script, never rewrite it. */
export function scriptCoverage(script: string, lines: string[]): { lengthRatio: number; linesFound: number } {
  const whole = comparable(script)
  const joined = comparable(lines.join(''))
  const found = lines.filter((line) => { const bit = comparable(line); return bit.length === 0 || whole.includes(bit) }).length
  return { lengthRatio: whole.length ? joined.length / whole.length : 0, linesFound: lines.length ? found / lines.length : 0 }
}

/** The xianxia prop library's function signatures and hats, for prompts. */
export function xianxiaVocabulary(source: string): string {
  const names = [...source.matchAll(/^function (xx\w+)\(/gm)].map((m) => m[1])
  const hats = [...source.matchAll(/^HATS\.(\w+) =/gm)].map((m) => m[1])
  const docs = names.map((name) => {
    const at = source.indexOf(`function ${name}(`)
    const before = source.slice(Math.max(0, at - 220), at)
    const doc = /\/\*\*([\s\S]*?)\*\/\s*$/.exec(before)?.[1].replace(/\s*\*\s*/g, ' ').trim()
    return `  ${signatureOf(source, name)}${doc ? `  -- ${doc}` : ''}`
  })
  return `XIANXIA KIT (loaded; all of it drawn with sh/mk so it takes the film's look):\n${docs.join('\n')}\n  new hats for pp/xxCultivator: ${hats.map((h) => `'${h}'`).join(', ')}`
}

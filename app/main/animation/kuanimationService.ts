import { app, BrowserWindow, session } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises'
import { join, relative, resolve } from 'path'
import { pathToFileURL } from 'url'
import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import type { AnimationProgress, AnimationRequest, AnimationResult, AnimationStyle } from '@shared/aiAnimation'
import { ANIMATION_VOICES } from '@shared/aiAnimation'
import { getGeminiApiKey } from '../ai/geminiApiKeyStore'
import { explainGeminiError, isRetryableError, sleepUnlessCanceled } from '../ai/geminiErrors'
import { isModelUnavailableError } from '../ai/storyRecapService'
import { ffmpegPath } from '../media/ffmpeg'
import { runEdgeTtsLine, EdgeTtsCanceledError } from '../media/edgeTts'
import { CanceledError } from '../media/jobRunner'
import { RUNTIME_SCRIPTS, buildFilmHtml, buildVoiceJs, captionsFromCues, captionsToSrt, extractCode, failingFile, failingLines, groupChapters, sceneSeconds, scriptCoverage, xianxiaVocabulary, kitVocabulary, loudnessEnvelope, patchRuntime, sceneSlugs, stageMoods, vocabularyText, type VoiceScene } from './kuanimationKit'
import { runInBackground } from '../media/processPriority'

/** AI Animation: a topic -> a narrated Kuanimation film (MP4).
 *
 *   1. writing   Gemini plans the scenes and writes the voice-over lines
 *   2. voicing   Edge TTS speaks each line (the app's bundled Python)
 *   3. staging   Gemini writes scenes.js -- the drawing and acting, timed to
 *                the measured voice lines
 *   4. checking  a hidden window runs the film; a script error goes back to
 *                Gemini to fix (a few rounds)
 *   5. rendering every frame is drawn and piped to ffmpeg
 *   6. mixing    the voice clips are placed at their cues and loudness-
 *                normalised, then muxed with the picture
 *
 * The code Gemini writes only ever runs in that hidden window: sandboxed,
 * no Node, no preload, every network request blocked. */

type Progress = (progress: AnimationProgress) => void

const WRITER_MODEL = process.env.GEMINI_ANIMATION_MODEL?.trim() || 'gemini-3.1-pro-preview'
const FALLBACK_MODEL = 'gemini-2.5-flash'
const MAX_NETWORK_ATTEMPTS = 4
/** Waits between retries: Gemini's "high demand" 503s last tens of seconds. */
const RETRY_WAIT_MS = [5000, 15000, 30000]
const MAX_REPAIRS = 3
/** How many times the AI director may send the film back. */
const DIRECTOR_ROUNDS = 2
const FPS = 24
const FRAMES_PER_CALL = 6
const TTS_PARALLEL = 3

const active = new Map<string, AbortController>()

export function kitDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'kuanimation') : join(__dirname, '../../resources/kuanimation')
}

export function animationsDir(): string {
  return join(app.getPath('userData'), 'animations')
}

export function cancelAnimation(jobId: string): boolean {
  const controller = active.get(jobId)
  if (!controller) return false
  controller.abort()
  return true
}

const throwIfCanceled = (signal: AbortSignal): void => {
  if (signal.aborted) throw new CanceledError()
}

// ---------- Gemini ----------

async function ask(ai: GoogleGenAI, state: { model: string }, prompt: string, signal: AbortSignal, schema?: object, images: string[] = []): Promise<string> {
  const imageParts = images.map((url) => ({ inlineData: { mimeType: url.slice(5, url.indexOf(';')), data: url.slice(url.indexOf(',') + 1) } }))
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: state.model,
        contents: [{ role: 'user', parts: [{ text: prompt }, ...imageParts] }],
        config: {
          temperature: 0.7,
          maxOutputTokens: 65536,
          thinkingConfig: /^gemini-3/i.test(state.model) ? { thinkingLevel: ThinkingLevel.HIGH } : { thinkingBudget: 8192 },
          ...(schema ? { responseMimeType: 'application/json', responseJsonSchema: schema } : {}),
          abortSignal: signal
        }
      })
      const text = response.text || ''
      if (!text.trim()) throw new Error(`Gemini returned nothing (${String(response.candidates?.[0]?.finishReason ?? 'no reason')}).`)
      return text
    } catch (error) {
      if (signal.aborted) throw new CanceledError()
      lastError = error
      // A key that cannot use the stronger model keeps going on the fallback.
      if (state.model !== FALLBACK_MODEL && isModelUnavailableError(error)) {
        state.model = FALLBACK_MODEL
        attempt = 0
        continue
      }
      // Still busy after the retries (measured: 3.1 Pro answering 503 "high
      // demand" three times running): finish the job on the fallback model.
      if (attempt >= MAX_NETWORK_ATTEMPTS && state.model !== FALLBACK_MODEL && isRetryableError(error)) {
        state.model = FALLBACK_MODEL
        attempt = 0
        continue
      }
      if (attempt >= MAX_NETWORK_ATTEMPTS || !isRetryableError(error)) break
      await sleepUnlessCanceled(RETRY_WAIT_MS[Math.min(attempt, RETRY_WAIT_MS.length) - 1], signal)
    }
  }
  throw new Error(explainGeminiError(lastError))
}

interface PlannedLine { spoken: string; subtitle: string; translation: string }
interface PlannedScene { name: string; mood: string; action: string; lines: PlannedLine[] }
interface PlannedCharacter { name: string; look: string }
interface FilmPlan { title: string; characters: PlannedCharacter[]; scenes: PlannedScene[] }

function planSchema(moods: string[]): object {
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      characters: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string' }, look: { type: 'string' } }, required: ['name', 'look'] }
      },
      scenes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            mood: { type: 'string', enum: moods },
            action: { type: 'string' },
            lines: {
              type: 'array',
              items: {
                type: 'object',
                properties: { spoken: { type: 'string' }, subtitle: { type: 'string' }, translation: { type: 'string' } },
                required: ['spoken', 'subtitle', 'translation']
              }
            }
          },
          required: ['name', 'mood', 'action', 'lines']
        }
      }
    },
    required: ['title', 'characters', 'scenes']
  }
}

const XIANXIA_STORY = `GENRE: XIANXIA (仙侠) -- ancient China, immortal cultivation: sects on misty mountains, masters and disciples in long robes, cultivation realms and breakthroughs, qi, flying swords, spirit beasts, pills and talismans, arrogant young masters, rivalries, revenge. Tell it like a Khmer donghua recap narrator: dramatic, clear about who is who, who is stronger, who wrongs whom and what it costs.`

function planPrompt(request: AnimationRequest, moods: string[], kit: KitText): string {
  const khmer = languageOf(request.voice) === 'km'
  const script = request.script?.trim()
  const lines = Math.max(6, Math.round(request.minutes * 10))
  const language = khmer
    ? 'Khmer. Every spoken line and subtitle in Khmer script. Put an English translation of each line in "translation".'
    : 'English. Leave "translation" empty.'
  const source = script
    ? `THE NARRATOR'S OWN SCRIPT (the voice-over of this film):
<<<SCRIPT
${script}
SCRIPT>>>

THE LINES ARE THE SCRIPT (most important rule): every "spoken" line is the script's own words, in order, every sentence -- nothing added, dropped, reworded, summarised or translated. Only cut the script into lines at sentence ends or natural pauses: one sentence per line, at most about 130 characters. "subtitle" is the same text as "spoken". Group consecutive lines into scenes of 2-6 lines, starting a new scene where the place, time or action changes.`
    : `THE USER'S BRIEF (it may be in any language):
${request.brief.trim()}

LENGTH: about ${request.minutes} minute${request.minutes === 1 ? '' : 's'}: about ${lines} lines in ${Math.max(3, Math.round(lines / 3.5))} scenes, 2-5 lines per scene.`
  return `You plan animated films made with the Kuanimation kit: cartoon players act the story out on a drawn stage while an unseen narrator speaks the lines and subtitles show them.

${source}

VOICE-OVER LANGUAGE: ${language}
LOOK: ${request.style}. Backdrop moods you may use: ${moods.join(', ')}.
${request.genre === 'xianxia' ? `${XIANXIA_STORY}\n` : ''}
For each scene:
- name: a short English slug (intro, journey, duel...).
- mood: one of the moods above.
- action: in English, for the animator, what happens on stage during EACH line, numbered ("line 1: ...; line 2: ..."): who enters, what they do, how others react (bubbles, emotes, cheering, fleeing), which props, places or effects appear. Only what a 2D cartoon can draw.
- lines: spoken = what the narrator says; subtitle = the same text as shown on screen${script ? '' : ' (digits allowed)'}; translation as above.
Also give the film a short title in the voice-over language, and list its characters once for the whole film: name, and look = in English, a fixed description the animator will draw the same way in every scene (age and size, skin, clothes and their colours as #rrggbb, hair or headwear, one distinctive detail${request.genre === 'xianxia' ? ', robe colour and sect' : ''}).
${script ? '' : '\nMake it lively: every scene has something moving and a feeling (joy, fear, surprise, triumph); a clear turning point in the middle; a strong ending.\n'}
The kit's own guide for the lines:
${kit.narration}

${kit.action}`
}

function genreDirection(request: AnimationRequest, kit: KitText): string {
  if (request.genre !== 'xianxia') return ''
  return `
${kit.xianxia}
XIANXIA DIRECTION:
- People: cultivators and disciples in long robes with xxCultivator (hat 'topknot' by default; masters 'crown' or 'guan'; women 'bun', 'veil' or 'longhair'; villains in dark robes such as #2b2b3a). Use pp only for villagers and servants.
- World in layers: distant xxPeak mountains and xxCloudSea bands behind, sect buildings (xxPavilion, xxPagoda, xxGate with a short Chinese sect name) in the middle, xxPine, xxLotus, xxLantern in front. Night scenes lit by xxLantern and qi glow.
- Power: xxAura while cultivating or angry; techniques with xxSlash (sword qi), xxSword (flying sword, moved along followPath), particleBurst and glowLight for spells, xxBreakthrough for a breakthrough, xxTalisman for charms, shake() on every clash.
- Motion: fliers use flying: true and glide on followPath curves; a fight is approach, clash (impact + shake + whoosh/thud), recoil, reaction.
- Sound: whoosh for flight and slashes, thunder for breakthroughs and anger, bell for sects, magic for techniques.`
}

/** What makes a Kuanimation film lively -- the gaps a first real film had:
 * players an eighth of the frame tall (the kit's own examples use s≈.85),
 * empty stages, a still camera, no reactions, no sound. */
function directionText(request: AnimationRequest, { opening }: { opening: boolean }): string {
  const khmer = languageOf(request.voice) === 'km'
  return `DIRECTION (follow all of it; this is what makes the film lively):
- SIZE: main characters pp scale s = 1.25-1.5 (a quarter of the frame tall); others at least 1.0; only far-away background people smaller. The kit's examples use about 0.85 -- that is too small here.
- FILL THE FRAME: every scene has scenery in front and behind so the stage never looks empty; the key action sits in the centre third; nobody is cut off by the frame edge unless walking in or out.
- CAMERA: every scene gets a camera (tau, S) => {x, y, zoom}. The default framing leaves the lower 40% of the picture as empty ground, so FRAME THE PEOPLE: zoom 1.2-1.45 with y about 560-640 and x on the action, a slow push toward the key action, a closer zoom (up to 1.6) on the emotional lines, follow a walker, ...shake(tau, t, amp, d) on impacts. Check that everyone who matters stays inside the zoomed view (visible width = 1920 / zoom).
- ACTING: every line has one clear event AND a reaction: the right face mood, an emote or a speech/thought bubble, a gesture (arms). Nobody stands frozen: walk with walk: stepPhase(x), bounce with joy, lean in fear, turn toward who speaks.
- EFFECTS: weather and magic when the story has them: rain, snow, windLines, particleBurst, confetti, glowLight, sparkle, sunBurst, dust, impact. Draw big effects BEHIND the characters or beside them -- never over a face.
${opening ? `- OPENING: the first scene sets pre: 3.2 and writes the film title on during its first 2.5 s over the establishing shot (${request.style === 'pencil' ? 'handText' : 'txt with reveal'}${khmer ? ', font FONT.khmer' : ''}), then it fades as the story starts. Draw the title in SCREEN space so the camera zoom cannot crop it: c.save(); resetT(c); ...draw at x 960, y 150-260...; c.restore().\n` : ''}- SOUND: every scene lists its audible events as sfx: [[lineIndex, secondsAfterLineStart, kind], ...], 2-5 per scene, kinds: pop thud whoosh chime sparkle drip splash thunder bird cheer magic step knock bell. The app plays them with mood music.`
}

function sceneTable(plan: FilmPlan, voice: VoiceScene[], indices: number[]): string {
  return indices.map((index) => {
    const scene = plan.scenes[index]
    const v = voice[index]
    let t = 1.2
    const rows = v.lines.map((line, i) => {
      const row = `    line ${i}: starts ≈${t.toFixed(1)} s, lasts ${line.dur.toFixed(1)} s — "${line.sub2 || line.sub}"`
      t += line.dur + 0.55
      return row
    })
    return `  scene "${v.scene}" · mood "${scene.mood}" · ≈${(t - 0.55 + 1.5).toFixed(1)} s\n    action: ${scene.action}\n${rows.join('\n')}`
  }).join('\n')
}

function castPrompt(request: AnimationRequest, plan: FilmPlan, kit: KitText): string {
  return `You are the lead animator of the Kuanimation film "${plan.title}". It will be animated chapter by chapter; first write film-cast.js, the code every chapter shares.

OUTPUT: only JavaScript in one \`\`\`js block, a classic script (no import/export, no Math.random, no DOM, no network) containing exactly:
1. const CAST = { <id>: {...options}, ... } -- one entry per character below; ids short lowercase latin (dara, master_lin). The options are what ${request.genre === 'xianxia' ? 'xxCultivator (cultivators) or pp (ordinary people)' : 'pp'} takes: body, skin, hat, robe, skirt... with exactly the colours of each look. Chapters draw a person as ${request.genre === 'xianxia' ? 'xxCultivator(c, x, y, s, {...CAST.lin, tau, mood: ...})' : 'pp(c, x, y, s, {...CAST.dara, mood: ...})'}.
2. Drawing helpers this story needs again and again (a special tree, the family house, a weapon, a creature, a vehicle), each a function named own<Name>(c, x, y, s, ...) drawn only with sh()/mk() and the kit's helpers.
Nothing else: no SCENES, no scene code, no drawing at load time. Never declare a name the kit already has (everything in the API, and fx*, chibi*, CHIBI_*, parallax, shotTrack) -- a second const of the same name stops the whole film.

CHARACTERS:
${plan.characters.length ? plan.characters.map((c) => `- ${c.name}: ${c.look}`).join('\n') : '- (derive them from the scenes)'}

THE STORY (scene by scene):
${plan.scenes.map((s) => `- ${s.name} (${s.mood}): ${s.action.slice(0, 300)}`).join('\n')}
${genreDirection(request, kit)}

${kit.vocabulary}

API:
${kit.api}

STYLE GUIDE:
${kit.style}`
}

function chapterPrompt(request: AnimationRequest, plan: FilmPlan, voice: VoiceScene[], kit: KitText, chapter: { index: number; count: number; scenes: number[] }, castCode: string, previous: string | null): string {
  const example = request.style === 'pencil' ? kit.examplePencil : kit.exampleWash
  const file = `chapter-${chapter.index + 1}.js`
  return `You animate chapter ${chapter.index + 1} of ${chapter.count} of the Kuanimation film "${plan.title}". Write ${file}.

OUTPUT: only JavaScript in one \`\`\`js block, a classic script (no import/export, no Math.random, no DOM, no network) of exactly this shape:
(() => {
  // helpers used only in this chapter (plain functions, drawn with sh/mk)
  SCENES.push(
    { name: '...', mood: '...', holds: {...}, camera: (tau, S) => ({...}), sfx: [...], set(c, tau, S) { ... } },
    ...
  );
})();
Loaded before your file: ${RUNTIME_SCRIPTS.join(', ')}${request.genre === 'xianxia' ? ', xianxia.js' : ''}, voice.js (VOICE), film-cast.js (below)${chapter.index > 0 ? `, and chapters 1-${chapter.index}, which already pushed their scenes` : ''}. film.html then calls buildPlay(SCENES, {narrator: null, style: '${request.style}', frame: 'stage'}).
Push exactly the scenes below, in this order, with exactly these names and moods. Draw every person from CAST (spread it, then add mood/arms/walk) so everyone looks the same all film; use the own* helpers from film-cast.js; never redefine CAST, an own* helper or any name the kit already defines (everything in the API, and fx*, chibi*, CHIBI_*, parallax, shotTrack). Time everything to S.beats(i) (the start of voice line i) -- never to fixed seconds -- and add holds where an action needs room. Draw every shape with sh() and every line with mk(). Use only functions and properties that exist in the API below.

${directionText(request, { opening: chapter.index === 0 })}
${genreDirection(request, kit)}

THIS CHAPTER'S SCENES:
${sceneTable(plan, voice, chapter.scenes)}
${previous ? `\nCONTINUITY: the chapter before ends with the code below; keep the same places, positions and looks where the story continues.\n\`\`\`js\n${previous.slice(-6000)}\n\`\`\`\n` : ''}
film-cast.js (already loaded):
\`\`\`js
${castCode}
\`\`\`

THE KIT'S RULES:
${kit.rules}

${kit.vocabulary}

API:
${kit.api}

ACTION GUIDE:
${kit.action}

STYLE GUIDE:
${kit.style}

A COMPLETE EXAMPLE of scene code (for structure and patterns; its film differs, and it defines SCENES itself where you push):
\`\`\`js
${example}
\`\`\``
}

function directorPrompt(request: AnimationRequest, plan: FilmPlan, fileName: string, code: string, castCode: string, kit: KitText, opening: boolean): string {
  return `You are the director of the animated film "${plan.title}". The attached image is a contact sheet of 16 frames from the part of the film drawn by ${fileName} (time and scene name under each). The film uses the Kuanimation kit; film-cast.js (shared people and helpers) is below.

Judge it like a picky director, frame by frame, against this direction:
${directionText(request, { opening })}
${genreDirection(request, kit)}

Common faults to look for: characters too small to read; people cut off or overlapping; an empty or plain stage; the same frozen pose across frames; nothing happening while a line is spoken; the story not readable with the sound off;${opening ? ' the title missing at the start or cut off by the camera zoom;' : ''} subtitles covered (keep the bottom 180 px clear); the same person looking different between scenes.

If it already meets the direction well, reply with exactly NO_CHANGES and nothing else.
Otherwise return the whole improved ${fileName} in one \`\`\`js block, in the same shape: keep the same scenes, names, moods and voice timing (S.beats), fix every fault you see, and keep it correct -- only functions, properties and values that exist in the kit and film-cast.js.

${kit.vocabulary}

API:
${kit.api}

film-cast.js:
\`\`\`js
${castCode}
\`\`\`

${fileName} now:
\`\`\`js
${code}
\`\`\``
}

function repairPrompt(fileName: string, code: string, failure: string, kit: KitText, castCode: string | null): string {
  return `The Kuanimation film file ${fileName} fails when the film is drawn:

${failure}

Fix the cause, not just the symptom, and return the whole corrected ${fileName} in one \`\`\`js block, in the same shape (same scenes, names and timing). Check every other place in the file that could fail the same way.

${kit.vocabulary}
${kit.xianxia ? `\n${kit.xianxia}\n` : ''}
Use only functions and properties that exist in this API:
${kit.api}
${castCode && fileName !== 'film-cast.js' ? `\nfilm-cast.js (loaded before it; do not redefine it):\n\`\`\`js\n${castCode}\n\`\`\`\n` : ''}
The failing file:
\`\`\`js
${code}
\`\`\``
}

// ---------- kit text for the prompts ----------

interface KitText { narration: string; action: string; style: string; api: string; rules: string; examplePencil: string; exampleWash: string; vocabulary: string; arms: string[]; xianxia: string }

async function readKitText(dir: string): Promise<KitText> {
  const read = (path: string): Promise<string> => readFile(join(dir, path), 'utf8')
  const skill = await read('SKILL.md')
  const vocabulary = kitVocabulary({ cast: await read('assets/cast.js'), action: await read('assets/action.js'), stage: await read('assets/stage.js'), brush: await read('assets/brush.js'), props: await read('assets/props.js'), runtime: await read('assets/kuanimation.js'), director: await read('assets/director.js') })
  const rulesStart = skill.indexOf('## Rules that keep it good')
  const rulesEnd = skill.indexOf('## Files', rulesStart)
  return {
    narration: await read('references/narration.md'),
    action: await read('references/action.md'),
    style: await read('references/style.md'),
    // The generated "Exact values" part of api.md is sent live (kit.vocabulary).
    api: (await read('references/api.md')).split('\n## Exact values and signatures')[0],
    rules: rulesStart >= 0 ? skill.slice(rulesStart, rulesEnd > 0 ? rulesEnd : undefined) : '',
    examplePencil: await read('examples/sunflower/scenes.js'),
    exampleWash: await read('examples/angkor/scenes.js'),
    vocabulary: vocabularyText(vocabulary),
    arms: vocabulary.arms,
    xianxia: xianxiaVocabulary(await read('assets/xianxia.js'))
  }
}

function languageOf(voice: string): 'km' | 'en' {
  return ANIMATION_VOICES.find((v) => v.id === voice)?.language ?? (voice.startsWith('km-') ? 'km' : 'en')
}

function parsePlan(text: string, moods: string[]): FilmPlan {
  const raw = JSON.parse(text) as FilmPlan
  const scenes = (raw.scenes ?? [])
    .map((scene) => ({
      name: String(scene.name ?? ''),
      mood: moods.includes(scene.mood) ? scene.mood : moods[0],
      action: String(scene.action ?? ''),
      lines: (scene.lines ?? []).filter((line) => /[\p{L}\p{N}]/u.test(line?.spoken ?? '')).map((line) => ({ spoken: line.spoken.trim(), subtitle: (line.subtitle || line.spoken).trim(), translation: (line.translation ?? '').trim() }))
    }))
    .filter((scene) => scene.lines.length > 0)
  if (scenes.length === 0) throw new Error('Gemini did not write any scenes for this film. Try again, or describe the topic in a little more detail.')
  const names = sceneSlugs(scenes.map((scene) => scene.name))
  const characters = (raw.characters ?? []).filter((c) => c && String(c.name ?? '').trim()).map((c) => ({ name: String(c.name).trim(), look: String(c.look ?? '').trim() }))
  return { title: String(raw.title ?? '').trim() || 'Animated film', characters, scenes: scenes.map((scene, i) => ({ ...scene, name: names[i] })) }
}

// ---------- voice ----------

function decodePcm(file: string, signal: AbortSignal): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-v', 'error', '-i', file, '-ac', '1', '-ar', '24000', '-f', 's16le', '-'])
    const chunks: Buffer[] = []
    const onAbort = (): void => { proc.kill() }
    signal.addEventListener('abort', onAbort, { once: true })
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.on('error', reject)
    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) return reject(new CanceledError())
      if (code !== 0) return reject(new Error(`Could not read the voice clip ${file}.`))
      const buffer = Buffer.concat(chunks)
      resolve(new Int16Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + (buffer.length & ~1))))
    })
  })
}

async function voiceFilm(folder: string, plan: FilmPlan, voice: string, signal: AbortSignal, onLine: (done: number, total: number) => void): Promise<VoiceScene[]> {
  await mkdir(join(folder, 'audio'), { recursive: true })
  const jobs = plan.scenes.flatMap((scene) => scene.lines.map((line, i) => ({ scene, line, i })))
  const results = new Map<string, { dur: number; env: number[] }>()
  let next = 0
  let done = 0
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next++]
      const file = `audio/${job.scene.name}-${job.i}.mp3`
      const path = join(folder, file)
      try {
        if (!existsSync(path)) await runEdgeTtsLine('', voice, job.line.spoken, path, signal)
      } catch (error) {
        if (error instanceof EdgeTtsCanceledError || signal.aborted) throw new CanceledError()
        throw error
      }
      const pcm = await decodePcm(path, signal)
      results.set(file, { dur: Math.round((pcm.length / 24000) * 1000) / 1000, env: loudnessEnvelope(pcm) })
      onLine(++done, jobs.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(TTS_PARALLEL, jobs.length) }, worker))
  return plan.scenes.map((scene) => ({
    scene: scene.name,
    lines: scene.lines.map((line, i) => {
      const file = `audio/${scene.name}-${i}.mp3`
      const measured = results.get(file)!
      return { file, dur: measured.dur, sub: line.subtitle, sub2: line.translation, env: measured.env }
    })
  }))
}

// ---------- the hidden film window ----------

const FILM_PARTITION = 'ai-animation-film'
let partitionReady = false

function filmSession(): Electron.Session {
  const filmSess = session.fromPartition(FILM_PARTITION)
  if (!partitionReady) {
    // The film is local files only; nothing it runs may reach the network.
    filmSess.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }))
    filmSess.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    partitionReady = true
  }
  return filmSess
}

interface FilmPage {
  win: BrowserWindow
  errors: string[]
  run<T>(code: string): Promise<T>
  close(): void
}

async function openFilm(folder: string, width: number, signal: AbortSignal): Promise<FilmPage> {
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    webPreferences: { session: filmSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false }
  })
  const errors: string[] = []
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !/Failed to load resource/.test(message)) errors.push(message)
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  const page: FilmPage = {
    win,
    errors,
    run: <T,>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>,
    close: () => { if (!win.isDestroyed()) win.destroy() }
  }
  const url = pathToFileURL(join(folder, 'film.html'))
  url.searchParams.set('bare', '1')
  url.searchParams.set('w', String(width))
  try {
    await win.loadURL(url.href)
    for (const started = Date.now(); ;) {
      throwIfCanceled(signal)
      const state = await page.run<{ ready: boolean; error: string | null }>('({ ready: !!(window.DT && window.DT.ready === true), error: window.DT && window.DT.error ? String(window.DT.error) : null })')
      if (state.error) throw new FilmScriptError(state.error)
      if (errors.length) throw new FilmScriptError(errors.join('\n'))
      if (state.ready) break
      if (Date.now() - started > 60_000) throw new FilmScriptError('The film page did not get ready within 60 s.')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return page
  } catch (error) {
    page.close()
    throw error
  }
}

class FilmScriptError extends Error {}

/** Draws a spread of frames (four a second) of the given scenes (a
 * chapter; all when null) and reports the first failure, with the scene and
 * time it happened in. */
async function checkFilm(folder: string, signal: AbortSignal, scenes: string[] | null = null): Promise<{ frames: number; preview: string; sheet: string }> {
  const page = await openFilm(folder, 640, signal)
  try {
    const range = `(() => {
      const names = ${JSON.stringify(scenes)};
      if (!names) return [0, DT.frames];
      let acc = 0, a = null, b = 0;
      for (const p of PLAY) { if (names.includes(p.name)) { if (a === null) a = acc; b = acc + p.dur; } acc += p.dur; }
      return a === null ? [0, 0] : [Math.round(a * DT.fps), Math.min(DT.frames, Math.round(b * DT.fps))];
    })()`
    const result = await page.run<{ error?: string; frames: number }>(`(() => {
      Error.stackTraceLimit = 50;
      const [from, to] = ${range};
      for (let i = from; i < to; i += 6) {
        try { DT.draw(i); } catch (e) { return { frames: DT.frames, error: 'frame ' + i + ' (' + (i / DT.fps).toFixed(1) + ' s into the film): ' + (e && e.stack ? e.stack : String(e)) }; }
      }
      return { frames: to - from };
    })()`)
    if (result.error) throw new FilmScriptError(result.error)
    if (page.errors.length) throw new FilmScriptError(page.errors.join('\n'))
    if (!(result.frames > 0)) throw new FilmScriptError('The film has no frames.')
    const preview = await page.run<string>('DT.grid(12)')
    // 16 frames spread over the film, big enough for the director to judge
    // sizes and staging, each labelled with its time and scene.
    const sheet = await page.run<string>(`(() => {
      const cols = 4, n = 16, cw = 400, ch = 225, src = document.getElementById('c'), [from, to] = ${range};
      const out = document.createElement('canvas'); out.width = cols * cw; out.height = Math.ceil(n / cols) * (ch + 22);
      const g = out.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, out.width, out.height); g.font = '15px sans-serif';
      for (let k = 0; k < n; k++) {
        const i = Math.min(to - 1, from + Math.round((k + .5) * (to - from) / n)); const name = DT.draw(i);
        const x = (k % cols) * cw, y = Math.floor(k / cols) * (ch + 22);
        g.drawImage(src, x, y, cw, ch); g.fillStyle = '#fff'; g.fillText('#' + (k + 1) + '  ' + (i / DT.fps).toFixed(1) + ' s  ' + name, x + 4, y + ch + 16);
      }
      return out.toDataURL('image/jpeg', .85);
    })()`)
    return { frames: result.frames, preview, sheet }
  } finally {
    page.close()
  }
}

async function renderVideo(folder: string, width: number, outPath: string, signal: AbortSignal, onFrame: (done: number, total: number) => void): Promise<{ frames: number; cues: Array<{ file: string; t: number }>; duration: number; hasScore: boolean; scoreRate: number }> {
  const page = await openFilm(folder, width, signal)
  let proc: ChildProcessWithoutNullStreams | null = null
  try {
    const meta = await page.run<{ frames: number; cues: Array<{ file: string; t: number }>; duration: number }>('({ frames: DT.frames, cues: DT.cues || [], duration: DT.dur })')
    const ffmpeg = runInBackground(spawn(ffmpegPath, ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '18', '-movflags', '+faststart', outPath]))
    proc = ffmpeg
    let stderr = ''
    ffmpeg.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const finished = new Promise<void>((resolve, reject) => {
      ffmpeg.on('error', reject)
      ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(signal.aborted ? 'Canceled' : `ffmpeg could not encode the film: ${stderr.trim().slice(-400)}`))))
    })
    const write = (buffer: Buffer): Promise<void> => new Promise((resolve, reject) => {
      if (ffmpeg.stdin.write(buffer)) resolve()
      else ffmpeg.stdin.once('drain', resolve)
      ffmpeg.stdin.once('error', reject)
    })
    for (let a = 0; a < meta.frames; a += FRAMES_PER_CALL) {
      throwIfCanceled(signal)
      const b = Math.min(meta.frames, a + FRAMES_PER_CALL)
      const jpegs = await page.run<string[]>(`(() => { const c = document.getElementById('c'), out = []; for (let i = ${a}; i < ${b}; i++) { DT.draw(i); out.push(c.toDataURL('image/jpeg', 0.93)); } return out; })()`)
      if (page.errors.length) throw new FilmScriptError(page.errors.join('\n'))
      for (const jpeg of jpegs) await write(Buffer.from(jpeg.slice(jpeg.indexOf(',') + 1), 'base64'))
      onFrame(b, meta.frames)
    }
    ffmpeg.stdin.end()
    await finished
    // The music and sound effects (score.js), rendered offline by the page
    // at 32 kHz mono and read out in 20 s pieces: a 10-minute score as one
    // base64 WAV string (the kit's DT.wav) would be ~150 MB.
    let hasScore = false
    const scoreInfo = await page.run<{ rate: number; length: number } | null>(`(async () => {
      if (typeof score !== 'function') return null;
      const rate = 32000, ac = new OfflineAudioContext(1, Math.ceil(rate * DT.dur), rate);
      score(ac, 0, ac.destination);
      window.__scorePcm = (await ac.startRendering()).getChannelData(0);
      return { rate, length: window.__scorePcm.length };
    })()`)
    if (scoreInfo && scoreInfo.length > 0) {
      const pieces: Buffer[] = []
      const step = scoreInfo.rate * 20
      for (let a = 0; a < scoreInfo.length; a += step) {
        throwIfCanceled(signal)
        const b64 = await page.run<string>(`(() => { const src = window.__scorePcm.subarray(${a}, ${Math.min(scoreInfo.length, a + step)}), out = new Int16Array(src.length); for (let i = 0; i < src.length; i++) out[i] = Math.max(-1, Math.min(1, src[i])) * 32767; const u = new Uint8Array(out.buffer); let s = ''; for (let k = 0; k < u.length; k += 32768) s += String.fromCharCode.apply(null, u.subarray(k, k + 32768)); return btoa(s); })()`)
        pieces.push(Buffer.from(b64, 'base64'))
      }
      await page.run('(() => { window.__scorePcm = null; return true; })()')
      await writeFile(join(folder, 'score.pcm'), Buffer.concat(pieces))
      hasScore = true
    }
    return { ...meta, hasScore, scoreRate: scoreInfo?.rate ?? 32000 }
  } catch (error) {
    proc?.kill()
    throw signal.aborted ? new CanceledError() : error
  } finally {
    page.close()
  }
}

function runFfmpegIn(folder: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-v', 'error', '-y', ...args], { cwd: folder })
    let stderr = ''
    const onAbort = (): void => { proc.kill() }
    signal.addEventListener('abort', onAbort, { once: true })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) return reject(new CanceledError())
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.trim().slice(-400)}`))
    })
  })
}

/** The voice clips at their cues, as the kit's mix.mjs does, then
 * loudness-normalised (-16 LUFS) and muxed under the picture. */
async function mixAndMux(folder: string, videoFile: string, finalFile: string, cues: Array<{ file: string; t: number }>, duration: number, hasScore: boolean, signal: AbortSignal, scoreRate = 32000): Promise<void> {
  if (cues.length === 0 && !hasScore) {
    await copyFile(join(folder, videoFile), join(folder, finalFile))
    return
  }
  // The kit's mix.mjs recipe: voice clips at their cues; the score (when
  // there is one) sidechain-ducked under the voice; -16 LUFS overall.
  const offset = hasScore ? 1 : 0
  const inputs = [...(hasScore ? ['-f', 's16le', '-ar', String(scoreRate), '-ac', '1', '-i', 'score.pcm'] : []), ...cues.flatMap((cue) => ['-i', cue.file])]
  const parts = cues.map((cue, i) => `[${i + offset}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,adelay=${Math.round(cue.t * 1000)}|${Math.round(cue.t * 1000)}[v${i}]`)
  const voice = cues.length ? `${parts.join(';')};${cues.map((_, i) => `[v${i}]`).join('')}amix=inputs=${cues.length}:normalize=0,apad,atrim=0:${duration.toFixed(3)}` : ''
  const loud = 'loudnorm=I=-16:TP=-1.5:LRA=11[a]'
  const filter = hasScore && cues.length
    ? `${voice},volume=1.6,asplit=2[vk][vm];[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0,volume=0.55[m];[m][vk]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[md];[md][vm]amix=inputs=2:normalize=0,${loud}`
    : hasScore ? `[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0,${loud}` : `${voice},${loud}`
  await writeFile(join(folder, 'mix-filter.txt'), filter, 'utf8')
  await runFfmpegIn(folder, [...inputs, '-filter_complex_script', 'mix-filter.txt', '-map', '[a]', '-ar', '48000', 'mix.wav'], signal)
  await runFfmpegIn(folder, ['-i', videoFile, '-i', 'mix.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', duration.toFixed(3), '-movflags', '+faststart', finalFile], signal)
}

const safeFileName = (title: string): string => title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Animated film'

// ---------- the whole job ----------

/** What a film folder has finished, so a stopped job continues from there
 * (a 10-minute film is an hour of work; starting over is not an option). */
interface FilmState {
  request: Omit<AnimationRequest, 'jobId' | 'resumeFolder'>
  planned?: boolean
  voiced?: boolean
  cast?: boolean
  chapters?: number[][]
  done?: boolean[]
  note?: string
}

/** ~10 minutes of narration: Khmer is read at ≈0.1 s a character. */
const MAX_SCRIPT_CHARS = 9000

class FilmJobError extends Error {
  constructor(message: string, readonly folder: string) {
    super(message)
  }
}

export async function generateAnimation(input: AnimationRequest, onProgress: Progress): Promise<AnimationResult> {
  if (active.has(input.jobId)) throw new Error('This animation job is already running.')
  const controller = new AbortController()
  const signal = controller.signal
  active.set(input.jobId, controller)
  const report = (phase: AnimationProgress['phase'], percent: number, message: string, preview?: string): void =>
    onProgress({ jobId: input.jobId, phase, percent: Math.round(percent), message, ...(preview ? { preview } : {}) })
  let folder = ''
  try {
    const apiKey = await getGeminiApiKey()
    if (!apiKey) throw new Error('Gemini API key is not configured. Add it under Settings > AI API Keys.')
    const kit = kitDir()
    if (!existsSync(join(kit, 'assets', 'kuanimation.js'))) throw new Error(`The Kuanimation kit is missing from this installation (${kit}).`)

    // A new film, or one that stopped part-way.
    let state: FilmState
    if (input.resumeFolder) {
      const root = animationsDir()
      const target = resolve(input.resumeFolder)
      const inside = relative(root, target)
      if (!inside || inside.startsWith('..') || !existsSync(join(target, 'state.json'))) throw new Error('That film cannot be continued -- its folder or progress file is missing.')
      folder = target
      state = JSON.parse(await readFile(join(folder, 'state.json'), 'utf8')) as FilmState
    } else {
      const { jobId: _job, resumeFolder: _resume, ...rest } = input
      if (!rest.brief.trim() && !rest.script?.trim()) throw new Error('Describe what the film should be about, or paste its script.')
      if ((rest.script ?? '').trim().length > MAX_SCRIPT_CHARS) throw new Error(`This script is longer than a 10-minute film (${rest.script!.trim().length} characters; about ${MAX_SCRIPT_CHARS} fit). Split it into parts and make one film per part.`)
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      folder = join(animationsDir(), `${stamp}-${input.jobId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-12)}`)
      await mkdir(folder, { recursive: true })
      state = { request: { ...rest, minutes: Math.min(10, Math.max(1, rest.minutes)) } }
    }
    const request: AnimationRequest = { ...state.request, jobId: input.jobId }
    const saveState = (): Promise<void> => writeFile(join(folder, 'state.json'), JSON.stringify(state, null, 1), 'utf8')
    await saveState()

    const ai = new GoogleGenAI({ apiKey })
    const model = { model: WRITER_MODEL }
    const style: AnimationStyle = request.style
    const khmer = languageOf(request.voice) === 'km'
    const xianxia = request.genre === 'xianxia'

    for (const script of RUNTIME_SCRIPTS) {
      const source = await readFile(join(kit, 'assets', script), 'utf8')
      await writeFile(join(folder, script), script === 'kuanimation.js' ? patchRuntime(source) : source, 'utf8')
    }
    // Music + sound effects and genre props: the app's own files.
    if (request.music !== false) await copyFile(join(kit, 'assets', 'score.js'), join(folder, 'score.js'))
    if (xianxia) await copyFile(join(kit, 'assets', 'xianxia.js'), join(folder, 'xianxia.js'))
    const kitText = await readKitText(kit)
    const moods = stageMoods(await readFile(join(kit, 'assets', 'stage.js'), 'utf8'), style)
    const template = await readFile(join(kit, 'assets', 'film-template.html'), 'utf8')

    // 1. The plan: scenes, lines, cast.
    let plan: FilmPlan
    if (state.planned && existsSync(join(folder, 'plan.json'))) {
      plan = JSON.parse(await readFile(join(folder, 'plan.json'), 'utf8')) as FilmPlan
    } else {
      report('writing', 2, request.script?.trim() ? 'Gemini is splitting your script into scenes…' : 'Gemini is writing the story and the voice-over…')
      const prompt = planPrompt(request, moods, kitText)
      plan = parsePlan(await ask(ai, model, prompt, signal, planSchema(moods)), moods)
      const script = request.script?.trim()
      if (script) {
        // The script's words are the voice-over: a plan that lost or changed
        // words is sent back once; if it still does, the user is told.
        const spokenLines = (p: FilmPlan): string[] => p.scenes.flatMap((scene) => scene.lines.map((line) => line.spoken))
        let coverage = scriptCoverage(script, spokenLines(plan))
        const faithful = (c: typeof coverage): boolean => c.lengthRatio >= 0.95 && c.lengthRatio <= 1.05 && c.linesFound >= 0.95
        if (!faithful(coverage)) {
          report('writing', 6, 'Gemini changed some of your words -- asking it to keep the script exactly…')
          const again = parsePlan(await ask(ai, model, `${prompt}\n\nYOUR LAST PLAN DID NOT KEEP THE SCRIPT: its lines covered ${Math.round(coverage.lengthRatio * 100)}% of the script's text and only ${Math.round(coverage.linesFound * 100)}% of them were the script's exact words. Plan it again with every sentence of the script, word for word, in order.`, signal, planSchema(moods)), moods)
          const againCoverage = scriptCoverage(script, spokenLines(again))
          if (Math.abs(1 - againCoverage.lengthRatio) + (1 - againCoverage.linesFound) < Math.abs(1 - coverage.lengthRatio) + (1 - coverage.linesFound)) { plan = again; coverage = againCoverage }
          if (!faithful(coverage)) state.note = `Some lines may differ from your script: they cover ${Math.round(coverage.lengthRatio * 100)}% of it and ${Math.round(coverage.linesFound * 100)}% are word for word. Check the SRT.`
        }
        plan = { ...plan, scenes: plan.scenes.map((scene) => ({ ...scene, lines: scene.lines.map((line) => ({ ...line, subtitle: line.spoken })) })) }
      }
      await writeFile(join(folder, 'plan.json'), JSON.stringify(plan, null, 1), 'utf8')
      state.planned = true
      await saveState()
    }

    // 2. The voice (clips already recorded are kept).
    throwIfCanceled(signal)
    const lineCount = plan.scenes.reduce((n, s) => n + s.lines.length, 0)
    report('voicing', 10, `Recording the voice-over (${lineCount} lines)…`)
    const voice = await voiceFilm(folder, plan, request.voice, signal, (done, total) => report('voicing', 10 + (done / total) * 15, `Recording the voice-over: ${done}/${total} lines`))
    await writeFile(join(folder, 'voice.js'), buildVoiceJs(voice), 'utf8')
    state.voiced = true
    state.chapters ??= groupChapters(voice.map((scene) => sceneSeconds(scene.lines.map((line) => line.dur))))
    state.done ??= state.chapters.map(() => false)
    await saveState()
    const chapters = state.chapters
    const count = chapters.length
    const writeHtml = (upTo: number): Promise<void> => writeFile(join(folder, 'film.html'), buildFilmHtml(template, { style, title: plan.title, khmer, subtitles: request.burnSubtitles !== false, chapters: upTo, xianxia }), 'utf8')

    // 3. The cast and shared helpers, written once for every chapter.
    throwIfCanceled(signal)
    if (!state.cast || !existsSync(join(folder, 'film-cast.js'))) {
      report('staging', 25, 'Gemini is designing the characters…')
      await writeFile(join(folder, 'film-cast.js'), extractCode(await ask(ai, model, castPrompt(request, plan, kitText), signal)), 'utf8')
      state.cast = true
      await saveState()
    }
    let castCode = await readFile(join(folder, 'film-cast.js'), 'utf8')

    /** Runs the film up to this chapter; an error goes back to Gemini to
     * fix, in whichever file it came from. */
    const makeItRun = async (fileName: string, start: string, sceneNames: string[], percent: number, repairs: number): Promise<{ code: string; checked: { frames: number; preview: string; sheet: string } }> => {
      let current = start
      for (let round = 0; ; round++) {
        await writeFile(join(folder, fileName), current, 'utf8')
        throwIfCanceled(signal)
        try {
          return { code: current, checked: await checkFilm(folder, signal, sceneNames) }
        } catch (error) {
          if (!(error instanceof FilmScriptError) || round >= repairs) throw error instanceof FilmScriptError ? new Error(`The animation code still fails after ${repairs} fixes: ${error.message.slice(0, 300)}`) : error
          const culprit = failingFile(error.message)
          report('checking', percent, `Gemini is fixing an error in the animation (round ${round + 1})…`)
          if (culprit === 'film-cast.js') {
            castCode = extractCode(await ask(ai, model, repairPrompt('film-cast.js', castCode, `${error.message.slice(0, 1500)}${failingLines(castCode, error.message, 'film-cast.js')}`, kitText, null), signal))
            await writeFile(join(folder, 'film-cast.js'), castCode, 'utf8')
          } else {
            current = extractCode(await ask(ai, model, repairPrompt(fileName, current, `${error.message.slice(0, 1500)}${failingLines(current, error.message, fileName)}`, kitText, castCode), signal))
          }
        }
      }
    }

    // 4. Chapter by chapter: animate, make it run, let the director improve it.
    let preview: string | undefined
    for (let k = 0; k < count; k++) {
      if (state.done[k] && existsSync(join(folder, `chapter-${k + 1}.js`))) continue
      throwIfCanceled(signal)
      const fileName = `chapter-${k + 1}.js`
      const names = chapters[k].map((i) => plan.scenes[i].name)
      const percent = 28 + (k / count) * 32
      const label = count > 1 ? ` (chapter ${k + 1} of ${count})` : ''
      await writeHtml(k + 1)
      report('staging', percent, `Gemini is animating the scenes${label}…`, preview)
      const previous = k > 0 ? await readFile(join(folder, `chapter-${k}.js`), 'utf8') : null
      const first = extractCode(await ask(ai, model, chapterPrompt(request, plan, voice, kitText, { index: k, count, scenes: chapters[k] }, castCode, previous), signal))
      report('checking', percent + 2, `Checking the animation${label}…`, preview)
      let working = await makeItRun(fileName, first, names, percent + 2, MAX_REPAIRS)
      // The director: one look per chapter on long films, two on short ones.
      const rounds = count > 1 ? 1 : DIRECTOR_ROUNDS
      for (let round = 1; round <= rounds; round++) {
        report('directing', percent + 4, `The AI director is reviewing the film${label}…`, working.checked.preview)
        const answer = await ask(ai, model, directorPrompt(request, plan, fileName, working.code, castCode, kitText, k === 0), signal, undefined, [working.checked.sheet])
        if (/^\s*NO_CHANGES\s*$/.test(answer) || !/SCENES\.push/.test(answer)) break
        try {
          working = await makeItRun(fileName, extractCode(answer), names, percent + 5, 2)
        } catch (error) {
          if (!(error instanceof Error) || signal.aborted) throw error
          await writeFile(join(folder, fileName), working.code, 'utf8')
          break
        }
      }
      await writeFile(join(folder, fileName), working.code, 'utf8')
      preview = working.checked.preview
      state.done[k] = true
      await saveState()
    }

    // 5. The whole film once more, then the pictures, the sound, the SRT.
    await writeHtml(count)
    report('checking', 60, 'Checking the whole film…', preview)
    const whole = await checkFilm(folder, signal, null)
    report('rendering', 62, 'Drawing the film…', whole.preview)
    const videoFile = 'film.mp4'
    const meta = await renderVideo(folder, request.width, join(folder, videoFile), signal, (done, total) => report('rendering', 62 + (done / total) * 30, `Drawing frame ${done} of ${total}…`))
    report('mixing', 93, 'Mixing the voice-over and music…')
    const finalFile = `${safeFileName(plan.title)}.mp4`
    await mixAndMux(folder, videoFile, finalFile, meta.cues, meta.duration, meta.hasScore, signal, meta.scoreRate)
    // The narration as subtitles, timed to the voice exactly as the film
    // places it: one SRT in the film's language, one in English for a Khmer
    // film (from the translations Gemini wrote with the lines).
    const captions = captionsFromCues(meta.cues, voice)
    const srtPath = join(folder, `${safeFileName(plan.title)}.srt`)
    await writeFile(srtPath, '﻿' + captionsToSrt(captions, 'text'), 'utf8')
    let srtEnglishPath: string | undefined
    if (khmer && captions.some((caption) => caption.text2)) {
      srtEnglishPath = join(folder, `${safeFileName(plan.title)}.en.srt`)
      await writeFile(srtEnglishPath, '﻿' + captionsToSrt(captions, 'text2'), 'utf8')
    }
    report('done', 100, 'Done')
    return { title: plan.title, outputPath: join(folder, finalFile), folder, durationSeconds: meta.duration, preview: whole.preview, captions, srtPath, srtEnglishPath, note: state.note }
  } catch (error) {
    if (folder && !(error instanceof CanceledError) && !signal.aborted) throw new FilmJobError(error instanceof Error ? error.message : String(error), folder)
    if (folder && (error instanceof CanceledError || signal.aborted)) { const canceled = new CanceledError(); Object.assign(canceled, { folder }); throw canceled }
    throw error
  } finally {
    active.delete(input.jobId)
  }
}

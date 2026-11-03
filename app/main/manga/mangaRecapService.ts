import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { GoogleGenAI } from '@google/genai'
import type { MangaGroupResult, MangaProgress, MangaRequest, MangaResult } from '@shared/mangaRecap'
import { MANGA_MOTIONS, asMangaMotion, groupPaths, isGoodCutout, voiceCutShort, withoutLatinAsides, joinPause, panelSeconds, timeLines, type MangaMotion } from '@shared/mangaRecap'
import { removeImageBackground } from '../media/removeBackground'
import { createGemini } from '../ai/geminiClient'
import { getGeminiApiKey } from '../ai/geminiApiKeyStore'
import { explainGeminiError, isRetryableError, sleepUnlessCanceled } from '../ai/geminiErrors'
import { createDubAudioWorkDir } from '../media/dubAudioStore'
import { CanceledError, runFfmpeg } from '../media/jobRunner'
import { KiriTtsError, kiriSpeakLine } from '../media/kiriTts'
import { probeMedia } from '../media/probe'

/** A recap's narration at YouTube voice-over loudness, its peaks held under
 * the top (never clipped), the length unchanged. levelVoiceClip stops its
 * gain where the loudest peak meets the ceiling: one sharp syllable held a
 * whole narration at -20 dB. loudnorm evens it over time instead. */
export async function levelNarration(jobId: string, inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg(jobId, ['-y', '-v', 'error', '-i', inputPath, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath])
}

/** AI Manga: already-cut panels -> a story recap -> voice, for the Timeline.
 *
 *   1. reading  every panel is shrunk to a small JPEG for Gemini
 *   2. writing  Gemini looks at the WHOLE chapter at once (in parts only
 *               past BATCH panels), works out the plot, and retells it as
 *               one connected recap: a passage for each group of panels
 *               shown together, each passage carrying on from the last.
 *   3. voicing  KiriTTS speaks each passage into one WAV (a passage read
 *               in one go flows better than a line per picture), kept with
 *               the app's data, never the temp folder; the passages are
 *               then joined into one narration and levelled.
 *
 * The groups are placed on the Timeline by the renderer
 * (renderer/src/manga/mangaPlacement.ts): a group lasts as long as its passage. */

type Progress = (progress: MangaProgress) => void

const MODEL = process.env.GEMINI_MANGA_MODEL?.trim() || 'gemini-2.5-flash'
/** After a call that hung: a model with its own daily quota and quick
 * answers, which the client's own fallbacks (same family) never try. */
const AFTER_TIMEOUT_MODEL = 'gemini-2.5-flash-lite'
/** Panels Gemini sees in one call: a whole chapter as a rule, so it knows
 * the plot before it writes the first word (a multiple of 3, so groups of
 * three are never split between calls). */
const BATCH = 60
const PREVIEW_SIDE = 768
const MAX_ATTEMPTS = 4
const RETRY_WAIT_MS = [5000, 15000, 30000]
const VOICES_AT_ONCE = 3
/** One Gemini call that has not answered in this long is given up and tried
 * again: a request that hangs would otherwise hold the job for ever. */
const CALL_TIMEOUT_MS = 180_000

const active = new Map<string, AbortController>()

export function cancelManga(jobId: string): boolean {
  const controller = active.get(jobId)
  if (!controller) return false
  controller.abort()
  return true
}

interface WrittenGroup {
  index: number
  lines: string[]
  focus: Array<{ x: number; y: number }>
  /** Per picture: how its character moves (asMangaMotion). */
  motion?: MangaMotion[]
  /** Per picture: only words (a caption, a bubble on a blank) -- left out. */
  textOnly?: boolean[]
}

interface WrittenBatch {
  title: string
  storySoFar: string
  groups: WrittenGroup[]
}

const BATCH_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    plot: { type: 'string' },
    storySoFar: { type: 'string' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          seen: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } },
          focus: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
          motion: { type: 'array', items: { type: 'string', enum: [...MANGA_MOTIONS] } },
          textOnly: { type: 'array', items: { type: 'boolean' } }
        },
        required: ['index', 'seen', 'lines']
      }
    }
  },
  required: ['title', 'plot', 'storySoFar', 'groups']
}

export function batchPrompt(language: MangaRequest['language'], notes: string, storySoFar: string, firstGroup: number, groupCount: number, totalGroups: number, groupSize: number, chapter: { continues?: boolean; more?: boolean } = {}): string {
  const km = language === 'km'
  const last = firstGroup + groupCount >= totalGroups
  const side = groupSize > 1
  return [
    `You are the narrator of a ${km ? 'Khmer story-recap video (សម្រាយរឿង)' : 'story-recap video'}: you RETELL a manga chapter as one connected story for viewers who never read it, the way a good recap YouTuber tells it.`,
    side
      ? `The pictures are its panels in reading order, shown on screen ${groupSize} at a time, side by side: "Group g, picture k". You write ONE passage per group, told while that group is on screen. Groups ${firstGroup} to ${firstGroup + groupCount - 1} are here, of ${totalGroups} in the chapter.`
      : `The pictures are its panels in reading order, shown one at a time: "Group g" is panel g. You write one passage per panel. Panels ${firstGroup} to ${firstGroup + groupCount - 1} are here, of ${totalGroups}.`,
    km ? 'Write in natural spoken Khmer, the way Khmer recap channels tell a story: lively, simple everyday words, sentences that pull the listener along.' : 'Write in natural spoken English, lively and simple.',
    '',
    'FIRST look through ALL the pictures here and work out the story: who each character is, what happens, why, and what it leads to. Put that in "plot" (English, a few sentences). Only then write the recap.',
    '',
    'The recap must read as ONE story, not as notes on pictures:',
    '- Every passage follows on from the one before: show how this moment comes out of the last one (because, so, then, but, at that moment, meanwhile...), and vary the linking words; never start passages the same way.',
    '- Never repeat what was already said. Each passage moves the story forward: a new event, a reason, a feeling, a turn.',
    '- Explain what a viewer needs: who someone is when first met, what a power or a word means, why a moment matters. Build the tension towards the big moments.',
    '- Always a storyteller in the THIRD person. A caption or speech bubble in the first person ("My name is Ye Tian", "I will kill you") is retold, never read: "His name is Ye Tian", "he swears he will kill him".',
    '- Tell the STORY, not the pictures: never "in this picture / panel / group", "we can see", "on the left". What characters do, feel and say is told as part of what happens.',
    '',
    'But every passage is about ITS OWN pictures -- the viewer sees them while hearing it, and a passage that tells something else feels wrong:',
    '- "seen" first (English, one or two sentences per picture): exactly what is in it -- who (by how they look: hair, clothes), what they do, their face and gesture, any text. Write "lines" from your "seen".',
    '- The passage tells the moment that is on screen: what the character does there, the gesture, the look on the face (shocked, smiling, crying, angry), what the caption or bubble there says. The links and the background come around that, never instead of it.',
    '- Never tell an event before its picture comes (a window that appears in a later picture is not there yet), and never stay on an event whose pictures are over.',
    '- Name a character only when the pictures show it is them. Someone who looks different (other hair, other clothes) is someone else: "a young man in a red suit", not the hero.',
    '- A picture that is only a caption or a bubble on a plain background: retell that caption.',
    '- A picture with no one in it -- light, sparks, a flash, a big word or a shout ("NO!"), a caption, a sky, a building: say what is seen ("golden sparks drift around the words low-level talent", "a huge NO! bursts out of him") and what it means. Never only a feeling or a thought that cannot be seen.',
    '- Every passage has at least one sentence a viewer can check against its picture.',
    '- Speech bubbles: tell what is said and why it matters, in your own words; quote only a short striking line. Never read sound effects.',
    '- Use the same name for the same character every time.',
    km ? '- Write every name in Khmer script as it sounds (Ye Tian -> យេ ធាន), never in Latin letters: the Khmer voice reads Latin letters badly. Write numbers as words.' : '- Write numbers as words.',
    '- No greetings, no "subscribe", no headings, no emoji, no brackets.',
    '',
    side
      ? 'Each passage: 2 to 5 sentences, about 8 to 18 seconds of speech, covering what happens across the pictures of its group in order. A group with little going on gets a shorter passage that still moves the story.'
      : 'Each passage: 2 to 4 sentences, about 6 to 12 seconds of speech (a picture stays up while it is told). Take the time to tell the moment fully: what the characters there say to each other -- who says what, to whom, and how (angry, mocking, pleading) -- what they do, and what it means. A caption-only or quiet picture gets 1 or 2 sentences.',
    firstGroup === 0 && !chapter.continues ? 'The first passage opens the video: start with a gripping sentence that pulls the viewer into the story world.' : '',
    firstGroup === 0 && chapter.continues ? 'This chapter follows straight on in the same video from the chapter before (see the story so far): no new opening and no recap of it, just carry the story on.' : '',
    last && !chapter.more ? 'The last passage ends the episode: close on the tension, with a question or a hint of what is coming, so the viewer wants the next episode.' : '',
    last && chapter.more ? 'The next chapter follows straight on in the same video: end this one mid-story, leading into what comes next -- no goodbye, no "next episode".' : '',
    '',
    'lines: the passage, one sentence per item. focus: for each picture of the group, where its main action is (x, y from 0 at the left / top to 1).',
    'motion: for each picture of the group, how its main character will gently move in the video while the picture behind stays still: "breathe" (a character in view, calm, talking or thinking), "float" (flying, falling, floating, casting magic, a dream), "shake" (fighting, being hit, angry, shouting, shocked, an explosion), "none" (no character to cut out: a landscape, a building, an object, a text card, a crowd too small).',
    'textOnly: for each picture of the group, true when it is ONLY words -- a caption, a title, a speech bubble or a sound word on a plain or empty background, with no person, creature, place or thing drawn. Such a picture is LEFT OUT of the video (the viewer wants pictures): it gets no lines of its own (a group whose pictures are all words only has lines []), and what its words say is told in the passage of the picture before or after it.',
    'title: a short title for the story. storySoFar: the story so far up to the end of these groups, in English, a few sentences, with the names exactly as you wrote them (for the narrator of the next part).',
    `index: the group's number as labelled. Answer for all ${groupCount} groups.`,
    '',
    notes.trim() ? `Notes from the video's maker (names, title, what came before): ${notes.trim()}` : '',
    storySoFar.trim() ? `The story so far (before these groups): ${storySoFar.trim()}` : ''
  ]
    .filter((line, i, all) => line || all[i - 1])
    .join('\n')
}

/** A panel as a small JPEG data part (webp, bmp and huge PNGs too). */
async function shrink(jobId: string, path: string, workDir: string, i: number, signal: AbortSignal): Promise<{ mimeType: string; data: string }> {
  if (signal.aborted) throw new CanceledError()
  const out = join(workDir, `p${i}.jpg`)
  await runFfmpeg(`${jobId}:panel:${i}`, ['-y', '-v', 'error', '-i', path, '-vf', `scale='min(${PREVIEW_SIDE},iw)':'min(${PREVIEW_SIDE},ih)':force_original_aspect_ratio=decrease`, '-frames:v', '1', '-q:v', '4', out])
  return { mimeType: 'image/jpeg', data: (await readFile(out)).toString('base64') }
}

async function writeBatch(ai: GoogleGenAI, prompt: string, groups: Array<{ index: number; images: Array<{ mimeType: string; data: string }> }>, side: boolean, signal: AbortSignal): Promise<WrittenBatch> {
  let lastError: unknown
  let hung = false
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const call = new AbortController()
    const stopCall = (): void => call.abort()
    signal.addEventListener('abort', stopCall, { once: true })
    const timer = setTimeout(stopCall, CALL_TIMEOUT_MS)
    try {
      const parts = [{ text: prompt }, ...groups.flatMap((g) => g.images.flatMap((image, k) => [{ text: side ? `Group ${g.index}, picture ${k + 1}:` : `Group ${g.index}:` }, { inlineData: image }]))]
      const response = await ai.models.generateContent({
        model: hung ? AFTER_TIMEOUT_MODEL : MODEL,
        contents: [{ role: 'user', parts }],
        config: { temperature: 0.7, maxOutputTokens: 32768, thinkingConfig: { thinkingBudget: 8192 }, responseMimeType: 'application/json', responseJsonSchema: BATCH_SCHEMA, abortSignal: call.signal }
      })
      const parsed = JSON.parse(response.text || '{}') as Partial<WrittenBatch>
      if (!Array.isArray(parsed.groups) || parsed.groups.length === 0) throw new Error('Gemini wrote nothing for these panels.')
      return { title: String(parsed.title ?? ''), storySoFar: String(parsed.storySoFar ?? ''), groups: parsed.groups }
    } catch (error) {
      if (signal.aborted) throw new CanceledError()
      const timedOut = call.signal.aborted
      hung ||= timedOut
      lastError = timedOut ? new Error('Gemini did not answer in time (tried several times). Try again in a few minutes.') : error
      if (attempt >= MAX_ATTEMPTS || !(timedOut || isRetryableError(error) || error instanceof SyntaxError)) break
      await sleepUnlessCanceled(RETRY_WAIT_MS[Math.min(attempt, RETRY_WAIT_MS.length) - 1], signal)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stopCall)
    }
  }
  throw new Error(explainGeminiError(lastError))
}

/** Each group's lines and focus points, by the group numbers asked for; a
 * group Gemini skipped gets none (it shows silently). */
export function linesByGroup(batch: Pick<WrittenBatch, 'groups'>, firstGroup: number, sizes: number[]): WrittenGroup[] {
  const out: WrittenGroup[] = sizes.map((size, k) => ({ index: firstGroup + k, lines: [], focus: Array.from({ length: size }, () => ({ x: 0.5, y: 0.5 })) }))
  batch.groups.forEach((group, order) => {
    const k = Number.isInteger(group.index) && group.index >= firstGroup && group.index < firstGroup + sizes.length ? group.index - firstGroup : order
    if (k >= sizes.length || out[k].lines.length) return
    const lines = (Array.isArray(group.lines) ? group.lines : []).map((l) => String(l).trim()).filter(Boolean)
    const focus = out[k].focus.map((f, i) => {
      const given = Array.isArray(group.focus) ? group.focus[i] : undefined
      return given && Number.isFinite(Number(given.x)) && Number.isFinite(Number(given.y)) ? { x: Number(given.x), y: Number(given.y) } : f
    })
    const motion = out[k].focus.map((_, i) => asMangaMotion(Array.isArray(group.motion) ? group.motion[i] : undefined))
    const textOnly = out[k].focus.map((_, i) => Array.isArray(group.textOnly) && group.textOnly[i] === true)
    out[k] = { index: firstGroup + k, lines, focus, motion, textOnly }
  })
  return out
}

/** A passage shorter than this (characters, no spaces) is "thin": about
 * four seconds of speech, one short sentence. */
const THIN_PASSAGE_CHARS = 70
/** Above this share of thin passages, the batch is written once more. */
const THIN_SHARE_LIMIT = 0.25
const THIN_RETRY_NOTE = 'IMPORTANT: in a first try, many passages were a single short sentence. Every picture that is shown (not textOnly) needs 2 to 4 full sentences about what is in it and what it means for the story -- never one short line.'

/** The share of shown pictures (not only words) whose passage is thin. */
export function thinShare(groups: WrittenGroup[]): number {
  const shown = groups.filter((g) => !(g.textOnly ?? []).every(Boolean) || (g.textOnly ?? []).length === 0)
  if (shown.length === 0) return 0
  return shown.filter((g) => g.lines.join('').replace(/\s+/g, '').length < THIN_PASSAGE_CHARS).length / shown.length
}

/** The groups without their pictures that are only words (the user,
 * 2026-11-04: "we want only pictures"). A group left with none goes; any
 * lines it still has join the passage before it (or after it, at the start),
 * so nothing of the story is lost. */
export function dropTextOnly(paths: string[][], written: WrittenGroup[]): { paths: string[][]; written: WrittenGroup[]; leftOut: number } {
  const keptPaths: string[][] = []
  const kept: WrittenGroup[] = []
  let carried: string[] = []
  let leftOut = 0
  paths.forEach((group, g) => {
    const w = written[g] ?? { index: g, lines: [], focus: group.map(() => ({ x: 0.5, y: 0.5 })) }
    const keep = group.map((_, i) => !w.textOnly?.[i])
    leftOut += keep.filter((k) => !k).length
    if (!keep.some(Boolean)) {
      if (kept.length > 0) kept[kept.length - 1] = { ...kept[kept.length - 1], lines: [...kept[kept.length - 1].lines, ...w.lines] }
      else carried = [...carried, ...w.lines]
      return
    }
    const only = <T,>(list: T[] | undefined): T[] | undefined => list?.filter((_, i) => keep[i])
    keptPaths.push(group.filter((_, i) => keep[i]))
    kept.push({ ...w, lines: [...carried, ...w.lines], focus: only(w.focus) ?? [], motion: only(w.motion), textOnly: only(w.textOnly) })
    carried = []
  })
  return { paths: keptPaths, written: kept, leftOut }
}

/** Every panel's voice end to end into one WAV (a voiceless panel as its
 * silence), each part padded or cut to exactly its panel's length, so a
 * panel's picture and its words stay together however long the read. A few
 * milliseconds of fade at each join keeps the cuts from clicking. */
export async function joinNarration(jobId: string, panels: Array<Pick<MangaGroupResult, 'audioPath' | 'audioSeconds' | 'pauseAfter'>>, outPath: string): Promise<string> {
  const inputs: string[] = []
  const parts: string[] = []
  const labels: string[] = []
  panels.forEach((panel, i) => {
    const seconds = panelSeconds(panel.audioSeconds, panel.pauseAfter).toFixed(6)
    if (panel.audioSeconds > 0 && panel.audioPath) {
      const k = inputs.length / 2
      inputs.push('-i', panel.audioPath)
      const fadeOut = Math.max(0, panel.audioSeconds - 0.006).toFixed(6)
      parts.push(`[${k}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,apad,atrim=0:${seconds},afade=t=in:d=0.004,afade=t=out:st=${fadeOut}:d=0.006,asetpts=N/SR/TB[p${i}]`)
    } else {
      parts.push(`anullsrc=r=48000:cl=mono,atrim=0:${seconds},aformat=sample_fmts=fltp[p${i}]`)
    }
    labels.push(`[p${i}]`)
  })
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`)
  // The graph grows with the panel count: a file keeps the command short.
  const script = `${outPath}.filter.txt`
  await writeFile(script, parts.join(';\n'))
  try {
    await runFfmpeg(`${jobId}:join`, ['-y', '-v', 'error', ...inputs, '-filter_complex_script', script, '-map', '[out]', '-c:a', 'pcm_s16le', outPath])
  } finally {
    await rm(script, { force: true }).catch(() => undefined)
  }
  return outPath
}

/** A cut-out's RGBA pixels, measured small (64 x 64), for isGoodCutout. */
export async function cutoutPixels(jobId: string, path: string): Promise<Uint8Array> {
  const { stdout } = await runFfmpeg(jobId, ['-v', 'error', '-i', path, '-vf', 'scale=64:64,format=rgba', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { captureStdout: true })
  return new Uint8Array(stdout ?? Buffer.alloc(0))
}

/** Seconds of quiet at the end of a voice file (below -40 dB). */
export async function trailingSilence(jobId: string, path: string, seconds: number): Promise<number> {
  const { stdout } = await runFfmpeg(jobId, ['-v', 'error', '-i', path, '-af', 'aformat=channel_layouts=mono,silencedetect=noise=-40dB:d=0.03,ametadata=mode=print:file=-', '-f', 'null', '-'], { captureStdout: true })
  const text = (stdout ?? Buffer.alloc(0)).toString()
  const starts = [...text.matchAll(/silence_start=([\d.]+)/g)].map((m) => Number(m[1]))
  const ends = [...text.matchAll(/silence_end=([\d.]+)/g)].map((m) => Number(m[1]))
  const last = starts[starts.length - 1]
  // A silence still open at the end of the file (no end after its start).
  if (last === undefined || ends.some((e) => e > last && e < seconds - 0.01)) return 0
  return Math.max(0, seconds - last)
}

export async function generateManga(request: MangaRequest, onProgress: Progress): Promise<MangaResult> {
  const controller = new AbortController()
  active.set(request.jobId, controller)
  const signal = controller.signal
  const report = (phase: MangaProgress['phase'], percent: number, message: string): void => onProgress({ jobId: request.jobId, phase, percent: Math.round(percent), message })
  const workDir = await mkdtemp(join(tmpdir(), 'manga-'))
  try {
    const total = request.imagePaths.length
    if (total === 0) throw new Error('Add the manga panels first.')
    const apiKey = await getGeminiApiKey()
    if (!apiKey) throw new Error('Add a Gemini API key in Settings first -- it writes the narration.')
    const ai = createGemini(apiKey)
    const groupSize = request.groupSize === 3 ? 3 : 1
    const groupsOfPaths = groupPaths(request.imagePaths, groupSize)
    const totalGroups = groupsOfPaths.length
    const groupsPerCall = Math.max(1, Math.floor(BATCH / groupSize))

    // 1-2. Read and write: the whole chapter in one call as a rule.
    const written: WrittenGroup[] = []
    let storySoFar = request.storySoFar?.trim() ?? ''
    let title = ''
    let shrunk = 0
    for (let firstGroup = 0; firstGroup < totalGroups; firstGroup += groupsPerCall) {
      const part = groupsOfPaths.slice(firstGroup, firstGroup + groupsPerCall)
      const groups: Array<{ index: number; images: Array<{ mimeType: string; data: string }> }> = []
      for (const [k, paths] of part.entries()) {
        const images: Array<{ mimeType: string; data: string }> = []
        for (const path of paths) {
          images.push(await shrink(request.jobId, path, workDir, shrunk++, signal))
          report('reading', (shrunk / total) * 25, `Looking at panel ${shrunk} of ${total}…`)
        }
        groups.push({ index: firstGroup + k, images })
      }
      report('writing', 25 + (firstGroup / totalGroups) * 15, 'Writing the recap…')
      const prompt = batchPrompt(request.language, request.notes, storySoFar, firstGroup, part.length, totalGroups, groupSize, { continues: request.continues, more: request.more })
      const sizes = part.map((p) => p.length)
      let batch = await writeBatch(ai, prompt, groups, groupSize > 1, signal)
      // One picture at a time, a passage of one short line leaves the
      // picture up for a second or two with next to nothing said about it
      // (EP1, 2026-11-04). When many come back that thin, it is asked once
      // more and the fuller answer kept.
      if (groupSize === 1 && thinShare(linesByGroup(batch, firstGroup, sizes)) > THIN_SHARE_LIMIT) {
        report('writing', 25 + (firstGroup / totalGroups) * 15, 'Writing the recap again, fuller…')
        const again = await writeBatch(ai, `${prompt}

${THIN_RETRY_NOTE}`, groups, false, signal).catch(() => null)
        if (again && thinShare(linesByGroup(again, firstGroup, sizes)) < thinShare(linesByGroup(batch, firstGroup, sizes))) batch = again
      }
      written.push(...linesByGroup(batch, firstGroup, sizes))
      storySoFar = batch.storySoFar || storySoFar
      title ||= batch.title
    }

    // Pictures that are only words are left out; their words were told
    // with the pictures beside them.
    if (request.language === 'km') for (const g of written) g.lines = g.lines.map(withoutLatinAsides).filter(Boolean)
    const shown = dropTextOnly(groupsOfPaths, written)
    if (shown.paths.length === 0) throw new Error('Every picture here is only words -- add the pictures of the chapter.')
    const shownPaths = shown.paths
    const passages = shown.written
    const shownGroups = shownPaths.length

    // 3. The characters that move (one picture at a time only): cut out of
    // their pictures, locally (IS-Net). A cut-out that found next to nothing,
    // or nearly the whole picture, is no character: that scene stays still.
    const cutouts: Array<Array<string | null>> = shownPaths.map((paths) => paths.map(() => null))
    if (groupSize === 1) {
      const todo = passages.flatMap((g, i) => (g.motion?.[0] && g.motion[0] !== 'none' ? [i] : []))
      for (const [n, i] of todo.entries()) {
        if (signal.aborted) throw new CanceledError()
        report('characters', 40 + (n / Math.max(1, todo.length)) * 10, `Cutting out character ${n + 1} of ${todo.length}…`)
        try {
          const cut = await removeImageBackground(`${request.jobId}:cutout:${i}`, shownPaths[i][0], () => undefined, signal)
          if (isGoodCutout(await cutoutPixels(`${request.jobId}:share:${i}`, cut))) cutouts[i][0] = cut
        } catch (error) {
          if (signal.aborted) throw new CanceledError()
          // The scene just stays still.
        }
      }
    }

    // 4. Voice every passage, a few at once.
    const outDir = await createDubAudioWorkDir('manga-')
    const results: Array<MangaGroupResult | null> = new Array(shownGroups).fill(null)
    let done = 0
    let fatal: string | null = null
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < shownGroups) {
        const g = next++
        if (signal.aborted) throw new CanceledError()
        const group = passages[g]
        const text = group.lines.join(' ')
        const audioPath = join(outDir, `passage-${String(g + 1).padStart(4, '0')}.wav`)
        let audioSeconds = 0
        if (text && !fatal) {
          try {
            // A voice cut to a fraction of its passage is asked again.
            for (let attempt = 1; attempt <= 3; attempt++) {
              await kiriSpeakLine(request.voice, text, audioPath, { signal })
              audioSeconds = (await probeMedia(audioPath)).durationSeconds
              if (!voiceCutShort(text, audioSeconds)) break
            }
          } catch (error) {
            if (signal.aborted) throw new CanceledError()
            // A bad key, no credits or no connection fails every passage alike.
            if (error instanceof KiriTtsError && (error.status === 401 || error.status === 402 || error.status === 403 || error.status < 0)) fatal = error.message
            audioSeconds = 0
          }
        }
        const pauseAfter = audioSeconds > 0 ? joinPause(await trailingSilence(`${request.jobId}:tail:${g}`, audioPath, audioSeconds).catch(() => 0)) : 0
        results[g] = { imagePaths: shownPaths[g], focus: group.focus, audioPath: audioSeconds > 0 ? audioPath : '', audioSeconds, pauseAfter, lines: timeLines(group.lines, audioSeconds), motions: group.motion, cutouts: cutouts[g] }
        done++
        report('voicing', 50 + (done / shownGroups) * 45, `Voicing passage ${done} of ${shownGroups}…`)
      }
    }
    await Promise.all(Array.from({ length: Math.min(VOICES_AT_ONCE, shownGroups) }, worker))
    const groups = results.filter((g): g is MangaGroupResult => !!g)
    const voiced = groups.filter((g) => g.audioSeconds > 0).length
    if (voiced === 0) throw new Error(fatal ?? 'KiriTTS made no voice for any passage. Check the KiriTTS key and credits in Settings.')
    report('voicing', 97, 'Joining the narration…')
    const joined = await joinNarration(request.jobId, groups, join(outDir, 'narration-joined.wav'))
    // Loud enough as it is: KiriTTS reads quietly (about -22 dB), and a
    // clip pushed to 283% to make up for it cut its loudest syllables off
    // (crackle). loudnorm evens it instead; the length is unchanged.
    const narrationPath = join(outDir, 'narration.wav')
    await levelNarration(`${request.jobId}:level`, joined, narrationPath)
    await rm(joined, { force: true }).catch(() => undefined)
    return { title: title || 'Manga', groups, skipped: shownGroups - voiced, narrationPath, leftOut: shown.leftOut, storySoFar }
  } finally {
    active.delete(request.jobId)
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

import { app } from 'electron'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { GoogleGenAI, FileState, MediaResolution, ThinkingLevel } from '@google/genai'
import { runFfmpeg, cancelJob, CanceledError } from '../media/jobRunner'
import type {
  StoryBeat,
  StoryBeatKind,
  StoryCharacter,
  StoryOutline,
  StoryOutlineRequest,
  StoryReferenceCharacter,
  StoryScriptRequest,
  VideoStoryNarrationProgress,
  VideoStoryNarrationResult,
  VideoStoryNarrationScene
} from '@shared/videoStoryNarration'
import type { TranscriptSegment } from '@shared/transcription'
import { getGeminiApiKey } from './geminiApiKeyStore'
import { explainGeminiError, isRetryableError, sleepUnlessCanceled } from './geminiErrors'
import { extractCompleteArrayItems } from '@shared/jsonSalvage'
import {
  MAX_PART_SPLIT_DEPTH,
  MIN_PART_SECONDS,
  SCRIPT_BATCH_BEATS,
  attachReferenceFaces,
  buildOutlinePrompt,
  buildScriptPrompt,
  cleanText,
  finishScript,
  isModelUnavailableError,
  khmerizeNames,
  mergeOutlineParts,
  namesSchema,
  needsKhmerRepair,
  outlineSchema,
  parseOutlinePart,
  partSegments,
  planOutlineParts,
  repairSchema,
  scriptSchema,
  validReferences
} from '@shared/storyRecap'

export {
  applyCanonicalNames,
  attachReferenceFaces,
  buildOutlinePrompt,
  buildScriptPrompt,
  finishScript,
  isModelUnavailableError,
  khmerizeNames,
  mergeOutlineParts,
  needsKhmerRepair,
  parseOutlinePart,
  partSegments,
  planOutlineParts,
  srtLines,
  validReferences
} from '@shared/storyRecap'

/** Story-first Khmer recap -- how a human recapper works, in three steps:
 *
 *  1. buildStoryOutline: watch the WHOLE video once (low resolution is plenty
 *     for who-did-what) with the full subtitles, and write down the
 *     characters (one Khmer name each, every alias the source uses) and the
 *     story beats in order -- marking the opening teaser/theme and credits so
 *     they are left out, and flashbacks so they are announced.
 *  2. The user reviews that outline -- the cheapest place to fix a wrong
 *     name or event (renderer VideoStoryRecapControls).
 *  3. writeRecapScript: write the whole script in ONE pass from the approved
 *     outline (text only), then check it: leftover Chinese/English is
 *     rewritten, every alias becomes the one Khmer name, repeats go.
 *
 * The previous design narrated each 90 s chunk blind to the rest: measured
 * on a 25-minute episode it opened on the teaser montage, restarted "the
 * story begins" three times, narrated the same events twice at chunk
 * overlaps, left 仙人/哥/小宁 untranslated and swapped who hugged whom. */

const MODEL = process.env.GEMINI_VIDEO_MODEL?.trim() || 'gemini-2.5-flash'
/** The outline is where understanding happens (who is who, who did what),
 * so it runs on the strongest model. Measured on a 25-minute episode against
 * the user's own correct recap (22 key events): gemini-3.1-pro-preview got
 * ~19 right with identities and times correct; gemini-2.5-flash varied run
 * to run between ~14 and ~17 and kept giving one character's nickname to
 * another. Script writing (text only) stays on MODEL. A key that cannot use
 * this model falls back to MODEL (see generateOutline). */
const OUTLINE_MODEL = process.env.GEMINI_OUTLINE_MODEL?.trim() || 'gemini-3.1-pro-preview'

const MAX_OUTPUT_TOKENS = 65536
const THINKING_BUDGET = 8192
const MAX_NETWORK_ATTEMPTS = 3
const active = new Map<string, AbortController>()
const activeFfmpeg = new Map<string, string>()

export function cancelStoryRecap(jobId: string): boolean {
  const controller = active.get(jobId)
  if (!controller) return false
  controller.abort()
  const ffmpegJobId = activeFfmpeg.get(jobId)
  if (ffmpegJobId) cancelJob(ffmpegJobId)
  return true
}

type Progress = (progress: VideoStoryNarrationProgress) => void

// ---------------------------------------------------------------------------
// Step 1: outline

async function waitForFile(ai: GoogleGenAI, name: string, signal: AbortSignal): Promise<{ uri: string; mimeType: string }> {
  for (;;) {
    if (signal.aborted) throw new CanceledError()
    const file = await ai.files.get({ name })
    if (file.state === FileState.ACTIVE && file.uri) return { uri: file.uri, mimeType: file.mimeType || 'video/mp4' }
    if (file.state === FileState.FAILED) throw new Error(file.error?.message || 'Gemini could not process the uploaded video.')
    await sleepUnlessCanceled(2000, signal)
  }
}

/** Calls Gemini with network retries; returns the answer text and finish
 * reason. */
async function generate(ai: GoogleGenAI, parts: Array<Record<string, unknown>>, schema: object, signal: AbortSignal, withVideo: boolean, model = MODEL): Promise<{ text: string; finishReason: string }> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          temperature: 0.2,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // Gemini 3 models set how hard they think by level, not by a
          // token budget.
          thinkingConfig: /^gemini-3/i.test(model) ? { thinkingLevel: ThinkingLevel.HIGH } : { thinkingBudget: THINKING_BUDGET },
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          // Who-did-what needs faces and actions, not fine detail: low
          // resolution fits a whole episode in one request.
          ...(withVideo ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW } : {}),
          abortSignal: signal
        }
      })
      return { text: response.text || '', finishReason: String(response.candidates?.[0]?.finishReason ?? '') }
    } catch (error) {
      if (error instanceof CanceledError || signal.aborted) throw new CanceledError()
      lastError = error
      if (attempt >= MAX_NETWORK_ATTEMPTS || !isRetryableError(error)) break
      await sleepUnlessCanceled(attempt === 1 ? 3000 : 8000, signal)
    }
  }
  throw new Error(explainGeminiError(lastError))
}

export async function buildStoryOutline(request: StoryOutlineRequest, onProgress: Progress): Promise<StoryOutline> {
  if (active.has(request.jobId)) throw new Error('A story job with this id is already running.')
  const controller = new AbortController()
  active.set(request.jobId, controller)
  const apiKey = await getGeminiApiKey()
  if (!apiKey) throw new Error('Gemini API key is not configured. Add it under Settings > AI API Keys.')
  const ai = new GoogleGenAI({ apiKey })
  const workDir = join(app.getPath('temp'), 'creative-ai-story-outline', request.jobId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const report = (phase: VideoStoryNarrationProgress['phase'], percent: number, message: string, part?: { index: number; count: number }): void =>
    onProgress({ jobId: request.jobId, phase, percent: Math.round(percent), message, ...(part ? { currentChunk: part.index + 1, totalChunks: part.count } : {}) })
  try {
    await mkdir(workDir, { recursive: true })
    // Only the stretch of the source the user kept on the Timeline (a clip
    // trimmed past its opening teaser starts later than 0).
    const rangeStart = Math.max(0, Math.min(request.videoDurationSeconds, request.rangeStart ?? 0))
    const rangeEnd = Math.max(rangeStart, Math.min(request.videoDurationSeconds, request.rangeEnd ?? request.videoDurationSeconds))
    const parts = planOutlineParts(rangeEnd - rangeStart).map((part) => ({ start: part.start + rangeStart, end: part.end + rangeStart }))
    const results: Array<{ characters: StoryCharacter[]; beats: StoryBeat[] }> = []
    const minutes = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    // Falls back to MODEL for the rest of the job if this key can't use the
    // outline model (measured: a key told gemini-2.5-pro "is no longer
    // available to new users" with a 404).
    let outlineModel = OUTLINE_MODEL
    // The user's face photos travel with every part, so each part matches
    // faces against the same pictures (text descriptions alone drifted
    // between parts).
    const references = validReferences(request.referenceCharacters)
    const referenceImageParts = references.map((reference) => ({ inlineData: { mimeType: reference.mimeType, data: reference.data } }))

    /** Outlines one stretch of video into `results`. A stretch whose answer
     * is unusable (cut off by the output limit before one whole beat, or
     * empty) is split in two and each half outlined on its own. */
    const outlinePart = async (part: { start: number; end: number }, partInfo: { index: number; count: number }, depth: number): Promise<void> => {
      const base = (partInfo.index / partInfo.count) * 90
      const clipPath = join(workDir, `part-${Math.round(part.start)}-${Math.round(part.end)}.mp4`)
      const ffmpegJobId = `${request.jobId}:part-${Math.round(part.start)}`
      activeFfmpeg.set(request.jobId, ffmpegJobId)
      report('preparing', 2 + base, `Preparing video ${minutes(part.start)}–${minutes(part.end)}…`, partInfo)
      await runFfmpeg(ffmpegJobId, [
        '-y', '-ss', String(part.start), '-i', request.videoPath, '-t', String(part.end - part.start),
        '-map', '0:v:0', '-map', '0:a?', '-vf', 'scale=-2:360,fps=1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
        '-c:a', 'aac', '-ac', '1', '-b:a', '48k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', clipPath
      ], { totalDurationSeconds: part.end - part.start, onProgress: (p) => report('preparing', 2 + base + (p / partInfo.count) * 0.2, `Preparing video ${minutes(part.start)}–${minutes(part.end)}…`, partInfo) })
      activeFfmpeg.delete(request.jobId)
      if (controller.signal.aborted) throw new CanceledError()
      report('uploading', 5 + base + 20 / partInfo.count, `Uploading ${minutes(part.start)}–${minutes(part.end)} to Gemini…`, partInfo)
      const uploaded = await ai.files.upload({ file: clipPath, config: { mimeType: 'video/mp4', abortSignal: controller.signal } })
      if (!uploaded.name) throw new Error('Gemini upload did not return a file name.')
      let answer: { text: string; finishReason: string }
      try {
        const file = await waitForFile(ai, uploaded.name, controller.signal)
        report('analyzing', 5 + base + 35 / partInfo.count, `Gemini is watching ${minutes(part.start)}–${minutes(part.end)} and noting characters and events…`, partInfo)
        const known = results.length ? mergeOutlineParts(results, MODEL) : undefined
        const ask = (model: string): Promise<{ text: string; finishReason: string }> => generate(ai, [
          { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
          ...referenceImageParts,
          { text: buildOutlinePrompt({ partStart: part.start, partEnd: part.end, segments: request.segments, characterContext: request.characterContext, known, referenceNames: references.map((r) => r.name), storyTitle: request.storyTitle }) }
        ], outlineSchema, controller.signal, true, model)
        try {
          answer = await ask(outlineModel)
        } catch (error) {
          if (controller.signal.aborted || outlineModel === MODEL || !isModelUnavailableError(error)) throw error
          console.warn(`[story-outline] ${outlineModel} unavailable for this key; using ${MODEL}. ${error instanceof Error ? error.message.slice(0, 200) : ''}`)
          outlineModel = MODEL
          report('analyzing', 5 + base + 35 / partInfo.count, `Gemini is watching ${minutes(part.start)}–${minutes(part.end)} (standard model)…`, partInfo)
          answer = await ask(outlineModel)
        }
      } finally {
        await ai.files.delete({ name: uploaded.name }).catch(() => undefined)
        await rm(clipPath, { force: true }).catch(() => undefined)
      }
      const parsed = parseOutlinePart(answer.text, part.start, part.end, partSegments(request.segments, part.start, part.end))
      if (parsed.beats.length > 0) {
        results.push(parsed)
        return
      }
      // Record what came back, so an unusable answer can be diagnosed.
      console.warn(`[story-outline] ${minutes(part.start)}–${minutes(part.end)}: no usable beats (${answer.finishReason || 'no finish reason'}, ${answer.text.length} chars). Began: ${answer.text.slice(0, 400).replace(/\s+/g, ' ')} … Ended: ${answer.text.slice(-300).replace(/\s+/g, ' ')}`)
      const length = part.end - part.start
      if (depth < MAX_PART_SPLIT_DEPTH && length / 2 >= MIN_PART_SECONDS) {
        const middle = part.start + length / 2
        await outlinePart({ start: part.start, end: middle }, partInfo, depth + 1)
        await outlinePart({ start: middle, end: part.end }, partInfo, depth + 1)
        return
      }
      throw new Error(`Gemini returned no story outline for ${minutes(part.start)}–${minutes(part.end)} (${answer.finishReason || 'no finish reason'}). Try again.`)
    }

    for (let index = 0; index < parts.length; index++) await outlinePart(parts[index], { index, count: parts.length }, 0)
    report('merging', 95, 'Writing character names in Khmer…')
    const merged = attachReferenceFaces(mergeOutlineParts(results, outlineModel), request.referenceCharacters ?? [])
    const outline = await khmerizeNames(merged, async (prompt) => (await generate(ai, [{ text: prompt }], namesSchema, controller.signal, false)).text)
    report('complete', 100, 'Story outline ready — review it, then write the script.')
    return outline
  } finally {
    active.delete(request.jobId)
    activeFfmpeg.delete(request.jobId)
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Step 3: script

export async function writeRecapScript(request: StoryScriptRequest, onProgress: Progress): Promise<VideoStoryNarrationResult> {
  if (active.has(request.jobId)) throw new Error('A story job with this id is already running.')
  const controller = new AbortController()
  active.set(request.jobId, controller)
  const apiKey = await getGeminiApiKey()
  if (!apiKey) throw new Error('Gemini API key is not configured. Add it under Settings > AI API Keys.')
  const ai = new GoogleGenAI({ apiKey })
  const report = (phase: VideoStoryNarrationProgress['phase'], percent: number, message: string): void => onProgress({ jobId: request.jobId, phase, percent: Math.round(percent), message })
  try {
    const beats = request.outline.beats.filter((beat) => beat.include)
    if (beats.length === 0) throw new Error('No story events are selected in the outline.')
    const batches: StoryBeat[][] = []
    for (let i = 0; i < beats.length; i += SCRIPT_BATCH_BEATS) batches.push(beats.slice(i, i + SCRIPT_BATCH_BEATS))
    const written: Array<{ beatId: string; khmerNarration: string }> = []
    for (let index = 0; index < batches.length; index++) {
      report('analyzing', 5 + (index / batches.length) * 75, `Writing the Khmer script${batches.length > 1 ? ` (part ${index + 1} of ${batches.length})` : ''}…`)
      const batch = batches[index]
      const answer = await generate(ai, [{ text: buildScriptPrompt({ outline: request.outline, beats: batch, segments: request.segments, isFirstBatch: index === 0, previousParagraphs: written.slice(-3).map((p) => p.khmerNarration) }) }], scriptSchema, controller.signal, false)
      let items: unknown[]
      try {
        items = (JSON.parse(answer.text) as { paragraphs?: unknown[] }).paragraphs ?? []
      } catch {
        items = extractCompleteArrayItems(answer.text, 'paragraphs')
      }
      const wanted = new Set(batch.map((beat) => beat.id))
      for (const raw of items) {
        const item = raw as { beatId?: unknown; khmerNarration?: unknown }
        const beatId = cleanText(item.beatId)
        const text = String(item.khmerNarration ?? '').trim()
        if (wanted.has(beatId) && text) written.push({ beatId, khmerNarration: text })
      }
    }

    // Checks: the one Khmer name everywhere, no second "story begins", no
    // repeats -- then anything still carrying Chinese or English is
    // rewritten in Khmer by a small targeted request.
    report('merging', 82, 'Checking names, repeats and language…')
    let paragraphs = finishScript(written, request.outline.characters)
    const needRepair = paragraphs.filter((p) => needsKhmerRepair(p.khmerNarration))
    if (needRepair.length > 0) {
      const names = request.outline.characters.map((c) => `${c.name}${c.sourceNames.length ? ` (= ${c.sourceNames.join(', ')})` : ''}`).join('\n')
      const answer = await generate(ai, [{ text: `Rewrite each paragraph below entirely in natural spoken Khmer. Translate every Chinese or English word or phrase into Khmer and remove the original. Call each character only by the Khmer name given. Keep the meaning, events and order exactly; do not add or drop anything.\n\nCHARACTER NAMES:\n${names}\n\nPARAGRAPHS (JSON):\n${JSON.stringify(needRepair)}` }], repairSchema, controller.signal, false)
      try {
        const repairs = new Map(((JSON.parse(answer.text) as { repairs?: Array<{ beatId: string; khmerNarration: string }> }).repairs ?? []).map((r) => [r.beatId, String(r.khmerNarration ?? '').trim()]))
        paragraphs = finishScript(paragraphs.map((p) => ({ ...p, khmerNarration: repairs.get(p.beatId) || p.khmerNarration })), request.outline.characters)
      } catch {
        // Keep the unrepaired text rather than lose the paragraph.
      }
    }

    const beatById = new Map(request.outline.beats.map((beat) => [beat.id, beat]))
    const scenes: VideoStoryNarrationScene[] = paragraphs.flatMap((p) => {
      const beat = beatById.get(p.beatId)
      if (!beat) return []
      return [{ id: beat.id, startTime: beat.startTime, endTime: beat.endTime, dialogueSummary: beat.summary, visibleAction: '', khmerNarration: p.khmerNarration, confidence: needsKhmerRepair(p.khmerNarration) ? 0.5 : 0.9 }]
    })
    report('complete', 100, 'Script ready.')
    return { scenes, generatedAt: new Date().toISOString(), model: MODEL, sourceSrtFileName: request.sourceSrtFileName }
  } finally {
    active.delete(request.jobId)
  }
}

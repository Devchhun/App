import type { TranscriptSegment } from './transcription'

export interface VideoStoryNarrationScene {
  id: string
  startTime: number
  endTime: number
  dialogueSummary: string
  visibleAction: string
  khmerNarration: string
  confidence: number
}

export interface VideoStoryNarrationResult {
  scenes: VideoStoryNarrationScene[]
  generatedAt: string
  model: string
  sourceSrtFileName?: string
}

export interface VideoStoryNarrationWorkspace {
  characterContext: string
  result?: VideoStoryNarrationResult
}

export interface VideoStoryNarrationRequest {
  jobId: string
  videoPath: string
  videoDurationSeconds: number
  segments: TranscriptSegment[]
  characterContext: string
  sourceSrtFileName?: string
}

export interface RegenerateNarrationSceneRequest {
  jobId: string
  videoPath: string
  videoDurationSeconds: number
  scene: VideoStoryNarrationScene
  segments: TranscriptSegment[]
  characterContext: string
  previousNarration?: string
  nextNarration?: string
}

/** Story-first recap (see app/main/ai/storyRecapService.ts). A human
 * recapper watches the WHOLE story, knows who is who and what matters, and
 * only then writes -- the old chunk-by-chunk narration wrote each 90 s piece
 * blind, so it narrated teasers as the opening, restarted the story every
 * chunk, repeated events at chunk overlaps and mixed up characters. */
export interface StoryCharacter {
  id: string
  /** The one Khmer-script name the script uses, every time. */
  name: string
  /** How the source (SRT/dialogue) refers to them: 小宁, 安哥, Gu An… */
  sourceNames: string[]
  /** Role and confirmed relationships, in Khmer. */
  role: string
  /** What they look like -- how to tell them apart on screen. */
  appearance: string
  /** A photo of their face, when the user supplied one (JPEG data URL). */
  faceImage?: string
}

/** A character the user identified with a photo before analysis: the
 * outline step shows Gemini these faces next to the video, so it recognises
 * the person by their face instead of by a text description that has to
 * survive from one video part to the next. */
export interface StoryReferenceCharacter {
  id: string
  name: string
  /** JPEG data URL, already scaled down by the renderer. */
  image: string
}

export type StoryBeatKind = 'story' | 'flashback' | 'teaser' | 'credits'

export interface StoryBeat {
  id: string
  startTime: number
  endTime: number
  kind: StoryBeatKind
  characterIds: string[]
  /** What happens, in Khmer: who does what to whom, and what it means. */
  summary: string
  /** Whether the script covers this beat. Teasers and credits start off. */
  include: boolean
}

export interface StoryOutline {
  characters: StoryCharacter[]
  beats: StoryBeat[]
  model: string
}

/** One story (a drama, series or novel adaptation) and the characters the
 * user photographed for it. Kept app-wide, not per project, so every
 * episode of the same story reuses the same faces and names. */
export interface StoryLibraryEntry {
  id: string
  /** The story's title as the user knows it (any language). */
  title: string
  characters: StoryReferenceCharacter[]
  updatedAt: string
}

export interface StoryLibrary {
  stories: StoryLibraryEntry[]
}

export interface StoryOutlineRequest {
  jobId: string
  videoPath: string
  videoDurationSeconds: number
  segments: TranscriptSegment[]
  characterContext: string
  /** Faces the user named -- see StoryReferenceCharacter. */
  referenceCharacters?: StoryReferenceCharacter[]
  /** The story this video belongs to, as the user titled it. */
  storyTitle?: string
  /** The stretch of the source file to outline, in source seconds -- the
   * part of the clip kept on the Timeline. Whole file when absent. */
  rangeStart?: number
  rangeEnd?: number
}

export interface StoryScriptRequest {
  jobId: string
  outline: StoryOutline
  segments: TranscriptSegment[]
  sourceSrtFileName?: string
}

export type StoryOutlineIpcResult = { ok: true; data: StoryOutline } | { ok: false; error: string; canceled?: boolean }

export interface VideoStoryNarrationProgress {
  jobId: string
  phase: 'preparing' | 'chunking' | 'uploading' | 'analyzing' | 'merging' | 'complete' | 'canceled' | 'error'
  percent: number
  message: string
  currentChunk?: number
  totalChunks?: number
}

export type VideoStoryNarrationIpcResult =
  | { ok: true; data: VideoStoryNarrationResult }
  | { ok: false; error: string; canceled?: boolean }

export interface VideoChunk {
  startTime: number
  endTime: number
}

export function narrativeMediaRange(durationSeconds: number, segments: TranscriptSegment[], paddingSeconds = 12, longGapSeconds = 30): VideoChunk {
  const duration = Math.max(0, durationSeconds)
  const valid = segments.filter((segment) => Number.isFinite(segment.startTime) && Number.isFinite(segment.endTime) && segment.endTime > segment.startTime)
  if (duration === 0 || valid.length === 0) return { startTime: 0, endTime: duration }
  const last = Math.min(duration, Math.max(...valid.map((segment) => segment.endTime)))
  return {
    // Always inspect from the first frame. A story can begin with an
    // important silent action long before its first subtitle; trimming to a
    // small SRT-backed window made Gemini miss precisely that opening setup.
    startTime: 0,
    endTime: duration - last > longGapSeconds ? Math.min(duration, last + paddingSeconds) : duration
  }
}

export function planVideoChunks(
  durationSeconds: number,
  segments: TranscriptSegment[],
  maxSeconds = 300,
  overlapSeconds = 2,
  rangeStartSeconds = 0,
  rangeEndSeconds = durationSeconds
): VideoChunk[] {
  const duration = Math.max(0, durationSeconds)
  if (duration === 0) return []
  const rangeStart = Math.max(0, Math.min(duration, rangeStartSeconds))
  const rangeEnd = Math.max(rangeStart, Math.min(duration, rangeEndSeconds))
  if (rangeEnd <= rangeStart) return []
  const chunks: VideoChunk[] = []
  let start = rangeStart
  while (start < rangeEnd - 0.01) {
    const target = Math.min(rangeEnd, start + maxSeconds)
    const candidates = segments
      .map((s) => s.endTime)
      .filter((time) => time > target - 15 && time < target + 15 && time > start + 30 && time <= rangeEnd)
    const end = target === rangeEnd || candidates.length === 0 ? target : candidates.reduce((best, time) => (Math.abs(time - target) < Math.abs(best - target) ? time : best))
    chunks.push({ startTime: start, endTime: end })
    if (end >= rangeEnd) break
    start = Math.max(start + 1, end - overlapSeconds)
  }
  return chunks
}

export function mergeNarrationScenes(scenes: VideoStoryNarrationScene[]): VideoStoryNarrationScene[] {
  const sorted = [...scenes]
    .filter((scene) => Number.isFinite(scene.startTime) && Number.isFinite(scene.endTime) && scene.endTime > scene.startTime && scene.khmerNarration.trim())
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
  const output: VideoStoryNarrationScene[] = []
  for (const scene of sorted) {
    const normalized = scene.khmerNarration.trim().replace(/\s+/g, ' ')
    const duplicate = output.find((existing) => Math.abs(existing.startTime - scene.startTime) < 2.5 && existing.khmerNarration.trim().replace(/\s+/g, ' ') === normalized)
    if (duplicate) {
      if (scene.confidence > duplicate.confidence) Object.assign(duplicate, scene)
      continue
    }
    output.push({ ...scene, id: scene.id || `story-${output.length + 1}`, confidence: Math.max(0, Math.min(1, scene.confidence)) })
  }
  return output.map((scene, index) => ({ ...scene, id: scene.id || `story-${index + 1}` }))
}

export function secondsToSrtTime(value: number): string {
  const totalMs = Math.max(0, Math.round(value * 1000))
  const ms = totalMs % 1000
  const seconds = Math.floor(totalMs / 1000) % 60
  const minutes = Math.floor(totalMs / 60_000) % 60
  const hours = Math.floor(totalMs / 3_600_000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

export function narrationToSrt(scenes: VideoStoryNarrationScene[]): string {
  return scenes.map((scene, index) => `${index + 1}\n${secondsToSrtTime(scene.startTime)} --> ${secondsToSrtTime(scene.endTime)}\n${scene.khmerNarration.trim()}`).join('\n\n') + '\n'
}

export function narrationToTxt(scenes: VideoStoryNarrationScene[]): string {
  return scenes.map((scene) => `[${secondsToSrtTime(scene.startTime)} - ${secondsToSrtTime(scene.endTime)}]\n${scene.khmerNarration.trim()}`).join('\n\n') + '\n'
}

export const VIDEO_STORY_NARRATION_IPC = {
  hasApiKey: 'video-story-narration:has-api-key',
  setApiKey: 'video-story-narration:set-api-key',
  clearApiKey: 'video-story-narration:clear-api-key',
  analyze: 'video-story-narration:analyze',
  /** Step 1 of the story-first recap: the whole video -> StoryOutline. */
  buildOutline: 'video-story-narration:build-outline',
  /** Step 2: an approved StoryOutline -> the Khmer recap script. */
  writeScript: 'video-story-narration:write-script',
  /** The app-wide StoryLibrary (userData/story-library.json). */
  libraryGet: 'video-story-narration:library-get',
  librarySave: 'video-story-narration:library-save',
  regenerateScene: 'video-story-narration:regenerate-scene',
  cancel: 'video-story-narration:cancel',
  exportTxt: 'video-story-narration:export-txt',
  exportSrt: 'video-story-narration:export-srt',
  progress: 'video-story-narration:progress'
} as const

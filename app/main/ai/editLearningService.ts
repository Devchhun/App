import { randomUUID } from 'crypto'
import { AUTO_EDIT_JOB } from '@shared/aiEditing'
import type { AiEditProgress, EditPair, LearnedStyle, NarrationSegment, TrainingProject } from '@shared/aiEditing'
import type { WhisperModelSize } from '@shared/transcription'
import { buildSamples, learnStyle } from '@shared/editSamples'
import { planAutoEdit, type AutoEditResult } from '@shared/autoEdit'
import { analyzeVideoPair, detectScenes } from './editAnalysisRunner'
import { loadProject, saveProject } from './editLearningStore'
import { startTranscription } from './transcriptionService'
import { transcribeKhmerWithGemini } from './geminiTranscriptionService'
import { planEditWithGemini } from './geminiScenePlanService'

/** A Whisper size, or 'gemini' for cloud transcription (best for Khmer). */
export type TranscribeModel = WhisperModelSize | 'gemini'

/** Khmer narration -> timed segments, via Gemini (cloud) or local Whisper. */
async function runTranscription(
  id: string,
  sourcePath: string,
  modelId: TranscribeModel,
  onProgress: (percent: number, message?: string) => void,
  signal: AbortSignal,
): Promise<NarrationSegment[]> {
  if (modelId === 'gemini') {
    return transcribeKhmerWithGemini(sourcePath, onProgress, signal)
  }
  const transcript = await startTranscription(id, sourcePath, modelId, 'km', (u) => onProgress(Math.round(u.percent)))
  return toNarration(transcript.segments)
}

/** Transcript segments -> NarrationSegment[], shared by the two callers. */
function toNarration(segments: { id: string; startTime: number; endTime: number; text: string; editedText?: string; confidence: number }[]): NarrationSegment[] {
  return segments
    .map((s) => ({ id: s.id, start: s.startTime, end: s.endTime, text: (s.editedText ?? s.text).trim(), confidence: s.confidence, reviewed: false as const }))
    .filter((n) => n.text.length > 0 && n.end > n.start)
}

/** Analyses in flight, so one can be cancelled by its pair id. */
const running = new Map<string, AbortController>()

export class AiEditCanceled extends Error {
  constructor() {
    super('Canceled')
    this.name = 'AiEditCanceled'
  }
}

export async function createProject(name: string): Promise<TrainingProject> {
  const now = Date.now()
  const project: TrainingProject = {
    id: randomUUID(),
    name: name.trim() || 'My editing style',
    createdAt: now,
    updatedAt: now,
    pairs: [],
    modelIds: [],
  }
  return saveProject(project)
}

export async function addPair(
  projectId: string,
  originalMediaPath: string,
  editedMediaPath: string,
  options: { name?: string; narrationAudioPath?: string; scriptPath?: string } = {},
): Promise<TrainingProject> {
  const project = await loadProject(projectId)
  if (!project) throw new Error('That training project no longer exists.')
  const pair: EditPair = {
    id: randomUUID(),
    name: options.name?.trim() || `Pair ${project.pairs.length + 1}`,
    originalMediaPath,
    editedMediaPath,
    narrationAudioPath: options.narrationAudioPath,
    scriptPath: options.scriptPath,
    addedAt: Date.now(),
    status: 'new',
  }
  project.pairs.push(pair)
  return saveProject(project)
}

/** Add many pairs at once — originals and edits zipped by order (the UI asks
 * the user to pick them in matching order). Ignores anything past the shorter
 * list, so a mismatched count can't make half-formed pairs. */
export async function addPairs(
  projectId: string,
  originals: string[],
  editeds: string[],
): Promise<TrainingProject> {
  const project = await loadProject(projectId)
  if (!project) throw new Error('That training project no longer exists.')
  const count = Math.min(originals.length, editeds.length)
  for (let i = 0; i < count; i += 1) {
    project.pairs.push({
      id: randomUUID(),
      name: `Pair ${project.pairs.length + 1}`,
      originalMediaPath: originals[i],
      editedMediaPath: editeds[i],
      addedAt: Date.now(),
      status: 'new',
    })
  }
  return saveProject(project)
}

export async function removePair(projectId: string, pairId: string): Promise<TrainingProject> {
  const project = await loadProject(projectId)
  if (!project) throw new Error('That training project no longer exists.')
  project.pairs = project.pairs.filter((p) => p.id !== pairId)
  return saveProject(project)
}

/**
 * Reverse-analyse one pair and turn it into training samples, saving the
 * result back into its project. Visual analysis only in this phase; the Khmer
 * narration join is added in a later step (samples are still useful by shot).
 */
export async function analyzePair(
  projectId: string,
  pairId: string,
  onProgress: (progress: AiEditProgress) => void,
): Promise<TrainingProject> {
  const project = await loadProject(projectId)
  if (!project) throw new Error('That training project no longer exists.')
  const pair = project.pairs.find((p) => p.id === pairId)
  if (!pair) throw new Error('That pair no longer exists.')

  const controller = new AbortController()
  running.set(pairId, controller)
  pair.status = 'analyzing'
  pair.error = undefined
  onProgress({ pairId, phase: 'decoding', percent: 2, message: 'Reading both videos…' })

  try {
    const result = await analyzeVideoPair(
      pair.originalMediaPath,
      pair.editedMediaPath,
      (fraction) => {
        const phase: AiEditProgress['phase'] = fraction < 0.55 ? 'decoding' : fraction < 0.65 ? 'detecting' : 'matching'
        onProgress({ pairId, phase, percent: Math.round(fraction * 90), message: phaseMessage(phase) })
      },
      controller.signal,
    )

    onProgress({ pairId, phase: 'samples', percent: 95, message: 'Building training examples…' })
    pair.sourceShots = result.sourceShots
    pair.editedShots = result.editedShots
    pair.matches = result.matches
    pair.originalDuration = result.originalDuration
    pair.editedDuration = result.editedDuration
    pair.samples = buildSamples(pair.id, result.matches, pair.narration)
    pair.status = pair.matches.some((m) => m.confidence < 0.5) ? 'needs-review' : 'analyzed'
    pair.progress = 1
    onProgress({ pairId, phase: 'done', percent: 100 })
    return saveProject(project)
  } catch (error) {
    if (controller.signal.aborted) {
      pair.status = 'new'
      await saveProject(project).catch(() => undefined)
      throw new AiEditCanceled()
    }
    pair.status = 'error'
    pair.error = error instanceof Error ? error.message : String(error)
    await saveProject(project).catch(() => undefined)
    throw error
  } finally {
    running.delete(pairId)
  }
}

/**
 * Transcribe the edited video's Khmer narration (or the pair's separate clean
 * narration file) and rebuild its training samples around the spoken lines —
 * the key signal for recap-style editing ("which scene did I show while saying
 * this?"). Reuses the editor's own transcription (faster-whisper, `km`), which
 * caches by file, extracts the audio and downloads the model as needed.
 */
export async function transcribeNarration(
  projectId: string,
  pairId: string,
  modelId: TranscribeModel,
  onProgress: (progress: AiEditProgress) => void,
): Promise<TrainingProject> {
  const project = await loadProject(projectId)
  if (!project) throw new Error('That training project no longer exists.')
  const pair = project.pairs.find((p) => p.id === pairId)
  if (!pair) throw new Error('That pair no longer exists.')

  const source = pair.narrationAudioPath || pair.editedMediaPath
  onProgress({ pairId, phase: 'narration', percent: 2, message: 'Listening to the narration…' })
  const controller = new AbortController()
  running.set(pairId, controller)
  // No ':' — a Whisper id becomes part of a temp filename, and a colon is
  // illegal on Windows (reads as a drive / alternate data stream).
  const narration = await runTranscription(`aiedit-${pairId}`, source, modelId, (percent, message) => {
    onProgress({ pairId, phase: 'narration', percent: Math.min(95, percent), message: message ?? 'Transcribing the Khmer narration…' })
  }, controller.signal).finally(() => running.delete(pairId))

  pair.narration = narration
  if (pair.matches) {
    pair.samples = buildSamples(pair.id, pair.matches, narration)
    pair.status = pair.matches.some((m) => m.confidence < 0.5) ? 'needs-review' : 'ready'
  }
  onProgress({ pairId, phase: 'done', percent: 100 })
  return saveProject(project)
}

/** The style learned across all of a project's analysed pairs. */
export async function projectStyle(projectId: string): Promise<LearnedStyle> {
  const project = await loadProject(projectId)
  if (!project) throw new Error('That training project no longer exists.')
  return learnStyle(project.pairs.flatMap((p) => p.samples ?? []))
}

/**
 * Plan an auto-edit of NEW footage to NEW Khmer narration, in the style the
 * project learned. Detects the source's scenes, transcribes the narration, and
 * lays out which scene plays when (shared/autoEdit). Returns the plan for the
 * renderer to import the media and build an editable timeline from — this
 * service never touches the timeline itself.
 */
export async function autoEditPlan(
  projectId: string,
  sourceVideoPath: string,
  narrationPath: string,
  modelId: TranscribeModel,
  onProgress: (progress: AiEditProgress) => void,
): Promise<AutoEditResult> {
  const jobId = randomUUID()
  const controller = new AbortController()
  running.set(jobId, controller)
  try {
    const style = await projectStyle(projectId)

    onProgress({ pairId: AUTO_EDIT_JOB, phase: 'detecting', percent: 5, message: 'Finding the scenes in the new footage…' })
    const scenes = await detectScenes(sourceVideoPath, (f) => onProgress({ pairId: AUTO_EDIT_JOB, phase: 'detecting', percent: 5 + Math.round(f * 45), message: 'Finding the scenes…' }), controller.signal)

    onProgress({ pairId: AUTO_EDIT_JOB, phase: 'narration', percent: 55, message: 'Transcribing the Khmer narration…' })
    const narration = await runTranscription(`aiedit-auto-${jobId}`, narrationPath, modelId, (percent, message) =>
      onProgress({ pairId: AUTO_EDIT_JOB, phase: 'narration', percent: 55 + Math.min(40, Math.round(percent * 0.4)), message: message ?? 'Transcribing the Khmer narration…' }), controller.signal)

    // With Gemini, it WATCHES the footage and matches each narration line to
    // the scene it is about (semantic). Otherwise the baseline picks scenes by
    // order and pacing. Either way the cut still follows the narration timing.
    const sourceDuration = scenes.length ? Math.max(...scenes.map((s) => s.end)) : 0
    let plan
    if (modelId === 'gemini' && narration.length > 0) {
      onProgress({ pairId: AUTO_EDIT_JOB, phase: 'samples', percent: 90, message: 'Gemini is matching scenes to the narration…' })
      plan = await planEditWithGemini(sourceVideoPath, narration, sourceDuration, (percent, message) =>
        onProgress({ pairId: AUTO_EDIT_JOB, phase: 'samples', percent: 90 + Math.round(percent * 0.08), message: message ?? 'Matching scenes…' }), controller.signal)
    } else {
      onProgress({ pairId: AUTO_EDIT_JOB, phase: 'samples', percent: 97, message: 'Arranging the timeline…' })
      plan = planAutoEdit(style, narration, scenes)
    }
    onProgress({ pairId: AUTO_EDIT_JOB, phase: 'done', percent: 100 })
    return { style, scenes, narration, plan }
  } finally {
    running.delete(jobId)
  }
}

export function cancelAnalyze(pairId: string): boolean {
  const controller = running.get(pairId)
  if (!controller) return false
  controller.abort()
  return true
}

function phaseMessage(phase: AiEditProgress['phase']): string {
  switch (phase) {
    case 'decoding':
      return 'Reading both videos…'
    case 'detecting':
      return 'Finding the cuts…'
    case 'matching':
      return 'Matching the edit to the source…'
    default:
      return ''
  }
}

import { useSyncExternalStore } from 'react'
import type { ClipTransform, TimelineClip } from '@shared/project'
import { planReframe, reframeClip } from '@shared/reframe'
import type { ClipPropertyPatch } from './sequenceOps'

/** Auto Reframe's one running job, shared by the Toolbar button and the
 * Clip Properties section: either starts it, both show its progress, and
 * either can stop it. */
export interface AutoReframeState {
  busy: { file: number; files: number; percent: number } | null
  note: string | null
}

let state: AutoReframeState = { busy: null, note: null }
const listeners = new Set<() => void>()
const set = (next: Partial<AutoReframeState>): void => {
  state = { ...state, ...next }
  for (const l of listeners) l()
}
let jobId: string | null = null
let stopped = false
let progressHooked = false

export function useAutoReframe(): AutoReframeState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state
  )
}

const IDENTITY: ClipTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 }
let nextId = 0
const makeId = (): string => `rf-${Date.now().toString(36)}-${(nextId++).toString(36)}`

/** A clip Auto Reframe has moved (its keyframes carry the rf- mark). */
export function isReframed(clip: TimelineClip): boolean {
  return !!(clip.keyframes?.x?.some((k) => k.id.startsWith('rf-')) || clip.keyframes?.y?.some((k) => k.id.startsWith('rf-')))
}

interface Context {
  clips: TimelineClip[]
  pathOf: (mediaId: string) => string | undefined
  /** The frame's width / height (the project's aspect). */
  frameAspect: number
  aspectLabel: string
  apply: (patches: Record<string, ClipPropertyPatch>) => void
  /** Started by itself (a video just added): says nothing when there was
   * nothing to do. */
  auto?: boolean
}

/** Looks through each video file of the clips once (cached per file),
 * plans the camera and gives every clip Fill scale + Position keyframes. */
export async function runAutoReframe(ids: string[], ctx: Context): Promise<void> {
  if (state.busy) return
  if (!progressHooked) {
    progressHooked = true
    window.api.reframe.onProgress((p) => {
      if (p.jobId === jobId && state.busy) set({ busy: { ...state.busy, percent: p.percent } })
    })
  }
  const wanted = new Set(ids)
  const clips = ctx.clips.filter((c) => wanted.has(c.id) && c.type === 'video' && !c.locked)
  const byMedia = new Map<string, TimelineClip[]>()
  for (const c of clips) byMedia.set(c.mediaId, [...(byMedia.get(c.mediaId) ?? []), c])
  const files = [...byMedia.keys()]
  if (files.length === 0) {
    set({ note: 'Select a video clip first (or none, for every video on the main track).' })
    return
  }
  stopped = false
  set({ note: null, busy: { file: 1, files: files.length, percent: 0 } })
  const patches: Record<string, ClipPropertyPatch> = {}
  let sameShape = 0
  let failed = 0
  try {
    for (let i = 0; i < files.length; i++) {
      if (stopped) break
      const path = ctx.pathOf(files[i])
      if (!path) continue
      set({ busy: { file: i + 1, files: files.length, percent: 0 } })
      jobId = `reframe-${Date.now().toString(36)}-${i}`
      const result = await window.api.reframe.analyze(jobId, path)
      if (!result.ok) {
        if (result.canceled) break
        failed++
        continue
      }
      const plan = planReframe(result.analysis.samples, result.analysis.width / result.analysis.height, ctx.frameAspect)
      if (!plan) {
        sameShape++
        continue
      }
      for (const c of byMedia.get(files[i]) ?? []) {
        const t = c.transform ?? IDENTITY
        const mirrored = plan.axis === 'x' ? t.scaleX < 0 : t.scaleY < 0
        const out = reframeClip(plan, c, ctx.frameAspect, mirrored, makeId)
        const other = plan.axis === 'x' ? 'y' : 'x'
        patches[c.id] = {
          transform: { ...t, scaleX: Math.sign(t.scaleX || 1) * out.scale, scaleY: Math.sign(t.scaleY || 1) * out.scale, [plan.axis]: out.keyframes[0]?.value ?? 0, [other]: 0 },
          // A steady shot gets a plain position; a moving one its keyframes
          // (marked rf- so they are known as Auto Reframe's).
          keyframes: { ...c.keyframes, [plan.axis]: out.keyframes.length > 1 ? out.keyframes : [{ ...out.keyframes[0], id: makeId() }], [other]: undefined }
        }
      }
    }
    const count = Object.keys(patches).length
    if (count > 0) ctx.apply(patches)
    if (ctx.auto && count === 0 && failed === 0) {
      set({ note: null })
      return
    }
    set({
      note: [
        count > 0 ? `${ctx.auto ? 'Auto Reframe: ' : ''}${count} clip${count === 1 ? '' : 's'} reframed to ${ctx.aspectLabel}: the frame follows the people.` : '',
        sameShape > 0 ? `The video already has the ${ctx.aspectLabel} shape -- nothing to reframe (pick 9:16 at the top first).` : '',
        failed > 0 ? `${failed} video${failed === 1 ? '' : 's'} could not be looked through.` : '',
        stopped ? 'Stopped.' : ''
      ]
        .filter(Boolean)
        .join(' ')
    })
  } finally {
    jobId = null
    set({ busy: null })
  }
}

export function stopAutoReframe(): void {
  stopped = true
  if (jobId) void window.api.reframe.cancel(jobId)
}

/** Takes Auto Reframe off: the whole picture back, fitted. */
export function removeReframe(ids: string[], clips: TimelineClip[], apply: (patches: Record<string, ClipPropertyPatch>) => void): void {
  const wanted = new Set(ids)
  const patches: Record<string, ClipPropertyPatch> = {}
  for (const c of clips) {
    if (!wanted.has(c.id) || c.locked || c.type !== 'video') continue
    const t = c.transform ?? IDENTITY
    patches[c.id] = { transform: { ...t, x: 0, y: 0, scaleX: Math.sign(t.scaleX || 1), scaleY: Math.sign(t.scaleY || 1) }, keyframes: { ...c.keyframes, x: undefined, y: undefined } }
  }
  apply(patches)
  set({ note: 'Reframe removed: the whole picture is back, fitted.' })
}

export function clearReframeNote(): void {
  if (state.note) set({ note: null })
}

const AUTO_KEY = 'cae.autoReframe'

/** Auto Reframe on its own as videos are added (the Toolbar's Auto
 * switch): on unless turned off. */
export function loadAutoReframeOn(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== '0'
  } catch {
    return true
  }
}

export function saveAutoReframeOn(on: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, on ? '1' : '0')
  } catch {
    // This session only.
  }
}

/** Clips of video FILES that were not on the Timeline before -- a video
 * just added (Import, Batch Load) -- on the main video track. A cut, split
 * or Video Sync of a video already there keeps its file, so it is not
 * "added" and its framing is left alone. Pure. */
export function newlyAddedVideoClips(
  before: Set<string>,
  clips: TimelineClip[],
  mainTrackId: string | undefined
): TimelineClip[] {
  return clips.filter((c) => c.type === 'video' && c.trackId === mainTrackId && !c.locked && !before.has(c.mediaId) && !isReframed(c))
}

/** Whether a picture of this size needs reframing into the frame: a
 * different shape (a wide video in a tall frame or the other way round).
 * Unknown size: maybe, let the look decide. */
export function needsReframe(size: { width?: number; height?: number } | undefined, frameAspect: number): boolean {
  if (!size?.width || !size.height) return true
  const aspect = size.width / size.height
  return aspect > frameAspect * 1.01 || aspect < frameAspect / 1.01
}

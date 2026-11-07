import type { LearnedStyle, NarrationSegment, Seconds, Shot } from './aiEditing'

/** Everything an auto-edit produced, for the renderer to turn into a timeline. */
export interface AutoEditResult {
  style: LearnedStyle
  scenes: Array<Pick<Shot, 'index' | 'start' | 'end' | 'duration'>>
  narration: NarrationSegment[]
  plan: AutoEditPlan
}

/**
 * Phase 3 baseline auto-edit planner. Given a learned style, the new Khmer
 * narration to edit to, and the scenes of the new source footage, it lays out
 * which scene plays when — following the user's pacing (how long a scene is
 * held, how often it cuts). Pure and deterministic, so it is fully testable
 * and the renderer only has to turn the plan into TimelineClips.
 *
 * This baseline chooses scenes by order and variety (never the same scene twice
 * in a row), spreading through the footage. Semantic relevance (show the scene
 * that matches what the narration is about) is a later improvement that slots
 * in at `pickScene` without changing this shape.
 */

export interface AutoEditClip {
  /** Index into the source `scenes` array. */
  sourceScene: number
  sourceIn: Seconds
  sourceOut: Seconds
  /** Where it sits on the new timeline (seconds). */
  timelineStart: Seconds
  duration: Seconds
  /** The narration line this clip plays under. */
  narrationId: string
}

export interface AutoEditPlan {
  clips: AutoEditClip[]
  /** Total timeline length (the narration's span). */
  duration: Seconds
  /** The hold and cut rate actually used, after clamping — shown to the user. */
  usedHold: Seconds
}

export interface AutoEditOptions {
  /** Hold is clamped here so an odd dataset can't make 0.3s or 40s scenes. */
  minHold?: Seconds
  maxHold?: Seconds
  /** Default hold when the style has none yet. */
  fallbackHold?: Seconds
}

const DEFAULTS = { minHold: 1.5, maxHold: 12, fallbackHold: 4 }

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export function planAutoEdit(
  style: LearnedStyle,
  narration: NarrationSegment[],
  scenes: Array<Pick<Shot, 'start' | 'end' | 'duration'>>,
  options: AutoEditOptions = {},
): AutoEditPlan {
  const opt = { ...DEFAULTS, ...options }
  const usable = narration.filter((n) => n.end > n.start)
  if (usable.length === 0 || scenes.length === 0) {
    return { clips: [], duration: 0, usedHold: opt.fallbackHold }
  }

  const hold = clamp(style.medianHold > 0 ? style.medianHold : opt.fallbackHold, opt.minHold, opt.maxHold)
  const clips: AutoEditClip[] = []
  let scenePointer = 0
  let previousScene = -1

  for (const line of usable) {
    const lineDuration = line.end - line.start
    // How many cuts this line gets, from the learned hold (encodes pacing).
    const cuts = Math.max(1, Math.round(lineDuration / hold))
    const clipDuration = lineDuration / cuts
    for (let i = 0; i < cuts; i += 1) {
      const scene = pickScene(scenes, scenePointer, previousScene)
      scenePointer = scene + 1
      previousScene = scene
      const src = scenes[scene]
      const sourceOut = Math.min(src.end, src.start + clipDuration)
      clips.push({
        sourceScene: scene,
        sourceIn: round(src.start),
        sourceOut: round(sourceOut),
        timelineStart: round(line.start + i * clipDuration),
        duration: round(clipDuration),
        narrationId: line.id,
      })
    }
  }

  const duration = round(Math.max(...usable.map((n) => n.end)))
  return { clips, duration, usedHold: round(hold) }
}

/** The next scene to show: step through the footage in order, but never the
 * same scene twice in a row. (Semantic relevance replaces this later.) */
function pickScene(scenes: unknown[], pointer: number, previous: number): number {
  let scene = pointer % scenes.length
  if (scene === previous && scenes.length > 1) scene = (scene + 1) % scenes.length
  return scene
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

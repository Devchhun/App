// Same "stay on this track, make room instead" policy as
// timeline/rippleCollision.ts, for graphics scenes: two scenes on one
// graphics track never overlap -- a scene landing on an occupied span
// pushes the scene it hits (and everything after it) right, in order.
import type { Scene } from '@shared/project'

export interface SceneRipplePlan {
  fits: boolean
  /** sceneId -> new [startTime, endTime] for every scene that must move. */
  pushes: Map<string, { startTime: number; endTime: number }>
}

export function planSceneRipple(scenes: Scene[], track: string, insertStart: number, insertEnd: number, excludeId?: string): SceneRipplePlan {
  const onTrack = scenes.filter((s) => s.track === track && s.id !== excludeId).sort((a, b) => a.startTime - b.startTime)
  let cursor = insertEnd
  const pushes = new Map<string, { startTime: number; endTime: number }>()
  for (const scene of onTrack) {
    if (scene.endTime <= insertStart) continue
    if (scene.startTime >= cursor) break
    const length = scene.endTime - scene.startTime
    if (scene.locked) {
      cursor = Math.max(cursor, scene.endTime)
      continue
    }
    pushes.set(scene.id, { startTime: cursor, endTime: cursor + length })
    cursor += length
  }
  return { fits: pushes.size === 0, pushes }
}

/** Applies a plan to a scene list (unlisted scenes untouched). */
export function applySceneRipple(scenes: Scene[], plan: SceneRipplePlan): Scene[] {
  if (plan.fits) return scenes
  return scenes.map((s) => {
    const push = plan.pushes.get(s.id)
    return push ? { ...s, startTime: push.startTime, endTime: push.endTime, edited: true } : s
  })
}

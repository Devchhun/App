import { useCallback } from 'react'
import { useScenes } from './SceneContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { reflowContentTransform, reflowScenePosition } from './contentTransformReflow'
import type { BrandPreset, Scene } from '@shared/project'

/** Switching the project's aspect ratio (16:9/9:16/1:1) must reflow every
 * scene's contentTransform/position for the new design canvas in the SAME
 * synchronous update as the aspect-ratio change itself -- both
 * `updateBrandPreset` and `restoreScenesByMedia` are called here, in one
 * event handler, so React 18 batches them into one re-render and
 * HistoryContext's snapshot watcher records exactly one undo entry for the
 * whole change (not one for the aspect ratio and a separate one for the
 * reflow). Background mode/opacity and scene timing are untouched -- this
 * only ever writes contentTransform/position. */
export function useChangeAspectRatio(): (nextAspect: BrandPreset['defaultAspectRatio']) => void {
  const { scenesByMedia, restoreScenesByMedia } = useScenes()
  const { brandPreset, updateBrandPreset } = useBrandPreset()

  return useCallback(
    (nextAspect: BrandPreset['defaultAspectRatio']) => {
      const prevAspect = brandPreset.defaultAspectRatio
      if (prevAspect === nextAspect) return
      updateBrandPreset({ defaultAspectRatio: nextAspect })

      let changed = false
      const next: Record<string, Scene[]> = {}
      for (const [mediaId, scenes] of Object.entries(scenesByMedia)) {
        next[mediaId] = scenes.map((scene) => {
          if (scene.contentTransform) {
            changed = true
            return { ...scene, contentTransform: reflowContentTransform(scene.contentTransform, prevAspect, nextAspect) }
          }
          if (scene.position) {
            changed = true
            return { ...scene, position: reflowScenePosition(scene.position, prevAspect, nextAspect) }
          }
          return scene
        })
      }
      if (changed) restoreScenesByMedia(next)
    },
    [scenesByMedia, restoreScenesByMedia, brandPreset.defaultAspectRatio, updateBrandPreset]
  )
}

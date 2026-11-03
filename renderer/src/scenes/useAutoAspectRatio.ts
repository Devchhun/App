import { useEffect, useRef } from 'react'
import { useSequence } from '../sequence/SequenceContext'
import { useMedia } from '../media/MediaContext'
import { useProject } from '../project/ProjectContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { useChangeAspectRatio } from './useAspectRatioChange'
import type { BrandPreset } from '@shared/project'

/** The project shape closest to a picture's own: tall -> 9:16, about
 * square -> 1:1, anything wider -> 16:9. */
export function aspectRatioFor(width: number, height: number): BrandPreset['defaultAspectRatio'] {
  const ratio = width / height
  if (ratio < 0.85) return '9:16'
  if (ratio <= 1.2) return '1:1'
  return '16:9'
}

/** A project opening brings its clips in over a moment; none of that is
 * the user adding a first video. */
const SETTLE_MS = 2000

/** Set when a tool has just chosen the shape for the pictures it is about to
 * place (AI Manga makes a recap 16:9; its first scene is a tall webtoon
 * picture that would otherwise turn the project 9:16 a moment later). */
let shapeChosen = false

/** The next first picture keeps the project's shape as it is. */
export function keepChosenAspectRatio(): void {
  shapeChosen = true
}

/** As CapCut does: the first video or picture put on an empty project sets
 * the project's shape to its own, so a vertical drama fills a 9:16 frame
 * instead of sitting small between black bars in 16:9. Only that first
 * one -- after that, and in a project opened with clips, the shape is the
 * user's. */
export function useAutoAspectRatio(): void {
  const { sequence } = useSequence()
  const { items } = useMedia()
  const { projectId } = useProject()
  const { brandPreset } = useBrandPreset()
  const changeAspectRatio = useChangeAspectRatio()
  const stateRef = useRef<{ projectId: string | null; openedAt: number; hadPicture: boolean } | null>(null)

  useEffect(() => {
    const pictures = sequence.clips.filter((clip) => clip.type === 'video' || clip.type === 'image')
    const state = stateRef.current
    if (!state || state.projectId !== projectId) {
      stateRef.current = { projectId, openedAt: Date.now(), hadPicture: pictures.length > 0 }
      return
    }
    if (pictures.length === 0) {
      state.hadPicture = false
      return
    }
    if (state.hadPicture) return
    if (shapeChosen) {
      shapeChosen = false
      state.hadPicture = true
      return
    }
    if (Date.now() - state.openedAt < SETTLE_MS) {
      state.hadPicture = true
      return
    }
    const media = items.find((item) => item.id === pictures[0].mediaId)
    const width = media?.metadata?.width
    const height = media?.metadata?.height
    // Its size is known once the file is probed: wait for that.
    if (!width || !height) return
    state.hadPicture = true
    const next = aspectRatioFor(width, height)
    if (next !== brandPreset.defaultAspectRatio) changeAspectRatio(next)
  }, [sequence.clips, items, projectId, brandPreset.defaultAspectRatio, changeAspectRatio])
}

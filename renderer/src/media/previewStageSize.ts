/** Pure sizing math for the Preview stage: contain-fits the project aspect
 * ratio inside the available wrap space, then caps the RESULT to a maximum
 * comfortable size so the stage doesn't grow without bound on a large/4K/
 * ultrawide monitor -- extra space on those screens becomes padding/gutters,
 * not an ever-larger video. Capping is applied AFTER the contain-fit (not
 * instead of it) and re-derives the other axis to keep the aspect ratio
 * exact either way. */
export interface StageSize {
  width: number
  height: number
}

export const PREVIEW_STAGE_MAX_WIDTH = 1200
export const PREVIEW_STAGE_MAX_HEIGHT = 680

export function computeStageSize(
  availWidth: number,
  availHeight: number,
  aspectW: number,
  aspectH: number,
  maxWidth: number = PREVIEW_STAGE_MAX_WIDTH,
  maxHeight: number = PREVIEW_STAGE_MAX_HEIGHT
): StageSize | null {
  if (availWidth <= 0 || availHeight <= 0 || aspectW <= 0 || aspectH <= 0) return null

  let width = availWidth
  let height = (width * aspectH) / aspectW
  if (height > availHeight) {
    height = availHeight
    width = (height * aspectW) / aspectH
  }

  if (width > maxWidth) {
    width = maxWidth
    height = (width * aspectH) / aspectW
  }
  if (height > maxHeight) {
    height = maxHeight
    width = (height * aspectW) / aspectH
  }

  return { width: Math.floor(width), height: Math.floor(height) }
}

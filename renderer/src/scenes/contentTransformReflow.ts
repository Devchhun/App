import { CANVAS_SIZE_BY_ASPECT } from '@shared/templates'
import type { SceneContentTransform, TemplateId, ScenePosition } from '@shared/templates'
import type { AnyAspectRatio } from '../templates/designScale'
import { SAFE_AREA_MARGIN_PERCENT } from './contentTransformMath'

export { SAFE_AREA_MARGIN_PERCENT }
const MIN_BOX_PERCENT = 5

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Re-lays-out one content transform for a NEW aspect ratio, given the
 * aspect ratio it was set under. Pure and deterministic -- no DOM, no scene
 * lookups -- so every rule is independently testable:
 *  - The box's normalized CENTER (`xPercent`/`yPercent`, see
 *    SceneContentTransform's doc comment -- this has been the stored
 *    coordinate contract since the center-based migration) is preserved as
 *    closely as possible.
 *  - Locked-aspect boxes keep their absolute pixel aspect ratio, resized to
 *    cover the same fraction of canvas AREA on the new canvas (so a box that
 *    was "a fairly large chunk of the frame" stays that way regardless of
 *    the frame's shape, instead of literally carrying raw percentages,
 *    which would silently change its visual weight).
 *  - Unlocked boxes carry their width%/height% through directly (each axis
 *    percentage is already resolution-independent on its own axis).
 *  - The result is then shrunk (preserving whatever aspect it has) if it
 *    would overflow the safe area, and finally clamped so all four edges
 *    stay within the safe area.
 * Internal element sizing (font-size, icon size, gaps) is untouched design-
 * space CSS, so nothing inside the box is ever stretched by this. */
export function reflowContentTransform(transform: SceneContentTransform, oldAspect: AnyAspectRatio, newAspect: AnyAspectRatio): SceneContentTransform {
  if (oldAspect === newAspect) return transform

  const oldCanvas = CANVAS_SIZE_BY_ASPECT[oldAspect]
  const newCanvas = CANVAS_SIZE_BY_ASPECT[newAspect]

  const centerXPercent = transform.xPercent
  const centerYPercent = transform.yPercent

  let widthPercent: number
  let heightPercent: number

  if (transform.lockAspectRatio) {
    const oldWidthPx = (transform.widthPercent / 100) * oldCanvas.width
    const oldHeightPx = Math.max(1, (transform.heightPercent / 100) * oldCanvas.height)
    const aspect = oldWidthPx / oldHeightPx
    const areaFraction = (oldWidthPx * oldHeightPx) / (oldCanvas.width * oldCanvas.height)
    const newHeightPx = Math.sqrt((areaFraction * newCanvas.width * newCanvas.height) / aspect)
    const newWidthPx = newHeightPx * aspect
    widthPercent = (newWidthPx / newCanvas.width) * 100
    heightPercent = (newHeightPx / newCanvas.height) * 100
  } else {
    widthPercent = transform.widthPercent
    heightPercent = transform.heightPercent
  }

  const maxSize = 100 - 2 * SAFE_AREA_MARGIN_PERCENT
  if (widthPercent > maxSize || heightPercent > maxSize) {
    const shrink = Math.min(maxSize / widthPercent, maxSize / heightPercent)
    widthPercent *= shrink
    heightPercent *= shrink
  }
  widthPercent = Math.max(MIN_BOX_PERCENT, widthPercent)
  heightPercent = Math.max(MIN_BOX_PERCENT, heightPercent)

  const xPercent = clamp(
    centerXPercent,
    SAFE_AREA_MARGIN_PERCENT + widthPercent / 2,
    Math.max(SAFE_AREA_MARGIN_PERCENT + widthPercent / 2, 100 - SAFE_AREA_MARGIN_PERCENT - widthPercent / 2)
  )
  const yPercent = clamp(
    centerYPercent,
    SAFE_AREA_MARGIN_PERCENT + heightPercent / 2,
    Math.max(SAFE_AREA_MARGIN_PERCENT + heightPercent / 2, 100 - SAFE_AREA_MARGIN_PERCENT - heightPercent / 2)
  )

  return { ...transform, xPercent, yPercent, widthPercent, heightPercent }
}

/** Same reflow rule, minus lockAspectRatio/rotation, for the older
 * `ScenePosition` shape used by overlay-mode scenes (e.g. a manually
 * repositioned Three-Step Presenter Plan). Always treated as "unlocked".
 * `ScenePosition` itself keeps its own long-standing TOP-LEFT
 * (xPct/yPct = top-left corner) storage contract -- unlike
 * `SceneContentTransform`, it was never re-declared as center-based, so this
 * function converts to the shared center-based math at its boundary and
 * converts the result straight back, rather than reinterpreting the field
 * meaning of the persisted `ScenePosition` type. */
export function reflowScenePosition(position: ScenePosition, oldAspect: AnyAspectRatio, newAspect: AnyAspectRatio): ScenePosition {
  const asTransform = reflowContentTransform(
    {
      xPercent: position.xPct + position.widthPct / 2,
      yPercent: position.yPct + position.heightPct / 2,
      widthPercent: position.widthPct,
      heightPercent: position.heightPct,
      rotation: 0,
      lockAspectRatio: false
    },
    oldAspect,
    newAspect
  )
  return {
    xPct: asTransform.xPercent - asTransform.widthPercent / 2,
    yPct: asTransform.yPercent - asTransform.heightPercent / 2,
    widthPct: asTransform.widthPercent,
    heightPct: asTransform.heightPercent
  }
}

/** Aspect-specific starting box for a full-frame template's foreground when
 * the scene has no explicit contentTransform yet -- used both for initial
 * render and as the base a reflow falls back to when a scene switches to a
 * template it's never had a transform for. Values are hand-tuned per
 * template per aspect ratio (wide/4-column for 16:9, compact/2x2 for
 * 9:16 and 1:1), not merely the 16:9 box shrunk down. */
const DEFAULT_TRANSFORMS: Partial<Record<TemplateId, Record<AnyAspectRatio, SceneContentTransform>>> = {
  'device-compatibility-lineup': {
    '16:9': { xPercent: 50, yPercent: 50, widthPercent: 80, heightPercent: 60, rotation: 0, lockAspectRatio: false },
    '9:16': { xPercent: 50, yPercent: 52.5, widthPercent: 80, heightPercent: 45, rotation: 0, lockAspectRatio: false },
    '1:1': { xPercent: 50, yPercent: 50, widthPercent: 76, heightPercent: 56, rotation: 0, lockAspectRatio: false }
  },
  'tech-title-scene': {
    '16:9': { xPercent: 50, yPercent: 50, widthPercent: 58, heightPercent: 40, rotation: 0, lockAspectRatio: false },
    '9:16': { xPercent: 50, yPercent: 49.5, widthPercent: 84, heightPercent: 35, rotation: 0, lockAspectRatio: false },
    '1:1': { xPercent: 50, yPercent: 50, widthPercent: 76, heightPercent: 40, rotation: 0, lockAspectRatio: false }
  },
  'cause-effect-flow': {
    '16:9': { xPercent: 50, yPercent: 50, widthPercent: 70, heightPercent: 46, rotation: 0, lockAspectRatio: false },
    '9:16': { xPercent: 50, yPercent: 50, widthPercent: 82, heightPercent: 60, rotation: 0, lockAspectRatio: false },
    '1:1': { xPercent: 50, yPercent: 50, widthPercent: 78, heightPercent: 56, rotation: 0, lockAspectRatio: false }
  },
  'security-login-flow': {
    '16:9': { xPercent: 50, yPercent: 50, widthPercent: 62, heightPercent: 46, rotation: 0, lockAspectRatio: false },
    '9:16': { xPercent: 50, yPercent: 50, widthPercent: 78, heightPercent: 62, rotation: 0, lockAspectRatio: false },
    '1:1': { xPercent: 50, yPercent: 50, widthPercent: 74, heightPercent: 58, rotation: 0, lockAspectRatio: false }
  },
  'vault-break-in-animation': {
    '16:9': { xPercent: 50, yPercent: 50, widthPercent: 82, heightPercent: 76, rotation: 0, lockAspectRatio: false },
    '9:16': { xPercent: 50, yPercent: 50, widthPercent: 86, heightPercent: 82, rotation: 0, lockAspectRatio: false },
    '1:1': { xPercent: 50, yPercent: 50, widthPercent: 82, heightPercent: 78, rotation: 0, lockAspectRatio: false }
  },
  'animated-break-in-vault-diagram': {
    // 16:9: diagram on the right half (paired with explanatory text on the
    // left), so its own box is offset right of center rather than fully centered.
    '16:9': { xPercent: 70, yPercent: 50, widthPercent: 56, heightPercent: 84, rotation: 0, lockAspectRatio: false },
    '9:16': { xPercent: 50, yPercent: 55, widthPercent: 78, heightPercent: 74, rotation: 0, lockAspectRatio: false },
    '1:1': { xPercent: 50, yPercent: 52, widthPercent: 80, heightPercent: 76, rotation: 0, lockAspectRatio: false }
  },
  'data-center-cyber-intrusion': {
    '16:9': { xPercent: 70, yPercent: 50, widthPercent: 56, heightPercent: 84, rotation: 0, lockAspectRatio: false },
    '9:16': { xPercent: 50, yPercent: 55, widthPercent: 78, heightPercent: 74, rotation: 0, lockAspectRatio: false },
    '1:1': { xPercent: 50, yPercent: 52, widthPercent: 80, heightPercent: 76, rotation: 0, lockAspectRatio: false }
  },
  'hospital-emergency-response': {
    '16:9': { xPercent: 70, yPercent: 50, widthPercent: 56, heightPercent: 84, rotation: 0, lockAspectRatio: false },
    '9:16': { xPercent: 50, yPercent: 55, widthPercent: 78, heightPercent: 74, rotation: 0, lockAspectRatio: false },
    '1:1': { xPercent: 50, yPercent: 52, widthPercent: 80, heightPercent: 76, rotation: 0, lockAspectRatio: false }
  },
  'reality-vs-dream': {
    '16:9': { xPercent: 50, yPercent: 50, widthPercent: 76, heightPercent: 50, rotation: 0, lockAspectRatio: false },
    '9:16': { xPercent: 50, yPercent: 50, widthPercent: 84, heightPercent: 66, rotation: 0, lockAspectRatio: false },
    '1:1': { xPercent: 50, yPercent: 50, widthPercent: 80, heightPercent: 60, rotation: 0, lockAspectRatio: false }
  },
  'body-vs-avatar': {
    '16:9': { xPercent: 50, yPercent: 50, widthPercent: 70, heightPercent: 40, rotation: 0, lockAspectRatio: false },
    '9:16': { xPercent: 50, yPercent: 50, widthPercent: 82, heightPercent: 56, rotation: 0, lockAspectRatio: false },
    '1:1': { xPercent: 50, yPercent: 50, widthPercent: 78, heightPercent: 50, rotation: 0, lockAspectRatio: false }
  },
  'source-branch': {
    '16:9': { xPercent: 50, yPercent: 50, widthPercent: 70, heightPercent: 40, rotation: 0, lockAspectRatio: false },
    '9:16': { xPercent: 50, yPercent: 50, widthPercent: 82, heightPercent: 56, rotation: 0, lockAspectRatio: false },
    '1:1': { xPercent: 50, yPercent: 50, widthPercent: 78, heightPercent: 50, rotation: 0, lockAspectRatio: false }
  },
  'final-summary': {
    '16:9': { xPercent: 50, yPercent: 50, widthPercent: 74, heightPercent: 74, rotation: 0, lockAspectRatio: true },
    '9:16': { xPercent: 50, yPercent: 50, widthPercent: 80, heightPercent: 80, rotation: 0, lockAspectRatio: true },
    '1:1': { xPercent: 50, yPercent: 50, widthPercent: 78, heightPercent: 78, rotation: 0, lockAspectRatio: true }
  }
}

export function getDefaultContentTransform(templateId: TemplateId, aspectRatio: AnyAspectRatio): SceneContentTransform | undefined {
  return DEFAULT_TRANSFORMS[templateId]?.[aspectRatio]
}

/** Absolute last-resort fallback, only reached for a full-frame template
 * that has no entry in DEFAULT_TRANSFORMS at all (should not happen for any
 * currently-shipping template, but keeps this function total). */
const GENERIC_FALLBACK_TRANSFORM: SceneContentTransform = { xPercent: 50, yPercent: 50, widthPercent: 60, heightPercent: 50, rotation: 0, lockAspectRatio: false }

/** THE single resolver for "what content transform does this scene's
 * foreground actually use" -- both the template's own render (via
 * SceneContentFrame) and SceneSelectionOverlay's hit-area/handles call this
 * exact function, so they can never resolve to two different boxes (e.g. the
 * render using a template default while selection falls back to full-stage
 * bounds). Resolution order: the scene's own explicit transform, else the
 * template's aspect-specific default, else a generic centered fallback --
 * never the video stage's own bounds. */
export function resolveEffectiveContentTransform(
  scene: { contentTransform?: SceneContentTransform },
  templateId: TemplateId,
  aspectRatio: AnyAspectRatio
): SceneContentTransform {
  return scene.contentTransform ?? getDefaultContentTransform(templateId, aspectRatio) ?? GENERIC_FALLBACK_TRANSFORM
}

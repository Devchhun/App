import type { CSSProperties } from 'react'
import type { BrandPreset, Scene } from '@shared/project'
import type { SceneMotion } from './animation'

export interface TemplateProps {
  scene: Scene
  brand: BrandPreset
  motion: SceneMotion
  /** Absolute Preview timeline time in seconds -- the single source of truth
   * for internal-element motion (see motion.ts's computeTemplateMotionFrame,
   * which takes this directly rather than `motion.enterProgress`, since that
   * one clamps to the enter window and can't drive hold-phase loops). Every
   * template that does its own internal choreography derives everything from
   * this value, never Date.now()/setInterval/a template-owned rAF loop. */
  currentTime: number
  /** Only set for numbered-steps scenes: 1-based position among the media's other numbered-steps scenes, in timeline order. */
  stepNumber?: number
  /** Actual measured pixel size of the video stage -- the cinematic templates
   * (Tech Title Scene, Three-Step Presenter Plan, Device Compatibility
   * Lineup) use this via DesignCanvas to scale their fixed design-space
   * layout uniformly instead of guessing font sizes from a small preview.
   * Undefined only very briefly before the stage's first ResizeObserver tick. */
  stageSize?: { width: number; height: number } | null
}

/** Explicit on-canvas position/size (Properties > Design > Position & Size),
 * expressed as percentages so it stays correct at any preview window size.
 * `xPct`/`yPct` are the box's TOP-LEFT corner (ScenePosition's own
 * coordinate contract -- see contentTransformMath.ts's applyScenePositionDrag
 * doc comment). `transform: 'none'` is required here, not cosmetic: several
 * templates' default (no-override) CSS class centers itself with
 * `transform: translate(-50%, -50%)`, which would otherwise survive
 * unchanged since an inline style only overrides properties it explicitly
 * sets -- silently shifting an explicitly-positioned box left/up by half its
 * own size and making it drift outside the canvas. Returns undefined when
 * the scene has no override, so templates fall back to their own default
 * anchored CSS layout (transform included). */
export function getPositionStyle(scene: Scene): CSSProperties | undefined {
  if (!scene.position) return undefined
  const { xPct, yPct, widthPct, heightPct } = scene.position
  return { left: `${xPct}%`, top: `${yPct}%`, width: `${widthPct}%`, height: `${heightPct}%`, bottom: 'auto', right: 'auto', transform: 'none' }
}

export function brandFontFamily(brand: BrandPreset, overrides?: Partial<BrandPreset>): string {
  const khmer = overrides?.khmerFont ?? brand.khmerFont
  const latin = overrides?.latinFont ?? brand.latinFont
  return `"${khmer}", "${latin}", "Leelawadee UI", sans-serif`
}

export function brandBoxRadius(brand: BrandPreset): number {
  if (brand.boxStyle === 'square') return 2
  if (brand.boxStyle === 'pill') return 999
  return 10
}

export function brandBoxBackground(brand: BrandPreset, colorHex: string): string {
  if (brand.backgroundStyle === 'translucent') return hexToRgba(colorHex, 0.82)
  if (brand.backgroundStyle === 'outline') return 'transparent'
  return colorHex
}

export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const full = clean.length === 3
    ? clean
        .split('')
        .map((c) => c + c)
        .join('')
    : clean
  const value = parseInt(full, 16)
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Fill + border + radius for a template's main "box" element -- per-scene
 * overrides (Properties > Design > Fill/Border) win when set, otherwise
 * falls back to the existing brand-driven look so scenes saved before these
 * fields existed keep rendering exactly as before. `defaultBorderColor` is
 * for templates (Statistic Callout, Comparison) that already draw an
 * accent-colored border via CSS `border: 2px solid` -- passing it keeps that
 * default while still letting a scene override just the color or width. */
export function resolveBoxStyle(scene: Scene, brand: BrandPreset, fallbackColorHex: string, defaultBorderColor?: string): CSSProperties {
  const fillBase = scene.fillColor ?? fallbackColorHex
  const background =
    scene.fillOpacity !== undefined ? hexToRgba(fillBase, Math.max(0, Math.min(100, scene.fillOpacity)) / 100) : brandBoxBackground(brand, fillBase)

  const style: CSSProperties = {
    background,
    borderRadius: scene.borderRadiusPx ?? brandBoxRadius(brand)
  }
  const borderColor = scene.borderColor ?? defaultBorderColor
  if (borderColor) style.borderColor = borderColor
  if (scene.borderWidthPx !== undefined) {
    style.borderWidth = scene.borderWidthPx
    style.borderStyle = 'solid'
  }
  return style
}

/** Per-scene text styling overrides (Properties > Design > Text) -- undefined
 * fields are omitted so a template's own default font size/weight/align/color
 * (usually inherited from CSS) still applies. */
export function resolveTextStyle(scene: Scene): CSSProperties {
  const style: CSSProperties = {}
  if (scene.fontSizePx) style.fontSize = scene.fontSizePx
  if (scene.fontWeight) style.fontWeight = scene.fontWeight === 'bold' ? 800 : scene.fontWeight === 'semibold' ? 600 : 400
  if (scene.textAlign) style.textAlign = scene.textAlign
  if (scene.textColor) style.color = scene.textColor
  return style
}

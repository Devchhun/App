import type { TemplateProps } from './templateShared'
import { brandFontFamily, brandBoxRadius, brandBoxBackground, getPositionStyle, resolveBoxStyle, resolveTextStyle } from './templateShared'
import { getMotionTransform } from './animation'
import { SceneIconGlyph } from './SceneIconGlyph'

const SPLIT_PATTERNS = [/\s+vs\.?\s+/i, /\s+\/\s+/]

function splitComparison(text: string): [string, string] | null {
  for (const pattern of SPLIT_PATTERNS) {
    if (pattern.test(text)) {
      const parts = text.split(pattern)
      if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
        return [parts[0].trim(), parts[1].trim()]
      }
    }
  }
  return null
}

export function Comparison({ scene, brand, motion }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const primary = overrides?.primaryColor ?? brand.primaryColor
  const secondary = overrides?.secondaryColor ?? brand.secondaryColor
  const accent = overrides?.accentColor ?? brand.accentColor
  const sides = splitComparison(scene.visualText)
  const positionStyle = getPositionStyle(scene)
  const textStyle = resolveTextStyle(scene)
  // Setting `transform` inline fully replaces the CSS class's static
  // translateX(-50%) centering (inline wins the whole property, not just a
  // diff), so the horizontal-centering half has to be folded in here too --
  // except when an explicit position override takes over left/top/width/height,
  // in which case centering no longer applies.
  const motionTransform = scene.animationPreset
    ? getMotionTransform(scene.animationPreset, motion)
    : `translateY(${20 * (1 - motion.enterProgress) - 20 * motion.exitProgress}px)`
  const transform = positionStyle ? motionTransform : `translateX(-50%) ${motionTransform}`

  return (
    <div
      data-scene-id={scene.id}
      className="scene-graphic scene-graphic-comparison"
      style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle, transform }}
    >
      {sides ? (
        <div
          className={`scene-graphic-comparison-split${positionStyle ? ' scene-graphic-fill' : ''}`}
          style={{ borderRadius: scene.borderRadiusPx ?? brandBoxRadius(brand) }}
        >
          <div className="scene-graphic-comparison-side" style={{ background: brandBoxBackground(brand, primary) }}>
            <SceneIconGlyph icon={scene.icon} defaultColor="#fff" defaultSize={18} />
            <span lang="km" style={textStyle}>
              {sides[0]}
            </span>
          </div>
          <span className="scene-graphic-comparison-vs" style={{ background: accent }}>
            VS
          </span>
          <div className="scene-graphic-comparison-side" style={{ background: brandBoxBackground(brand, secondary) }}>
            {/* Left/right sides currently mirror the same configured icon --
                Scene only carries one icon slot; independent left vs. right
                icons would need a second field and are deferred. */}
            <SceneIconGlyph icon={scene.icon} defaultColor="#fff" defaultSize={18} />
            <span lang="km" style={textStyle}>
              {sides[1]}
            </span>
          </div>
        </div>
      ) : (
        <div
          className={`scene-graphic-comparison-single${positionStyle ? ' scene-graphic-fill' : ''}`}
          style={resolveBoxStyle(scene, brand, primary, accent)}
        >
          <SceneIconGlyph icon={scene.icon} defaultColor="#fff" defaultSize={18} />
          <span lang="km" style={textStyle}>
            {scene.visualText}
          </span>
        </div>
      )}
    </div>
  )
}

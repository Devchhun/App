import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, resolveTextStyle } from './templateShared'
import { getMotionTransform } from './animation'
import { SceneIconGlyph } from './SceneIconGlyph'

const RADIUS = 32
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function extractPercent(text: string): number {
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/)
  if (match) return Math.min(100, Math.max(0, parseFloat(match[1])))
  return 50
}

/** A radial percentage ring with a label -- for statistics expressed as a percentage. */
export function PercentageCard({ scene, brand, motion }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const primary = overrides?.primaryColor ?? brand.primaryColor
  const accent = overrides?.accentColor ?? brand.accentColor
  const pct = scene.content?.value ? extractPercent(scene.content.value) : extractPercent(scene.visualText)
  const positionStyle = getPositionStyle(scene)
  const transform = scene.animationPreset
    ? getMotionTransform(scene.animationPreset, motion)
    : `scale(${0.85 + 0.15 * motion.enterProgress - 0.05 * motion.exitProgress})`
  const dashOffset = CIRCUMFERENCE * (1 - (pct / 100) * motion.enterProgress)

  return (
    <div
      data-scene-id={scene.id}
      className="scene-graphic scene-graphic-percentage"
      style={{ opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides), ...positionStyle, transform }}
    >
      <div
        className={`scene-graphic-percentage-inner${positionStyle ? ' scene-graphic-fill' : ''}`}
        style={{ background: primary, borderRadius: scene.borderRadiusPx ?? 16 }}
      >
        <svg className="scene-graphic-percentage-ring" viewBox="0 0 72 72" width="72" height="72">
          <circle cx="36" cy="36" r={RADIUS} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="6" />
          <circle
            cx="36"
            cy="36"
            r={RADIUS}
            fill="none"
            stroke={accent}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 36 36)"
          />
          <text x="36" y="41" textAnchor="middle" className="scene-graphic-percentage-number">
            {Math.round(pct)}%
          </text>
        </svg>
        <span className="scene-graphic-percentage-label-row">
          <SceneIconGlyph icon={scene.icon} defaultColor={accent} defaultSize={16} />
          <span className="scene-graphic-percentage-label" lang="km" style={resolveTextStyle(scene)}>
            {scene.content?.title ?? scene.visualText}
          </span>
        </span>
      </div>
    </div>
  )
}

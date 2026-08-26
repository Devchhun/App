import type { TemplateProps } from './templateShared'
import { brandFontFamily, getPositionStyle, hexToRgba } from './templateShared'
import { remap } from './animation'
import { computeTemplateMotionFrame, resolveMotionOptions, loopProgress } from './motion'
import { SceneIconGlyph } from './SceneIconGlyph'
import { DesignCanvas } from './DesignCanvas'
import { SceneContentFrame } from './SceneContentFrame'
import { SceneBackgroundLayer } from './SceneBackgroundLayer'
import { isCompactAspectRatio } from './designScale'
import { resolveEffectiveContentTransform } from '../scenes/contentTransformReflow'
import { getEffectivePresentationMode } from '@shared/templates'
import type { SceneContentItem } from '@shared/project'

const DEFAULT_ITEMS: SceneContentItem[] = [
  { id: 'reality-real', label: "Wang Lin's Life", description: 'Chapter 1 onward, real events', value: 'REAL EVENTS', color: '#18d77b' },
  { id: 'reality-dream', label: "Lu Mo's Dao Dream", description: 'Repeated simulation, branching', value: 'SIMULATION / CALCULATION', color: '#b45bff' }
]

export const INTRINSIC_SIZE = { width: 1500, height: 480 }
export const INTRINSIC_SIZE_COMPACT = { width: 640, height: 780 }

export function deriveRealityDreamSides(scene: TemplateProps['scene']): SceneContentItem[] {
  if (scene.content?.items?.length) return scene.content.items.slice(0, 2)
  return DEFAULT_ITEMS
}

/** Visualization family B -- a split composition separating real story
 * events (left) from Lu Mo's Dao Dream simulation/calculation (right),
 * divided by a labeled connector. The real side animates its entrance once;
 * the simulation side keeps a small repeating branch animation for as long
 * as the scene holds, visually distinguishing "this happened" from "this
 * was calculated over and over." */
export function RealityVsDaoDream({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const positionStyle = !isFullFrame ? getPositionStyle(scene) : undefined
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const sides = deriveRealityDreamSides(scene)
  const real = sides[0]
  const dream = sides[1]
  const dividerLabel = scene.content?.value

  const options = resolveMotionOptions(scene, 'cinematic')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const enter = frame.enterProgress
  const realP = remap(enter, 0, 0.4)
  const dividerP = remap(enter, 0.25, 0.55)
  const dreamP = remap(enter, 0.35, 0.75)
  const branchT = frame.loopEnabled ? loopProgress(frame.holdTime, frame.loopSpeed, 2.4) : 0

  const realColor = real?.color ?? '#18d77b'
  const dreamColor = dream?.color ?? '#b45bff'

  const composition = (
    <div className={`scene-graphic-reality-dream${compact ? ' scene-graphic-reality-dream-compact' : ''}`}>
      {real && (
        <div
          className="scene-reality-side scene-reality-side-real"
          style={{ opacity: realP, transform: `translateY(${(1 - realP) * 12}px)`, borderColor: `${realColor}77`, background: hexToRgba(realColor, 0.12) }}
        >
          {real.value && (
            <span className="scene-flow-node-eyebrow" style={{ color: realColor }}>
              {real.value}
            </span>
          )}
          <SceneIconGlyph icon={{ iconId: real.iconId, color: realColor }} defaultColor={realColor} defaultSize={22} />
          <span className="scene-flow-node-title" lang="km">
            {real.label}
          </span>
          {real.description && (
            <span className="scene-flow-node-subtitle" lang="km">
              {real.description}
            </span>
          )}
          <span className="scene-reality-real-track" style={{ opacity: realP }}>
            <span className="scene-reality-real-track-line" style={{ transform: `scaleX(${realP})`, background: realColor }} />
          </span>
        </div>
      )}

      <div className="scene-reality-divider" style={{ opacity: dividerP }}>
        <span className="scene-reality-divider-line" style={{ background: accent }} />
        {dividerLabel && (
          <span className="scene-reality-divider-label" lang="km">
            {dividerLabel}
          </span>
        )}
      </div>

      {dream && (
        <div
          className="scene-reality-side scene-reality-side-dream"
          style={{ opacity: dreamP, transform: `translateY(${(1 - dreamP) * 12}px)`, borderColor: `${dreamColor}77`, background: hexToRgba(dreamColor, 0.12) }}
        >
          {dream.value && (
            <span className="scene-flow-node-eyebrow" style={{ color: dreamColor }}>
              {dream.value}
            </span>
          )}
          <SceneIconGlyph icon={{ iconId: dream.iconId, color: dreamColor }} defaultColor={dreamColor} defaultSize={22} />
          <span className="scene-flow-node-title" lang="km">
            {dream.label}
          </span>
          {dream.description && (
            <span className="scene-flow-node-subtitle" lang="km">
              {dream.description}
            </span>
          )}
          <div className="scene-reality-branches" style={{ opacity: dreamP }}>
            {[0, 1, 2].map((i) => {
              const t = (branchT + i / 3) % 1
              const failed = i !== 2
              return (
                <span
                  key={i}
                  className="scene-reality-branch-line"
                  style={{
                    background: failed ? '#ff5364' : '#ffd166',
                    opacity: failed ? remap(1 - Math.abs(t - 0.5) * 2, 0, 1) * 0.8 : 1,
                    transform: `scaleX(${remap(t, 0, 0.6)}) rotate(${(i - 1) * 8}deg)`
                  }}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )

  const intrinsic = compact ? INTRINSIC_SIZE_COMPACT : INTRINSIC_SIZE

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div style={{ position: 'absolute', inset: 0, opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides) }}>
        {isFullFrame && <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={dividerP} defaultMode="transparent" />}

        {isFullFrame ? (
          <SceneContentFrame
            transform={resolveEffectiveContentTransform(scene, scene.templateId, brand.defaultAspectRatio)}
            aspectRatio={brand.defaultAspectRatio}
            intrinsicWidth={intrinsic.width}
            intrinsicHeight={intrinsic.height}
            dataSceneId={scene.id}
          >
            {composition}
          </SceneContentFrame>
        ) : (
          <div
            data-scene-id={scene.id}
            className={positionStyle ? 'scene-graphic-fill' : undefined}
            style={{ position: 'absolute', ...(positionStyle ?? { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }) }}
          >
            {composition}
          </div>
        )}
      </div>
    </DesignCanvas>
  )
}

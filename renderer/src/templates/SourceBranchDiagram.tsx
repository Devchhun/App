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
  { id: 'source-wang-lin', label: 'Wang Lin', description: 'Source identity', value: 'SOURCE', color: '#5b8cff' },
  { id: 'branch-lu-mo', label: 'Lu Mo', description: 'Slaughter Essence, sent into the past', value: 'BRANCH', color: '#b45bff' }
]

export const INTRINSIC_SIZE = { width: 1500, height: 320 }
export const INTRINSIC_SIZE_COMPACT = { width: 640, height: 640 }

export function deriveSourceBranchNodes(scene: TemplateProps['scene']): SceneContentItem[] {
  if (scene.content?.items?.length) return scene.content.items.slice(0, 2)
  return DEFAULT_ITEMS
}

/** Visualization family F -- a source node with a branch line leading to a
 * second, related-but-distinct node, carrying a relationship label (e.g.
 * "created_from", "sent_to_past") along the connector. Generic over any
 * `NarrativeRelation` between two entities, not hardcoded to Wang Lin/Lu Mo
 * -- reusable for any created-from/split-from/sent-to-past pair the
 * Narrative Graph finds. The connecting line stays visible throughout, per
 * the spec's requirement that the branch never reads as fully severed from
 * its source. */
export function SourceBranchDiagram({ scene, brand, motion, currentTime, stageSize }: TemplateProps): JSX.Element {
  const overrides = scene.brandOverrides
  const accent = overrides?.accentColor ?? brand.accentColor
  const mode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = mode === 'full-frame'
  const positionStyle = !isFullFrame ? getPositionStyle(scene) : undefined
  const compact = isCompactAspectRatio(brand.defaultAspectRatio)
  const nodes = deriveSourceBranchNodes(scene)
  const source = nodes[0]
  const branch = nodes[1]
  const relationLabel = scene.content?.value ?? scene.content?.subtitle

  const options = resolveMotionOptions(scene, 'technical')
  const frame = computeTemplateMotionFrame(currentTime, scene.startTime, scene.endTime, options)
  const enter = frame.enterProgress
  const sourceP = remap(enter, 0, 0.3)
  const connectorP = remap(enter, 0.22, 0.6)
  const branchP = remap(enter, 0.5, 0.85)
  const dotT = frame.loopEnabled && connectorP >= 1 ? loopProgress(frame.holdTime, frame.loopSpeed, 2.2) : null

  const sourceColor = source?.color ?? accent
  const branchColor = branch?.color ?? '#b45bff'

  const composition = (
    <div className={`scene-graphic-flow scene-graphic-source-branch${compact ? ' scene-graphic-flow-compact' : ''}`}>
      <div className="scene-flow-main">
        {source && (
          <div
            className="scene-flow-node"
            style={{ opacity: sourceP, transform: `translateY(${(1 - sourceP) * 14}px)`, borderColor: `${sourceColor}77`, background: hexToRgba(sourceColor, 0.14) }}
          >
            {source.value && (
              <span className="scene-flow-node-eyebrow" style={{ color: sourceColor }}>
                {source.value}
              </span>
            )}
            <SceneIconGlyph icon={{ iconId: source.iconId, color: sourceColor }} defaultColor={sourceColor} defaultSize={24} />
            <span className="scene-flow-node-title" lang="km">
              {source.label}
            </span>
            {source.description && (
              <span className="scene-flow-node-subtitle" lang="km">
                {source.description}
              </span>
            )}
          </div>
        )}

        <span className="scene-flow-connector scene-source-branch-connector" style={{ opacity: connectorP }}>
          {relationLabel && (
            <span className="scene-source-branch-label" lang="km" style={{ color: accent, opacity: connectorP }}>
              {relationLabel}
            </span>
          )}
          <span className="scene-flow-connector-line" style={{ transform: `scaleX(${connectorP})`, background: accent }} />
          <span className="scene-flow-connector-arrow" style={{ opacity: remap(connectorP, 0.75, 1), borderLeftColor: accent }} />
          {dotT !== null && <span className="scene-flow-connector-dot" style={{ left: `${dotT * 100}%`, background: accent }} />}
        </span>

        {branch && (
          <div
            className="scene-flow-node"
            style={{ opacity: branchP, transform: `translateY(${(1 - branchP) * 14}px)`, borderColor: `${branchColor}77`, background: hexToRgba(branchColor, 0.14) }}
          >
            {branch.value && (
              <span className="scene-flow-node-eyebrow" style={{ color: branchColor }}>
                {branch.value}
              </span>
            )}
            <SceneIconGlyph icon={{ iconId: branch.iconId, color: branchColor }} defaultColor={branchColor} defaultSize={24} />
            <span className="scene-flow-node-title" lang="km">
              {branch.label}
            </span>
            {branch.description && (
              <span className="scene-flow-node-subtitle" lang="km">
                {branch.description}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )

  const intrinsic = compact ? INTRINSIC_SIZE_COMPACT : INTRINSIC_SIZE

  return (
    <DesignCanvas aspectRatio={brand.defaultAspectRatio} stageSize={stageSize ?? null}>
      <div style={{ position: 'absolute', inset: 0, opacity: motion.opacity, fontFamily: brandFontFamily(brand, scene.brandOverrides) }}>
        {isFullFrame && <SceneBackgroundLayer background={scene.background} fallbackColor={accent} progress={connectorP} defaultMode="transparent" />}

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

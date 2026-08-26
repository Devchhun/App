import type { Scene, BrandPreset } from '@shared/project'
import { computeSceneMotion } from './animation'
import { getTemplate } from './registry'

interface Props {
  scenes: Scene[]
  brand: BrandPreset
  currentTime: number
  /** Unused for visibility now (see isSceneVisibleAt) -- kept only so a
   * selected scene can still receive `stageSize` styling/measurement hooks
   * later without a prop-shape change; selection no longer overrides
   * time-based visibility (see isSceneVisibleAt / Timeline's seek-on-select). */
  selectedSceneId?: string | null
  /** Actual measured stage pixel size, forwarded to every template so the
   * cinematic templates can scale their design-space layout uniformly. */
  stageSize?: { width: number; height: number } | null
}

/** A scene renders during ordinary playback/scrubbing if and only if the
 * playhead is inside its [startTime, endTime) range -- selection alone must
 * never keep a scene visible outside that range (that would silently show a
 * scene at a timeline position it doesn't actually occupy). Pure and
 * unit-tested directly; GraphicsOverlay is a thin renderer around it. */
export function isSceneVisibleAt(currentTime: number, scene: Pick<Scene, 'startTime' | 'endTime'>): boolean {
  return currentTime >= scene.startTime && currentTime < scene.endTime
}

/** Renders active graphics as plain, absolutely-positioned DOM elements driven
 * by the video's currentTime, rather than through a Remotion <Player>. Since
 * the Electron renderer is itself Chromium, DOM text already gets correct
 * Khmer shaping (HarfBuzz/Skia) without Remotion in the loop -- Remotion's
 * real value is WYSIWYG with the Node-side export renderer, which is a
 * Phase G (export) concern, not required for this editable preview. */
export function GraphicsOverlay({ scenes, brand, currentTime, stageSize }: Props): JSX.Element {
  const visibleScenes = scenes.filter((s) => s.status !== 'rejected')
  const stepScenesInOrder = visibleScenes.filter((s) => s.templateId === 'numbered-steps').sort((a, b) => a.startTime - b.startTime)
  // Bring Forward / Send Backward reorders zIndex, which determines paint
  // order here (later siblings paint on top) independent of timeline position.
  const paintOrder = [...visibleScenes].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))

  return (
    <div className="graphics-overlay">
      {paintOrder.map((scene) => {
        if (!isSceneVisibleAt(currentTime, scene)) return null
        const inSeconds = scene.animationInDurationSeconds ?? scene.animationDurationSeconds
        const outSeconds = scene.animationOutDurationSeconds ?? scene.animationDurationSeconds
        const motion = computeSceneMotion(currentTime, scene.startTime, scene.endTime, {
          intensity: brand.animationIntensity,
          enterSeconds: inSeconds,
          exitSeconds: outSeconds,
          easing: scene.animationEasing
        })
        if (!motion.visible) return null
        // A scene can reference a templateId the current build no longer
        // registers (a hand-edited/corrupted project file, or a project
        // saved by a future version with a template this one doesn't know)
        // -- skip just that one scene rather than crashing the whole Preview.
        const template = getTemplate(scene.templateId)
        if (!template) return null
        const Component = template.component
        const stepNumber = scene.templateId === 'numbered-steps' ? stepScenesInOrder.findIndex((s) => s.id === scene.id) + 1 : undefined
        return <Component key={scene.id} scene={scene} brand={brand} motion={motion} currentTime={currentTime} stepNumber={stepNumber} stageSize={stageSize} />
      })}
    </div>
  )
}

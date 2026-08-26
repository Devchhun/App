import type { Scene, SceneContent } from '@shared/project'
import type { ScenePlanScene } from '@shared/localAi'
import { defaultContentForTemplate } from '../templates/defaultContent'

function isContentEmpty(content: ScenePlanScene['content']): boolean {
  return !content.eyebrow && !content.title && !content.subtitle && !content.body && !content.value && (!content.items || content.items.length === 0) && !content.cta
}

/** Converts one validated (shared/localAi.ts's validateScenePlan has
 * already run) ScenePlanScene into a real, insertable Scene -- the only
 * place a ScenePlanScene ever becomes a Scene, called once per accepted
 * plan item at "Apply" time (never earlier; the preview list the user
 * reviews works entirely off ScenePlanScene, never a half-built Scene).
 * `track` is supplied by the caller's own placement routing (see
 * scenePlacementPlanning.ts) -- matches insertScene's own established
 * "track/atTime are already a valid, non-overlapping placement by the time
 * this runs" contract.
 *
 * `suggestionId` is deliberately prefixed `local-ai-` (distinct from the
 * cloud path's raw AiSuggestion.id and from insertScene's `manual-` prefix)
 * so syncScenes.ts -- which reconciles Scenes against the CLOUD suggestion
 * list -- can never mistake a locally-planned scene for one of its own and
 * delete/overwrite it when cloud suggestions regenerate. */
export function scenePlanSceneToScene(planScene: ScenePlanScene, mediaId: string, track: string, originalText: string): Scene {
  const id = crypto.randomUUID()
  const defaults = defaultContentForTemplate(planScene.templateId, id)
  const content: SceneContent | undefined = isContentEmpty(planScene.content) ? defaults?.content : planScene.content
  const background =
    planScene.background || defaults?.background
      ? {
          mode: planScene.background?.mode ?? defaults?.background?.mode,
          glowColor: planScene.background?.glowColor ?? defaults?.background?.glowColor,
          intensity: planScene.background?.opacity ?? defaults?.background?.intensity
        }
      : undefined

  return {
    id,
    mediaId,
    segmentId: planScene.segmentId,
    suggestionId: `local-ai-${id}`,
    track,
    templateId: planScene.templateId,
    startTime: planScene.startTime,
    endTime: planScene.endTime,
    purpose: planScene.purpose,
    originalText,
    visualText: content?.title ?? content?.value ?? content?.eyebrow ?? defaults?.visualText ?? 'New text',
    reason: planScene.explanation,
    confidence: planScene.confidence,
    locked: false,
    edited: false,
    status: 'accepted',
    createdAt: new Date().toISOString(),
    content,
    icon: planScene.icon ?? defaults?.icon,
    presentationMode: planScene.presentationMode ?? defaults?.presentationMode,
    background,
    motionPreset: planScene.motion?.preset,
    motionIntensity: planScene.motion?.intensity,
    staggerDelay: planScene.motion?.stagger,
    loopEnabled: planScene.motion?.loop
  }
}

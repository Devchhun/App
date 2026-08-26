import type { Scene, SceneContent, SceneContentItem } from '@shared/project'
import type { CommunicationPurpose } from '@shared/suggestions'
import type { StoryBeat, NarrativeEntity, NarrativeRelation, StoryVisualTheme, VisualizationType } from '@shared/story'

/** Deterministic templateId -> CommunicationPurpose mapping (Scene.purpose
 * is typed as CommunicationPurpose; StoryBeat.purpose is free text per the
 * spec's own NarrativeGraph shape, so it can't be used directly). Keyed by
 * the recommended visualization rather than parsed from the beat's own
 * free-text purpose, so this never depends on guessing intent from natural
 * language. */
const VISUALIZATION_PURPOSE: Record<VisualizationType, CommunicationPurpose> = {
  'central-identity': 'introduction',
  'reality-vs-dream': 'comparison',
  'body-vs-avatar': 'comparison',
  'source-branch': 'cause',
  'chapter-evidence': 'conclusion',
  'final-summary': 'conclusion'
}

function resolveColor(entity: NarrativeEntity, theme: StoryVisualTheme): string {
  return theme.entityColors[entity.id] ?? entity.color
}

function entityToItem(entity: NarrativeEntity, theme: StoryVisualTheme): SceneContentItem {
  return {
    id: entity.id,
    label: entity.canonicalName,
    description: entity.description.slice(0, 200),
    iconId: entity.iconId,
    color: resolveColor(entity, theme)
  }
}

function buildContent(
  beat: StoryBeat,
  entities: NarrativeEntity[],
  relations: NarrativeRelation[],
  entitiesById: ReadonlyMap<string, NarrativeEntity>,
  theme: StoryVisualTheme
): { content: SceneContent; fillColor?: string; iconId?: NarrativeEntity['iconId'] } {
  const primary = entities[0]

  switch (beat.recommendedVisualization) {
    case 'central-identity': {
      const fillColor = primary ? resolveColor(primary, theme) : undefined
      return {
        fillColor,
        iconId: primary?.iconId,
        content: {
          title: primary?.canonicalName ?? beat.title,
          value: beat.summary.slice(0, 80),
          eyebrow: beat.importance === 'critical' && primary ? `The same ${primary.canonicalName}` : undefined
        }
      }
    }
    case 'reality-vs-dream':
      return {
        content: { eyebrow: beat.title, value: beat.summary.slice(0, 100), items: entities.slice(0, 2).map((e) => entityToItem(e, theme)) }
      }
    case 'body-vs-avatar':
      return {
        content: {
          title: primary?.canonicalName ?? beat.title,
          value: primary ? `Same ${primary.canonicalName}` : beat.title,
          items: entities.slice(0, 2).map((e) => entityToItem(e, theme))
        }
      }
    case 'source-branch': {
      const relation = relations[0]
      return {
        content: {
          eyebrow: beat.title,
          value: relation?.label ?? beat.title,
          items: entities.slice(0, 2).map((e) => entityToItem(e, theme))
        }
      }
    }
    case 'chapter-evidence': {
      const fillColor = primary ? resolveColor(primary, theme) : undefined
      return {
        fillColor,
        iconId: primary?.iconId,
        content: { eyebrow: beat.evidence?.[0], title: beat.title, body: beat.summary.slice(0, 200), value: 'Evidence' }
      }
    }
    case 'final-summary': {
      const relationPoints: SceneContentItem[] = relations.slice(0, 3).map((r) => {
        const target = entitiesById.get(r.toEntityId)
        return { id: r.id, label: r.label, color: target ? resolveColor(target, theme) : undefined }
      })
      const remaining = Math.max(0, 3 - relationPoints.length)
      const entityPoints: SceneContentItem[] = entities.slice(0, remaining).map((e) => entityToItem(e, theme))
      return {
        content: { title: primary?.canonicalName ?? beat.title, items: [...relationPoints, ...entityPoints] }
      }
    }
  }
}

/** Converts one ACCEPTED StoryBeat (from a media's VisualPlan) into a real,
 * insertable Scene -- the only place a StoryBeat ever becomes a Scene,
 * called once per accepted plan item at "Generate Accepted Graphics" time
 * (mirrors scenePlanSceneToScene's own "propose, review, convert on accept"
 * shape one level up: a StoryBeat is lighter than Scene the same way a
 * ScenePlanScene is). Entity colors/icons are resolved through `theme` here
 * (never at render time) so continuity is a baked-in data fact on the Scene
 * itself, matching the plan's "data-level continuity" scope decision --
 * `theme.entityColors[entityId]` wins over the entity's own stored color so
 * a user's theme edit after generation is what every new scene reflects.
 *
 * `track` is supplied by the caller's own placement routing (see
 * scenePlacementPlanning.ts), matching insertScene/scenePlanSceneToScene's
 * established "track/atTime are already a valid, non-overlapping placement
 * by the time this runs" contract. `suggestionId` is prefixed `story-`
 * (distinct from `local-ai-`/cloud raw ids/`manual-`) so syncScenes.ts can
 * never mistake a story-generated scene for one of its own. */
export function storyBeatToScene(
  beat: StoryBeat,
  mediaId: string,
  track: string,
  theme: StoryVisualTheme,
  entitiesById: ReadonlyMap<string, NarrativeEntity>,
  relationsById: ReadonlyMap<string, NarrativeRelation>
): Scene {
  const id = crypto.randomUUID()
  const entities = beat.entities.map((eid) => entitiesById.get(eid)).filter((e): e is NarrativeEntity => !!e)
  const relations = beat.relations.map((rid) => relationsById.get(rid)).filter((r): r is NarrativeRelation => !!r)
  const { content, fillColor, iconId } = buildContent(beat, entities, relations, entitiesById, theme)
  const primary = entities[0]

  return {
    id,
    mediaId,
    // A story beat may span multiple transcript segments (spec Section 8: "do
    // not force one scene per segment") -- the first is used only as the
    // scene's own sync anchor, matching how the rest of the app already
    // treats segmentId as "where this came from," not "everything it covers."
    segmentId: beat.segmentIds[0] ?? '',
    suggestionId: `story-${id}`,
    track,
    templateId: beat.recommendedVisualization,
    startTime: beat.startTime,
    endTime: beat.endTime,
    purpose: VISUALIZATION_PURPOSE[beat.recommendedVisualization],
    originalText: beat.summary,
    visualText: primary?.canonicalName ?? beat.title,
    reason: beat.purpose,
    confidence: 1,
    locked: false,
    edited: false,
    status: 'accepted',
    createdAt: new Date().toISOString(),
    content,
    fillColor,
    icon: iconId ? { iconId, color: fillColor } : undefined
  }
}

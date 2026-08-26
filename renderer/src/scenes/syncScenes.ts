// Pure logic (no React/Electron deps) for keeping a media item's graphics
// scenes in sync with its accepted AI suggestions. A scene is auto-created
// for each newly-accepted suggestion and auto-updated as the suggestion's
// text/timing changes -- but the moment a user locks or hand-edits a scene,
// it's treated as their work and left alone (mirrors the suggestion-side
// accepted/locked/edited preservation rule in mergeSuggestions.ts).
import type { AiSuggestion } from '@shared/suggestions'
import type { Scene } from '@shared/project'
import { DEFAULT_TEMPLATE_FOR_PURPOSE } from '@shared/templates'

/** AI-suggestion-generated scenes always land on the fixed 'V2' overlay
 * track -- these are auto-created in bulk from a whole suggestion batch, not
 * a single user-driven "Add" action, so per-instance collision-avoiding
 * track routing (see renderer/src/timeline/trackModel.ts) doesn't apply
 * here the same way it does to manual template insertion. */
const DEFAULT_GRAPHICS_TRACK = 'V2'

export function syncScenesFromSuggestions(mediaId: string, existingScenes: Scene[], suggestions: AiSuggestion[]): Scene[] {
  const byId = new Map(suggestions.map((s) => [s.id, s]))
  const acceptedById = new Map(suggestions.filter((s) => s.status === 'accepted').map((s) => [s.id, s]))
  const result: Scene[] = []

  for (const scene of existingScenes) {
    // A scene whose suggestionId doesn't match ANY suggestion for this
    // media (accepted or not) never originated from this suggestion batch
    // in the first place -- it's from a different pipeline entirely (manual
    // insert, Local AI Planner's `local-ai-` scenes, Story Visualization's
    // `story-` scenes). This reconciliation sweep must never touch those:
    // only a scene that WAS suggestion-derived can be dropped when its own
    // suggestion disappears/gets rejected.
    if (!byId.has(scene.suggestionId)) {
      result.push(scene)
      continue
    }
    const suggestion = acceptedById.get(scene.suggestionId)
    if (!suggestion) {
      // Suggestion is gone or no longer accepted -- drop the scene, unless
      // the user's manual work on it (lock, edit, or an explicit unlink)
      // should be preserved.
      if (scene.locked || scene.edited || scene.linked === false) result.push(scene)
      continue
    }
    acceptedById.delete(suggestion.id)

    if (scene.locked || scene.edited || scene.linked === false) {
      result.push(scene)
      continue
    }

    result.push({
      ...scene,
      startTime: suggestion.startTime,
      endTime: suggestion.endTime,
      purpose: suggestion.purpose,
      originalText: suggestion.originalText,
      visualText: suggestion.visualText,
      reason: suggestion.reason,
      confidence: suggestion.confidence
    })
  }

  for (const suggestion of acceptedById.values()) {
    result.push({
      id: crypto.randomUUID(),
      mediaId,
      segmentId: suggestion.segmentId,
      suggestionId: suggestion.id,
      track: DEFAULT_GRAPHICS_TRACK,
      templateId: DEFAULT_TEMPLATE_FOR_PURPOSE[suggestion.purpose],
      startTime: suggestion.startTime,
      endTime: suggestion.endTime,
      purpose: suggestion.purpose,
      originalText: suggestion.originalText,
      visualText: suggestion.visualText,
      reason: suggestion.reason,
      confidence: suggestion.confidence,
      locked: false,
      edited: false,
      status: 'accepted',
      createdAt: new Date().toISOString()
    })
  }

  result.sort((a, b) => a.startTime - b.startTime)
  return result
}

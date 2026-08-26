import { describe, it, expect } from 'vitest'
import { syncScenesFromSuggestions } from './syncScenes'
import type { AiSuggestion } from '@shared/suggestions'
import type { Scene } from '@shared/project'

function makeSuggestion(overrides: Partial<AiSuggestion> & { id: string; segmentId: string; startTime: number }): AiSuggestion {
  return {
    mediaId: 'media-1',
    endTime: overrides.startTime + 1,
    purpose: 'warning',
    originalText: 'original',
    visualText: 'visual',
    reason: 'reason',
    confidence: 0.8,
    status: 'accepted',
    locked: false,
    edited: false,
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

function makeScene(overrides: Partial<Scene> & { id: string; suggestionId: string; startTime: number }): Scene {
  return {
    mediaId: 'media-1',
    segmentId: 'seg',
    track: 'V2',
    templateId: 'warning-alert',
    endTime: overrides.startTime + 1,
    purpose: 'warning',
    originalText: 'original',
    visualText: 'visual',
    reason: 'reason',
    confidence: 0.8,
    locked: false,
    edited: false,
    status: 'accepted',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

describe('syncScenesFromSuggestions', () => {
  it('creates a scene for each newly-accepted suggestion using the purpose-default template', () => {
    const suggestions = [makeSuggestion({ id: 's1', segmentId: 'seg1', startTime: 0, purpose: 'warning' })]
    const scenes = syncScenesFromSuggestions('media-1', [], suggestions)
    expect(scenes).toHaveLength(1)
    expect(scenes[0].suggestionId).toBe('s1')
    expect(scenes[0].templateId).toBe('warning-alert')
    expect(scenes[0].track).toBe('V2')
  })

  it('does not create a scene for a suggestion that is not accepted', () => {
    const suggestions = [makeSuggestion({ id: 's1', segmentId: 'seg1', startTime: 0, status: 'suggested' })]
    const scenes = syncScenesFromSuggestions('media-1', [], suggestions)
    expect(scenes).toHaveLength(0)
  })

  it('refreshes text/timing on an unlocked, unedited scene when its suggestion changes', () => {
    const suggestion = makeSuggestion({ id: 's1', segmentId: 'seg1', startTime: 5, visualText: 'updated text' })
    const existing = [makeScene({ id: 'scene-1', suggestionId: 's1', startTime: 0, visualText: 'stale text' })]
    const scenes = syncScenesFromSuggestions('media-1', existing, [suggestion])
    expect(scenes).toHaveLength(1)
    expect(scenes[0].visualText).toBe('updated text')
    expect(scenes[0].startTime).toBe(5)
  })

  it('preserves a locked scene even when the underlying suggestion changes', () => {
    const suggestion = makeSuggestion({ id: 's1', segmentId: 'seg1', startTime: 5, visualText: 'updated text' })
    const existing = [makeScene({ id: 'scene-1', suggestionId: 's1', startTime: 0, visualText: 'manual text', locked: true })]
    const scenes = syncScenesFromSuggestions('media-1', existing, [suggestion])
    expect(scenes).toHaveLength(1)
    expect(scenes[0].visualText).toBe('manual text')
    expect(scenes[0].startTime).toBe(0)
  })

  it('preserves an edited scene even when the underlying suggestion changes', () => {
    const suggestion = makeSuggestion({ id: 's1', segmentId: 'seg1', startTime: 5, visualText: 'updated text' })
    const existing = [makeScene({ id: 'scene-1', suggestionId: 's1', startTime: 0, visualText: 'hand-edited text', edited: true })]
    const scenes = syncScenesFromSuggestions('media-1', existing, [suggestion])
    expect(scenes[0].visualText).toBe('hand-edited text')
  })

  it('drops a scene whose suggestion is no longer accepted, unless locked or edited', () => {
    const rejectedSuggestion = makeSuggestion({ id: 's1', segmentId: 'seg1', startTime: 0, status: 'rejected' })
    const plainScene = [makeScene({ id: 'scene-1', suggestionId: 's1', startTime: 0 })]
    expect(syncScenesFromSuggestions('media-1', plainScene, [rejectedSuggestion])).toHaveLength(0)

    const lockedScene = [makeScene({ id: 'scene-2', suggestionId: 's1', startTime: 0, locked: true })]
    expect(syncScenesFromSuggestions('media-1', lockedScene, [rejectedSuggestion])).toHaveLength(1)

    const editedScene = [makeScene({ id: 'scene-3', suggestionId: 's1', startTime: 0, edited: true })]
    expect(syncScenesFromSuggestions('media-1', editedScene, [rejectedSuggestion])).toHaveLength(1)
  })

  it('preserves an explicitly unlinked scene even when unlocked/unedited and its suggestion is gone', () => {
    const rejectedSuggestion = makeSuggestion({ id: 's1', segmentId: 'seg1', startTime: 0, status: 'rejected' })
    const unlinkedScene = [makeScene({ id: 'scene-1', suggestionId: 's1', startTime: 0, linked: false })]
    const scenes = syncScenesFromSuggestions('media-1', unlinkedScene, [rejectedSuggestion])
    expect(scenes).toHaveLength(1)
    expect(scenes[0].id).toBe('scene-1')
  })

  it('preserves an unlinked scene as-is even when its suggestion is still accepted and changed', () => {
    const suggestion = makeSuggestion({ id: 's1', segmentId: 'seg1', startTime: 5, visualText: 'updated text' })
    const unlinkedScene = [makeScene({ id: 'scene-1', suggestionId: 's1', startTime: 0, visualText: 'frozen text', linked: false })]
    const scenes = syncScenesFromSuggestions('media-1', unlinkedScene, [suggestion])
    expect(scenes[0].visualText).toBe('frozen text')
    expect(scenes[0].startTime).toBe(0)
  })

  it('never touches a scene whose suggestionId does not match any suggestion for this media (Local AI Planner / Story Visualization scenes)', () => {
    // Regression test: a real live run showed every Story-Visualization-
    // generated scene (suggestionId prefixed "story-") getting silently
    // wiped the moment ANY AI Suggestion changed for the same media, even
    // though none of those scenes ever came from a suggestion at all.
    const suggestions = [makeSuggestion({ id: 's1', segmentId: 'seg1', startTime: 0 })]
    const localAiScene = makeScene({ id: 'scene-1', suggestionId: 'local-ai-abc123', startTime: 10 })
    const storyScene = makeScene({ id: 'scene-2', suggestionId: 'story-def456', startTime: 20 })
    const manualScene = makeScene({ id: 'scene-3', suggestionId: 'manual-ghi789', startTime: 30 })
    const scenes = syncScenesFromSuggestions('media-1', [localAiScene, storyScene, manualScene], suggestions)
    const ids = scenes.map((s) => s.id)
    expect(ids).toContain('scene-1')
    expect(ids).toContain('scene-2')
    expect(ids).toContain('scene-3')
  })

  it('still drops a scene whose suggestion genuinely exists but is no longer accepted, alongside untouched non-suggestion scenes', () => {
    const rejectedSuggestion = makeSuggestion({ id: 's1', segmentId: 'seg1', startTime: 0, status: 'rejected' })
    const suggestionDerivedScene = makeScene({ id: 'scene-1', suggestionId: 's1', startTime: 0 })
    const storyScene = makeScene({ id: 'scene-2', suggestionId: 'story-abc', startTime: 20 })
    const scenes = syncScenesFromSuggestions('media-1', [suggestionDerivedScene, storyScene], [rejectedSuggestion])
    expect(scenes.map((s) => s.id)).toEqual(['scene-2'])
  })

  it('returns scenes sorted by startTime', () => {
    const suggestions = [
      makeSuggestion({ id: 's1', segmentId: 'seg1', startTime: 10 }),
      makeSuggestion({ id: 's2', segmentId: 'seg2', startTime: 2 })
    ]
    const scenes = syncScenesFromSuggestions('media-1', [], suggestions)
    expect(scenes.map((s) => s.suggestionId)).toEqual(['s2', 's1'])
  })
})

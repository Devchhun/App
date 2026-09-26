import { describe, expect, it } from 'vitest'
import { createDefaultDubbingWorkspaceState, defaultDubbingSegmentState, withoutTransientDubbingState } from './dubbing'

describe('withoutTransientDubbingState (what a project saves and loads)', () => {
  const saved = {
    ...createDefaultDubbingWorkspaceState(),
    active: true,
    videoMediaId: 'video-1',
    generationError: 'Edge TTS failed (exit 1): Traceback (most recent call last): File "C:',
    generationNote: 'Canceled — 70 of 201 done; the rest were not generated.',
    generationProgress: { completed: 70, total: 201 },
    segments: {
      done: { ...defaultDubbingSegmentState('done'), voiceId: 'female-adult', status: 'generated' as const, generatedClipId: 'clip-1' },
      running: { ...defaultDubbingSegmentState('running'), voiceId: 'male-adult', status: 'generating' as const, joinedInto: 'x' },
      waiting: { ...defaultDubbingSegmentState('waiting'), status: 'generating' as const }
    }
  }
  const cleaned = withoutTransientDubbingState(saved)

  it('drops the last run\'s error, note and progress so an old message never reappears', () => {
    expect(cleaned.generationError).toBeUndefined()
    expect(cleaned.generationNote).toBeUndefined()
    expect(cleaned.generationProgress).toBeUndefined()
  })

  it('puts lines left "generating" by a closed project back where they were', () => {
    expect(cleaned.segments.running).toMatchObject({ status: 'voice-assigned', joinedInto: undefined })
    expect(cleaned.segments.waiting.status).toBe('pending')
  })

  it('keeps everything that belongs to the project', () => {
    expect(cleaned.segments.done).toEqual(saved.segments.done)
    expect(cleaned).toMatchObject({ active: true, videoMediaId: 'video-1' })
  })
})

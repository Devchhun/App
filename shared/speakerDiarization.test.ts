import { describe, expect, it } from 'vitest'
import { clusterSpeakerObservations, embeddingSimilarity, predictAge, predictGender } from './speakerDiarization'

describe('speaker embedding clustering', () => {
  it('keeps the same voice together across non-adjacent lines and separates another voice', () => {
    const result = clusterSpeakerObservations([
      { segmentId: 'a1', embedding: [1, 0, 0], f0Hz: 120, voicedRatio: 0.9 },
      { segmentId: 'b1', embedding: [0, 1, 0], f0Hz: 220, voicedRatio: 0.8 },
      { segmentId: 'a2', embedding: [0.99, 0.03, 0], f0Hz: 123, voicedRatio: 0.85 }
    ])
    expect(result.speakers).toHaveLength(2)
    expect(result.assignmentBySegmentId.a1.speakerId).toBe(result.assignmentBySegmentId.a2.speakerId)
    expect(result.assignmentBySegmentId.b1.speakerId).not.toBe(result.assignmentBySegmentId.a1.speakerId)
  })

  it('bases identity on embeddings, not matching gender', () => {
    const result = clusterSpeakerObservations([
      { segmentId: 'one', embedding: [1, 0], f0Hz: 115, voicedRatio: 0.9 },
      { segmentId: 'two', embedding: [0, 1], f0Hz: 118, voicedRatio: 0.9 }
    ])
    expect(result.speakers).toHaveLength(2)
    expect(result.speakers.every((speaker) => speaker.gender === 'male')).toBe(true)
  })

  it('normalizes cosine similarity and makes low-evidence predictions Unknown', () => {
    expect(embeddingSimilarity([2, 0], [10, 0])).toBeCloseTo(1)
    expect(predictGender(undefined, 0).gender).toBe('unknown')
    expect(predictAge(280, 0.1, 2000).ageCategory).toBe('unknown')
  })
})

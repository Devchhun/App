import { beforeEach, describe, expect, it } from 'vitest'
import { loadReviewPlace, reviewStartIndex, saveReviewPlace } from './detectGenderResume'

const ids = ['a', 'b', 'c', 'd', 'e']
const picked = (...done: string[]) => (id: string): boolean => done.includes(id)
const place = (segmentId: string, selectedThen: string | null = null) => ({ segmentId, selectedThen, at: 1 })

describe('reviewStartIndex', () => {
  it('opens where the review was left', () => {
    expect(reviewStartIndex(ids, picked('a', 'b', 'c'), place('d'), null)).toBe(3)
    // The same subtitle is still selected as when it was left: not a new pointer.
    expect(reviewStartIndex(ids, picked('a', 'b', 'c'), place('d', 'a'), 'a')).toBe(3)
  })

  it('goes to a subtitle selected since it was left', () => {
    expect(reviewStartIndex(ids, picked('a', 'b', 'c'), place('d', 'a'), 'b')).toBe(1)
    expect(reviewStartIndex(ids, picked('a'), place('d'), 'e')).toBe(4)
  })

  it('continues at the first line without a hand-picked voice when no place was kept', () => {
    // 229 lines done before places were remembered: line 230, not line 1.
    expect(reviewStartIndex(ids, picked('a', 'b', 'c'), null, null)).toBe(3)
    // A selected line that is already done does not pull the review back.
    expect(reviewStartIndex(ids, picked('a', 'b', 'c'), null, 'a')).toBe(3)
    // A selected line still to do is where it opens.
    expect(reviewStartIndex(ids, picked('a'), null, 'd')).toBe(3)
  })

  it('falls back when the kept line is gone, and when every line is done', () => {
    expect(reviewStartIndex(ids, picked('a', 'b'), place('zz'), null)).toBe(2)
    expect(reviewStartIndex(ids, picked(...ids), null, 'c')).toBe(2)
    expect(reviewStartIndex(ids, picked(...ids), null, null)).toBe(0)
    expect(reviewStartIndex([], picked(), null, null)).toBe(0)
  })
})

describe('the kept place', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value)
    }
  })

  it('is kept per story and read back', () => {
    saveReviewPlace('video-1', 'line-230', null)
    saveReviewPlace('video-2', 'line-7', 'line-3')
    expect(loadReviewPlace('video-1')?.segmentId).toBe('line-230')
    expect(loadReviewPlace('video-2')).toMatchObject({ segmentId: 'line-7', selectedThen: 'line-3' })
    expect(loadReviewPlace('video-3')).toBeNull()
  })

  it('survives unreadable storage', () => {
    store.set('cae-detect-gender-resume-v1', '{not json')
    expect(loadReviewPlace('video-1')).toBeNull()
    saveReviewPlace('video-1', 'line-2', null)
    expect(loadReviewPlace('video-1')?.segmentId).toBe('line-2')
  })
})

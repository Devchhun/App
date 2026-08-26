import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AiSuggestion } from '@shared/suggestions'
import type { SegmentInput } from './providers/AiProvider'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cae-cache-test-'))
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

function makeSuggestion(): AiSuggestion {
  return {
    id: 's1',
    mediaId: 'm1',
    segmentId: 'seg1',
    startTime: 0,
    endTime: 1,
    purpose: 'main_claim',
    originalText: 'orig',
    visualText: 'vis',
    reason: 'r',
    confidence: 0.9,
    status: 'suggested',
    locked: false,
    edited: false,
    createdAt: new Date().toISOString()
  }
}

describe('computeCacheKey', () => {
  it('is deterministic and independent of segment order', async () => {
    const { computeCacheKey } = await import('./suggestionsCache')
    const a: SegmentInput[] = [
      { segmentId: 's1', text: 'hello' },
      { segmentId: 's2', text: 'world' }
    ]
    const b: SegmentInput[] = [
      { segmentId: 's2', text: 'world' },
      { segmentId: 's1', text: 'hello' }
    ]
    expect(computeCacheKey('media-1', a, 'claude-sonnet-5')).toBe(computeCacheKey('media-1', b, 'claude-sonnet-5'))
  })

  it('changes when the transcript text, media id, or model changes', async () => {
    const { computeCacheKey } = await import('./suggestionsCache')
    const base = computeCacheKey('media-1', [{ segmentId: 's1', text: 'hello' }], 'claude-sonnet-5')
    expect(computeCacheKey('media-1', [{ segmentId: 's1', text: 'goodbye' }], 'claude-sonnet-5')).not.toBe(base)
    expect(computeCacheKey('media-2', [{ segmentId: 's1', text: 'hello' }], 'claude-sonnet-5')).not.toBe(base)
    expect(computeCacheKey('media-1', [{ segmentId: 's1', text: 'hello' }], 'other-model')).not.toBe(base)
  })
})

describe('readCache / writeCache / invalidateCache', () => {
  it('returns null for a key that was never written', async () => {
    const { readCache } = await import('./suggestionsCache')
    expect(await readCache('nonexistent-key')).toBeNull()
  })

  it('round-trips a written cache entry', async () => {
    const { readCache, writeCache } = await import('./suggestionsCache')
    const suggestion = makeSuggestion()
    await writeCache('key-1', [suggestion], 'claude-sonnet-5')
    const entry = await readCache('key-1')
    expect(entry).not.toBeNull()
    expect(entry?.suggestions).toEqual([suggestion])
    expect(entry?.model).toBe('claude-sonnet-5')
  })

  it('removes an entry after invalidateCache and readCache returns null again', async () => {
    const { readCache, writeCache, invalidateCache } = await import('./suggestionsCache')
    await writeCache('key-2', [makeSuggestion()], 'claude-sonnet-5')
    expect(await readCache('key-2')).not.toBeNull()
    await invalidateCache('key-2')
    expect(await readCache('key-2')).toBeNull()
  })

  it('does not throw when invalidating a key that was never written', async () => {
    const { invalidateCache } = await import('./suggestionsCache')
    await expect(invalidateCache('never-existed')).resolves.toBeUndefined()
  })
})

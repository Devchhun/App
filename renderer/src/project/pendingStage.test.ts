import { describe, it, expect } from 'vitest'
import { pendingStageFor } from './pendingStage'

describe('pendingStageFor', () => {
  it('is undefined once fully ready -- nothing left to resume', () => {
    expect(pendingStageFor('ready')).toBeUndefined()
  })

  it('preserves error/canceled/waveform/proxy as-is', () => {
    expect(pendingStageFor('error')).toBe('error')
    expect(pendingStageFor('canceled')).toBe('canceled')
    expect(pendingStageFor('waveform')).toBe('waveform')
    expect(pendingStageFor('proxy')).toBe('proxy')
  })

  it('collapses every pre-thumbnail stage to thumbnail', () => {
    expect(pendingStageFor('queued')).toBe('thumbnail')
    expect(pendingStageFor('validating')).toBe('thumbnail')
    expect(pendingStageFor('probing')).toBe('thumbnail')
    expect(pendingStageFor('thumbnail')).toBe('thumbnail')
  })
})

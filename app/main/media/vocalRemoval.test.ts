import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'

// demucsModelRepo/getMediaCacheRoot reach for electron's `app` at call time
// only; the parser under test never does, but the module import must not
// explode on the missing electron binding.
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() } }))

import { buildVocalRemovalFilter, makeDemucsProgressParser } from './vocalRemoval'

describe('buildVocalRemovalFilter', () => {
  it('is the centre-channel cancellation pan', () => {
    expect(buildVocalRemovalFilter()).toBe('pan=stereo|c0=c0-c1|c1=c1-c0')
  })
})

describe('makeDemucsProgressParser', () => {
  function collect(): { parse: (chunk: string) => void; values: number[] } {
    const values: number[] = []
    const parse = makeDemucsProgressParser((f) => values.push(Number(f.toFixed(4))))
    return { parse, values }
  }

  it('reads a tqdm bar and scales it to a quarter of the job (one of four models)', () => {
    const { parse, values } = collect()
    parse('  0%|          | 0/20 [00:00<?, ?seconds/s]')
    parse('\r 50%|#####     | 10/20 [00:01<00:01,  8.00seconds/s]')
    parse('\r100%|##########| 20/20 [00:02<00:00,  8.00seconds/s]')
    expect(values).toEqual([0, 0.125, 0.25])
  })

  it('advances to the next model when the bar restarts from zero', () => {
    const { parse, values } = collect()
    parse('100%|##########| 20/20')
    parse('\r  0%|          | 0/20')
    parse('\r 50%|#####     | 10/20')
    // model 1 done (0.25), then model 2 at 0% (0.25) and 50% (0.375)
    expect(values).toEqual([0.25, 0.25, 0.375])
  })

  it('takes the LAST reading when a chunk carries several rewritten bars', () => {
    const { parse, values } = collect()
    parse(' 10%|#         | 2/20\r 30%|###       | 6/20\r 45%|####      | 9/20')
    expect(values).toEqual([0.1125])
  })

  it('does not treat a small backwards jitter as a new model', () => {
    const { parse, values } = collect()
    parse(' 60%|######    | 12/20')
    parse('\r 58%|#####     | 11/20')
    // still model 1: 0.58/4
    expect(values[values.length - 1]).toBeCloseTo(0.145, 3)
  })

  it('never exceeds the four-model ceiling even if extra bars appear', () => {
    const { parse, values } = collect()
    for (let i = 0; i < 6; i++) {
      parse('100%|##########| 20/20')
      parse('\r  0%|          | 0/20')
    }
    parse('\r100%|##########| 20/20')
    expect(Math.max(...values)).toBeLessThanOrEqual(1)
  })

  it('ignores chunks with no bar in them', () => {
    const { parse, values } = collect()
    parse('Selected model is a bag of 4 models. You will see that many progress bars per track.\n')
    parse('Separating track input.wav\n')
    expect(values).toEqual([])
  })
})

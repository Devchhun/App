import { describe, expect, it } from 'vitest'
import { commandLength, fitCommandLine } from './ffmpegArgs'

describe('fitCommandLine', () => {
  const write = (graph: string): string => `C:/tmp/graph-${graph.length}.txt`

  it('leaves a command that fits alone', () => {
    const args = ['-y', '-i', 'a.mp4', '-filter_complex', '[0:v]null[v]', '-map', '[v]', 'out.mp4']
    expect(fitCommandLine('ffmpeg', args, write)).toEqual(args)
  })

  it('reads a filter graph too long for Windows from a file', () => {
    const graph = Array.from({ length: 4000 }, (_, i) => `[v${i}]null[v${i + 1}]`).join(';')
    const args = ['-y', '-i', 'a.mp4', '-filter_complex', graph, '-map', '[v]', 'out.mp4']
    const out = fitCommandLine('ffmpeg', args, write)
    expect(out).toEqual(['-y', '-i', 'a.mp4', '-filter_complex_script', `C:/tmp/graph-${graph.length}.txt`, '-map', '[v]', 'out.mp4'])
    expect(commandLength('ffmpeg', out)).toBeLessThan(30_000)
  })

  it('moves the longest graph first and stops once it fits', () => {
    const long = 'x'.repeat(29_000)
    const short = 'y'.repeat(2_000)
    const out = fitCommandLine('ffmpeg', ['-vf', short, '-af', long], write)
    expect(out).toEqual(['-vf', short, '-filter_script:a', `C:/tmp/graph-${long.length}.txt`])
  })
})

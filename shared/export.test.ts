import { describe, expect, it } from 'vitest'
import {
  resolveOutputDimensions,
  computeExportDurationSeconds,
  activeExportClips,
  buildExportFilterGraph,
  planExportWindows,
  sliceClipsToWindow,
  DEFAULT_EXPORT_OPTIONS,
  type ResolvedExportClip
} from './export'
import type { ProjectSequence, TimelineClip } from './project'
import type { TimelineTrack } from './timelineTracks'

function track(overrides: Partial<TimelineTrack> & Pick<TimelineTrack, 'id' | 'kind' | 'order'>): TimelineTrack {
  return { name: overrides.id, height: 40, hidden: false, locked: false, removable: true, ...overrides }
}

function clip(overrides: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'trackId' | 'startTime' | 'duration'>): TimelineClip {
  return { mediaId: 'm1', type: 'video', sourceIn: 0, sourceOut: overrides.duration, locked: false, ...overrides }
}

describe('resolveOutputDimensions', () => {
  it('derives width from height + aspect ratio, both even', () => {
    expect(resolveOutputDimensions('1080p', '16:9')).toEqual({ width: 1920, height: 1080 })
    expect(resolveOutputDimensions('720p', '9:16')).toEqual({ width: 406, height: 720 })
    expect(resolveOutputDimensions('480p', '1:1')).toEqual({ width: 480, height: 480 })
  })

  it('always returns even dimensions (yuv420p requirement)', () => {
    for (const res of ['480p', '720p', '1080p', '2k', '4k'] as const) {
      for (const ar of ['16:9', '9:16', '1:1'] as const) {
        const { width, height } = resolveOutputDimensions(res, ar)
        expect(width % 2).toBe(0)
        expect(height % 2).toBe(0)
      }
    }
  })
})

describe('computeExportDurationSeconds', () => {
  it('is the real content end, NOT the padded sequence.duration', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 10 })]
    expect(computeExportDurationSeconds(clips)).toBe(10)
  })

  it('accounts for scene end times when given', () => {
    const clips = [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 })]
    expect(computeExportDurationSeconds(clips, [8, 3])).toBe(8)
  })

  it('is 0 for an empty sequence', () => {
    expect(computeExportDurationSeconds([])).toBe(0)
  })

  it('ignores a deleted clip entirely -- duration reflects only what survives', () => {
    // Simulates the state right after removing a track/clip: the deleted
    // clip is gone from the array (this function never sees it at all), and
    // the survivor was left with a stale linkedClipId pointing at it, since
    // this test predates sanitizeLinkedClips ever running. Duration must
    // come out exactly as if that dangling reference weren't there.
    const clips = [clip({ id: 'survivor', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'deleted-id' })]
    expect(computeExportDurationSeconds(clips)).toBe(5)
  })
})

describe('activeExportClips', () => {
  const tracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'V2', kind: 'video', order: 1, hidden: true }), track({ id: 'A1', kind: 'audio', order: 0 })]

  it('excludes clips on hidden tracks', () => {
    const sequence: ProjectSequence = {
      tracks,
      clips: [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), clip({ id: 'b', trackId: 'V2', startTime: 0, duration: 5 })],
      markers: [],
      duration: 10
    }
    const { videoClips } = activeExportClips(sequence)
    expect(videoClips.map((c) => c.id)).toEqual(['a'])
  })

  it('a surviving clip\'s stale linkedClipId (pointing at an already-deleted clip) is simply absent from the output, not a broken reference to chase', () => {
    const sequence: ProjectSequence = {
      tracks,
      clips: [clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'deleted-audio-id' })],
      markers: [],
      duration: 10
    }
    const { videoClips } = activeExportClips(sequence)
    expect(videoClips.map((c) => c.id)).toEqual(['v'])
  })

  it('excludes disabled clips', () => {
    const sequence: ProjectSequence = {
      tracks,
      clips: [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5, enabled: false })],
      markers: [],
      duration: 10
    }
    const { videoClips } = activeExportClips(sequence)
    expect(videoClips).toHaveLength(0)
  })

  it('includes a video clip\'s own audio unless muted, and dedicated audio clips', () => {
    const sequence: ProjectSequence = {
      tracks,
      clips: [
        clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5 }),
        clip({ id: 'v-muted', trackId: 'V1', startTime: 5, duration: 5, muted: true }),
        clip({ id: 'a', trackId: 'A1', startTime: 0, duration: 5, type: 'audio' })
      ],
      markers: [],
      duration: 10
    }
    const { audioClips } = activeExportClips(sequence)
    expect(audioClips.map((c) => c.id).sort()).toEqual(['a', 'v'])
  })

  it('excludes a video clip\'s own audio when it has already been split onto a linked audio clip (regression: audio was mixed in twice, once from each)', () => {
    const sequence: ProjectSequence = {
      tracks,
      clips: [
        clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'a' }),
        clip({ id: 'a', trackId: 'A1', startTime: 0, duration: 5, type: 'audio', linkedClipId: 'v' })
      ],
      markers: [],
      duration: 10
    }
    const { audioClips } = activeExportClips(sequence)
    expect(audioClips.map((c) => c.id)).toEqual(['a'])
  })

  it('a video clip\'s linkedClipId pointing at a non-audio-clip id (or one excluded by hidden/disabled filtering) still contributes its own audio', () => {
    const sequence: ProjectSequence = {
      tracks,
      clips: [clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5, linkedClipId: 'gone' })],
      markers: [],
      duration: 10
    }
    const { audioClips } = activeExportClips(sequence)
    expect(audioClips.map((c) => c.id)).toEqual(['v'])
  })

  it('excludes a standalone audio clip\'s own audio when IT is muted (regression: only a video clip\'s own `muted` used to be checked)', () => {
    const sequence: ProjectSequence = {
      tracks,
      clips: [clip({ id: 'a', trackId: 'A1', startTime: 0, duration: 5, type: 'audio', muted: true })],
      markers: [],
      duration: 10
    }
    const { audioClips } = activeExportClips(sequence)
    expect(audioClips).toHaveLength(0)
  })

  it('excludes every clip on a track silenced by track-level Mute (regression: export used to ignore Mute/Solo entirely, mixing in audio Preview never played)', () => {
    const mutedTracks = [track({ id: 'V1', kind: 'video', order: 0 }), track({ id: 'A1', kind: 'audio', order: 0, muted: true })]
    const sequence: ProjectSequence = {
      tracks: mutedTracks,
      clips: [clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5 }), clip({ id: 'a', trackId: 'A1', startTime: 0, duration: 5, type: 'audio' })],
      markers: [],
      duration: 10
    }
    const { audioClips, videoClips } = activeExportClips(sequence)
    expect(audioClips.map((c) => c.id)).toEqual(['v'])
    expect(videoClips.map((c) => c.id)).toEqual(['v']) // muting a track's AUDIO never hides its video visually
  })

  it('a soloed track is the only one included, even though every other track is unmuted (regression: Solo had no export effect at all)', () => {
    const soloTracks = [
      track({ id: 'V1', kind: 'video', order: 0 }),
      track({ id: 'A1', kind: 'audio', order: 0, solo: true }),
      track({ id: 'A2', kind: 'audio', order: 1 })
    ]
    const sequence: ProjectSequence = {
      tracks: soloTracks,
      clips: [
        clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 5 }),
        clip({ id: 'a1', trackId: 'A1', startTime: 0, duration: 5, type: 'audio' }),
        clip({ id: 'a2', trackId: 'A2', startTime: 0, duration: 5, type: 'audio' })
      ],
      markers: [],
      duration: 10
    }
    const { audioClips } = activeExportClips(sequence)
    expect(audioClips.map((c) => c.id)).toEqual(['a1'])
  })

  it('keeps clips on locked tracks (locked is edit-protection only, not export exclusion)', () => {
    const lockedTracks = [track({ id: 'V1', kind: 'video', order: 0, locked: true })]
    const sequence: ProjectSequence = { tracks: lockedTracks, clips: [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 })], markers: [], duration: 10 }
    const { videoClips } = activeExportClips(sequence)
    expect(videoClips).toHaveLength(1)
  })
})

/** Frames of each stretch laid end to end on the bottom track. */
function stretchFrames(graph: string): number[] {
  return [...graph.matchAll(/trim=(start_frame=1:)?end_frame=(\d+)(,setpts=PTS-STARTPTS)?\[(?!z\d)/g)].map((m) => Number(m[2]) - (m[1] ? 1 : 0))
}

describe('buildExportFilterGraph', () => {
  const dims = { width: 640, height: 360 }

  it('keeps video and audio in sync at 4x speed', () => {
    const sped = clip({ id: 'fast', trackId: 'V1', startTime: 0, duration: 2.5, sourceIn: 0, sourceOut: 10, playbackRate: 4 })
    const rc: ResolvedExportClip = { clip: sped, sourcePath: '/fast.mp4', trackOrder: 0 }
    const result = buildExportFilterGraph([rc], [rc], 2.5, dims, 30, DEFAULT_EXPORT_OPTIONS, 'out.mp4')
    const graph = result.args[result.args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('setpts=PTS/4')
    expect(graph).toContain('atempo=2,atempo=2')
    expect(stretchFrames(graph)).toEqual([75]) // 2.5 s at 30 fps
  })

  it('reports isEmpty when there are no clips at all', () => {
    const result = buildExportFilterGraph([], [], 0, dims, 30, DEFAULT_EXPORT_OPTIONS, 'out.mp4')
    expect(result.isEmpty).toBe(true)
    expect(result.args).toEqual([])
  })

  it('builds a real filter_complex graph for one video clip, mapping [vout]', () => {
    const rc: ResolvedExportClip = { clip: clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), sourcePath: '/a.mp4', trackOrder: 0 }
    const result = buildExportFilterGraph([rc], [], 5, dims, 30, DEFAULT_EXPORT_OPTIONS, 'out.mp4')
    expect(result.isEmpty).toBe(false)
    expect(result.args).toContain('-i')
    expect(result.args).toContain('/a.mp4')
    expect(result.args).toContain('-filter_complex')
    const graphIdx = result.args.indexOf('-filter_complex')
    expect(result.args[graphIdx + 1]).toContain('[vout]')
    expect(result.args).toContain('-map')
    expect(result.args).toContain('[vout]')
    expect(result.args).toContain('-an') // no audio clips given
    expect(result.args).toContain('out.mp4')
  })

  it('mixes multiple audio clips via amix and maps [aout]', () => {
    const rcA: ResolvedExportClip = { clip: clip({ id: 'a1', trackId: 'A1', startTime: 0, duration: 5, type: 'audio' }), sourcePath: '/a1.mp3', trackOrder: 0 }
    const rcB: ResolvedExportClip = { clip: clip({ id: 'a2', trackId: 'A2', startTime: 0, duration: 5, type: 'audio' }), sourcePath: '/a2.mp3', trackOrder: 0 }
    const result = buildExportFilterGraph([], [rcA, rcB], 5, dims, 30, DEFAULT_EXPORT_OPTIONS, 'out.mp4')
    const graph = result.args[result.args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('amix=inputs=2')
    expect(result.args).toContain('[aout]')
    expect(result.args).not.toContain('-an')
  })

  it('omits amix and maps the single audio label directly when there is only one audio clip', () => {
    const rc: ResolvedExportClip = { clip: clip({ id: 'a1', trackId: 'A1', startTime: 0, duration: 5, type: 'audio' }), sourcePath: '/a1.mp3', trackOrder: 0 }
    const result = buildExportFilterGraph([], [rc], 5, dims, 30, DEFAULT_EXPORT_OPTIONS, 'out.mp4')
    const graph = result.args[result.args.indexOf('-filter_complex') + 1]
    expect(graph).not.toContain('amix')
    expect(result.args).toContain('[a0]')
  })

  it('applies CRF from the bitrate preset, not a fixed bitrate', () => {
    const rc: ResolvedExportClip = { clip: clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), sourcePath: '/a.mp4', trackOrder: 0 }
    const result = buildExportFilterGraph([rc], [], 5, dims, 30, { ...DEFAULT_EXPORT_OPTIONS, bitratePreset: 'higher' }, 'out.mp4')
    const crfIdx = result.args.indexOf('-crf')
    expect(crfIdx).toBeGreaterThan(-1)
    expect(result.args[crfIdx + 1]).toBe('18')
  })

  it('uses a custom bitrate when bitratePreset is custom', () => {
    const rc: ResolvedExportClip = { clip: clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), sourcePath: '/a.mp4', trackOrder: 0 }
    const result = buildExportFilterGraph([rc], [], 5, dims, 30, { ...DEFAULT_EXPORT_OPTIONS, bitratePreset: 'custom', customBitrateKbps: 4000 }, 'out.mp4')
    expect(result.args).toContain('-b:v')
    expect(result.args[result.args.indexOf('-b:v') + 1]).toBe('4000k')
    expect(result.args).not.toContain('-crf')
  })

  it('selects the codec encoder for the requested codec', () => {
    const rc: ResolvedExportClip = { clip: clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), sourcePath: '/a.mp4', trackOrder: 0 }
    const result = buildExportFilterGraph([rc], [], 5, dims, 30, { ...DEFAULT_EXPORT_OPTIONS, codec: 'hevc' }, 'out.mp4')
    expect(result.args[result.args.indexOf('-c:v') + 1]).toBe('libx265')
  })

  it('excludes audio entirely when includeAudio is false, even with audio clips given', () => {
    const rcV: ResolvedExportClip = { clip: clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), sourcePath: '/a.mp4', trackOrder: 0 }
    const rcA: ResolvedExportClip = { clip: clip({ id: 'a1', trackId: 'A1', startTime: 0, duration: 5, type: 'audio' }), sourcePath: '/a1.mp3', trackOrder: 0 }
    const result = buildExportFilterGraph([rcV], [rcA], 5, dims, 30, { ...DEFAULT_EXPORT_OPTIONS, includeAudio: false }, 'out.mp4')
    expect(result.args).toContain('-an')
    expect(result.args).not.toContain('/a1.mp3')
  })

  it('produces an audio-only graph (no [vout], -vn, no video encoder flags) when includeVideo is false', () => {
    const rcV: ResolvedExportClip = { clip: clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), sourcePath: '/a.mp4', trackOrder: 0 }
    const rcA: ResolvedExportClip = { clip: clip({ id: 'a1', trackId: 'A1', startTime: 0, duration: 5, type: 'audio' }), sourcePath: '/a1.mp3', trackOrder: 0 }
    const result = buildExportFilterGraph([rcV], [rcA], 5, dims, 30, { ...DEFAULT_EXPORT_OPTIONS, includeVideo: false }, 'out.m4a')
    expect(result.isEmpty).toBe(false)
    const graph = result.args[result.args.indexOf('-filter_complex') + 1]
    expect(graph).not.toContain('[vout]')
    expect(graph).not.toContain('color=c=black')
    expect(result.args).not.toContain('[vout]')
    expect(result.args).not.toContain('-c:v')
    expect(result.args).toContain('-vn')
    expect(result.args).not.toContain('-movflags')
    // The video input still gets skipped entirely -- only the audio source is fed in.
    expect(result.args).not.toContain('/a.mp4')
    expect(result.args).toContain('/a1.mp3')
  })

  it('reports isEmpty when includeVideo is false and there is no audio either', () => {
    const rcV: ResolvedExportClip = { clip: clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 }), sourcePath: '/a.mp4', trackOrder: 0 }
    const result = buildExportFilterGraph([rcV], [], 5, dims, 30, { ...DEFAULT_EXPORT_OPTIONS, includeVideo: false }, 'out.m4a')
    expect(result.isEmpty).toBe(true)
  })

  it('lays the bottom track end to end: black, the clip, black -- each exactly its frames', () => {
    const rc: ResolvedExportClip = { clip: clip({ id: 'a', trackId: 'V1', startTime: 3, duration: 4 }), sourcePath: '/a.mp4', trackOrder: 0 }
    const result = buildExportFilterGraph([rc], [], 10, dims, 30, DEFAULT_EXPORT_OPTIONS, 'out.mp4')
    const graph = result.args[result.args.indexOf('-filter_complex') + 1]
    expect(stretchFrames(graph)).toEqual([90, 120, 90])
    expect(graph).toContain('concat=n=3:v=1:a=0[lane]')
    expect(graph).not.toContain('enable=')
  })

  it('never drifts: hundreds of odd-length clips add up to the run\'s exact frame count', () => {
    const clips: ResolvedExportClip[] = Array.from({ length: 300 }, (_, i) => ({ clip: clip({ id: `c${i}`, trackId: 'V1', startTime: i * 0.377 + (i % 3 === 0 ? 0.05 : 0), duration: 0.3 + (i % 3 === 0 ? 0 : 0.05) }), sourcePath: '/f.mp4', trackOrder: 0 }))
    const total = 300 * 0.377
    const graph = buildExportFilterGraph(clips, [], total, dims, 30, DEFAULT_EXPORT_OPTIONS, 'out.mp4').args.join(' ')
    expect(stretchFrames(graph).reduce((a, b) => a + b, 0)).toBe(Math.round(total * 30))
  })

  it('shows a higher track\'s clip over the bottom one for its own time only', () => {
    const base: ResolvedExportClip = { clip: clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 10 }), sourcePath: '/a.mp4', trackOrder: 0 }
    const top: ResolvedExportClip = { clip: clip({ id: 'b', trackId: 'V2', startTime: 3, duration: 4 }), sourcePath: '/b.mp4', trackOrder: 1 }
    const graph = buildExportFilterGraph([top, base], [], 10, dims, 30, DEFAULT_EXPORT_OPTIONS, 'out.mp4').args.join(' ')
    expect(graph).toContain("enable='between(t,3,7)'")
    expect(stretchFrames(graph)).toEqual([300])
  })

  it('places a moved or see-through clip over black; a plain one is padded, never overlaid', () => {
    const plain: ResolvedExportClip = { clip: clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 2 }), sourcePath: '/a.mp4', trackOrder: 0 }
    const faded: ResolvedExportClip = { clip: clip({ id: 'b', trackId: 'V1', startTime: 2, duration: 2, opacity: 0.5 }), sourcePath: '/b.mp4', trackOrder: 0 }
    const graph = buildExportFilterGraph([plain, faded], [], 4, dims, 30, DEFAULT_EXPORT_OPTIONS, 'out.mp4').args.join(' ')
    expect(graph.match(/overlay=/g)).toHaveLength(1)
    expect(graph).toContain('pad=640:360:(ow-iw)/2:(oh-ih)/2')
    expect(stretchFrames(graph)).toEqual([60, 60])
  })

  it('never seeks inside a still image, even in a later window of its clip', () => {
    const img: ResolvedExportClip = { clip: clip({ id: 'i', trackId: 'V1', startTime: 0, duration: 4, sourceIn: 3, sourceOut: 7, type: 'image' }), sourcePath: '/p.png', trackOrder: 0 }
    const { args } = buildExportFilterGraph([img], [], 4, dims, 30, DEFAULT_EXPORT_OPTIONS, 'out.mp4', undefined, { seekInputs: true })
    const i = args.indexOf('/p.png')
    expect(args[i - 2]).not.toBe('3')
    expect(args.slice(0, i)).not.toContain('-ss')
  })
})

describe('planExportWindows', () => {
  const span = (startTime: number, duration: number, isAudio = false, fades: { fadeIn?: number; fadeOut?: number } = {}) => ({ startTime, duration, isAudio, ...fades })
  it('keeps a small Timeline in one window', () => {
    expect(planExportWindows([span(0, 10), span(2, 1, true)], 10, 30)).toEqual([{ start: 0, end: 10 }])
  })
  it('splits a Timeline of many clips so no window touches more than the limit, end to end', () => {
    const clips = Array.from({ length: 400 }, (_, i) => span(i * 1.8, 1.8)).concat(Array.from({ length: 1500 }, (_, i) => span(i * 0.48, 0.4, true)))
    const windows = planExportWindows(clips, 720, 30)
    expect(windows.length).toBeGreaterThan(1)
    expect(windows[0].start).toBe(0)
    expect(windows[windows.length - 1].end).toBe(720)
    for (let i = 1; i < windows.length; i++) expect(windows[i].start).toBe(windows[i - 1].end)
    for (const w of windows) {
      expect(clips.filter((c) => c.startTime < w.end && c.startTime + c.duration > w.start).length).toBeLessThanOrEqual(40)
      // On the frame grid (30 fps).
      expect(Math.abs(w.end * 30 - Math.round(w.end * 30))).toBeLessThan(1e-6)
    }
  })
  it('never cuts through an audio fade', () => {
    const clips = Array.from({ length: 100 }, (_, i) => span(i, 1, false)).concat([span(0, 100, true, { fadeOut: 60 })])
    const windows = planExportWindows(clips, 100, 25, 20)
    for (const w of windows.slice(0, -1)) expect(w.end <= 40 || w.end >= 100).toBe(true)
  })
})

describe('sliceClipsToWindow', () => {
  it('cuts clips to the window, timed from its start, further into the file by the playback rate', () => {
    const rc = { clip: clip({ id: 'c', trackId: 'V1', startTime: 10, duration: 10, sourceIn: 100, sourceOut: 108.5, playbackRate: 0.85 }), sourcePath: 'f.mp4', trackOrder: 0 }
    const [part] = sliceClipsToWindow([rc], { start: 14, end: 30 })
    expect(part.clip.startTime).toBe(0)
    expect(part.clip.duration).toBe(6)
    expect(part.clip.sourceIn).toBeCloseTo(100 + 4 * 0.85, 9)
    expect(part.clip.sourceOut).toBeCloseTo(100 + 10 * 0.85, 9)
    expect(sliceClipsToWindow([rc], { start: 30, end: 40 })).toEqual([])
  })
})

describe('buildExportFilterGraph with seekInputs', () => {
  it('opens each input at its own stretch instead of trimming from the start of the file', () => {
    const v = { clip: clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 2, sourceIn: 4800, sourceOut: 4802 }), sourcePath: 'film.mp4', trackOrder: 0 }
    const { args } = buildExportFilterGraph([v], [], 2, { width: 854, height: 480 }, 30, { ...DEFAULT_EXPORT_OPTIONS, includeAudio: false }, 'out.mp4', undefined, { seekInputs: true })
    const i = args.indexOf('film.mp4')
    expect(args.slice(i - 5, i + 1)).toEqual(['-ss', '4800', '-t', '2', '-i', 'film.mp4'])
    expect(args.join(' ')).not.toContain('trim=start=4800')
  })
})

describe('buildExportFilterGraph with gpuDecode', () => {
  it('decodes and fits a video on the GPU, then brings it back for the rest; a cropped one stays on the CPU', () => {
    const plain = { clip: clip({ id: 'v', trackId: 'V1', startTime: 0, duration: 2 }), sourcePath: 'film.mp4', trackOrder: 0 }
    const cropped = { clip: clip({ id: 'c', trackId: 'V1', startTime: 2, duration: 2, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0.1, cropRight: 0, cropBottom: 0, cropLeft: 0 } }), sourcePath: 'crop.mp4', trackOrder: 0 }
    const { args } = buildExportFilterGraph([plain, cropped], [], 4, { width: 854, height: 480 }, 30, { ...DEFAULT_EXPORT_OPTIONS, includeAudio: false }, 'out.mp4', undefined, { seekInputs: true, gpuDecode: true, decoderThreads: 2 })
    const film = args.indexOf('film.mp4')
    const crop = args.indexOf('crop.mp4')
    expect(args.slice(0, film).join(' ')).toContain('-hwaccel cuda -hwaccel_output_format cuda')
    expect(args.slice(film, crop).join(' ')).not.toContain('-hwaccel')
    expect(args.slice(film, crop)).toContain('-threads')
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph.match(/scale_cuda=854:480:force_original_aspect_ratio=decrease:format=yuv420p,hwdownload,format=yuv420p/g)).toHaveLength(1)
  })
})

describe('buildExportFilterGraph for a piece of a longer export', () => {
  const piece = { seekInputs: true, silentBed: true, pcmAudio: true, forceVideo: true }
  it('still draws a black picture (and silence) for a stretch with no clips at all', () => {
    const result = buildExportFilterGraph([], [], 3, { width: 854, height: 480 }, 30, DEFAULT_EXPORT_OPTIONS, 'p.mov', undefined, piece)
    expect(result.isEmpty).toBe(false)
    expect(result.args).toContain('[vout]')
    expect(result.args.join(' ')).toContain('anullsrc')
    expect(result.args[result.args.indexOf('-filter_complex') + 1]).toContain('trim=end_frame=90[gap0]')
  })
  it('keeps the picture for a stretch with only dub lines in it', () => {
    const line: ResolvedExportClip = { clip: clip({ id: 'a', trackId: 'A1', startTime: 0, duration: 2, type: 'audio' }), sourcePath: '/a.wav', trackOrder: 0 }
    const { args } = buildExportFilterGraph([], [line], 3, { width: 854, height: 480 }, 30, DEFAULT_EXPORT_OPTIONS, 'p.mov', undefined, piece)
    expect(args).toContain('[vout]')
    expect(args).toContain('[aout]')
  })
})

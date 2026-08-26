import { describe, expect, it } from 'vitest'
import {
  resolveOutputDimensions,
  computeExportDurationSeconds,
  activeExportClips,
  buildExportFilterGraph,
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

  it('keeps clips on locked tracks (locked is edit-protection only, not export exclusion)', () => {
    const lockedTracks = [track({ id: 'V1', kind: 'video', order: 0, locked: true })]
    const sequence: ProjectSequence = { tracks: lockedTracks, clips: [clip({ id: 'a', trackId: 'V1', startTime: 0, duration: 5 })], markers: [], duration: 10 }
    const { videoClips } = activeExportClips(sequence)
    expect(videoClips).toHaveLength(1)
  })
})

describe('buildExportFilterGraph', () => {
  const dims = { width: 640, height: 360 }

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

  it('gates each video clip\'s overlay visibility to its own [start, end] window', () => {
    const rc: ResolvedExportClip = { clip: clip({ id: 'a', trackId: 'V1', startTime: 3, duration: 4 }), sourcePath: '/a.mp4', trackOrder: 0 }
    const result = buildExportFilterGraph([rc], [], 10, dims, 30, DEFAULT_EXPORT_OPTIONS, 'out.mp4')
    const graph = result.args[result.args.indexOf('-filter_complex') + 1]
    expect(graph).toContain("enable='between(t,3,7)'")
  })
})

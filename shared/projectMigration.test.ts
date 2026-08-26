import { describe, it, expect } from 'vitest'
import { migrateProjectFile } from './projectMigration'
import { createNewProjectFile } from './project'
import type { Scene, ProjectFile, MediaSource } from './project'

function baseScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    mediaId: 'm1',
    segmentId: 'seg1',
    suggestionId: 'sug1',
    track: 'V2',
    templateId: 'cause-effect-flow',
    startTime: 0,
    endTime: 4,
    purpose: 'cause',
    originalText: '',
    visualText: 'Weak password leads to account takeover',
    reason: 'test',
    confidence: 1,
    locked: false,
    edited: false,
    status: 'accepted',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

function baseMedia(overrides: Partial<MediaSource> = {}): MediaSource {
  return {
    id: 'm1',
    kind: 'video',
    fileName: 'clip.mp4',
    originalPath: 'C:/clip.mp4',
    durationSeconds: 12,
    hasAudio: true,
    addedAt: new Date().toISOString(),
    ...overrides
  }
}

describe('migrateProjectFile', () => {
  it('schemaVersion 1 -> current: reinterprets a stored contentTransform from top-left to center, chaining through the sequence migration too', () => {
    const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 1 }
    // Under schema 1, xPercent/yPercent were the box's top-left corner:
    // left=20, top=25, width=60, height=50 -> right=80, bottom=75.
    project.scenes = [baseScene({ contentTransform: { xPercent: 20, yPercent: 25, widthPercent: 60, heightPercent: 50, rotation: 0, lockAspectRatio: false } })]

    const migrated = migrateProjectFile(project)

    expect(migrated.schemaVersion).toBe(7)
    // Center is now xPercent/yPercent directly: (20+60/2, 25+50/2) = (50, 50).
    expect(migrated.scenes[0].contentTransform).toEqual({ xPercent: 50, yPercent: 50, widthPercent: 60, heightPercent: 50, rotation: 0, lockAspectRatio: false })
  })

  it('preserves rotation/lockAspectRatio and every other scene field untouched during migration', () => {
    const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 1 }
    project.scenes = [
      baseScene({
        visualText: 'Untouched text',
        contentTransform: { xPercent: 10, yPercent: 5, widthPercent: 40, heightPercent: 30, rotation: 8, lockAspectRatio: true }
      })
    ]
    const migrated = migrateProjectFile(project)
    expect(migrated.scenes[0].visualText).toBe('Untouched text')
    expect(migrated.scenes[0].contentTransform?.rotation).toBe(8)
    expect(migrated.scenes[0].contentTransform?.lockAspectRatio).toBe(true)
  })

  it('leaves scenes with no contentTransform untouched', () => {
    const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 1 }
    project.scenes = [baseScene()]
    const migrated = migrateProjectFile(project)
    expect(migrated.scenes[0].contentTransform).toBeUndefined()
  })

  it('is idempotent -- an already-current project is returned unchanged (no double-migration)', () => {
    const project: ProjectFile = createNewProjectFile('Current Project')
    project.scenes = [baseScene({ contentTransform: { xPercent: 50, yPercent: 50, widthPercent: 60, heightPercent: 50, rotation: 0, lockAspectRatio: false } })]
    const migrated = migrateProjectFile(project)
    expect(migrated).toEqual(project)
  })

  it('never mutates the input project', () => {
    const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 1 }
    project.scenes = [baseScene({ contentTransform: { xPercent: 20, yPercent: 25, widthPercent: 60, heightPercent: 50, rotation: 0, lockAspectRatio: false } })]
    const before = JSON.parse(JSON.stringify(project))
    migrateProjectFile(project)
    expect(project).toEqual(before)
  })

  describe('schemaVersion 2 -> 3: sequence migration', () => {
    it('converts the one implicit media item into a single V1 clip spanning its full duration', () => {
      const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 2 }
      project.media = [baseMedia({ id: 'm1', durationSeconds: 12, hasAudio: false })]

      const migrated = migrateProjectFile(project)

      expect(migrated.schemaVersion).toBe(7)
      const v1Clips = migrated.sequence.clips.filter((c) => c.trackId === 'V1')
      expect(v1Clips).toHaveLength(1)
      expect(v1Clips[0]).toMatchObject({ mediaId: 'm1', type: 'video', startTime: 0, duration: 12, sourceIn: 0, sourceOut: 12 })
    })

    it('creates a linked A1 audio clip when the source video has audio', () => {
      const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 2 }
      project.media = [baseMedia({ id: 'm1', durationSeconds: 20, hasAudio: true })]

      const migrated = migrateProjectFile(project)

      const v1 = migrated.sequence.clips.find((c) => c.trackId === 'V1')!
      const a1 = migrated.sequence.clips.find((c) => c.trackId === 'A1')!
      expect(a1).toBeDefined()
      expect(a1.type).toBe('audio')
      expect(a1.duration).toBe(20)
      expect(v1.linkedClipId).toBe(a1.id)
      expect(a1.linkedClipId).toBe(v1.id)
    })

    it('marks an image-sourced asset as an image clip with no sourceOut', () => {
      const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 2 }
      project.media = [baseMedia({ id: 'm1', assetType: 'image', durationSeconds: 8, hasAudio: false })]

      const migrated = migrateProjectFile(project)

      const v1 = migrated.sequence.clips.find((c) => c.trackId === 'V1')!
      expect(v1.type).toBe('image')
      expect(v1.sourceOut).toBeUndefined()
    })

    it('places an audio-only asset directly on A1 instead of V1', () => {
      const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 2 }
      project.media = [baseMedia({ id: 'm1', kind: 'audio', durationSeconds: 30, hasAudio: true })]

      const migrated = migrateProjectFile(project)

      expect(migrated.sequence.clips).toHaveLength(1)
      expect(migrated.sequence.clips[0].trackId).toBe('A1')
      expect(migrated.sequence.clips[0].type).toBe('audio')
    })

    it('yields an empty sequence when the project has no media at all', () => {
      const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 2 }
      project.media = []

      const migrated = migrateProjectFile(project)

      expect(migrated.sequence.clips).toEqual([])
      expect(migrated.sequence.duration).toBe(0)
    })

    it('never touches scenes/captions/transcripts -- their time values are already absolute', () => {
      const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 2 }
      project.media = [baseMedia()]
      project.scenes = [baseScene({ startTime: 3, endTime: 7 })]

      const migrated = migrateProjectFile(project)

      expect(migrated.scenes).toEqual(project.scenes)
    })
  })

  describe('schemaVersion 3 -> 4: track registry migration', () => {
    it('synthesizes the six fixed tracks so every existing clip/scene trackId still resolves', () => {
      const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 3 }
      project.media = [baseMedia({ id: 'm1', durationSeconds: 12, hasAudio: true })]
      project.sequence = { tracks: [], clips: [], markers: [], duration: 0 }
      project.scenes = [baseScene({ track: 'V3' })]

      const migrated = migrateProjectFile(project)

      expect(migrated.schemaVersion).toBe(7)
      const trackIds = migrated.sequence.tracks.map((t) => t.id)
      expect(trackIds.sort()).toEqual(['A1', 'A2', 'C1', 'V1', 'V2', 'V3'])
      expect(migrated.sequence.tracks.find((t) => t.id === 'C1')?.removable).toBe(false)
    })

    it('is idempotent -- re-running on an already-migrated project only bumps the version', () => {
      const project: ProjectFile = createNewProjectFile('Old Project')
      const once = migrateProjectFile(project)
      const twice = migrateProjectFile(once)
      expect(twice.sequence.tracks).toEqual(once.sequence.tracks)
    })
  })

  describe('schemaVersion 4 -> 5: main track + markers migration', () => {
    it('marks the lowest-order video track as isMain and adds an empty markers array', () => {
      const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 4 }
      project.sequence = {
        tracks: [
          { id: 'V1', kind: 'video', name: 'Video 1', order: 0, height: 40, hidden: false, locked: false, removable: true },
          { id: 'V4', kind: 'video', name: 'Video 2', order: 1, height: 40, hidden: false, locked: false, removable: true }
        ],
        clips: [],
        markers: [],
        duration: 0
      }

      const migrated = migrateProjectFile(project)

      expect(migrated.schemaVersion).toBe(7)
      expect(migrated.sequence.tracks.find((t) => t.id === 'V1')?.isMain).toBe(true)
      expect(migrated.sequence.tracks.find((t) => t.id === 'V4')?.isMain).toBeFalsy()
      expect(migrated.sequence.markers).toEqual([])
    })

    it('is idempotent -- a project that already has isMain and markers is only version-bumped', () => {
      const project: ProjectFile = createNewProjectFile('Old Project')
      const once = migrateProjectFile(project)
      const twice = migrateProjectFile(once)
      expect(twice.sequence.tracks).toEqual(once.sequence.tracks)
      expect(twice.sequence.markers).toEqual(once.sequence.markers)
    })
  })

  describe('schemaVersion 5 -> 6: clip properties migration', () => {
    it('is purely a version bump -- no existing clip field is touched', () => {
      const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 5 }
      project.media = [baseMedia({ id: 'm1', durationSeconds: 12, hasAudio: false })]
      project.sequence = {
        tracks: [{ id: 'V1', kind: 'video', name: 'Video 1', order: 0, height: 40, hidden: false, locked: false, removable: true, isMain: true }],
        clips: [{ id: 'c1', mediaId: 'm1', type: 'video', trackId: 'V1', startTime: 0, duration: 12, sourceIn: 0, sourceOut: 12, locked: false }],
        markers: [],
        duration: 12
      }

      const migrated = migrateProjectFile(project)

      expect(migrated.schemaVersion).toBe(7)
      expect(migrated.sequence.clips[0]).toEqual(project.sequence.clips[0])
    })

    it('is idempotent -- an already-current project is only version-bumped', () => {
      const project: ProjectFile = createNewProjectFile('Old Project')
      const once = migrateProjectFile(project)
      const twice = migrateProjectFile(once)
      expect(twice).toEqual(once)
    })
  })

  describe('schemaVersion 6 -> 7: story visualization migration', () => {
    it('defaults narrativeGraph/entityBible/visualPlan/sceneGroups to empty for an old project that has none of them', () => {
      const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 6 }
      // Simulate a real pre-7 file, which never had these keys at all.
      delete (project as Partial<ProjectFile>).narrativeGraph
      delete (project as Partial<ProjectFile>).entityBible
      delete (project as Partial<ProjectFile>).visualPlan
      delete (project as Partial<ProjectFile>).sceneGroups

      const migrated = migrateProjectFile(project)

      expect(migrated.schemaVersion).toBe(7)
      expect(migrated.narrativeGraph).toEqual({})
      expect(migrated.entityBible).toEqual({})
      expect(migrated.visualPlan).toEqual({})
      expect(migrated.sceneGroups).toEqual([])
    })

    it('is purely additive -- an existing schemaVersion 6 project keeps every other field untouched', () => {
      const project: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 6 }
      project.scenes = [baseScene()]
      delete (project as Partial<ProjectFile>).narrativeGraph

      const migrated = migrateProjectFile(project)

      expect(migrated.scenes).toEqual(project.scenes)
      expect(migrated.media).toEqual(project.media)
    })

    it('is idempotent -- a project that already has all four fields is only version-bumped', () => {
      const project: ProjectFile = createNewProjectFile('Old Project')
      const once = migrateProjectFile(project)
      const twice = migrateProjectFile(once)
      expect(twice).toEqual(once)
    })
  })
})

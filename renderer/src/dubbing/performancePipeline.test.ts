import { describe, expect, it } from 'vitest'
import { planGenerationUnits, type PlannedLine } from './dubbingPlan'
import { VOICE_MODELS } from './voiceModels'
import { cleanTextForSpeech } from './ttsTextCleaning'
import { buildLineControl, extractEmotionTags, neutralPerformance, type LinePerformance } from '@shared/dubbingPerformance'
import { withoutTransientDubbingState, createDefaultDubbingWorkspaceState, type DubbingWorkspaceState } from '@shared/dubbing'
import { migrateProjectFile } from '@shared/projectMigration'
import { createNewProjectFile, type ProjectFile } from '@shared/project'

const perf = (emotion: LinePerformance['emotion'], intensity: number): LinePerformance => ({ ...neutralPerformance('ai'), emotion, emotionIntensity: intensity })
const planned = (id: string, start: number, performance?: LinePerformance, takeNonce = 0): PlannedLine => ({
  id,
  text: id,
  startTime: start,
  endTime: start + 1,
  voiceId: 'male-adult',
  pitch: 0,
  speed: 1,
  volumeDb: 0,
  performance,
  takeNonce
})

describe('takes carry their performance', () => {
  it('joins neighbouring lines acted the same way into one take with that performance', () => {
    const units = planGenerationUnits([planned('a', 0, perf('angry', 80)), planned('b', 1.2, perf('angry', 75))])
    expect(units).toHaveLength(1)
    expect(units[0].performance?.emotion).toBe('angry')
  })
  it('never reads an angry line and a calm reply as one take', () => {
    const units = planGenerationUnits([planned('a', 0, perf('angry', 80)), planned('b', 1.2, perf('calm', 30))])
    expect(units.map((u) => u.performance?.emotion)).toEqual(['angry', 'calm'])
  })
  it('keeps a regenerated line (new take number) out of its neighbours\' take', () => {
    expect(planGenerationUnits([planned('a', 0, perf('sad', 60), 0), planned('b', 1.2, perf('sad', 60), 1)])).toHaveLength(2)
  })
})

describe('the old voice lock no longer reaches any line', () => {
  it('every catalog voice has a short identity and its line control has no "Do not perform dialogue"', () => {
    for (const voice of VOICE_MODELS.filter((v) => v.id !== 'custom-voice')) {
      expect(voice.identity, voice.id).toBeTruthy()
      expect(voice.identity).not.toMatch(/perform dialogue|slow and steady/i)
      const control = buildLineControl(voice.identity, perf('angry', 80))
      expect(control).not.toMatch(/perform dialogue/i)
      expect(control).toContain('emotion angry')
    }
  })
})

describe('emotion tags survive until analysis, then are cleaned from the spoken text', () => {
  it('reads (យំ) as crying from the raw line, and speaks the line without it', () => {
    const raw = '(យំ) ម៉ែ... កុំចោលកូន'
    expect(extractEmotionTags(raw).emotions).toEqual(['crying'])
    expect(cleanTextForSpeech(raw)).toBe('ម៉ែ... កុំចោលកូន')
  })
})

describe('projects saved before performances still open', () => {
  it('migrates an old project whose dubbing lines have no performance', () => {
    const oldProject: ProjectFile = { ...createNewProjectFile('Old Project'), schemaVersion: 11 }
    oldProject.dubbingWorkspace = {
      active: true,
      genderDetectionStatus: 'detected',
      segments: { s1: { segmentId: 's1', detectedGender: 'male', voiceId: 'male-adult', pitch: 0, speed: 1, volumeDb: 0, status: 'generated' } },
      speakers: {}
    }
    const migrated = migrateProjectFile(oldProject)
    expect(migrated.dubbingWorkspace?.segments.s1.voiceId).toBe('male-adult')
    expect(migrated.dubbingWorkspace?.segments.s1.performance).toBeUndefined()
  })
  it('saves performances with the project but not the last run\'s debug record', () => {
    const state: DubbingWorkspaceState = {
      ...createDefaultDubbingWorkspaceState(),
      segments: {
        s1: { segmentId: 's1', detectedGender: 'unknown', pitch: 0, speed: 1, volumeDb: 0, status: 'generated', performance: perf('shout', 90), takeNonce: 2, debug: { voiceId: 'male-adult', control: 'x' } }
      }
    }
    const saved = withoutTransientDubbingState(state)
    expect(saved.segments.s1.performance?.emotion).toBe('shout')
    expect(saved.segments.s1.takeNonce).toBe(2)
    expect(saved.segments.s1.debug).toBeUndefined()
  })
})

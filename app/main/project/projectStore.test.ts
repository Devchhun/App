import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createNewProjectFile } from '@shared/project'
import type { AiSuggestion } from '@shared/suggestions'
import type { Scene } from '@shared/project'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cae-project-test-'))
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

function makeSuggestion(): AiSuggestion {
  return {
    id: 's1',
    mediaId: 'm1',
    segmentId: 'seg1',
    startTime: 2.5,
    endTime: 4.25,
    purpose: 'warning',
    originalText: 'watch out',
    visualText: 'WARNING',
    reason: 'flags a hazard',
    confidence: 0.87,
    status: 'accepted',
    locked: true,
    edited: true,
    createdAt: new Date().toISOString()
  }
}

describe('project persistence', () => {
  it('round-trips a project file including aiSuggestions through save and load', async () => {
    const { saveProjectAtomic, loadProject } = await import('./projectStore')
    const project = createNewProjectFile('Test Project')
    const suggestion = makeSuggestion()
    project.aiSuggestions = { m1: [suggestion] }

    const path = await saveProjectAtomic(project)
    const loaded = await loadProject(path)

    expect(loaded.id).toBe(project.id)
    expect(loaded.aiSuggestions.m1).toEqual([suggestion])
  })

  it('never writes an API key into the saved project file', async () => {
    const { saveProjectAtomic } = await import('./projectStore')
    const project = createNewProjectFile('Test Project')
    const path = await saveProjectAtomic(project)
    const raw = await readFile(path, 'utf-8')
    expect(raw).not.toMatch(/sk-ant-/)
    expect(raw.toLowerCase()).not.toContain('apikey')
  })

  it('round-trips a cinematic scene\'s structured fields (content, icon, presentationMode, background, contentTransform) through save and load', async () => {
    const { saveProjectAtomic, loadProject } = await import('./projectStore')
    const project = createNewProjectFile('Cinematic Test Project')
    const scene: Scene = {
      id: 'scene-1',
      mediaId: 'm1',
      segmentId: 'seg1',
      suggestionId: 'manual-scene-1',
      track: 'V2',
      templateId: 'tech-title-scene',
      startTime: 0,
      endTime: 4,
      purpose: 'cybersecurity_event',
      originalText: '',
      visualText: 'Session Theft Explained',
      reason: 'Manually added',
      confidence: 1,
      content: {
        eyebrow: 'TELEGRAM • SESSION THEFT • 2026',
        title: 'Your Session\nCan Be Stolen',
        value: 'Without Your Password',
        items: [{ id: 'i1', label: 'Install', description: 'Download the app', iconId: 'device', color: '#1687ff' }],
        cta: 'Which one is yours?'
      },
      icon: { iconId: 'security', color: '#5ec8ff', size: 22, opacity: 90, hAlign: 'left', vAlign: 'center', backgroundShape: 'circle' },
      presentationMode: 'full-frame',
      background: { mode: 'gradient-overlay', glowColor: '#1687ff', intensity: 60 },
      contentTransform: { xPercent: 38, yPercent: 22, widthPercent: 55, heightPercent: 48, rotation: -4, lockAspectRatio: true },
      locked: false,
      edited: true,
      status: 'accepted',
      createdAt: new Date().toISOString()
    }
    project.scenes = [scene]

    const path = await saveProjectAtomic(project)
    const loaded = await loadProject(path)

    expect(loaded.scenes).toEqual([scene])
  })

  it('8. round-trips a contentTransform shaped like it just came out of an aspect-ratio reflow', async () => {
    const { saveProjectAtomic, loadProject } = await import('./projectStore')
    const project = createNewProjectFile('Reflowed Test Project')
    // Representative of what renderer/src/scenes/contentTransformReflow.ts
    // produces after a 16:9 -> 9:16 switch: non-round percentages, still
    // within the safe area. projectStore itself is aspect-ratio-agnostic --
    // this only verifies persistence doesn't round/truncate/drop the values.
    const reflowed: Scene['contentTransform'] = { xPercent: 8.42, yPercent: 30.71, widthPercent: 83.16, heightPercent: 38.5, rotation: 0, lockAspectRatio: true }
    const scene: Scene = {
      id: 'scene-reflowed',
      mediaId: 'm1',
      segmentId: 'seg1',
      suggestionId: 'manual-scene-reflowed',
      track: 'V2',
      templateId: 'device-compatibility-lineup',
      startTime: 1.5,
      endTime: 5,
      purpose: 'device',
      originalText: '',
      visualText: 'Available on four devices',
      reason: 'Manually added',
      confidence: 1,
      contentTransform: reflowed,
      locked: false,
      edited: true,
      status: 'accepted',
      createdAt: new Date().toISOString()
    }
    project.scenes = [scene]

    const path = await saveProjectAtomic(project)
    const loaded = await loadProject(path)

    expect(loaded.scenes[0].contentTransform).toEqual(reflowed)
    // Timing must be untouched by the reflow/persist round trip.
    expect(loaded.scenes[0].startTime).toBe(1.5)
    expect(loaded.scenes[0].endTime).toBe(5)
  })

  it('10. round-trips an off-canvas contentTransform exactly, without silently clamping it back onto the canvas', async () => {
    const { saveProjectAtomic, loadProject } = await import('./projectStore')
    const project = createNewProjectFile('Off Canvas Test Project')
    // "Constrain to canvas" off: a graphic dragged/enlarged partially outside
    // the frame (per the current schema's generous safety range) must
    // persist exactly as edited -- projectStore has no business rewriting it.
    const offCanvas: Scene['contentTransform'] = { xPercent: -35, yPercent: 140, widthPercent: 180, heightPercent: 12, rotation: 0, lockAspectRatio: false }
    const scene: Scene = {
      id: 'scene-off-canvas',
      mediaId: 'm1',
      segmentId: 'seg1',
      suggestionId: 'manual-scene-off-canvas',
      track: 'V2',
      templateId: 'cause-effect-flow',
      startTime: 0,
      endTime: 4,
      purpose: 'cause',
      originalText: '',
      visualText: 'Animating in from off-frame',
      reason: 'Manually added',
      confidence: 1,
      contentTransform: offCanvas,
      constrainToCanvas: false,
      locked: false,
      edited: true,
      status: 'accepted',
      createdAt: new Date().toISOString()
    }
    project.scenes = [scene]

    const path = await saveProjectAtomic(project)
    const loaded = await loadProject(path)

    expect(loaded.scenes[0].contentTransform).toEqual(offCanvas)
    expect(loaded.scenes[0].constrainToCanvas).toBe(false)
  })

  it('round-trips an Animated Break-In Vault Diagram scene\'s full animatedVaultConfig through save and load', async () => {
    const { saveProjectAtomic, loadProject } = await import('./projectStore')
    const project = createNewProjectFile('Animated Vault Diagram Test Project')
    const scene: Scene = {
      id: 'scene-animated-vault',
      mediaId: 'm1',
      segmentId: 'seg1',
      suggestionId: 'manual-scene-animated-vault',
      track: 'V2',
      templateId: 'animated-break-in-vault-diagram',
      startTime: 0,
      endTime: 6,
      purpose: 'cybersecurity_event',
      originalText: '',
      visualText: 'Tracing the break-in, floor by floor',
      reason: 'Manually added',
      confidence: 1,
      content: { eyebrow: 'CYBERSECURITY EVENT', title: 'Tracing the Break-In' },
      animatedVaultConfig: {
        outlineColor: '#3CAEEB',
        laserColor: '#FF355F',
        personColor: '#9AA9B4',
        vaultWheelColor: '#3CAEEB',
        surfaceOpacity: 28,
        gridOpacity: 18,
        glowIntensity: 55,
        laserCount: 5,
        showPerson: true,
        showVaultWheel: true,
        showFloorOpening: true
      },
      locked: false,
      edited: true,
      status: 'accepted',
      createdAt: new Date().toISOString()
    }
    project.scenes = [scene]

    const path = await saveProjectAtomic(project)
    const loaded = await loadProject(path)

    expect(loaded.scenes[0]).toEqual(scene)
    expect(loaded.scenes[0].animatedVaultConfig?.laserCount).toBe(5)
    expect(loaded.scenes[0].animatedVaultConfig?.showFloorOpening).toBe(true)
  })

  it('round-trips a Data Center Cyber Intrusion scene\'s full dataCenterConfig through save and load', async () => {
    const { saveProjectAtomic, loadProject } = await import('./projectStore')
    const project = createNewProjectFile('Data Center Intrusion Test Project')
    const scene: Scene = {
      id: 'scene-data-center',
      mediaId: 'm1',
      segmentId: 'seg1',
      suggestionId: 'manual-scene-data-center',
      track: 'V2',
      templateId: 'data-center-cyber-intrusion',
      startTime: 0,
      endTime: 6,
      purpose: 'cybersecurity_event',
      originalText: '',
      visualText: 'An attacker probes the firewall',
      reason: 'Manually added',
      confidence: 1,
      content: { eyebrow: 'CYBERSECURITY EVENT', title: 'Data Center Intrusion' },
      dataCenterConfig: {
        serverCount: 4,
        packetCount: 3,
        attackColor: '#FF3B4E',
        secureColor: '#33D6A6',
        firewallColor: '#3CAEEB',
        showAttacker: true,
        showShield: true,
        attackResult: 'blocked',
        glowIntensity: 55
      },
      locked: false,
      edited: true,
      status: 'accepted',
      createdAt: new Date().toISOString()
    }
    project.scenes = [scene]

    const path = await saveProjectAtomic(project)
    const loaded = await loadProject(path)

    expect(loaded.scenes[0]).toEqual(scene)
    expect(loaded.scenes[0].dataCenterConfig?.attackResult).toBe('blocked')
    expect(loaded.scenes[0].dataCenterConfig?.packetCount).toBe(3)
  })

  it('round-trips a Hospital Emergency Response scene\'s full hospitalResponseConfig through save and load', async () => {
    const { saveProjectAtomic, loadProject } = await import('./projectStore')
    const project = createNewProjectFile('Hospital Emergency Response Test Project')
    const scene: Scene = {
      id: 'scene-hospital',
      mediaId: 'm1',
      segmentId: 'seg1',
      suggestionId: 'manual-scene-hospital',
      track: 'V2',
      templateId: 'hospital-emergency-response',
      startTime: 0,
      endTime: 6,
      purpose: 'sequence_of_steps',
      originalText: '',
      visualText: 'From arrival to recovery',
      reason: 'Manually added',
      confidence: 1,
      content: { eyebrow: 'EMERGENCY RESPONSE', title: 'From Arrival to Recovery' },
      hospitalResponseConfig: {
        patientCondition: 'critical',
        emergencySeverity: 70,
        treatmentStageCount: 3,
        showDoctor: true,
        showNurse: true,
        pathColor: '#3CAEEB',
        emergencyColor: '#FF3B4E',
        recoveryColor: '#33D6A6',
        scannerSpeed: 55,
        topFloorLabel: 'Emergency Entrance',
        middleFloorLabel: 'Scanning Room',
        bottomFloorLabel: 'Treatment & Recovery'
      },
      locked: false,
      edited: true,
      status: 'accepted',
      createdAt: new Date().toISOString()
    }
    project.scenes = [scene]

    const path = await saveProjectAtomic(project)
    const loaded = await loadProject(path)

    expect(loaded.scenes[0]).toEqual(scene)
    expect(loaded.scenes[0].hospitalResponseConfig?.patientCondition).toBe('critical')
    expect(loaded.scenes[0].hospitalResponseConfig?.treatmentStageCount).toBe(3)
  })

  it('round-trips a batch-2 template scene with per-item status (complete/warning/blocked)', async () => {
    const { saveProjectAtomic, loadProject } = await import('./projectStore')
    const project = createNewProjectFile('Batch 2 Test Project')
    const scene: Scene = {
      id: 'scene-login',
      mediaId: 'm1',
      segmentId: 'seg1',
      suggestionId: 'manual-scene-login',
      track: 'V2',
      templateId: 'security-login-flow',
      startTime: 0,
      endTime: 4,
      purpose: 'cybersecurity_event',
      originalText: '',
      visualText: 'Two-step verification blocked the login',
      reason: 'Manually added',
      confidence: 1,
      content: {
        eyebrow: 'ACCOUNT SECURITY',
        items: [
          { id: 'row-0', label: 'Password', description: 'Entered correctly', iconId: 'security', color: '#18d77b', status: 'complete' },
          { id: 'row-1', label: 'SMS Code', description: 'Sent to device', iconId: 'message', color: '#f2ad18', status: 'warning' },
          { id: 'row-2', label: 'Two-Step Verification', description: 'Blocked', iconId: 'warning', color: '#ff5364', status: 'blocked' }
        ],
        cta: 'Never share your verification code'
      },
      locked: false,
      edited: true,
      status: 'accepted',
      createdAt: new Date().toISOString()
    }
    project.scenes = [scene]

    const path = await saveProjectAtomic(project)
    const loaded = await loadProject(path)

    expect(loaded.scenes[0].content?.items?.map((i) => i.status)).toEqual(['complete', 'warning', 'blocked'])
    expect(loaded.scenes[0]).toEqual(scene)
  })

  it('round-trips a scene\'s internal-motion settings (motionPreset, intensity, loop, stagger, enter/exit duration) through save and load', async () => {
    const { saveProjectAtomic, loadProject } = await import('./projectStore')
    const project = createNewProjectFile('Motion Test Project')
    const scene: Scene = {
      id: 'scene-isometric',
      mediaId: 'm1',
      segmentId: 'seg1',
      suggestionId: 'manual-scene-isometric',
      track: 'V2',
      templateId: 'isometric-system-diagram',
      startTime: 2,
      endTime: 8,
      purpose: 'cybersecurity_event',
      originalText: '',
      visualText: 'Data flows up through three platforms',
      reason: 'Manually added',
      confidence: 1,
      motionPreset: 'technical',
      motionIntensity: 65,
      loopEnabled: true,
      loopSpeed: 1.2,
      staggerDelay: 0.09,
      enterDuration: 2.2,
      exitDuration: 0.5,
      locked: false,
      edited: true,
      status: 'accepted',
      createdAt: new Date().toISOString()
    }
    project.scenes = [scene]

    const path = await saveProjectAtomic(project)
    const loaded = await loadProject(path)

    expect(loaded.scenes[0]).toEqual(scene)
    expect(loaded.scenes[0].motionPreset).toBe('technical')
    expect(loaded.scenes[0].loopEnabled).toBe(true)
    expect(loaded.scenes[0].loopSpeed).toBe(1.2)
  })

  it('12. loadProject migrates a schemaVersion-1 file\'s contentTransform (top-left) to center on the way in, and a re-save persists the repaired value', async () => {
    const { saveProjectAtomic, loadProject } = await import('./projectStore')
    const project = createNewProjectFile('Legacy Schema Project')
    const scene: Scene = {
      id: 'scene-legacy',
      mediaId: 'm1',
      segmentId: 'seg1',
      suggestionId: 'manual-scene-legacy',
      track: 'V2',
      templateId: 'cause-effect-flow',
      startTime: 0,
      endTime: 4,
      purpose: 'cause',
      originalText: '',
      visualText: 'Weak password leads to account takeover',
      reason: 'Manually added',
      confidence: 1,
      // Schema 1: xPercent/yPercent were the box's top-left corner.
      contentTransform: { xPercent: 20, yPercent: 25, widthPercent: 60, heightPercent: 50, rotation: 0, lockAspectRatio: false },
      locked: false,
      edited: true,
      status: 'accepted',
      createdAt: new Date().toISOString()
    }
    // saveProjectAtomic writes whatever schemaVersion the project object
    // carries (it doesn't force the current one) -- this simulates a
    // project file saved before the center-based migration existed.
    const legacyProject = { ...project, schemaVersion: 1 as const, scenes: [scene] }
    const path = await saveProjectAtomic(legacyProject)

    const loaded = await loadProject(path)
    expect(loaded.schemaVersion).toBe(7)
    expect(loaded.scenes[0].contentTransform).toEqual({ xPercent: 50, yPercent: 50, widthPercent: 60, heightPercent: 50, rotation: 0, lockAspectRatio: false })

    // Re-saving persists the repaired (center-based) value, not the raw file's old one.
    const resavedPath = await saveProjectAtomic(loaded)
    const reloaded = await loadProject(resavedPath)
    expect(reloaded.scenes[0].contentTransform).toEqual({ xPercent: 50, yPercent: 50, widthPercent: 60, heightPercent: 50, rotation: 0, lockAspectRatio: false })
    expect(reloaded.schemaVersion).toBe(7)
  })

  it('getOrCreateStartupProject reopens the most recently saved project', async () => {
    const { saveProjectAtomic, getOrCreateStartupProject } = await import('./projectStore')
    const project = createNewProjectFile('Reopened Project')
    await saveProjectAtomic(project)

    const reopened = await getOrCreateStartupProject()
    expect(reopened.id).toBe(project.id)
    expect(reopened.name).toBe('Reopened Project')
  })

  it('a project with a single clip loads compact (no empty Overlay/Graphics/Music/caption clutter), and reopening it repeatedly never grows the track list or reintroduces empty tracks', async () => {
    const { saveProjectAtomic, loadProject } = await import('./projectStore')
    const project = createNewProjectFile('Single Clip Project')
    // createNewProjectFile's default sequence carries the full 6-track
    // registry (V1/V2/V3/A1/A2/C1) with nothing on any of them yet -- one
    // clip lands on V1, matching a real "just imported one video" project.
    project.sequence = {
      ...project.sequence,
      clips: [{ id: 'clip-1', mediaId: 'm1', type: 'video', trackId: 'V1', startTime: 0, duration: 10, sourceIn: 0, sourceOut: 10, locked: false }],
      duration: 15
    }
    const path = await saveProjectAtomic(project)

    const first = await loadProject(path)
    // V2 (Overlay), V3 (Graphics), A1 (Narration), A2 (Music) are all empty
    // and non-essential -- pruned on load. V1 (holds the clip) and C1 (the
    // fixed caption track) remain.
    expect(first.sequence.tracks.map((t) => t.id)).toEqual(['V1', 'C1'])

    // Reopen (load -> resave -> load) several times, simulating the user
    // closing and reopening the app on the same project repeatedly -- the
    // track list must stay exactly as-is, never growing and never bringing
    // back a previously-pruned empty track.
    let current = first
    for (let i = 0; i < 3; i++) {
      const resavedPath = await saveProjectAtomic(current)
      current = await loadProject(resavedPath)
      expect(current.sequence.tracks.map((t) => t.id)).toEqual(['V1', 'C1'])
    }

    expect(current.sequence.clips).toEqual(project.sequence.clips)
  })
})

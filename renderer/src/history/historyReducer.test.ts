import { describe, it, expect } from 'vitest'
import { createHistoryState, recordChange, beginTransaction, endTransaction, undoStep, redoStep } from './historyReducer'
import { reflowContentTransform } from '../scenes/contentTransformReflow'
import type { SceneContentTransform } from '@shared/templates'

describe('historyReducer', () => {
  it('basic undo/redo round-trips through recorded states', () => {
    let state = createHistoryState<number>()
    state = recordChange(state, 0, 100) // committing value 1, previous was 0
    let value = 1

    const u = undoStep(state, value)!
    expect(u.value).toBe(0)
    state = u.state
    value = u.value
    expect(state.past).toHaveLength(0)
    expect(state.future).toHaveLength(1)

    const r = redoStep(state, value)!
    expect(r.value).toBe(1)
    state = r.state
    value = r.value
    expect(value).toBe(1)
    expect(state.future).toHaveLength(0)
  })

  it('a new action after undo clears redo (future) history', () => {
    let state = createHistoryState<number>()
    state = recordChange(state, 0, 100)
    let value = 1

    const u = undoStep(state, value)!
    state = u.state
    value = u.value
    expect(state.future).toHaveLength(1)

    // New discrete action committed at value 0 -> now moving to value 2.
    state = recordChange(state, value, 100)
    value = 2
    expect(state.future).toHaveLength(0)
    expect(redoStep(state, value)).toBeNull()
  })

  it('caps history at the configured maximum, dropping the oldest entries', () => {
    let state = createHistoryState<number>()
    const MAX = 100
    let value = 0
    for (let i = 1; i <= 150; i++) {
      state = recordChange(state, value, MAX)
      value = i
    }
    expect(state.past).toHaveLength(MAX)
    // 150 pushes (values 0..149), capped to the last 100 -> oldest surviving is 50.
    expect(state.past[0]).toBe(50)
  })

  it('groups a continuous drag transaction into exactly one history entry', () => {
    let state = createHistoryState<number>()
    let value = 0

    state = beginTransaction(state, value)
    // Simulate many pointermove-driven updates during the drag.
    for (const v of [1, 2, 3, 4, 5]) {
      state = recordChange(state, value, 100) // should be suppressed while transactionActive
      value = v
    }
    expect(state.past).toHaveLength(0) // nothing recorded yet -- still mid-drag

    state = endTransaction(state, value, 100)
    expect(state.past).toHaveLength(1)
    expect(state.past[0]).toBe(0) // baseline captured at drag start

    const u = undoStep(state, value)!
    expect(u.value).toBe(0) // one undo restores pre-drag state, not one of the intermediate positions
  })

  it('11. a content-transform drag/resize (many pointermove-driven applyContentDrag calls) collapses to exactly one undo entry', () => {
    interface Snap {
      contentTransform: { xPercent: number; yPercent: number; widthPercent: number; heightPercent: number; rotation: number; lockAspectRatio: boolean }
    }
    const start: Snap = { contentTransform: { xPercent: 50, yPercent: 50, widthPercent: 60, heightPercent: 50, rotation: 0, lockAspectRatio: false } }
    let state = createHistoryState<Snap>()
    let value = start

    state = beginTransaction(state, value)
    // Simulate a real resize drag: many pointermove events, each nudging the
    // 'se' handle a bit further (mirrors SceneSelectionOverlay.tsx's
    // handleContentPointerMove calling applyContentDrag on every move).
    for (const delta of [1, 2, 4, 7, 10]) {
      state = recordChange(state, value, 100) // suppressed while the transaction is active
      value = { contentTransform: { ...start.contentTransform, widthPercent: 60 + delta, heightPercent: 50 + delta / 2 } }
    }
    expect(state.past).toHaveLength(0) // still mid-drag, nothing recorded yet

    state = endTransaction(state, value, 100)
    expect(state.past).toHaveLength(1)

    const undo = undoStep(state, value)!
    expect(undo.value).toEqual(start) // one undo restores the pre-drag transform exactly, not an intermediate size
    const redo = redoStep(undo.state, undo.value)!
    expect(redo.value.contentTransform.widthPercent).toBe(70) // 60 + 10, the final size when the pointer was released
  })

  it('groups continuous text editing into one entry on end-of-transaction (blur/Enter/debounce)', () => {
    let state = createHistoryState<string>()
    let value = 'Hello'

    state = beginTransaction(state, value)
    for (const v of ['Hello ', 'Hello W', 'Hello Wo', 'Hello World']) {
      state = recordChange(state, value, 100)
      value = v
    }
    state = endTransaction(state, value, 100) // blur/Enter/debounce fires this

    expect(state.past).toHaveLength(1)
    expect(state.past[0]).toBe('Hello')
  })

  it('a transaction that ends with no net change records nothing', () => {
    let state = createHistoryState<number>()
    const value = 5
    state = beginTransaction(state, value)
    state = endTransaction(state, value, 100) // dragged and released back to the same spot
    expect(state.past).toHaveLength(0)
  })

  it('restores full create/delete style object states (not just scalars)', () => {
    interface Snap {
      scenes: { id: string }[]
    }
    let state = createHistoryState<Snap>()
    let value: Snap = { scenes: [] }

    // "Create" a scene.
    state = recordChange(state, value, 100)
    value = { scenes: [{ id: 'a' }] }

    // "Delete" it.
    state = recordChange(state, value, 100)
    value = { scenes: [] }

    let step = undoStep(state, value)! // undo delete -> scene back
    expect(step.value.scenes).toEqual([{ id: 'a' }])
    state = step.state
    value = step.value

    step = undoStep(state, value)! // undo create -> empty again
    expect(step.value.scenes).toEqual([])
  })

  it('restores a template replacement (arbitrary field change) via undo', () => {
    interface Snap {
      templateId: string
    }
    let state = createHistoryState<Snap>()
    let value: Snap = { templateId: 'lower-third' }
    state = recordChange(state, value, 100)
    value = { templateId: 'title-card' }

    const step = undoStep(state, value)!
    expect(step.value.templateId).toBe('lower-third')
  })

  it('restores brand preset changes via undo, independent of scene changes', () => {
    interface Snap {
      brand: { primaryColor: string }
    }
    let state = createHistoryState<Snap>()
    let value: Snap = { brand: { primaryColor: '#111111' } }
    state = recordChange(state, value, 100)
    value = { brand: { primaryColor: '#ff00ff' } }

    const step = undoStep(state, value)!
    expect(step.value.brand.primaryColor).toBe('#111111')
  })

  it('restores the new cinematic-template structured fields (content, icon, presentationMode, background) via undo', () => {
    interface Snap {
      scene: {
        templateId: string
        content?: { eyebrow?: string; items?: { id: string; label: string; color?: string }[] }
        icon?: { iconId?: string; color?: string }
        presentationMode?: string
        background?: { mode?: string; glowColor?: string }
      }
    }
    let state = createHistoryState<Snap>()
    let value: Snap = {
      scene: {
        templateId: 'tech-title-scene',
        content: { eyebrow: 'TELEGRAM • SESSION THEFT • 2026' },
        icon: { iconId: 'security', color: '#5ec8ff' },
        presentationMode: 'full-frame',
        background: { mode: 'glow', glowColor: '#1687ff' }
      }
    }
    state = recordChange(state, value, 100)
    // Edit the eyebrow text and change the background mode -- two structured-field edits.
    value = {
      scene: {
        ...value.scene,
        content: { eyebrow: 'UPDATED EYEBROW' },
        background: { mode: 'grid', glowColor: '#1687ff' }
      }
    }

    const step = undoStep(state, value)!
    expect(step.value.scene.content?.eyebrow).toBe('TELEGRAM • SESSION THEFT • 2026')
    expect(step.value.scene.background?.mode).toBe('glow')
    expect(step.value.scene.icon?.iconId).toBe('security')
    expect(step.value.scene.presentationMode).toBe('full-frame')

    const redo = redoStep(step.state, step.value)!
    expect(redo.value.scene.content?.eyebrow).toBe('UPDATED EYEBROW')
    expect(redo.value.scene.background?.mode).toBe('grid')
  })

  it('groups a per-item structured edit (device label typed character by character) into one undo entry', () => {
    interface Snap {
      items: { id: string; label: string }[]
    }
    let state = createHistoryState<Snap>()
    let value: Snap = { items: [{ id: 'a', label: 'iPhone' }] }

    state = beginTransaction(state, value)
    for (const label of ['iPhone ', 'iPhone 1', 'iPhone 15']) {
      state = recordChange(state, value, 100)
      value = { items: [{ id: 'a', label }] }
    }
    state = endTransaction(state, value, 100)

    expect(state.past).toHaveLength(1)
    const step = undoStep(state, value)!
    expect(step.value.items[0].label).toBe('iPhone')
  })

  it('never needs playback/selection/UI fields to function -- the snapshot type is caller-defined and can be exactly the undoable slice', () => {
    // This test documents the contract: historyReducer is fully generic over
    // T, so HistoryContext.tsx choosing T = {scenesByMedia, brandPreset} is
    // what keeps playback time, hover state, selection, and API keys out of
    // history -- not something this pure module needs to special-case.
    let state = createHistoryState<{ scenesByMedia: object; brandPreset: object }>()
    const value = { scenesByMedia: {}, brandPreset: {} }
    state = recordChange(state, value, 100)
    expect(Object.keys(state.past[0]).sort()).toEqual(['brandPreset', 'scenesByMedia'])
  })

  it('7. an aspect-ratio-triggered content reflow across every scene is undoable in a single step', () => {
    // Mirrors the real wiring: when brandPreset.defaultAspectRatio changes,
    // every full-frame scene's contentTransform is reflowed in one batch
    // (one HistoryContext snapshot change), not one entry per scene.
    interface Snap {
      scenes: { id: string; contentTransform: SceneContentTransform }[]
    }
    const before: Snap = {
      scenes: [
        { id: 'a', contentTransform: { xPercent: 10, yPercent: 20, widthPercent: 80, heightPercent: 60, rotation: 0, lockAspectRatio: false } },
        { id: 'b', contentTransform: { xPercent: 20, yPercent: 30, widthPercent: 50, heightPercent: 30, rotation: 0, lockAspectRatio: true } }
      ]
    }
    let state = createHistoryState<Snap>()
    state = recordChange(state, before, 100)

    const after: Snap = {
      scenes: before.scenes.map((s) => ({ ...s, contentTransform: reflowContentTransform(s.contentTransform, '16:9', '9:16') }))
    }

    const undo = undoStep(state, after)!
    expect(undo.value).toEqual(before)
    expect(undo.value.scenes[0].contentTransform.widthPercent).toBe(80) // exactly restored, not re-derived

    const redo = redoStep(undo.state, undo.value)!
    expect(redo.value).toEqual(after)
  })

  it('restores internal-motion property edits (motionPreset, intensity, loop) via undo/redo', () => {
    interface Snap {
      scene: {
        motionPreset?: string
        motionIntensity?: number
        loopEnabled?: boolean
        loopSpeed?: number
        enterDuration?: number
      }
    }
    let state = createHistoryState<Snap>()
    let value: Snap = {
      scene: { motionPreset: 'technical', motionIntensity: 70, loopEnabled: true, loopSpeed: 1, enterDuration: 0.55 }
    }
    state = recordChange(state, value, 100)
    // Switch preset and disable looping -- a discrete Animation-tab control edit.
    value = { scene: { ...value.scene, motionPreset: 'cinematic', loopEnabled: false, loopSpeed: 1 } }

    const step = undoStep(state, value)!
    expect(step.value.scene.motionPreset).toBe('technical')
    expect(step.value.scene.loopEnabled).toBe(true)
    expect(step.value.scene.motionIntensity).toBe(70)

    const redo = redoStep(step.state, step.value)!
    expect(redo.value.scene.motionPreset).toBe('cinematic')
    expect(redo.value.scene.loopEnabled).toBe(false)
  })

  it('restores a staggerDelay edit (Animation tab Stagger delay field) via undo/redo, distinct from other motion fields', () => {
    interface Snap {
      scene: { staggerDelay?: number }
    }
    let state = createHistoryState<Snap>()
    let value: Snap = { scene: { staggerDelay: 0.09 } }
    state = recordChange(state, value, 100)
    // A dramatic sequential-entrance edit, per the Properties panel's 0-1s range.
    value = { scene: { staggerDelay: 0.6 } }

    const step = undoStep(state, value)!
    expect(step.value.scene.staggerDelay).toBe(0.09)

    const redo = redoStep(step.state, step.value)!
    expect(redo.value.scene.staggerDelay).toBe(0.6)
  })

  it('restores an Animated Break-In Vault Diagram Properties edit (animatedVaultConfig) via undo/redo', () => {
    interface Snap {
      scene: { animatedVaultConfig?: { laserColor?: string; laserCount?: number; showVaultWheel?: boolean } }
    }
    let state = createHistoryState<Snap>()
    let value: Snap = { scene: { animatedVaultConfig: { laserColor: '#FF355F', laserCount: 5, showVaultWheel: true } } }
    state = recordChange(state, value, 100)
    // A user edit: fewer, differently-colored lasers, vault wheel hidden.
    value = { scene: { animatedVaultConfig: { laserColor: '#ffaa00', laserCount: 3, showVaultWheel: false } } }

    const step = undoStep(state, value)!
    expect(step.value.scene.animatedVaultConfig?.laserColor).toBe('#FF355F')
    expect(step.value.scene.animatedVaultConfig?.laserCount).toBe(5)
    expect(step.value.scene.animatedVaultConfig?.showVaultWheel).toBe(true)

    const redo = redoStep(step.state, step.value)!
    expect(redo.value.scene.animatedVaultConfig?.laserColor).toBe('#ffaa00')
    expect(redo.value.scene.animatedVaultConfig?.laserCount).toBe(3)
    expect(redo.value.scene.animatedVaultConfig?.showVaultWheel).toBe(false)
  })

  it('restores a Data Center Cyber Intrusion Properties edit (dataCenterConfig) via undo/redo', () => {
    interface Snap {
      scene: { dataCenterConfig?: { attackColor?: string; packetCount?: number; attackResult?: 'blocked' | 'breached' } }
    }
    let state = createHistoryState<Snap>()
    let value: Snap = { scene: { dataCenterConfig: { attackColor: '#FF3B4E', packetCount: 3, attackResult: 'blocked' } } }
    state = recordChange(state, value, 100)
    // A user edit: fewer, differently-colored packets, attack now breaches.
    value = { scene: { dataCenterConfig: { attackColor: '#cc0000', packetCount: 1, attackResult: 'breached' } } }

    const step = undoStep(state, value)!
    expect(step.value.scene.dataCenterConfig?.attackColor).toBe('#FF3B4E')
    expect(step.value.scene.dataCenterConfig?.packetCount).toBe(3)
    expect(step.value.scene.dataCenterConfig?.attackResult).toBe('blocked')

    const redo = redoStep(step.state, step.value)!
    expect(redo.value.scene.dataCenterConfig?.attackColor).toBe('#cc0000')
    expect(redo.value.scene.dataCenterConfig?.packetCount).toBe(1)
    expect(redo.value.scene.dataCenterConfig?.attackResult).toBe('breached')
  })

  it('restores a Hospital Emergency Response Properties edit (hospitalResponseConfig) via undo/redo', () => {
    interface Snap {
      scene: { hospitalResponseConfig?: { patientCondition?: 'critical' | 'stable' | 'recovering'; treatmentStageCount?: number } }
    }
    let state = createHistoryState<Snap>()
    let value: Snap = { scene: { hospitalResponseConfig: { patientCondition: 'critical', treatmentStageCount: 3 } } }
    state = recordChange(state, value, 100)
    // A user edit: patient stabilizes, one fewer treatment stage shown.
    value = { scene: { hospitalResponseConfig: { patientCondition: 'stable', treatmentStageCount: 2 } } }

    const step = undoStep(state, value)!
    expect(step.value.scene.hospitalResponseConfig?.patientCondition).toBe('critical')
    expect(step.value.scene.hospitalResponseConfig?.treatmentStageCount).toBe(3)

    const redo = redoStep(step.state, step.value)!
    expect(redo.value.scene.hospitalResponseConfig?.patientCondition).toBe('stable')
    expect(redo.value.scene.hospitalResponseConfig?.treatmentStageCount).toBe(2)
  })
})

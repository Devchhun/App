import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { ProjectSequence, Marker } from '@shared/project'
import { createEmptySequence } from '@shared/project'
import type { TimelineTrackKind } from '@shared/timelineTracks'
import {
  insertClip as insertClipOp,
  moveClip as moveClipOp,
  moveClipToTrack as moveClipToTrackOp,
  moveClipToNewTrack as moveClipToNewTrackOp,
  trimClip as trimClipOp,
  splitClip as splitClipOp,
  deleteClips as deleteClipsOp,
  deleteTimeRange as deleteTimeRangeOp,
  type TimeRange,
  duplicateClips as duplicateClipsOp,
  setClipsLocked as setClipsLockedOp,
  setClipsMuted as setClipsMutedOp,
  pickClipProperties,
  applyClipProperties as applyClipPropertiesOp,
  type ClipPropertyPatch,
  linkClips as linkClipsOp,
  unlinkClips as unlinkClipsOp,
  relinkOriginalAudio as relinkOriginalAudioOp,
  extractAudio as extractAudioOp,
  selectedWithLinkedClips,
  setClipsEnabled as setClipsEnabledOp,
  groupClips as groupClipsOp,
  ungroupClips as ungroupClipsOp,
  moveClipsToTrack as moveClipsToTrackOp,
  addMarker as addMarkerOp,
  moveMarker as moveMarkerOp,
  updateMarker as updateMarkerOp,
  removeMarker as removeMarkerOp,
  type InsertableAsset,
  type TrimEdge
} from './sequenceOps'
import { updateClipSelection, clearClipSelection as clearClipSelectionOp, type ClickModifiers } from './sequenceSelection'
import type { PlannedPlacement } from '../timeline/placementPlanning'
import type { TimelineTrack } from '@shared/timelineTracks'
import {
  addTrack as addTrackOp,
  addTrackAt as addTrackAtOp,
  duplicateTrack as duplicateTrackOp,
  renameTrack as renameTrackOp,
  removeTrack as removeTrackOp,
  reorderTrack as reorderTrackOp,
  moveTrackToIndex as moveTrackToIndexOp,
  setTrackHeight as setTrackHeightOp,
  toggleTrackFlag as toggleTrackFlagOp,
  collapseAll as collapseAllOp,
  ensureTrack as ensureTrackOp,
  getMainVideoTrackId,
  findOrCreateTrack,
  type TrackFlag
} from '../timeline/trackModel'
import { moveClipMagnetic } from '../timeline/magnet'
import { rippleTrim as rippleTrimOp, rippleDelete as rippleDeleteOp, type RippleScope } from '../timeline/ripple'
import { copyToClipboard, pasteClipsAt, getClipboard } from './clipClipboard'
import { rollEdit as rollEditOp } from '../timeline/rollEdit'
import { removeGap as removeGapOp, removeAllGapsOnTrack as removeAllGapsOnTrackOp, insertGapAt as insertGapAtOp, type Gap } from '../timeline/gapOps'

interface SequenceContextValue {
  sequence: ProjectSequence
  selectedTimelineClipIds: string[]

  selectClip: (clipId: string, modifiers?: ClickModifiers) => void
  /** Bulk-select, e.g. from a box/marquee drag -- see boxSelection.ts. */
  selectClips: (clipIds: string[]) => void
  clearClipSelection: () => void

  /** Video/image/audio insertion rules (see sequenceOps.buildInsertedClips).
   * Returns the id(s) of the newly-inserted clip(s) and selects them. */
  insertClip: (asset: InsertableAsset, atTime: number, trackId: string) => void
  /** Bulk-inserts every planned placement (see placementPlanning.ts) as one
   * history entry -- merges in any newly-created tracks first, then inserts
   * each clip at its planned track/time, selecting all of them. Used by
   * Timeline.tsx's drag-multiple-media-assets-onto-the-Timeline drop handler. */
  insertPlannedClips: (placements: PlannedPlacement[]) => void
  /** `magnetic: true` routes through magnet.ts's gapless-reorder math, but
   * ONLY when the clip is actually on the current main video track (see
   * TimelineTrack.isMain) -- Magnet never affects overlay/graphic/text/audio
   * tracks even when the toggle is on, matching the spec's "Overlay tracks
   * must always allow free positioning" rule. Falls back to the ordinary
   * move otherwise. `trackId` (an existing track) or `createTrackKind` (drop
   * into empty space below the last track) route through moveClipToTrack /
   * moveClipToNewTrack instead, for cross-track dragging -- mutually
   * exclusive with `magnetic` (a cross-track drop is never a same-track
   * gapless reorder). `linked` (default true) gates whether this clip's
   * linkedClipId partner (e.g. its own A1 audio) cascades by the same delta
   * -- pass the Linkage toggle's current value; the default of true exists
   * only so a call site that genuinely doesn't care keeps today's behavior. */
  moveClip: (clipId: string, newStartTime: number, options?: { magnetic?: boolean; trackId?: string; createTrackKind?: TimelineTrackKind; linked?: boolean }) => void
  /** `rippleScope` present (any RippleScope) routes right-edge trims through
   * ripple.ts's rippleTrim (pushing/pulling later clips); left-edge trims
   * and a missing/undefined scope use the ordinary trim. `linked` (default
   * true) gates whether the linked partner is trimmed by the same edge/time. */
  trimClip: (clipId: string, edge: TrimEdge, pointerTime: number, sourceDurationSeconds?: number, options?: { rippleScope?: RippleScope; linked?: boolean }) => void
  /** Splits every currently-selected clip at `atTime` (in practice always
   * exactly one, since clip selection replaces itself on a plain click --
   * multi-select + Split splits each independently). `linked` should be
   * sourced from the Linkage toggle at the call site (Alt is a per-action
   * override to force `false` regardless of the toggle). */
  splitSelected: (atTime: number, options?: { linked?: boolean }) => void
  /** `rippleScope` present routes through ripple.ts's rippleDelete (closing
   * the gap each deleted clip leaves), across the given scope's tracks.
   * `linked` (default true) also deletes each target's linked partner. */
  deleteSelected: (options?: { rippleScope?: RippleScope; linked?: boolean }) => void
  /** `linked` (default true) also duplicates each target's linked partner,
   * keeping the two copies linked to each other. */
  duplicateSelected: (options?: { linked?: boolean }) => void
  toggleClipLock: (clipId: string) => void
  toggleClipMute: (clipId: string) => void

  /** Real Linkage commands (spec section 3), independent of the Linkage
   * TOGGLE (which only gates whether move/trim/split/delete/duplicate
   * cascade automatically) -- these explicitly edit the link relationship
   * itself. `linkSelected` requires exactly two clips selected. */
  linkSelected: () => void
  unlinkSelected: () => void
  /** Re-links the (single) selected clip to the other same-media clip in the
   * sequence that best matches it (see sequenceOps.relinkOriginalAudio). */
  relinkSelectedAudio: () => void
  /** "Extract to Audio" -- splits a standalone, linked audio clip out of a
   * video clip's own embedded audio, routed onto a free (or newly-created)
   * audio track (see sequenceOps.extractAudio). No-op for a non-video clip
   * or one that already has a linked clip. */
  extractAudio: (clipId: string) => void
  /** Extends the current selection to include every selected clip's own
   * linked partner. */
  selectLinkedClips: () => void

  /** In-app clipboard (spec section 10) -- see clipClipboard.ts. Not OS
   * clipboard integration. */
  copySelected: () => void
  /** Copy + delete in one call (respects `linked` the same way deleteSelected does). */
  cutSelected: (options?: { linked?: boolean }) => void
  /** Pastes whatever's currently copied at `atTime`, auto-routing around
   * existing clips the same way a fresh media insertion does (never
   * silently overwriting). A no-op if the clipboard is empty. Selects the
   * newly-pasted clips. */
  pasteAtTime: (atTime: number) => void
  /** Copies the FIRST clipboard clip's appearance/speed/audio properties
   * (spec section 10's Paste Attributes) onto every currently-selected
   * clip's own timing -- unlike pasteAtTime, this never creates a clip. */
  pasteAttributesToSelected: () => void
  hasClipboardContent: () => boolean
  /** Clip Properties panel -- speed/opacity/volume/fades/transform (spec
   * section 16). Applies to exactly one clip (the panel only ever edits the
   * first selected one); a no-op for a locked clip. */
  updateClipProperties: (clipId: string, patch: ClipPropertyPatch) => void

  /** Blade tool -- splits exactly `clipId` at `atTime`, independent of the
   * current selection (unlike splitSelected). A no-op for a locked clip. */
  splitClipAt: (clipId: string, atTime: number, options?: { linked?: boolean }) => void
  /** Roll Edit tool -- see timeline/rollEdit.ts. A no-op unless the two
   * clips genuinely share a boundary (canRollEdit). */
  rollEditClips: (leftClipId: string, rightClipId: string, pointerTime: number, sourceDurationSecondsByClip?: Record<string, number | undefined>) => void
  /** Range tool's Delete Range / Ripple Delete Range (spec sections 4/9) --
   * see sequenceOps.deleteTimeRange. Operates across every track, not a
   * selection. */
  deleteRange: (range: TimeRange, ripple?: boolean) => void

  /** Enable/Disable (clip context menu) -- see sequenceOps.setClipsEnabled. */
  setSelectedEnabled: (enabled: boolean) => void
  /** Group/Ungroup Selected -- arbitrary multi-clip "move together" set,
   * independent of Linkage (see TimelineClip.groupId). */
  groupSelected: () => void
  ungroupSelected: () => void
  /** Move to Track (clip context menu) -- reassigns every selected clip's
   * track without changing its time. A no-op per-clip if the clip is locked. */
  moveSelectedToTrack: (trackId: string) => void
  /** Add Marker (ruler/empty-space context menu, `M` shortcut) -- see
   * sequenceOps.addMarker. Selects nothing; markers aren't clips. */
  addMarkerAtTime: (time: number) => void
  /** Drag-reposition an existing marker along the ruler. */
  moveMarkerTo: (markerId: string, newTime: number) => void
  /** Rename/recolor/annotate a marker (marker edit popover). */
  updateMarkerFields: (markerId: string, patch: Partial<Pick<Marker, 'name' | 'note' | 'color'>>) => void
  /** Delete a marker (marker context menu / delete key while a marker is selected). */
  removeMarkerById: (markerId: string) => void

  /** Gap interaction (spec section 12) -- see timeline/gapOps.ts. */
  removeGap: (trackId: string, gap: Gap) => void
  removeAllGapsOnTrack: (trackId: string) => void
  insertGapAt: (trackId: string, atTime: number, gapDuration: number) => void

  /** Bulk-replaces the whole sequence -- used by undo/redo (HistoryContext)
   * and initial project load, each a single call so it's one re-render. */
  restoreSequence: (sequence: ProjectSequence) => void

  /** Dynamic track registry -- see shared/timelineTracks.ts / trackModel.ts.
   * Lives inside `sequence` (not a separate state slice), so undo/redo of
   * track add/remove/reorder/rename/etc. comes for free via restoreSequence. */
  addTrack: (kind: TimelineTrackKind) => void
  addTrackAt: (kind: TimelineTrackKind, referenceTrackId: string, position: 'above' | 'below') => void
  duplicateTrack: (trackId: string) => void
  renameTrack: (trackId: string, name: string) => void
  /** No-ops (rejected) for the one non-removable caption track; the UI is
   * responsible for confirming before calling this when a track is non-empty. */
  removeTrack: (trackId: string) => void
  reorderTrack: (trackId: string, direction: 'up' | 'down') => void
  moveTrackToIndex: (trackId: string, targetIndex: number) => void
  setTrackHeight: (trackId: string, height: number) => void
  toggleTrackFlag: (trackId: string, flag: TrackFlag) => void
  collapseAllTracks: (collapsed: boolean) => void
  /** Adds an already-decided track (e.g. findOrCreateTrack's `newTrack`) if
   * it isn't already present -- the second half of routing an insertion
   * that needed a brand-new track (see trackModel.ts's ensureTrack). */
  ensureTrack: (track: TimelineTrack) => void
}

const SequenceContext = createContext<SequenceContextValue | null>(null)

export function SequenceProvider({ children }: { children: ReactNode }): JSX.Element {
  const [sequence, setSequence] = useState<ProjectSequence>(createEmptySequence())
  const [selectedTimelineClipIds, setSelectedTimelineClipIds] = useState<string[]>([])

  const orderedClipIds = useMemo(() => sequence.clips.map((c) => c.id), [sequence.clips])

  const selectClip = useCallback(
    (clipId: string, modifiers: ClickModifiers = {}) => {
      setSelectedTimelineClipIds((prev) => updateClipSelection(prev, clipId, orderedClipIds, modifiers))
    },
    [orderedClipIds]
  )

  /** Bulk-replaces the whole selection -- box/marquee selection's own
   * ctrl-toggle/shift-add math (boxSelection.ts's applyBoxSelection) already
   * computes the full next set itself, so this just commits it directly
   * rather than going through selectClip's single-id modifier logic. */
  const selectClips = useCallback((clipIds: string[]) => {
    setSelectedTimelineClipIds(clipIds)
  }, [])

  const clearClipSelection = useCallback(() => {
    setSelectedTimelineClipIds((prev) => clearClipSelectionOp(prev))
  }, [])

  const insertClip = useCallback((asset: InsertableAsset, atTime: number, trackId: string) => {
    setSequence((prev) => {
      const before = prev.clips.map((c) => c.id)
      const next = insertClipOp(prev, asset, atTime, trackId)
      const newIds = next.clips.map((c) => c.id).filter((id) => !before.includes(id))
      setSelectedTimelineClipIds(newIds)
      return next
    })
  }, [])

  const insertPlannedClips = useCallback((placements: PlannedPlacement[]) => {
    setSequence((prev) => {
      let next = prev
      for (const placement of placements) {
        if (placement.newTrack) next = { ...next, tracks: ensureTrackOp(next.tracks, placement.newTrack) }
      }
      const before = next.clips.map((c) => c.id)
      for (const placement of placements) {
        const asset: InsertableAsset = {
          mediaId: placement.asset.mediaId,
          type: placement.asset.type,
          sourceDurationSeconds: placement.asset.sourceDurationSeconds,
          hasAudio: placement.asset.hasAudio
        }
        next = insertClipOp(next, asset, placement.startTime, placement.trackId)
      }
      const newIds = next.clips.map((c) => c.id).filter((id) => !before.includes(id))
      setSelectedTimelineClipIds(newIds)
      return next
    })
  }, [])

  const moveClip = useCallback((clipId: string, newStartTime: number, options?: { magnetic?: boolean; trackId?: string; createTrackKind?: TimelineTrackKind; linked?: boolean }) => {
    const linked = options?.linked ?? true
    setSequence((prev) => {
      // `trackId` alongside `createTrackKind` is the caller's pre-computed id
      // for the track it wants created (see moveClipToNewTrack's doc comment)
      // -- passed on every pointermove of a drag gesture so repeated calls
      // land on the one track already created instead of each making a new one.
      if (options?.createTrackKind) return moveClipToNewTrackOp(prev, clipId, newStartTime, options.createTrackKind, linked, options.trackId)
      if (options?.trackId) return moveClipToTrackOp(prev, clipId, newStartTime, options.trackId, linked)
      if (options?.magnetic) {
        const clip = prev.clips.find((c) => c.id === clipId)
        if (clip && clip.trackId === getMainVideoTrackId(prev.tracks)) {
          return moveClipMagnetic(prev, clipId, newStartTime, linked)
        }
      }
      return moveClipOp(prev, clipId, newStartTime, linked)
    })
  }, [])

  const trimClip = useCallback(
    (clipId: string, edge: TrimEdge, pointerTime: number, sourceDurationSeconds?: number, options?: { rippleScope?: RippleScope; linked?: boolean }) => {
      const linked = options?.linked ?? true
      setSequence((prev) => {
        if (options?.rippleScope && edge === 'right') {
          return rippleTrimOp(prev, clipId, edge, pointerTime, options.rippleScope, sourceDurationSeconds)
        }
        return trimClipOp(prev, clipId, edge, pointerTime, sourceDurationSeconds, linked)
      })
    },
    []
  )

  const splitSelected = useCallback(
    (atTime: number, options: { linked?: boolean } = {}) => {
      setSequence((prev) => {
        let next = prev
        for (const clipId of selectedTimelineClipIds) {
          next = splitClipOp(next, clipId, atTime, options)
        }
        return next
      })
    },
    [selectedTimelineClipIds]
  )

  const deleteSelected = useCallback(
    (options?: { rippleScope?: RippleScope; linked?: boolean }) => {
      const linked = options?.linked ?? true
      setSequence((prev) => (options?.rippleScope ? rippleDeleteOp(prev, selectedTimelineClipIds, options.rippleScope) : deleteClipsOp(prev, selectedTimelineClipIds, linked)))
      setSelectedTimelineClipIds([])
    },
    [selectedTimelineClipIds]
  )

  const duplicateSelected = useCallback(
    (options?: { linked?: boolean }) => {
      const linked = options?.linked ?? true
      setSequence((prev) => {
        const { sequence: next, newClipIds } = duplicateClipsOp(prev, selectedTimelineClipIds, undefined, linked)
        setSelectedTimelineClipIds(newClipIds)
        return next
      })
    },
    [selectedTimelineClipIds]
  )

  const linkSelected = useCallback(() => {
    if (selectedTimelineClipIds.length !== 2) return
    const [a, b] = selectedTimelineClipIds
    setSequence((prev) => linkClipsOp(prev, a, b))
  }, [selectedTimelineClipIds])

  const unlinkSelected = useCallback(() => {
    setSequence((prev) => {
      let next = prev
      for (const id of selectedTimelineClipIds) next = unlinkClipsOp(next, id)
      return next
    })
  }, [selectedTimelineClipIds])

  const relinkSelectedAudio = useCallback(() => {
    const clipId = selectedTimelineClipIds[0]
    if (!clipId) return
    setSequence((prev) => relinkOriginalAudioOp(prev, clipId))
  }, [selectedTimelineClipIds])

  const extractAudio = useCallback((clipId: string) => {
    setSequence((prev) => {
      const clip = prev.clips.find((c) => c.id === clipId)
      if (!clip || clip.type !== 'video' || clip.linkedClipId) return prev
      const occupied = prev.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
      const routing = findOrCreateTrack(prev.tracks, occupied, clip.startTime, clip.duration, 'audio')
      const tracks = routing.newTrack ? ensureTrackOp(prev.tracks, routing.newTrack) : prev.tracks
      return extractAudioOp({ ...prev, tracks }, clipId, routing.trackId)
    })
  }, [])

  const selectLinkedClips = useCallback(() => {
    setSelectedTimelineClipIds((prev) => selectedWithLinkedClips(sequence.clips, prev))
  }, [sequence.clips])

  const setSelectedEnabled = useCallback(
    (enabled: boolean) => {
      setSequence((prev) => setClipsEnabledOp(prev, selectedTimelineClipIds, enabled))
    },
    [selectedTimelineClipIds]
  )

  const groupSelected = useCallback(() => {
    setSequence((prev) => groupClipsOp(prev, selectedTimelineClipIds))
  }, [selectedTimelineClipIds])

  const ungroupSelected = useCallback(() => {
    setSequence((prev) => ungroupClipsOp(prev, selectedTimelineClipIds))
  }, [selectedTimelineClipIds])

  const moveSelectedToTrack = useCallback(
    (trackId: string) => {
      setSequence((prev) => moveClipsToTrackOp(prev, selectedTimelineClipIds, trackId))
    },
    [selectedTimelineClipIds]
  )

  const addMarkerAtTime = useCallback((time: number) => {
    setSequence((prev) => addMarkerOp(prev, time))
  }, [])

  const moveMarkerTo = useCallback((markerId: string, newTime: number) => {
    setSequence((prev) => moveMarkerOp(prev, markerId, newTime))
  }, [])

  const updateMarkerFields = useCallback((markerId: string, patch: Partial<Pick<Marker, 'name' | 'note' | 'color'>>) => {
    setSequence((prev) => updateMarkerOp(prev, markerId, patch))
  }, [])

  const removeMarkerById = useCallback((markerId: string) => {
    setSequence((prev) => removeMarkerOp(prev, markerId))
  }, [])

  const removeGap = useCallback((trackId: string, gap: Gap) => {
    setSequence((prev) => removeGapOp(prev, trackId, gap.start, gap.end))
  }, [])

  const removeAllGapsOnTrack = useCallback((trackId: string) => {
    setSequence((prev) => removeAllGapsOnTrackOp(prev, trackId))
  }, [])

  const insertGapAt = useCallback((trackId: string, atTime: number, gapDuration: number) => {
    setSequence((prev) => insertGapAtOp(prev, trackId, atTime, gapDuration))
  }, [])

  const copySelected = useCallback(() => {
    const clips = sequence.clips.filter((c) => selectedTimelineClipIds.includes(c.id))
    if (clips.length > 0) copyToClipboard(clips)
  }, [sequence.clips, selectedTimelineClipIds])

  const cutSelected = useCallback(
    (options?: { linked?: boolean }) => {
      const clips = sequence.clips.filter((c) => selectedTimelineClipIds.includes(c.id))
      if (clips.length === 0) return
      copyToClipboard(clips)
      const linked = options?.linked ?? true
      setSequence((prev) => deleteClipsOp(prev, selectedTimelineClipIds, linked))
      setSelectedTimelineClipIds([])
    },
    [sequence.clips, selectedTimelineClipIds]
  )

  const pasteAtTime = useCallback((atTime: number) => {
    const entry = getClipboard()
    if (!entry || entry.clips.length === 0) return
    const anchor = entry.clips[0]
    const kind: TimelineTrackKind = anchor.type === 'audio' ? 'audio' : 'video'
    setSequence((prev) => {
      const occupied = prev.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
      const routing = findOrCreateTrack(prev.tracks, occupied, atTime, anchor.duration, kind)
      const tracks = routing.newTrack ? ensureTrackOp(prev.tracks, routing.newTrack) : prev.tracks
      const { sequence: next, newClipIds } = pasteClipsAt({ ...prev, tracks }, atTime, routing.trackId)
      setSelectedTimelineClipIds(newClipIds)
      return next
    })
  }, [])

  const pasteAttributesToSelected = useCallback(() => {
    const entry = getClipboard()
    if (!entry || entry.clips.length === 0 || selectedTimelineClipIds.length === 0) return
    const patch = pickClipProperties(entry.clips[0])
    setSequence((prev) => applyClipPropertiesOp(prev, selectedTimelineClipIds, patch))
  }, [selectedTimelineClipIds])

  const hasClipboardContent = useCallback(() => {
    const entry = getClipboard()
    return !!entry && entry.clips.length > 0
  }, [])

  const updateClipProperties = useCallback((clipId: string, patch: ClipPropertyPatch) => {
    setSequence((prev) => applyClipPropertiesOp(prev, [clipId], patch))
  }, [])

  const splitClipAt = useCallback((clipId: string, atTime: number, options?: { linked?: boolean }) => {
    setSequence((prev) => splitClipOp(prev, clipId, atTime, { linked: options?.linked ?? true }))
  }, [])

  const rollEditClips = useCallback((leftClipId: string, rightClipId: string, pointerTime: number, sourceDurationSecondsByClip?: Record<string, number | undefined>) => {
    setSequence((prev) => rollEditOp(prev, leftClipId, rightClipId, pointerTime, sourceDurationSecondsByClip))
  }, [])

  const deleteRange = useCallback((range: TimeRange, ripple = false) => {
    setSequence((prev) => deleteTimeRangeOp(prev, range, ripple))
  }, [])

  const toggleClipLock = useCallback((clipId: string) => {
    setSequence((prev) => {
      const clip = prev.clips.find((c) => c.id === clipId)
      if (!clip) return prev
      return setClipsLockedOp(prev, [clipId], !clip.locked)
    })
  }, [])

  const toggleClipMute = useCallback((clipId: string) => {
    setSequence((prev) => {
      const clip = prev.clips.find((c) => c.id === clipId)
      if (!clip) return prev
      return setClipsMutedOp(prev, [clipId], !clip.muted)
    })
  }, [])

  const restoreSequence = useCallback((next: ProjectSequence) => {
    setSequence(next)
  }, [])

  const addTrack = useCallback((kind: TimelineTrackKind) => {
    setSequence((prev) => ({ ...prev, tracks: addTrackOp(prev.tracks, kind) }))
  }, [])

  const addTrackAt = useCallback((kind: TimelineTrackKind, referenceTrackId: string, position: 'above' | 'below') => {
    setSequence((prev) => ({ ...prev, tracks: addTrackAtOp(prev.tracks, kind, referenceTrackId, position) }))
  }, [])

  const duplicateTrack = useCallback((trackId: string) => {
    setSequence((prev) => ({ ...prev, tracks: duplicateTrackOp(prev.tracks, trackId) }))
  }, [])

  const renameTrack = useCallback((trackId: string, name: string) => {
    setSequence((prev) => ({ ...prev, tracks: renameTrackOp(prev.tracks, trackId, name) }))
  }, [])

  const removeTrack = useCallback((trackId: string) => {
    setSequence((prev) => ({ ...prev, tracks: removeTrackOp(prev.tracks, trackId) }))
  }, [])

  const reorderTrack = useCallback((trackId: string, direction: 'up' | 'down') => {
    setSequence((prev) => ({ ...prev, tracks: reorderTrackOp(prev.tracks, trackId, direction) }))
  }, [])

  const moveTrackToIndex = useCallback((trackId: string, targetIndex: number) => {
    setSequence((prev) => ({ ...prev, tracks: moveTrackToIndexOp(prev.tracks, trackId, targetIndex) }))
  }, [])

  const setTrackHeight = useCallback((trackId: string, height: number) => {
    setSequence((prev) => ({ ...prev, tracks: setTrackHeightOp(prev.tracks, trackId, height) }))
  }, [])

  const toggleTrackFlag = useCallback((trackId: string, flag: TrackFlag) => {
    setSequence((prev) => ({ ...prev, tracks: toggleTrackFlagOp(prev.tracks, trackId, flag) }))
  }, [])

  const collapseAllTracks = useCallback((collapsed: boolean) => {
    setSequence((prev) => ({ ...prev, tracks: collapseAllOp(prev.tracks, collapsed) }))
  }, [])

  const ensureTrack = useCallback((track: TimelineTrack) => {
    setSequence((prev) => ({ ...prev, tracks: ensureTrackOp(prev.tracks, track) }))
  }, [])

  const value = useMemo<SequenceContextValue>(
    () => ({
      sequence,
      selectedTimelineClipIds,
      selectClip,
      selectClips,
      clearClipSelection,
      insertClip,
      insertPlannedClips,
      moveClip,
      trimClip,
      splitSelected,
      deleteSelected,
      duplicateSelected,
      toggleClipLock,
      toggleClipMute,
      linkSelected,
      unlinkSelected,
      relinkSelectedAudio,
      extractAudio,
      selectLinkedClips,
      copySelected,
      cutSelected,
      pasteAtTime,
      pasteAttributesToSelected,
      hasClipboardContent,
      updateClipProperties,
      splitClipAt,
      rollEditClips,
      deleteRange,
      setSelectedEnabled,
      groupSelected,
      ungroupSelected,
      moveSelectedToTrack,
      addMarkerAtTime,
      moveMarkerTo,
      updateMarkerFields,
      removeMarkerById,
      removeGap,
      removeAllGapsOnTrack,
      insertGapAt,
      restoreSequence,
      addTrack,
      addTrackAt,
      duplicateTrack,
      renameTrack,
      removeTrack,
      reorderTrack,
      moveTrackToIndex,
      setTrackHeight,
      toggleTrackFlag,
      collapseAllTracks,
      ensureTrack
    }),
    [
      sequence,
      selectedTimelineClipIds,
      selectClip,
      selectClips,
      clearClipSelection,
      insertClip,
      insertPlannedClips,
      moveClip,
      trimClip,
      splitSelected,
      deleteSelected,
      duplicateSelected,
      toggleClipLock,
      toggleClipMute,
      linkSelected,
      unlinkSelected,
      relinkSelectedAudio,
      extractAudio,
      selectLinkedClips,
      copySelected,
      cutSelected,
      pasteAtTime,
      pasteAttributesToSelected,
      hasClipboardContent,
      updateClipProperties,
      splitClipAt,
      rollEditClips,
      deleteRange,
      setSelectedEnabled,
      groupSelected,
      ungroupSelected,
      moveSelectedToTrack,
      addMarkerAtTime,
      moveMarkerTo,
      updateMarkerFields,
      removeMarkerById,
      removeGap,
      removeAllGapsOnTrack,
      insertGapAt,
      restoreSequence,
      addTrack,
      addTrackAt,
      duplicateTrack,
      renameTrack,
      removeTrack,
      reorderTrack,
      moveTrackToIndex,
      setTrackHeight,
      toggleTrackFlag,
      collapseAllTracks,
      ensureTrack
    ]
  )

  return <SequenceContext.Provider value={value}>{children}</SequenceContext.Provider>
}

export function useSequence(): SequenceContextValue {
  const ctx = useContext(SequenceContext)
  if (!ctx) throw new Error('useSequence must be used within SequenceProvider')
  return ctx
}

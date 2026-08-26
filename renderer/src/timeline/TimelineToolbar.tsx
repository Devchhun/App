import { useMedia } from '../media/MediaContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useScenes } from '../scenes/SceneContext'
import { useSequence } from '../sequence/SequenceContext'
import { useHistory } from '../history/HistoryContext'
import { canSplitClip } from '../sequence/sequenceOps'
import { findOrCreateTrack, type OccupiedRange } from './trackModel'
import { AddTrackButton } from './AddTrackButton'
import { ToggleButton } from './ToggleButton'
import { SelectionToolButton } from './SelectionToolButton'
import { TimelineViewOptionsMenu } from './TimelineViewOptionsMenu'
import { VoiceoverRecorder } from './VoiceoverRecorder'
import { canFreezeFrame as canFreezeFrameCheck, useFreezeFrame } from './useFreezeFrame'
import { useTimelineView, MIN_PPS, MAX_PPS } from './TimelineViewContext'
import {
  UndoIcon,
  RedoIcon,
  ScissorsIcon,
  TrimIcon,
  TrashIcon,
  TextToolIcon,
  MagnetIcon,
  RippleIcon,
  LinkIcon,
  LockIcon,
  MirrorIcon,
  RotateIcon,
  ZoomOutGlyphIcon,
  ZoomInGlyphIcon,
  ZoomToFitIcon
} from '../nav/icons'

/** Identity default for a clip with no transform yet -- same constant
 * ClipPropertiesPanel.tsx uses, kept in sync with it since both read/merge
 * `TimelineClip.transform`. */
const IDENTITY_TRANSFORM = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 }

const ZOOM_SLIDER_MAX = 100
/** Matches SceneContext.insertScene's own fixed default duration for a
 * freshly-added scene. */
const NEW_SCENE_DURATION_SECONDS = 3

function ppsToSlider(pps: number): number {
  return (Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * ZOOM_SLIDER_MAX
}

function sliderToPps(value: number): number {
  return MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, value / ZOOM_SLIDER_MAX)
}

/** CapCut-style Timeline toolbar, rendered as the first child of
 * `.timeline-root` (directly above the ruler) by Timeline.tsx -- a thin
 * strip matching the reference editor's own toolbar-then-ruler layout, not
 * a Preview-panel control. Two groups: editing tools (left) and Timeline-
 * behavior toggles + zoom (right). Every toggle shows its state via the
 * app's existing cyan/blue accent (see ToggleButton.tsx) -- never a merely-
 * disabled-looking icon for something that's actually available. */
interface Props {
  /** Playhead-anchored zoom (preserves the playhead's on-screen position,
   * same math as the Timeline's own cursor-anchored wheel-zoom) -- used by
   * the zoom in/out buttons and the slider below. "Fit to window" does NOT
   * use this (it deliberately resets the view to show everything, so there's
   * nothing to anchor). */
  onZoom: (newPps: number) => void
}

export function TimelineToolbar({ onZoom }: Props): JSX.Element {
  const { items, selectedId } = useMedia()
  const { currentTime } = usePlayback()
  const { scenesByMedia, selectedSceneId, deleteScene, splitScene, insertScene } = useScenes()
  const {
    sequence,
    selectedTimelineClipIds,
    splitSelected,
    deleteSelected,
    trimClip,
    ensureTrack,
    addTrack,
    collapseAllTracks,
    toggleClipLock,
    updateClipProperties
  } = useSequence()
  const { canUndo, canRedo, undo, redo } = useHistory()
  const { triggerFreezeFrame } = useFreezeFrame()
  const {
    pixelsPerSecond,
    setPixelsPerSecond,
    timelineViewportWidth,
    magnetOn,
    toggleMagnet,
    rippleOn,
    toggleRipple,
    linkageOn,
    toggleLinkage,
    snappingOn,
    toggleSnapping,
    tool,
    setTool,
    showWaveforms,
    toggleShowWaveforms,
    trackHeightMode,
    setTrackHeightMode,
    skimmerOn,
    toggleSkimmer
  } = useTimelineView()

  const media = items.find((m) => m.id === selectedId)
  const allScenes = Object.values(scenesByMedia).flat()
  const selectedScene = allScenes.find((s) => s.id === selectedSceneId)
  const selectedClipId = selectedTimelineClipIds[0]
  const selectedClip = selectedClipId ? sequence.clips.find((c) => c.id === selectedClipId) : undefined
  const selectedClipMedia = selectedClip ? items.find((m) => m.id === selectedClip.mediaId) : undefined

  // A Timeline clip takes priority over a graphics scene when both are
  // somehow selected at once (they're independent selection states, so this
  // can't normally happen from a single click, only if the user selected one
  // then the other without deselecting).
  const canSplitClipSelection = canSplitClip(selectedClip, currentTime)
  const canSplitSceneSelection = !!selectedScene && !selectedScene.locked && currentTime > selectedScene.startTime && currentTime < selectedScene.endTime
  const canSplit = canSplitClipSelection || canSplitSceneSelection
  const canDelete = !!selectedClip || !!selectedScene
  const canTrimToPlayhead = !!selectedClip && !selectedClip.locked && currentTime > selectedClip.startTime && currentTime < selectedClip.startTime + selectedClip.duration
  const canFreezeFrame = canFreezeFrameCheck(selectedClip, currentTime)
  const canTransformClip = !!selectedClip && !selectedClip.locked && (selectedClip.type === 'video' || selectedClip.type === 'image')
  const sceneMaxEnd = allScenes.reduce((max, s) => Math.max(max, s.endTime), 0)
  const effectiveDuration = Math.max(sequence.duration, sceneMaxEnd > 0 ? sceneMaxEnd + 5 : 0)

  const handleFreezeFrame = (): void => {
    if (!selectedClip) return
    triggerFreezeFrame(selectedClip)
  }

  const handleToggleLock = (): void => {
    if (!selectedClip) return
    toggleClipLock(selectedClip.id)
  }

  // Mirror/Rotate reuse the same TimelineClip.transform field
  // ClipPropertiesPanel.tsx already edits -- no new data model, just a
  // one-click quick-action for two of its numeric fields. Both a no-op on a
  // locked clip (matching every other toolbar mutation's disabled-while-
  // locked convention).
  const handleMirror = (): void => {
    if (!selectedClip || selectedClip.locked) return
    const transform = selectedClip.transform ?? IDENTITY_TRANSFORM
    updateClipProperties(selectedClip.id, { transform: { ...transform, scaleX: -transform.scaleX } })
  }

  const handleRotate = (): void => {
    if (!selectedClip || selectedClip.locked) return
    const transform = selectedClip.transform ?? IDENTITY_TRANSFORM
    updateClipProperties(selectedClip.id, { transform: { ...transform, rotation: (transform.rotation + 90) % 360 } })
  }

  // No manual beginTransaction/endTransaction here -- each of these is a
  // single already-atomic mutation, and HistoryContext's own snapshot-watch
  // effect records it as one entry automatically (see useTimelineShortcuts.ts's
  // doc comment for why wrapping a synchronous single action in
  // begin+mutate+end back-to-back doesn't actually work).
  const handleSplit = (): void => {
    if (canSplitClipSelection) {
      splitSelected(currentTime, { linked: linkageOn })
    } else if (canSplitSceneSelection && selectedScene) {
      splitScene(selectedScene.mediaId, selectedScene.id, currentTime)
    }
  }

  const handleDelete = (): void => {
    if (selectedClip) {
      deleteSelected({ linked: linkageOn })
    } else if (selectedScene) {
      deleteScene(selectedScene.mediaId, selectedScene.id)
    }
  }

  const handleTrimLeftToPlayhead = (): void => {
    if (!selectedClip || !canTrimToPlayhead) return
    trimClip(selectedClip.id, 'left', currentTime, selectedClipMedia?.metadata?.durationSeconds, { linked: linkageOn })
  }

  const handleTrimRightToPlayhead = (): void => {
    if (!selectedClip || !canTrimToPlayhead) return
    trimClip(selectedClip.id, 'right', currentTime, selectedClipMedia?.metadata?.durationSeconds, { linked: linkageOn })
  }

  const handleInsertText = (): void => {
    if (!media) return
    const occupied: OccupiedRange[] = allScenes.map((s) => ({ trackId: s.track, startTime: s.startTime, endTime: s.endTime }))
    const routing = findOrCreateTrack(sequence.tracks, occupied, currentTime, NEW_SCENE_DURATION_SECONDS, 'graphic')
    if (routing.newTrack) ensureTrack(routing.newTrack)
    insertScene(media.id, currentTime, routing.trackId)
  }

  const zoomToFit = (): void => {
    if (effectiveDuration > 0) {
      setPixelsPerSecond(Math.max(MIN_PPS, Math.min(MAX_PPS, timelineViewportWidth / effectiveDuration)))
    }
  }

  const zoomStep = (factor: number): void => {
    onZoom(Math.max(MIN_PPS, Math.min(MAX_PPS, pixelsPerSecond * factor)))
  }

  return (
    <div className="timeline-toolbar">
      <div className="timeline-tool-group">
        <SelectionToolButton tool={tool} onChange={setTool} />
        <ToggleButton icon={<UndoIcon size={15} />} label="Undo" shortcut="Ctrl+Z" active={false} disabled={!canUndo} onClick={undo} />
        <ToggleButton icon={<RedoIcon size={15} />} label="Redo" shortcut="Ctrl+Shift+Z" active={false} disabled={!canRedo} onClick={redo} />
        <ToggleButton icon={<ScissorsIcon />} label="Split at Playhead" shortcut="S" active={false} disabled={!canSplit} onClick={handleSplit} />
        <ToggleButton
          icon={<TrimIcon />}
          label="Trim Left to Playhead"
          active={false}
          disabled={!canTrimToPlayhead}
          onClick={handleTrimLeftToPlayhead}
        />
        <ToggleButton
          icon={<TrimIcon />}
          label="Trim Right to Playhead"
          active={false}
          disabled={!canTrimToPlayhead}
          onClick={handleTrimRightToPlayhead}
        />
        <ToggleButton icon={<TrashIcon />} label="Delete" shortcut="Delete" active={false} disabled={!canDelete} onClick={handleDelete} />
        <ToggleButton
          icon={<LockIcon locked={!!selectedClip?.locked} />}
          label={selectedClip?.locked ? 'Unlock Clip' : 'Lock Clip'}
          active={!!selectedClip?.locked}
          disabled={!selectedClip}
          onClick={handleToggleLock}
        />
        <ToggleButton icon={<MirrorIcon />} label="Mirror" active={false} disabled={!canTransformClip} onClick={handleMirror} />
        <ToggleButton icon={<RotateIcon />} label="Rotate 90°" active={false} disabled={!canTransformClip} onClick={handleRotate} />
        <ToggleButton
          icon={<span className="timeline-toolbar-freeze-glyph">❄</span>}
          label="Freeze Frame"
          active={false}
          disabled={!canFreezeFrame}
          onClick={handleFreezeFrame}
        />
        <ToggleButton icon={<TextToolIcon />} label={media ? 'Insert a blank text graphic at the playhead' : 'Import media first'} active={false} disabled={!media} onClick={handleInsertText} />
        <AddTrackButton onAdd={addTrack} />
      </div>

      <div className="timeline-tool-group timeline-tool-group-right">
        <VoiceoverRecorder />
        <ToggleButton icon={<MagnetIcon />} label="Main Track Magnet" active={magnetOn} onClick={toggleMagnet} />
        <ToggleButton icon={<RippleIcon />} label="Auto Ripple" active={rippleOn} onClick={toggleRipple} />
        <ToggleButton icon={<LinkIcon />} label="Linkage" active={linkageOn} onClick={toggleLinkage} />
        <ToggleButton icon={<span className="timeline-toolbar-snap-glyph">◆</span>} label="Snapping" active={snappingOn} onClick={toggleSnapping} />
        <TimelineViewOptionsMenu
          showWaveforms={showWaveforms}
          onToggleShowWaveforms={toggleShowWaveforms}
          trackHeightMode={trackHeightMode}
          onSetTrackHeightMode={setTrackHeightMode}
          skimmerOn={skimmerOn}
          onToggleSkimmer={toggleSkimmer}
          onCollapseAll={() => collapseAllTracks(true)}
          onExpandAll={() => collapseAllTracks(false)}
        />
        <div className="timeline-zoom-group">
          <button className="timeline-tool-button" onClick={() => zoomStep(1 / 1.4)} title="Zoom out">
            <ZoomOutGlyphIcon />
          </button>
          <input
            type="range"
            className="timeline-zoom-slider"
            min={0}
            max={ZOOM_SLIDER_MAX}
            step={0.1}
            value={ppsToSlider(pixelsPerSecond)}
            onChange={(e) => onZoom(Math.min(MAX_PPS, Math.max(MIN_PPS, sliderToPps(Number(e.target.value)))))}
            title="Zoom"
          />
          <button className="timeline-tool-button" onClick={() => zoomStep(1.4)} title="Zoom in">
            <ZoomInGlyphIcon />
          </button>
          <button className="timeline-tool-button" onClick={zoomToFit} title="Fit to window">
            <ZoomToFitIcon />
          </button>
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMedia } from './MediaContext'
import { usePlaybackControls, type SeekOptions } from '../playback/PlaybackContext'
import { useScenes } from '../scenes/SceneContext'
import { useSequence } from '../sequence/SequenceContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { GraphicsOverlay } from '../templates/GraphicsOverlay'
import { SceneSelectionOverlay } from '../scenes/SceneSelectionOverlay'
import { formatTimecode } from './format'
import { computeStageSize } from './previewStageSize'
import { getFitModeStorageKey, parseStoredFitMode, type PreviewFitMode, getPreviewQualityStorageKey, parseStoredPreviewQuality, type PreviewQuality, getScopeStorageKey, parseStoredScopeVisible } from './previewPreferences'
import { ColorScope } from './ColorScope'
import { StillFrameExportDialog } from './StillFrameExportDialog'
import { useProject } from '../project/ProjectContext'
import { findActiveClips } from '../sequence/sequenceOps'
import { clipRate, sourceTimeAt, timelineTimeAtSource } from '@shared/clipTiming'
import { isVideoReady, nextPlayheadTime } from './playbackClock'
import { resolveActiveVideoClip, isTrackAudioMuted } from '../timeline/trackModel'
import { useNarration } from '../narration/NarrationContext'
import { useConfirm } from '../ui/ConfirmDialog'
import { computeClipVisualStyle, resolveClipVolume, clipHasAnimatedProperties } from './clipVisuals'
import type { TimelineClip } from '@shared/project'
import {
  PlayIcon,
  PauseIcon,
  SkipStartIcon,
  SkipEndIcon,
  StepBackIcon,
  StepForwardIcon,
  SnapshotIcon,
  VolumeIcon,
  FullscreenIcon,
  HamburgerIcon
} from '../nav/icons'
import type { BrandPreset } from '@shared/project'
import type { MediaItem } from '@shared/media'

const ASPECT_RATIO_PARTS: Record<BrandPreset['defaultAspectRatio'], [number, number]> = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1]
}

const FRAME_STEP_SECONDS = 1 / 30
/** How far the active clip's local time is allowed to drift from what the
 * project playhead expects before we force-correct it -- loose enough that
 * natural video decode timing doesn't fight this correction every frame. */
const DRIFT_CORRECTION_THRESHOLD_SECONDS = 0.3
/** During a live scrub drag, real <video> seeks (an actual decoder
 * operation -- find the nearest keyframe, decode forward -- not a cheap
 * state update) are throttled to at most once per this interval, instead of
 * firing on every RAF-batched drag update (~60/s). Requesting seeks faster
 * than the decoder can complete them just queues up latency, so the visible
 * frame lagged further and further behind the pointer the longer a drag
 * continued. The playhead position and timecode UI still update every
 * frame regardless -- only the actual video-element seek is throttled. */
const LIVE_SEEK_THROTTLE_MS = 100

// `readyToUse` (probing done, duration/hasAudio/originalUrl known) rather
// than `stage === 'ready'` (every background job finished) -- Preview plays
// the original the moment it's usable, then automatically picks up
// `proxyUrl` on whatever later render sees it appear, with no separate
// "switch to proxy" step to write. Clip start/duration/trim math is always
// computed in seconds against the (unchanging) probed metadata and applied
// identically regardless of which URL this returns, so swapping sources
// here never touches timing.
function mediaUrl(media: MediaItem | undefined, quality: PreviewQuality = 'performance'): string | undefined {
  if (!media || !media.readyToUse) return undefined
  // Best quality: the original at full resolution; best performance: the
  // proxy whenever one exists (see the Player menu > Preview).
  return quality === 'quality' ? media.originalUrl : (media.proxyUrl ?? media.originalUrl)
}

export function PreviewPlayer(): JSX.Element {
  const { items, selectedId } = useMedia()
  const { registerSeek, reportTime, reportDuration, narrationMuted, toggleNarrationMuted, reportPlaying, registerPlayPause, registerFrameCapture, captureFrame } =
    usePlaybackControls()
  const { importPaths } = useMedia()
  const confirm = useConfirm()
  const { scenesByMedia, selectedSceneId } = useScenes()
  const { sequence } = useSequence()
  const { brandPreset } = useBrandPreset()
  const narration = useNarration()

  const mediaById = useMemo(() => Object.fromEntries(items.map((m) => [m.id, m] as const)), [items])
  const selectedMedia = items.find((m) => m.id === selectedId)
  const trackById = useMemo(() => Object.fromEntries(sequence.tracks.map((t) => [t.id, t] as const)), [sequence.tracks])
  // Track-level Mute/Solo (the header row's speaker icon) -- previously typed
  // and toggleable but never actually read anywhere, so it had zero effect
  // on playback. See trackModel.isTrackAudioMuted for the actual semantics.
  const isTrackAudioMutedFn = useCallback((trackId: string): boolean => isTrackAudioMuted(sequence.tracks, trackId), [sequence.tracks])

  // Scenes are project-global -- every scene renders in the composed
  // Project Preview regardless of which Media asset happens to be selected
  // for inspection in the side panel. A scene whose track was deleted (should
  // not normally happen) stays visible rather than silently vanishing.
  const allScenes = useMemo(() => Object.values(scenesByMedia).flat(), [scenesByMedia])
  const scenes = allScenes.filter((s) => !trackById[s.track]?.hidden)

  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageWrapEl, setStageWrapEl] = useState<HTMLDivElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  // The user's requested transport state is kept separately from the
  // element's transient paused state. Calling load() for a newly-active
  // source emits pause before canplay; treating that as a real user pause
  // left the button showing Pause while the media clock stayed at 00:00.
  const playIntentRef = useRef(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [volume, setVolume] = useState(1)
  const [previewMode, setPreviewMode] = useState<'project' | 'source'>('project')

  // Story Narration Workspace requires the PROJECT timeline to actually play
  // during recording (its own playhead advance drives the auto-stop-at-bound
  // check, the live waveform region on VO1, and the accepted take's exact
  // timing) -- every play/seek/volume path above is deliberately a no-op
  // whenever `previewMode !== 'project'` (Source Preview shows the raw
  // media file, disconnected from the sequence entirely). If "Source
  // Preview" was left selected from unrelated earlier use, entering the
  // workspace would otherwise silently record audio-only: the video never
  // visibly played, currentTime never advanced, and the live recording
  // region on the Timeline stayed a zero-width sliver. Forced back to
  // 'project' the moment the workspace activates, since there's no reason
  // to view Source Preview while narrating.
  useEffect(() => {
    if (narration.active) setPreviewMode('project')
  }, [narration.active])
  const [fitMode, setFitModeState] = useState<PreviewFitMode>(() => {
    if (typeof localStorage === 'undefined') return 'contain'
    try {
      return parseStoredFitMode(localStorage.getItem(getFitModeStorageKey()))
    } catch {
      return 'contain'
    }
  })
  const [previewQuality, setPreviewQualityState] = useState<PreviewQuality>(() =>
    parseStoredPreviewQuality(typeof localStorage === 'undefined' ? null : localStorage.getItem(getPreviewQualityStorageKey()))
  )
  const setPreviewQuality = (quality: PreviewQuality): void => {
    setPreviewQualityState(quality)
    try {
      localStorage.setItem(getPreviewQualityStorageKey(), quality)
    } catch {
      // Per-machine convenience only.
    }
  }
  const [scopeVisible, setScopeVisibleState] = useState<boolean>(() =>
    parseStoredScopeVisible(typeof localStorage === 'undefined' ? null : localStorage.getItem(getScopeStorageKey()))
  )
  const setScopeVisible = (visible: boolean): void => {
    setScopeVisibleState(visible)
    try {
      localStorage.setItem(getScopeStorageKey(), visible ? '1' : '0')
    } catch {
      // Per-machine convenience only.
    }
  }
  const setFitMode = (mode: PreviewFitMode): void => {
    setFitModeState(mode)
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(getFitModeStorageKey(), mode)
    } catch {
      // Storage unavailable/full -- the in-memory preference still works for this session.
    }
  }
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null)

  const requestVideoPlay = useCallback((el: HTMLVideoElement): void => {
    void el.play().catch((error: unknown) => {
      if (!playIntentRef.current) return
      // load()/src replacement commonly aborts the first play request. The
      // canplay handler retries it against the now-ready source.
      if (error instanceof DOMException && error.name === 'AbortError') return
      playIntentRef.current = false
      setIsPlaying(false)
    })
  }, [])

  // A project can be pure graphics (scenes with no underlying V1/A1/A2 clip
  // at all -- e.g. a full-frame template over a transparent/solid
  // background) -- the previewable/playable duration must cover whichever
  // is longer, the clip sequence or the furthest scene, or Play would have
  // nothing to advance through and the scrub bar would cap at 0.
  const sceneMaxEnd = allScenes.reduce((max, s) => Math.max(max, s.endTime), 0)
  const duration = Math.max(sequence.duration, sceneMaxEnd > 0 ? sceneMaxEnd + 5 : 0)
  // The scrub bar's own range/max still uses the padded `duration` above
  // (sequence.duration bakes in a +5s trailing buffer -- see
  // computeSequenceDuration -- so there's always a little room to drop a
  // next clip right after the last one) -- but an actual SEEK (scrub,
  // Timeline ruler click, skip-to-end) has no reason to land in that dead
  // buffer zone since nothing plays there. Clamping seeks to the real last
  // clip/scene end instead keeps the playhead exactly where content stops,
  // while the Timeline ruler is free to visually extend further for layout
  // (see Timeline.tsx's own ruler-width stretch).
  const contentEndTime = Math.max(
    sequence.clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0),
    sceneMaxEnd
  )
  // Hidden tracks never render in Preview (locked tracks still do -- locked
  // only protects against editing, it isn't a visibility toggle). Filtered
  // here rather than inside findActiveClips itself, which other call sites
  // (context menus, gap logic) need un-filtered.
  const activeClips = useMemo(
    () => findActiveClips(sequence, currentTime).filter((c) => !trackById[c.trackId]?.hidden),
    [sequence, currentTime, trackById]
  )
  // The single <video> element can only ever play one clip at a time -- among
  // however many video-kind tracks exist, the highest-order one wins (same
  // "topmost track renders/plays on top" rule Preview compositing uses).
  const activeV1Clip = useMemo(() => resolveActiveVideoClip(activeClips, sequence.tracks, currentTime), [activeClips, sequence.tracks, currentTime])
  const activeMedia = activeV1Clip ? mediaById[activeV1Clip.mediaId] : undefined
  const activeSrc = mediaUrl(activeMedia, previewQuality)
  const lastSyncedClipRef = useRef<{ id: string | undefined; src: string | undefined; mediaId?: string }>({ id: undefined, src: undefined })
  /** Wall-clock time (performance.now()) of the last real <video> seek --
   * see LIVE_SEEK_THROTTLE_MS. */
  const lastRealSeekAtRef = useRef(0)

  // CSS `aspect-ratio` combined with a percentage `max-height` inside this
  // flex chain doesn't reliably letterbox in this Chromium build -- the
  // stage rendered far smaller than the actual available space. Measuring
  // the wrap and computing the fitted box in JS is deterministic and avoids
  // that whole class of flex/aspect-ratio sizing ambiguity.
  useEffect(() => {
    if (!stageWrapEl) return
    const [arW, arH] = ASPECT_RATIO_PARTS[brandPreset.defaultAspectRatio]

    const recompute = (): void => {
      const size = computeStageSize(stageWrapEl.clientWidth, stageWrapEl.clientHeight, arW, arH)
      if (size) setStageSize(size)
    }

    recompute()
    const observer = new ResizeObserver(recompute)
    observer.observe(stageWrapEl)
    return () => observer.disconnect()
  }, [stageWrapEl, brandPreset.defaultAspectRatio])

  useEffect(() => {
    reportDuration(duration)
  }, [duration, reportDuration])

  /** Forces the <video> element to match a given project-absolute time:
   * swaps `src` if the active V1 clip's media changed, seeks to the mapped
   * local time (sourceIn for video, always 0 for a still image -- every
   * frame of the synthesized clip is identical), and plays/pauses it to
   * match the requested clip type + isPlaying intent. This is the ONE place
   * that reaches into the video element imperatively; everything else only
   * ever changes `currentTime` state and lets this run in response. */
  const syncVideoToTime = useCallback(
    (time: number, playing: boolean, options?: SeekOptions, deferSourceSwap = false) => {
      const el = videoRef.current
      if (!el) return
      const clips = findActiveClips(sequence, time).filter((c) => !trackById[c.trackId]?.hidden)
      const v1 = resolveActiveVideoClip(clips, sequence.tracks, time)

      if (!v1 || (v1.type !== 'video' && v1.type !== 'image')) {
        if (!el.paused) el.pause()
        lastSyncedClipRef.current = { id: undefined, src: undefined }
        return
      }

      const media = mediaById[v1.mediaId]
      const src = mediaUrl(media, previewQuality)
      if (!src) return

      const localTime = v1.type === 'image' ? 0 : sourceTimeAt(v1, time)
      el.playbackRate = clipRate(v1)
      const clipChanged = lastSyncedClipRef.current.id !== v1.id
      // A preview proxy finishing in the background changes this media's URL
      // mid-playback. Swapping then means load() + seek + a visible stall, so
      // playback keeps the source it started with; the next pause, seek or
      // clip change picks up the proxy.
      const sameMediaNewUrl = lastSyncedClipRef.current.mediaId === v1.mediaId && lastSyncedClipRef.current.src !== undefined
      if (deferSourceSwap && playing && !clipChanged && sameMediaNewUrl && lastSyncedClipRef.current.src !== src) return
      const srcChanged = lastSyncedClipRef.current.src !== src

      if (srcChanged) {
        el.src = src
        el.load()
      }
      const needsSeek = clipChanged || srcChanged || Math.abs(el.currentTime - localTime) > DRIFT_CORRECTION_THRESHOLD_SECONDS
      // Only the fine-grained "still the same clip, just correcting drift"
      // case is throttleable during a live scrub -- a genuine clip/source
      // change always seeks immediately regardless, since that's a much
      // rarer event within one drag and always needs a fresh seek anyway.
      const throttled = options?.live && !clipChanged && !srcChanged && performance.now() - lastRealSeekAtRef.current < LIVE_SEEK_THROTTLE_MS
      if (needsSeek && !throttled) {
        el.currentTime = localTime
        lastRealSeekAtRef.current = performance.now()
      }
      lastSyncedClipRef.current = { id: v1.id, src, mediaId: v1.mediaId }

      if (v1.type === 'video' && playing) {
        if (el.paused) requestVideoPlay(el)
      } else if (!el.paused) {
        el.pause()
      }
    },
    [sequence, mediaById, previewQuality, trackById, requestVideoPlay]
  )

  const applyProjectTime = useCallback(
    (time: number, playing: boolean, options?: SeekOptions) => {
      const clamped = Math.max(0, Math.min(contentEndTime, time))
      setCurrentTime(clamped)
      reportTime(clamped)
      if (previewMode === 'project') syncVideoToTime(clamped, playing, options)
      return clamped
    },
    [contentEndTime, reportTime, previewMode, syncVideoToTime]
  )

  // Explicit seeks (scrub bar, skip buttons, frame step, Timeline click,
  // double-click a clip) -- always forces a full video re-sync, unless
  // marked `live` (an in-progress scrub drag), which throttles just the
  // real <video> seek (see LIVE_SEEK_THROTTLE_MS) while still updating the
  // playhead/timecode UI every call.
  const seek = useCallback(
    (value: number, options?: SeekOptions) => {
      applyProjectTime(value, isPlaying, options)
    },
    [applyProjectTime, isPlaying]
  )

  useEffect(() => {
    registerSeek((time: number, options?: SeekOptions) => seek(time, options))
    return () => registerSeek(null)
  }, [registerSeek, seek])

  // Re-sync the video element whenever the SEQUENCE itself changes (a clip
  // inserted/moved/trimmed/split/deleted, or an undo/redo) while the
  // playhead stays where it is -- e.g. adding a clip under the current
  // playhead, or trimming the active clip's boundary past it. Reads
  // time/playing from refs (not deps) so this fires only on structural
  // sequence changes, never on every playback tick.
  const currentTimeRef = useRef(currentTime)
  currentTimeRef.current = currentTime
  const isPlayingRef = useRef(isPlaying)
  isPlayingRef.current = isPlaying
  useEffect(() => {
    if (previewMode !== 'project') return
    // This also fires when a proxy finishes (the media's URL changes): that
    // swap waits for the next pause instead of stalling playback.
    syncVideoToTime(currentTimeRef.current, isPlayingRef.current, undefined, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: see comment above.
  }, [sequence, previewMode, syncVideoToTime])

  // Keeps PlaybackContext's `isPlaying` mirroring this component's own local
  // state (the actual source of truth, since only this component touches
  // the <video> element) -- lets keyboard shortcuts (Space/J/K/L) elsewhere
  // in the app read play state without owning the player.
  useEffect(() => {
    reportPlaying(isPlaying)
  }, [isPlaying, reportPlaying])

  // Freeze Frame (spec section 13/checkpoint 4) -- draws whatever the main
  // <video> element is currently displaying to an offscreen canvas and
  // returns it as a PNG data URL. Registered the same way seek/play-pause
  // are (see PlaybackContext.tsx) since the Timeline toolbar button that
  // triggers this has no reference to the video element itself.
  useEffect(() => {
    registerFrameCapture(() => {
      const el = videoRef.current
      if (!el || !el.videoWidth || !el.videoHeight) return null
      const canvas = document.createElement('canvas')
      canvas.width = el.videoWidth
      canvas.height = el.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/png')
    })
    return () => registerFrameCapture(null)
  }, [registerFrameCapture])

  // Registers the actual play/pause action so Space/J/K/L (useTimelineShortcuts.ts)
  // can drive it via PlaybackContext.setPlaying without any direct reference
  // to this component, mirroring registerSeek's exact pattern above.
  useEffect(() => {
    registerPlayPause((playing: boolean) => {
      if (previewMode !== 'project') return
      playIntentRef.current = playing
      setIsPlaying(playing)
      syncVideoToTime(currentTimeRef.current, playing)
    })
    return () => registerPlayPause(null)
  }, [registerPlayPause, previewMode, syncVideoToTime])

  // The playhead clock. While a video clip plays, the <video> element IS the
  // clock: the playhead reads the frame the decoder is on, so there is no
  // drift to correct and no seek-to-catch-up. (The previous design ran the
  // playhead on the wall clock and made the video chase it; on long-GOP
  // sources every catch-up seek took longer than the 0.3 s tolerance, so it
  // seeked again every half second -- a stutter loop.) While the decoder is
  // starting, seeking or buffering, the playhead waits for it -- briefly: a
  // decoder that never delivers must not freeze the Timeline at 00:00 (the
  // bug the wall clock was introduced for), so after MAX_HOLD_MS the wall
  // clock takes over again. Gaps, stills and audio-only spans always use the
  // wall clock. See playbackClock.ts.
  useEffect(() => {
    if (!isPlaying || previewMode !== 'project') return
    let cancelled = false
    let rafHandle: number | null = null
    let lastNow = performance.now()
    let lastVideoTime = -1
    let lastProgressAt = lastNow

    const loop = (now: number): void => {
      if (cancelled) return
      // Do not jump several seconds after the renderer was suspended or a
      // debugger breakpoint; resume with a bounded frame instead.
      const deltaSeconds = Math.min(0.1, Math.max(0, (now - lastNow) / 1000))
      lastNow = now
      const previous = currentTimeRef.current
      const el = videoRef.current
      const clips = findActiveClips(sequence, previous).filter((c) => !trackById[c.trackId]?.hidden)
      const v1 = resolveActiveVideoClip(clips, sequence.tracks, previous)
      // Only trust the element when it holds this very clip.
      const videoOnScreen = !!el && v1?.type === 'video' && lastSyncedClipRef.current.id === v1.id
      const ready = videoOnScreen && isVideoReady(el)
      if (videoOnScreen && el.currentTime !== lastVideoTime) {
        lastVideoTime = el.currentTime
        if (ready) lastProgressAt = now
      }
      const { time: next } = nextPlayheadTime({
        previousTime: previous,
        wallDeltaSeconds: deltaSeconds,
        videoTime: videoOnScreen ? timelineTimeAtSource(v1, el.currentTime) : null,
        videoReady: ready,
        stalledMs: now - lastProgressAt
      })
      if (next >= contentEndTime) {
        cancelled = true
        playIntentRef.current = false
        applyProjectTime(contentEndTime, false)
        setIsPlaying(false)
        return
      }
      // Update the ref in the same frame rather than waiting for React's
      // render to copy state into it; this keeps the clock monotonic even
      // when React batches several animation frames under heavy UI work.
      currentTimeRef.current = next
      setCurrentTime(next)
      reportTime(next)
      syncVideoToTime(next, true, undefined, true)
      rafHandle = requestAnimationFrame(loop)
    }
    rafHandle = requestAnimationFrame(loop)

    return () => {
      cancelled = true
      if (rafHandle !== null) cancelAnimationFrame(rafHandle)
    }
  }, [isPlaying, previewMode, contentEndTime, reportTime, applyProjectTime, syncVideoToTime, sequence, trackById])

  // Keep the video element's volume/mute in sync with the transport controls
  // AND the active clip's own volume + fade-in/fade-out (spec section 16) --
  // multiplied together, so a clip fade never fights the transport's own
  // volume slider or the global narration-mute toggle. Recomputes every
  // frame during playback (currentTime is a dep) since a fade is
  // time-dependent, not just clip-identity-dependent.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const clipVolume = resolveClipVolume(activeV1Clip, currentTime - (activeV1Clip?.startTime ?? 0))
    let fadeMultiplier = 1
    if (activeV1Clip) {
      const elapsed = currentTime - activeV1Clip.startTime
      const remaining = activeV1Clip.startTime + activeV1Clip.duration - currentTime
      if (activeV1Clip.fadeIn && activeV1Clip.fadeIn > 0 && elapsed < activeV1Clip.fadeIn) {
        fadeMultiplier = Math.min(fadeMultiplier, Math.max(0, elapsed / activeV1Clip.fadeIn))
      }
      if (activeV1Clip.fadeOut && activeV1Clip.fadeOut > 0 && remaining < activeV1Clip.fadeOut) {
        fadeMultiplier = Math.min(fadeMultiplier, Math.max(0, remaining / activeV1Clip.fadeOut))
      }
    }
    const trackMuted = activeV1Clip ? isTrackAudioMutedFn(activeV1Clip.trackId) : false
    // A video clip with a `linkedClipId` has had its audio split off onto
    // its own dedicated audio-track clip (via the explicit "Extract to
    // Audio" action -- see SequenceContext.extractAudio; a plain video
    // import no longer auto-creates this pair, see
    // sequenceOps.buildInsertedClips), which plays separately through
    // SecondaryTrackMedia below. Without this, the video element's own
    // embedded audio track played at the same time as that linked clip's
    // audio, so every such video was audibly doubled/echoing on every
    // playback -- this silences the video element's own track whenever its
    // audio lives in that separate clip instead.
    const audioSplitToLinkedClip = !!activeV1Clip?.linkedClipId
    // This is the SAME clip-level Mute checkbox SecondaryTrackMedia's own
    // volume effect already honors (ClipPropertiesPanel.tsx's Mute toggle,
    // sequenceOps.setClipsMuted) -- missing here meant muting the currently-
    // playing main-track (V1) clip visibly showed the muted badge on it but
    // never actually silenced it.
    const clipMuted = !!activeV1Clip?.muted
    // Story Narration Workspace: the original video keeps playing (visually)
    // while actively recording, for timing reference, but its own audio must
    // stay silent -- otherwise it plays back through the speakers right as
    // the mic is capturing, bleeding into the very take being recorded.
    // Countdown/reviewing/idle are unaffected (the original audio is still
    // audible then, e.g. via "Play Original", for rehearsal/reference).
    const recordingNarration = narration.phase === 'recording'
    el.volume = Math.min(1, Math.max(0, volume * clipVolume * fadeMultiplier * (trackMuted || audioSplitToLinkedClip || clipMuted || recordingNarration ? 0 : 1)))
    el.muted = narrationMuted
  }, [volume, narrationMuted, currentTime, activeV1Clip, isTrackAudioMutedFn, narration.phase])

  // Opacity/transform/crop (spec section 16) applied as plain CSS -- purely
  // derived from the active clip's own data. A plain (unkeyframed) clip's
  // style only ever changes when the clip identity itself changes, so this
  // still memoizes on `activeV1Clip` alone in that case; a clip with
  // Keyframe Animation (see clipVisuals.ts) needs `currentTime` too, the
  // same way the volume/fade effect above already recomputes every frame --
  // `clipHasAnimatedProperties` is what decides which of the two this is,
  // so an unkeyframed clip's dependency list (and therefore recompute
  // frequency) is completely unchanged from before this feature existed.
  const activeClipAnimated = clipHasAnimatedProperties(activeV1Clip)
  const activeClipVisualStyle = useMemo(
    (): React.CSSProperties => computeClipVisualStyle(activeV1Clip, currentTime - (activeV1Clip?.startTime ?? 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `currentTime` is deliberately only a dependency while `activeClipAnimated` is true; see the comment above.
    [activeV1Clip, activeClipAnimated ? currentTime : null]
  )

  // Multi-track compositing/audio-mixing (spec section 20) -- every OTHER
  // active clip besides the one main-track video the existing rvfc-driven
  // <video>/refs above already handle: overlay video tracks, image
  // overlays, and every audio-kind track (which previously had NO playback
  // element at all -- a standalone audio/voiceover clip silently never
  // played). Each renders via SecondaryTrackMedia below, staying in sync by
  // following the same `currentTime`/`isPlaying` state the master clock
  // already produces (not perfectly frame-locked like the rvfc master, but
  // genuinely synchronized playback, not silence/invisibility). Z-order
  // matches "highest track renders on top" (same rule resolveActiveVideoClip
  // itself already uses for picking the master clip).
  const trackOrderById = useMemo(() => Object.fromEntries(sequence.tracks.map((t) => [t.id, t.order] as const)), [sequence.tracks])
  const secondaryClips = useMemo(() => activeClips.filter((c) => c.id !== activeV1Clip?.id), [activeClips, activeV1Clip])

  const isEmpty = sequence.clips.length === 0 && allScenes.length === 0 && previewMode === 'project'

  const togglePlay = (): void => {
    if (previewMode !== 'project') return
    const next = !playIntentRef.current
    playIntentRef.current = next
    setIsPlaying(next)
    syncVideoToTime(currentTime, next)
  }

  const step = (deltaSeconds: number): void => seek(currentTime + deltaSeconds)

  const changeVolume = (value: number): void => setVolume(value)

  const toggleFullscreen = (): void => {
    const el = stageRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen()
  }

  // Player menu (the ≡ in the header): Preview mode / fit, still-frame
  // export, fullscreen -- the same things the controls strip offers,
  // gathered under one button the way CapCut's player menu is.
  const [menuOpen, setMenuOpen] = useState(false)
  const [submenu, setSubmenu] = useState<'preview' | 'scope' | null>(null)
  const menuRootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!menuRootRef.current?.contains(e.target as Node)) {
        setMenuOpen(false)
        setSubmenu(null)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        setSubmenu(null)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])
  const closeMenu = (): void => {
    setMenuOpen(false)
    setSubmenu(null)
  }

  // "Export still frame": the frame under the playhead, saved as a PNG
  // beside the app's other generated files and added to Media, so it can
  // be dropped on the Timeline or found on disk (the dialog says where).
  const canExportStill = previewMode === 'project' && activeV1Clip?.type === 'video'
  const [stillFrame, setStillFrame] = useState<string | null>(null)
  const { projectName } = useProject()
  const exportStillFrame = (): void => {
    closeMenu()
    const dataUrl = captureFrame()
    if (!dataUrl) {
      void confirm({ title: 'No frame to export', message: 'Park the playhead on a video clip in Project Preview first.', confirmLabel: 'OK', cancelLabel: 'Close' })
      return
    }
    setStillFrame(dataUrl)
  }
  const saveStillFrame = async (args: { dirPath: string; fileName: string; bytes: Uint8Array; importIntoProject: boolean }): Promise<void> => {
    const savedPath = await window.api.media.saveStillFrame(args.dirPath, args.fileName, args.bytes)
    if (args.importIntoProject) void importPaths([savedPath])
    void confirm({ title: 'Still frame exported', message: `Saved to ${savedPath}${args.importIntoProject ? ' and added to Media.' : '.'}`, confirmLabel: 'OK', cancelLabel: 'Close' })
  }

  const frameRate = activeMedia?.metadata?.frameRate || 30
  const stillDefaultName = `${(projectName ?? 'Frame').replace(/[\\/:*?"<>|]+/g, '-')} ${formatTimecode(currentTime, frameRate).replace(/[:;]/g, '-')}`

  return (
    <div className="preview-player">
      {stillFrame && <StillFrameExportDialog dataUrl={stillFrame} defaultName={stillDefaultName} onClose={() => setStillFrame(null)} onExport={saveStillFrame} />}
      <div className="preview-header">
        <span className="preview-header-title">Player</span>
        <div className="preview-mode-toggle">
          <button
            className={previewMode === 'project' ? 'preview-mode-button preview-mode-button-active' : 'preview-mode-button'}
            title="Project Preview -- the composed Timeline sequence"
            onClick={() => setPreviewMode('project')}
          >
            Project Preview
          </button>
          <button
            className={previewMode === 'source' ? 'preview-mode-button preview-mode-button-active' : 'preview-mode-button'}
            title={
              narration.active
                ? 'Unavailable during Story Narration -- recording plays back the Project timeline, never the raw source file'
                : "Source Preview -- the selected Media asset's raw file, never affects the Timeline"
            }
            disabled={!selectedMedia || narration.active}
            onClick={() => setPreviewMode('source')}
          >
            Source Preview
          </button>
        </div>
        <div className="preview-menu-root" ref={menuRootRef}>
          <button
            className={menuOpen ? 'preview-header-menu preview-header-menu-open' : 'preview-header-menu'}
            title="Player menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((v) => !v)
              setSubmenu(null)
            }}
          >
            <HamburgerIcon />
          </button>
          {menuOpen && (
            <div className="preview-menu" role="menu">
              <div className="preview-menu-item-wrap" onPointerEnter={() => setSubmenu('scope')}>
                <button className="preview-menu-item" role="menuitem" onClick={() => setSubmenu(submenu === 'scope' ? null : 'scope')}>
                  Color oscilloscope
                  <span className="preview-menu-chevron" aria-hidden>
                    ›
                  </span>
                </button>
                {submenu === 'scope' && (
                  <div className="preview-menu preview-submenu" role="menu">
                    <button
                      className={scopeVisible ? 'preview-menu-item preview-menu-item-checked' : 'preview-menu-item'}
                      role="menuitemradio"
                      aria-checked={scopeVisible}
                      onClick={() => {
                        setScopeVisible(true)
                        closeMenu()
                      }}
                    >
                      Show
                    </button>
                    <button
                      className={!scopeVisible ? 'preview-menu-item preview-menu-item-checked' : 'preview-menu-item'}
                      role="menuitemradio"
                      aria-checked={!scopeVisible}
                      onClick={() => {
                        setScopeVisible(false)
                        closeMenu()
                      }}
                    >
                      Hide
                    </button>
                  </div>
                )}
              </div>
              <div className="preview-menu-item-wrap" onPointerEnter={() => setSubmenu('preview')}>
                <button className="preview-menu-item" role="menuitem" onClick={() => setSubmenu(submenu === 'preview' ? null : 'preview')}>
                  Preview
                  <span className="preview-menu-chevron" aria-hidden>
                    ›
                  </span>
                </button>
                {submenu === 'preview' && (
                  <div className="preview-menu preview-submenu preview-submenu-wide" role="menu">
                    <button
                      className={previewQuality === 'performance' ? 'preview-menu-item preview-menu-item-checked' : 'preview-menu-item'}
                      role="menuitemradio"
                      aria-checked={previewQuality === 'performance'}
                      onClick={() => {
                        setPreviewQuality('performance')
                        closeMenu()
                      }}
                    >
                      <span className="preview-menu-item-text">
                        Best performance
                        <span className="preview-menu-item-hint">Play the video smoothly.</span>
                      </span>
                    </button>
                    <button
                      className={previewQuality === 'quality' ? 'preview-menu-item preview-menu-item-checked' : 'preview-menu-item'}
                      role="menuitemradio"
                      aria-checked={previewQuality === 'quality'}
                      onClick={() => {
                        setPreviewQuality('quality')
                        closeMenu()
                      }}
                    >
                      <span className="preview-menu-item-text">
                        Best quality
                        <span className="preview-menu-item-hint">Show full resolution of the video.</span>
                      </span>
                    </button>
                  </div>
                )}
              </div>
              <div className="preview-menu-item-wrap" onPointerEnter={() => setSubmenu(null)}>
                <button className="preview-menu-item" role="menuitem" disabled={!canExportStill} title={canExportStill ? 'Save the frame under the playhead as an image' : 'Park the playhead on a video clip first'} onClick={exportStillFrame}>
                  Export still frames
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {previewMode === 'source' ? (
        <SourcePreview media={selectedMedia} />
      ) : isEmpty ? (
        <div className="preview-empty">Add media to the Timeline to preview your project</div>
      ) : (
        <>
          <div className="preview-stage-wrap" ref={setStageWrapEl}>
            <div
              className="preview-stage"
              ref={stageRef}
              style={stageSize ? { width: stageSize.width, height: stageSize.height } : { width: '100%', height: '100%' }}
            >
              <div className="preview-stage-clip">
                <video
                  ref={videoRef}
                  style={{ objectFit: fitMode, ...activeClipVisualStyle }}
                  onPlay={(e) => {
                    if (playIntentRef.current) setIsPlaying(true)
                    else e.currentTarget.pause()
                  }}
                  onPause={() => {
                    // Ignore the synthetic pause caused by load()/src swap;
                    // canplay below resumes while intent is still true.
                    if (!playIntentRef.current) setIsPlaying(false)
                  }}
                  onCanPlay={(e) => {
                    if (playIntentRef.current && e.currentTarget.paused) requestVideoPlay(e.currentTarget)
                  }}
                  onError={() => {
                    playIntentRef.current = false
                    setIsPlaying(false)
                  }}
                />
                {!activeV1Clip && <div className="preview-stage-gap" />}
                {secondaryClips.map((clip) => (
                  <SecondaryTrackMedia
                    key={clip.id}
                    clip={clip}
                    media={mediaById[clip.mediaId]}
                    currentTime={currentTime}
                    isPlaying={isPlaying && previewMode === 'project'}
                    globalVolume={volume}
                    narrationMuted={narrationMuted}
                    trackMuted={isTrackAudioMutedFn(clip.trackId)}
                    zIndex={trackOrderById[clip.trackId] ?? 0}
                    quality={previewQuality}
                  />
                ))}
                <GraphicsOverlay scenes={scenes} brand={brandPreset} currentTime={currentTime} selectedSceneId={selectedSceneId} stageSize={stageSize} />
                {scopeVisible && <ColorScope videoRef={videoRef} />}
                {/* Just the line being narrated -- the segment's own time
                    range already shows in the Recording Assistant's card,
                    so the blue timecode chip that used to sit here was a
                    duplicate over the picture. */}
                {narration.active && narration.currentSegment && (
                  <div className="narration-subtitle-overlay">
                    <div className="narration-subtitle-overlay-text">{narration.currentSegment.editedText ?? narration.currentSegment.text}</div>
                  </div>
                )}
              </div>
              <SceneSelectionOverlay stageRef={stageRef} currentTime={currentTime} brand={brandPreset} />
            </div>
          </div>
          <div className="preview-transport">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.01}
              value={currentTime}
              onChange={(e) => seek(Number(e.target.value))}
              className="preview-seek"
              /* Drives the played-portion fill in CSS -- a range input can't
                 colour its own track up to the current value on its own. */
              style={{ '--seek-progress': `${duration > 0 ? (currentTime / duration) * 100 : 0}%` } as React.CSSProperties}
            />
            <div className="preview-controls">
              <div className="preview-controls-left">
                <span className="preview-time">
                  <span className="preview-time-current">{formatTimecode(currentTime, frameRate)}</span>
                  <span className="preview-time-total">{formatTimecode(duration, frameRate)}</span>
                </span>
                <button title={narrationMuted ? 'Unmute' : 'Mute'} onClick={toggleNarrationMuted}>
                  <VolumeIcon muted={narrationMuted} />
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={(e) => changeVolume(Number(e.target.value))}
                  className="preview-volume"
                />
              </div>

              <div className="preview-transport-buttons">
                <button title="Skip to start" onClick={() => seek(0)}>
                  <SkipStartIcon />
                </button>
                <button title="Previous frame" onClick={() => step(-FRAME_STEP_SECONDS)}>
                  <StepBackIcon />
                </button>
                <button className="preview-play-button" title={isPlaying ? 'Pause' : 'Play'} onClick={togglePlay}>
                  {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button title="Next frame" onClick={() => step(FRAME_STEP_SECONDS)}>
                  <StepForwardIcon />
                </button>
                <button title="Skip to end" onClick={() => seek(duration)}>
                  <SkipEndIcon />
                </button>
              </div>

              <div className="preview-controls-right">
                <button disabled={!canExportStill} title={canExportStill ? 'Export still frames' : 'Park the playhead on a video clip first'} onClick={exportStillFrame}>
                  <SnapshotIcon />
                </button>
                <select className="preview-fit-select" title="How the picture fills the player" value={fitMode} onChange={(e) => setFitMode(e.target.value as 'contain' | 'cover')}>
                  <option value="contain">Fit</option>
                  <option value="cover">Fill</option>
                </select>
                <button title="Fullscreen" onClick={toggleFullscreen}>
                  <FullscreenIcon />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

interface SecondaryTrackMediaProps {
  clip: TimelineClip
  media: MediaItem | undefined
  /** The shared project clock -- this element chases it every render rather
   * than owning any playback state itself. */
  currentTime: number
  isPlaying: boolean
  globalVolume: number
  narrationMuted: boolean
  /** Whether this clip's OWN track is silenced by track-level Mute/Solo
   * (see PreviewPlayer's isTrackAudioMuted) -- independent of clip.muted. */
  trackMuted: boolean
  /** Track order, used directly as CSS z-index so overlay stacking matches
   * the exact same "highest track paints on top" rule the main <video>'s own
   * clip-selection (resolveActiveVideoClip) already uses. */
  zIndex: number
  quality: PreviewQuality
}

/** One additional simultaneously-active clip beyond whichever the main
 * <video> element (with its precise rvfc-driven master clock) is already
 * handling -- an overlay video track, an image overlay, or ANY audio-kind
 * track (spec section 20: "replace or extend... do not leave Timeline
 * functionality as UI-only"). Before this component existed, every one of
 * these had no playback element in Preview at all: overlay video/image
 * tracks were invisible, and audio-kind clips (including voiceover) were
 * silent. Mounted/unmounted by its parent's `key={clip.id}` -- switching to
 * a genuinely different clip on the same track remounts fresh rather than
 * reusing the element, which is fine here since these tracks change far
 * less often than the main video does. Stays in sync with the shared clock
 * on every render (not frame-perfect like the rvfc master, but genuinely
 * synchronized, checked continuously during playback) rather than owning a
 * second independent clock that could drift. */
function SecondaryTrackMedia({ clip, media, currentTime, isPlaying, globalVolume, narrationMuted, trackMuted, zIndex, quality }: SecondaryTrackMediaProps): JSX.Element | null {
  const elRef = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const src = mediaUrl(media, quality)
  const localTime = clip.type === 'image' ? 0 : sourceTimeAt(clip, currentTime)

  useEffect(() => {
    const el = elRef.current
    if (!el || clip.type === 'image') return
    el.playbackRate = clipRate(clip)
    if (Math.abs(el.currentTime - localTime) > DRIFT_CORRECTION_THRESHOLD_SECONDS) el.currentTime = localTime
    if (isPlaying) {
      if (el.paused) void el.play().catch(() => {})
    } else if (!el.paused) {
      el.pause()
    }
  })

  useEffect(() => {
    const el = elRef.current
    if (!el || clip.type === 'image') return
    const elapsed = currentTime - clip.startTime
    const clipVolume = resolveClipVolume(clip, elapsed)
    let fadeMultiplier = 1
    const remaining = clip.startTime + clip.duration - currentTime
    if (clip.fadeIn && clip.fadeIn > 0 && elapsed < clip.fadeIn) fadeMultiplier = Math.min(fadeMultiplier, Math.max(0, elapsed / clip.fadeIn))
    if (clip.fadeOut && clip.fadeOut > 0 && remaining < clip.fadeOut) fadeMultiplier = Math.min(fadeMultiplier, Math.max(0, remaining / clip.fadeOut))
    // Same doubled-audio case the main <video> element's own volume effect
    // guards against (see its `audioSplitToLinkedClip`) -- this branch
    // renders every OTHER simultaneously-active video-kind clip (an overlay/
    // picture-in-picture track), which just as easily has its own audio
    // already split onto a separate linked clip that also plays here as a
    // sibling SecondaryTrackMedia instance.
    const audioSplitToLinkedClip = clip.type === 'video' && !!clip.linkedClipId
    el.volume = Math.min(1, Math.max(0, globalVolume * clipVolume * fadeMultiplier * (clip.muted || trackMuted || audioSplitToLinkedClip ? 0 : 1)))
    el.muted = narrationMuted
  })

  if (!src || clip.enabled === false) return null

  const visualStyle: React.CSSProperties = { zIndex, ...computeClipVisualStyle(clip, currentTime - clip.startTime) }

  if (clip.type === 'image') {
    // eslint-disable-next-line jsx-a11y/alt-text -- decorative Timeline overlay, not user-facing content needing description.
    return <img src={src} className="preview-secondary-visual" style={visualStyle} />
  }
  if (clip.type === 'audio') {
    return <audio ref={elRef} src={src} />
  }
  return <video ref={elRef} src={src} className="preview-secondary-visual" style={{ ...visualStyle, objectFit: 'contain' }} />
}

/** Source Preview: a small, self-contained player for one Media asset's raw
 * file, opened explicitly (never the default). Has its own local play/seek
 * state and never touches the project sequence, the Timeline, or the shared
 * playback clock -- switching to it and back leaves Project Preview exactly
 * as it was. */
function SourcePreview({ media }: { media: MediaItem | undefined }): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  const src = mediaUrl(media)

  useEffect(() => {
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(0)
  }, [src])

  if (!media) return <div className="preview-empty">Select a Media asset to preview its source</div>
  if (!src) return <div className="preview-empty">{media.stage === 'error' ? 'Import failed' : 'Processing…'}</div>

  const togglePlay = (): void => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }

  const seek = (value: number): void => {
    const el = videoRef.current
    if (!el) return
    const clamped = Math.min(Math.max(0, value), duration || value)
    el.currentTime = clamped
    setCurrentTime(clamped)
  }

  return (
    <>
      <div className="preview-stage-wrap">
        <div className="preview-stage" style={{ width: '100%', height: '100%' }}>
          <div className="preview-stage-clip">
            <video
              ref={videoRef}
              src={src}
              style={{ objectFit: 'contain' }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            />
          </div>
        </div>
      </div>
      <div className="preview-transport">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={currentTime}
          onChange={(e) => seek(Number(e.target.value))}
          className="preview-seek"
          style={{ '--seek-progress': `${duration > 0 ? (currentTime / duration) * 100 : 0}%` } as React.CSSProperties}
        />
        <div className="preview-controls">
          <div className="preview-controls-left">
            <span className="preview-time">
              <span className="preview-time-current">{formatTimecode(currentTime, 30)}</span>
              <span className="preview-time-total">{formatTimecode(duration, 30)}</span>
            </span>
          </div>
          <div className="preview-transport-buttons">
            <button title="Skip to start" onClick={() => seek(0)}>
              <SkipStartIcon />
            </button>
            <button className="preview-play-button" title={isPlaying ? 'Pause' : 'Play'} onClick={togglePlay}>
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button title="Skip to end" onClick={() => seek(duration)}>
              <SkipEndIcon />
            </button>
          </div>
          <div className="preview-controls-right" />
        </div>
      </div>
    </>
  )
}

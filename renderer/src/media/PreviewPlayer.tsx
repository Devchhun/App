import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMedia } from './MediaContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useScenes } from '../scenes/SceneContext'
import { useSequence } from '../sequence/SequenceContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { GraphicsOverlay } from '../templates/GraphicsOverlay'
import { SceneSelectionOverlay } from '../scenes/SceneSelectionOverlay'
import { formatTimecode } from './format'
import { computeStageSize } from './previewStageSize'
import { getFitModeStorageKey, parseStoredFitMode, type PreviewFitMode } from './previewPreferences'
import { findActiveClips } from '../sequence/sequenceOps'
import { resolveActiveVideoClip, isTrackAudioMuted } from '../timeline/trackModel'
import type { TimelineClip } from '@shared/project'
import {
  PlayIcon,
  PauseIcon,
  SkipStartIcon,
  SkipEndIcon,
  StepBackIcon,
  StepForwardIcon,
  CameraIcon,
  VolumeIcon,
  FullscreenIcon,
  MenuDotsIcon
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

function mediaUrl(media: MediaItem | undefined): string | undefined {
  if (!media || media.stage !== 'ready') return undefined
  return media.proxyUrl ?? media.originalUrl
}

export function PreviewPlayer(): JSX.Element {
  const { items, selectedId } = useMedia()
  const { registerSeek, reportTime, reportDuration, narrationMuted, toggleNarrationMuted, reportPlaying, registerPlayPause, registerFrameCapture } = usePlayback()
  const { scenesByMedia, selectedSceneId } = useScenes()
  const { sequence } = useSequence()
  const { brandPreset } = useBrandPreset()

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
  const [currentTime, setCurrentTime] = useState(0)
  const [volume, setVolume] = useState(1)
  const [previewMode, setPreviewMode] = useState<'project' | 'source'>('project')
  const [fitMode, setFitModeState] = useState<PreviewFitMode>(() => {
    if (typeof localStorage === 'undefined') return 'contain'
    try {
      return parseStoredFitMode(localStorage.getItem(getFitModeStorageKey()))
    } catch {
      return 'contain'
    }
  })
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

  // A project can be pure graphics (scenes with no underlying V1/A1/A2 clip
  // at all -- e.g. a full-frame template over a transparent/solid
  // background) -- the previewable/playable duration must cover whichever
  // is longer, the clip sequence or the furthest scene, or Play would have
  // nothing to advance through and the scrub bar would cap at 0.
  const sceneMaxEnd = allScenes.reduce((max, s) => Math.max(max, s.endTime), 0)
  const duration = Math.max(sequence.duration, sceneMaxEnd > 0 ? sceneMaxEnd + 5 : 0)
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
  const activeSrc = mediaUrl(activeMedia)
  const lastSyncedClipRef = useRef<{ id: string | undefined; src: string | undefined }>({ id: undefined, src: undefined })

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
    (time: number, playing: boolean) => {
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
      const src = mediaUrl(media)
      if (!src) return

      const localTime = v1.type === 'image' ? 0 : v1.sourceIn + (time - v1.startTime)
      const clipChanged = lastSyncedClipRef.current.id !== v1.id
      const srcChanged = lastSyncedClipRef.current.src !== src

      if (srcChanged) {
        el.src = src
        el.load()
      }
      if (clipChanged || srcChanged || Math.abs(el.currentTime - localTime) > DRIFT_CORRECTION_THRESHOLD_SECONDS) {
        el.currentTime = localTime
      }
      lastSyncedClipRef.current = { id: v1.id, src }

      if (v1.type === 'video' && playing) {
        if (el.paused) void el.play().catch(() => {})
      } else if (!el.paused) {
        el.pause()
      }
    },
    [sequence, mediaById, trackById]
  )

  const applyProjectTime = useCallback(
    (time: number, playing: boolean) => {
      const clamped = Math.max(0, Math.min(duration, time))
      setCurrentTime(clamped)
      reportTime(clamped)
      if (previewMode === 'project') syncVideoToTime(clamped, playing)
      return clamped
    },
    [duration, reportTime, previewMode, syncVideoToTime]
  )

  // Explicit seeks (scrub bar, skip buttons, frame step, Timeline click,
  // double-click a clip) -- always forces a full video re-sync.
  const seek = useCallback(
    (value: number) => {
      applyProjectTime(value, isPlaying)
    },
    [applyProjectTime, isPlaying]
  )

  useEffect(() => {
    registerSeek((time: number) => seek(time))
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
    syncVideoToTime(currentTimeRef.current, isPlayingRef.current)
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
      setIsPlaying(playing)
      syncVideoToTime(currentTimeRef.current, playing)
    })
    return () => registerPlayPause(null)
  }, [registerPlayPause, previewMode, syncVideoToTime])

  // Video-driven playback: while the active V1 clip is a real video, ride
  // its native decode clock (rvfc, falling back to rAF) exactly like a
  // single-file player would -- this is what keeps audio and picture in
  // sync. The project's own `currentTime` is derived FROM the video
  // element's position via the clip's startTime/sourceIn mapping.
  useEffect(() => {
    const el = videoRef.current
    if (!el || !isPlaying || previewMode !== 'project' || activeV1Clip?.type !== 'video') return
    const clip = activeV1Clip
    let cancelled = false
    let rafHandle: number | null = null
    let rvfcHandle: number | null = null

    const publish = (): void => {
      if (cancelled) return
      const projectTime = clip.startTime + (el.currentTime - clip.sourceIn)
      if (projectTime >= duration) {
        applyProjectTime(duration, false)
        setIsPlaying(false)
        return
      }
      setCurrentTime(projectTime)
      reportTime(projectTime)
      // Crossing into a different clip (or off the end of this one) is
      // handled by the render-time `activeV1Clip` recompute + this effect's
      // own dependency on it -- but if the NEW active clip is still a video
      // whose id differs, force an explicit sync/handoff here too.
      const stillSameClip = projectTime >= clip.startTime && projectTime < clip.startTime + clip.duration
      if (!stillSameClip) syncVideoToTime(projectTime, true)
    }

    const withRvfc = el as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number
      cancelVideoFrameCallback?: (handle: number) => void
    }

    if (typeof withRvfc.requestVideoFrameCallback === 'function') {
      const loop = (): void => {
        if (cancelled) return
        publish()
        rvfcHandle = withRvfc.requestVideoFrameCallback!(loop)
      }
      rvfcHandle = withRvfc.requestVideoFrameCallback(loop)
    } else {
      const loop = (): void => {
        if (cancelled) return
        publish()
        rafHandle = requestAnimationFrame(loop)
      }
      rafHandle = requestAnimationFrame(loop)
    }

    return () => {
      cancelled = true
      if (rvfcHandle !== null) withRvfc.cancelVideoFrameCallback?.(rvfcHandle)
      if (rafHandle !== null) cancelAnimationFrame(rafHandle)
    }
  }, [isPlaying, previewMode, activeV1Clip, duration, reportTime, applyProjectTime, syncVideoToTime])

  // Wall-clock playback for spans where V1 has no playing video (a still
  // image clip, or a gap) -- nothing else advances time in that case.
  useEffect(() => {
    if (!isPlaying || previewMode !== 'project' || activeV1Clip?.type === 'video') return
    let cancelled = false
    let rafHandle: number | null = null
    let lastNow = performance.now()

    const loop = (now: number): void => {
      if (cancelled) return
      const deltaSeconds = (now - lastNow) / 1000
      lastNow = now
      setCurrentTime((prev) => {
        const next = prev + deltaSeconds
        if (next >= duration) {
          applyProjectTime(duration, false)
          setIsPlaying(false)
          return duration
        }
        reportTime(next)
        syncVideoToTime(next, true)
        return next
      })
      rafHandle = requestAnimationFrame(loop)
    }
    rafHandle = requestAnimationFrame(loop)

    return () => {
      cancelled = true
      if (rafHandle !== null) cancelAnimationFrame(rafHandle)
    }
  }, [isPlaying, previewMode, activeV1Clip?.type, duration, reportTime, applyProjectTime, syncVideoToTime])

  // Keep the video element's volume/mute in sync with the transport controls
  // AND the active clip's own volume + fade-in/fade-out (spec section 16) --
  // multiplied together, so a clip fade never fights the transport's own
  // volume slider or the global narration-mute toggle. Recomputes every
  // frame during playback (currentTime is a dep) since a fade is
  // time-dependent, not just clip-identity-dependent.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const clipVolume = activeV1Clip?.volume ?? 1
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
    el.volume = Math.min(1, Math.max(0, volume * clipVolume * fadeMultiplier * (trackMuted ? 0 : 1)))
    el.muted = narrationMuted
  }, [volume, narrationMuted, currentTime, activeV1Clip, isTrackAudioMutedFn])

  // Opacity/transform/crop (spec section 16) applied as plain CSS -- purely
  // derived from the active clip's own data, no imperative video-element
  // work needed (unlike volume/fades above, which are time-dependent).
  const activeClipVisualStyle = useMemo((): React.CSSProperties => {
    if (!activeV1Clip) return {}
    const t = activeV1Clip.transform
    const style: React.CSSProperties = {}
    if (activeV1Clip.opacity !== undefined) style.opacity = activeV1Clip.opacity
    if (t) {
      style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scaleX}, ${t.scaleY}) rotate(${t.rotation}deg)`
      const top = (t.cropTop ?? 0) * 100
      const right = (t.cropRight ?? 0) * 100
      const bottom = (t.cropBottom ?? 0) * 100
      const left = (t.cropLeft ?? 0) * 100
      if (top || right || bottom || left) style.clipPath = `inset(${top}% ${right}% ${bottom}% ${left}%)`
    }
    return style
  }, [activeV1Clip])

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
    setIsPlaying((prev) => {
      const next = !prev
      syncVideoToTime(currentTime, next)
      return next
    })
  }

  const step = (deltaSeconds: number): void => seek(currentTime + deltaSeconds)

  const changeVolume = (value: number): void => setVolume(value)

  const toggleFullscreen = (): void => {
    const el = stageRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen()
  }

  const frameRate = activeMedia?.metadata?.frameRate || 30

  return (
    <div className="preview-player">
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
            title="Source Preview -- the selected Media asset's raw file, never affects the Timeline"
            disabled={!selectedMedia}
            onClick={() => setPreviewMode('source')}
          >
            Source Preview
          </button>
        </div>
        <button className="preview-header-menu" title="More (coming soon)" disabled>
          <MenuDotsIcon />
        </button>
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
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
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
                  />
                ))}
                <GraphicsOverlay scenes={scenes} brand={brandPreset} currentTime={currentTime} selectedSceneId={selectedSceneId} stageSize={stageSize} />
              </div>
              <SceneSelectionOverlay stageRef={stageRef} currentTime={currentTime} brand={brandPreset} />
            </div>
          </div>
          <div className="preview-transport">
            <div className="preview-controls">
              <span className="preview-time">
                {formatTimecode(currentTime, frameRate)} / {formatTimecode(duration, frameRate)}
              </span>

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
                <button disabled title="Snapshot export lands in a future phase">
                  <CameraIcon />
                </button>
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
                <select className="preview-fit-select" value={fitMode} onChange={(e) => setFitMode(e.target.value as 'contain' | 'cover')}>
                  <option value="contain">Fit</option>
                  <option value="cover">Fill</option>
                </select>
                <button title="Fullscreen" onClick={toggleFullscreen}>
                  <FullscreenIcon />
                </button>
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.01}
              value={currentTime}
              onChange={(e) => seek(Number(e.target.value))}
              className="preview-seek"
            />
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
function SecondaryTrackMedia({ clip, media, currentTime, isPlaying, globalVolume, narrationMuted, trackMuted, zIndex }: SecondaryTrackMediaProps): JSX.Element | null {
  const elRef = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const src = mediaUrl(media)
  const localTime = clip.type === 'image' ? 0 : clip.sourceIn + (currentTime - clip.startTime)

  useEffect(() => {
    const el = elRef.current
    if (!el || clip.type === 'image') return
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
    const clipVolume = clip.volume ?? 1
    let fadeMultiplier = 1
    const elapsed = currentTime - clip.startTime
    const remaining = clip.startTime + clip.duration - currentTime
    if (clip.fadeIn && clip.fadeIn > 0 && elapsed < clip.fadeIn) fadeMultiplier = Math.min(fadeMultiplier, Math.max(0, elapsed / clip.fadeIn))
    if (clip.fadeOut && clip.fadeOut > 0 && remaining < clip.fadeOut) fadeMultiplier = Math.min(fadeMultiplier, Math.max(0, remaining / clip.fadeOut))
    el.volume = Math.min(1, Math.max(0, globalVolume * clipVolume * fadeMultiplier * (clip.muted || trackMuted ? 0 : 1)))
    el.muted = narrationMuted
  })

  if (!src || clip.enabled === false) return null

  const t = clip.transform
  const visualStyle: React.CSSProperties = { zIndex }
  if (clip.opacity !== undefined) visualStyle.opacity = clip.opacity
  if (t) {
    visualStyle.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scaleX}, ${t.scaleY}) rotate(${t.rotation}deg)`
    const top = (t.cropTop ?? 0) * 100
    const right = (t.cropRight ?? 0) * 100
    const bottom = (t.cropBottom ?? 0) * 100
    const left = (t.cropLeft ?? 0) * 100
    if (top || right || bottom || left) visualStyle.clipPath = `inset(${top}% ${right}% ${bottom}% ${left}%)`
  }

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
      <div className="preview-transport">
        <div className="preview-controls">
          <span className="preview-time">
            {formatTimecode(currentTime, 30)} / {formatTimecode(duration, 30)}
          </span>
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
        </div>
        <input type="range" min={0} max={duration || 0} step={0.01} value={currentTime} onChange={(e) => seek(Number(e.target.value))} className="preview-seek" />
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CastScanProgress } from '@shared/cast'
import type { DubbingSpeakerProfile } from '@shared/dubbing'
import { useMedia } from '../media/MediaContext'
import { isPastRecordingBound } from '../timeline/recordingBounds'
import { useAiDubber } from './AiDubberContext'
import { ENGINE_LABEL, useEngineVoices } from './engineVoices'
import type { VoiceModel } from './voiceModels'
import { getVoxCpmSettingsStorageKey, parseStoredVoxCpmSettings } from './voxcpmSettings'

/** Take the music out before listening: remembered between openings. */
const REMOVE_MUSIC_KEY = 'cae-cast-remove-music'
/** The Detect Gender review's own key for "Cloned" or "All" voices. */
const VOICE_TAB_KEY = 'cae-detect-gender-voice-tab'

/** Playable URLs of the portraits (the app-media protocol), asked for once
 * per file for as long as the app runs. */
const faceUrls = new Map<string, string | null>()

function useFaceUrls(paths: string[]): Map<string, string | null> {
  const [, setTick] = useState(0)
  const key = paths.join('|')
  useEffect(() => {
    let live = true
    const missing = paths.filter((path) => !faceUrls.has(path))
    if (missing.length === 0) return
    void Promise.all(
      missing.map(async (path) => {
        faceUrls.set(path, await window.api.dubbing.audioUrl(path).catch(() => null))
      })
    ).then(() => {
      if (live) setTick((t) => t + 1)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the paths.
  }, [key])
  return faceUrls
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** A colour of its own for each voice model, by its place in the list --
 * the same rule the Detect Gender review uses. */
function voiceHue(index: number): number {
  return Math.round((Math.max(0, index) * 137.508 + 18) % 360)
}

interface Props {
  onClose: () => void
}

/** The Cast window: every voice heard in the video as a card -- the
 * speaker's face, their lines to play one by one, and under the picture the
 * voice model that will speak them. One choice per character instead of one
 * per subtitle line (Detect Gender). Opened from the Timeline's toolbar. */
export function CastWindow({ onClose }: Props): JSX.Element {
  const aiDubber = useAiDubber()
  const { items } = useMedia()
  const [settings] = useState(() => parseStoredVoxCpmSettings(localStorage.getItem(getVoxCpmSettingsStorageKey())))
  const engineVoices = useEngineVoices(settings.engine)
  const voices = engineVoices.voices

  const [removeMusic, setRemoveMusicState] = useState(() => {
    try {
      return localStorage.getItem(REMOVE_MUSIC_KEY) !== '0'
    } catch {
      return true
    }
  })
  const setRemoveMusic = (on: boolean): void => {
    setRemoveMusicState(on)
    try {
      localStorage.setItem(REMOVE_MUSIC_KEY, on ? '1' : '0')
    } catch {
      // Remembering it is only a convenience.
    }
  }

  // ---- the scan
  const [progress, setProgress] = useState<CastScanProgress | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const jobRef = useRef<string | null>(null)
  const scanning = progress !== null
  useEffect(
    () =>
      window.api.dubbing.onCastProgress((update) => {
        if (update.jobId === jobRef.current) setProgress(update)
      }),
    []
  )
  // Closing the window stops a scan still running.
  useEffect(
    () => () => {
      if (jobRef.current) void window.api.dubbing.cancelCast(jobRef.current)
    },
    []
  )

  const segments = aiDubber.segments
  const scan = async (): Promise<void> => {
    if (scanning) return
    const lines = segments.flatMap((segment) => {
      const source = aiDubber.sourceOfLine(segment)
      const path = source ? items.find((m) => m.id === source.mediaId)?.originalPath : undefined
      return source && path ? [{ id: segment.id, path, start: source.start, end: source.end }] : []
    })
    if (lines.length === 0) {
      setScanError('The video these subtitles belong to could not be found.')
      return
    }
    stop()
    const jobId = `cast-${Date.now().toString(36)}`
    jobRef.current = jobId
    setScanError(null)
    setScanNote(null)
    setProgress({ jobId, stage: 'model', percent: 0, message: 'Starting…' })
    const answer = await window.api.dubbing.scanCast({ jobId, lines, removeMusic, voxCpmInstallDir: settings.installDir || undefined }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error), canceled: false }))
    if (jobRef.current !== jobId) return
    jobRef.current = null
    setProgress(null)
    if (!answer.ok) {
      if (!answer.canceled) setScanError(answer.error)
      return
    }
    aiDubber.applyCast(answer.result)
    setSampleAt({})
    setReviewing({})
    const notes: string[] = []
    if (removeMusic && !answer.result.speechOnly) notes.push('The music could not be taken out first (that needs the VoxCPM2 runtime and a graphics card), so the voices were heard over it — expect more lines in the wrong voice.')
    if (answer.result.unheardIds.length > 0) notes.push(`${answer.result.unheardIds.length} line${answer.result.unheardIds.length === 1 ? ' has' : 's have'} nothing to hear (silence or too short).`)
    setScanNote(notes.join(' ') || null)
  }
  const cancelScan = (): void => {
    const jobId = jobRef.current
    if (!jobId) return
    jobRef.current = null
    setProgress(null)
    void window.api.dubbing.cancelCast(jobId)
  }

  // ---- the cast
  const cast = useMemo(
    () =>
      Object.values(aiDubber.state.speakers)
        .filter((speaker) => speaker.sampleIds !== undefined && speaker.segmentIds.length > 0)
        .sort((a, b) => b.segmentIds.length - a.segmentIds.length),
    [aiDubber.state.speakers]
  )
  const segmentById = useMemo(() => new Map(segments.map((segment, index) => [segment.id, { segment, number: index + 1 }])), [segments])
  const castLineIds = useMemo(() => new Set(cast.flatMap((speaker) => speaker.segmentIds)), [cast])
  const looseCount = cast.length > 0 ? segments.filter((segment) => !castLineIds.has(segment.id)).length : 0
  const unsureCount = cast.reduce((sum, speaker) => sum + (speaker.unsureIds?.length ?? 0), 0)
  const chosenCount = cast.filter((speaker) => speaker.voiceId).length
  const chosenLines = cast.filter((speaker) => speaker.voiceId).reduce((sum, speaker) => sum + speaker.segmentIds.length, 0)
  const urls = useFaceUrls(cast.flatMap((speaker) => speaker.faces ?? []))
  const voiceOf = (voiceId: string | undefined): VoiceModel | undefined => (voiceId ? voices.find((voice) => voice.id === voiceId) : undefined)

  // ---- hearing a line: the original, from its own video
  const videoRef = useRef<HTMLVideoElement>(null)
  const stopAtRef = useRef(0)
  const [playing, setPlaying] = useState<{ speakerId: string; lineId: string } | null>(null)
  /** Which line each card shows (its place in the card's list). */
  const [sampleAt, setSampleAt] = useState<Record<string, number>>({})
  /** Cards showing only their "not sure" lines. */
  const [reviewing, setReviewing] = useState<Record<string, boolean>>({})

  const listOf = (speaker: DubbingSpeakerProfile): string[] => {
    if (reviewing[speaker.id] && speaker.unsureIds?.length) return speaker.unsureIds
    const own = new Set(speaker.segmentIds)
    const first = (speaker.sampleIds ?? []).filter((id) => own.has(id))
    const firstSet = new Set(first)
    return [...first, ...speaker.segmentIds.filter((id) => !firstSet.has(id))]
  }
  const stop = (): void => {
    videoRef.current?.pause()
    setPlaying(null)
  }
  const play = (speakerId: string, lineId: string): void => {
    const video = videoRef.current
    const found = segmentById.get(lineId)
    const source = found ? aiDubber.sourceOfLine(found.segment) : null
    const media = source ? items.find((m) => m.id === source.mediaId) : undefined
    const src = media?.proxyUrl ?? media?.originalUrl
    if (!video || !source || !src) return
    stopAtRef.current = source.end
    const start = (): void => {
      video.currentTime = source.start
      void video.play().catch(() => undefined)
    }
    if (video.getAttribute('src') !== src) {
      video.setAttribute('src', src)
      video.addEventListener('loadedmetadata', start, { once: true })
      video.load()
    } else if (video.readyState >= 1) start()
    else video.addEventListener('loadedmetadata', start, { once: true })
    setPlaying({ speakerId, lineId })
  }
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onTime = (): void => {
      if (isPastRecordingBound(video.currentTime, stopAtRef.current)) {
        video.pause()
        setPlaying(null)
      }
    }
    const onEnded = (): void => setPlaying(null)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('ended', onEnded)
    return () => {
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('ended', onEnded)
    }
  }, [])

  const step = (speaker: DubbingSpeakerProfile, by: number): void => {
    const list = listOf(speaker)
    if (list.length === 0) return
    const at = (((sampleAt[speaker.id] ?? 0) + by) % list.length + list.length) % list.length
    setSampleAt((prev) => ({ ...prev, [speaker.id]: at }))
    play(speaker.id, list[at])
  }

  // ---- choosing a voice model, moving a line, merging two voices
  const [pickFor, setPickFor] = useState<string | null>(null)
  // Cloned or all voices: the same choice as the Detect Gender review's.
  const [voiceTab, setVoiceTabState] = useState<'cloned' | 'all'>(() => {
    try {
      return localStorage.getItem(VOICE_TAB_KEY) === 'cloned' ? 'cloned' : 'all'
    } catch {
      return 'all'
    }
  })
  const setVoiceTab = (tab: 'cloned' | 'all'): void => {
    setVoiceTabState(tab)
    try {
      localStorage.setItem(VOICE_TAB_KEY, tab)
    } catch {
      // Remembering it is only a convenience.
    }
  }
  const [voiceSearch, setVoiceSearch] = useState('')
  const [panel, setPanel] = useState<{ speakerId: string; kind: 'move' | 'merge' } | null>(null)
  const picking = pickFor ? cast.find((speaker) => speaker.id === pickFor) : undefined
  const clonedVoices = voices.filter((voice) => voice.category === 'custom')
  const shownVoices = (voiceTab === 'cloned' && clonedVoices.length > 0 ? clonedVoices : voices).filter((voice) => !voiceSearch.trim() || voice.name.toLowerCase().includes(voiceSearch.trim().toLowerCase()))
  /** How many characters each voice model speaks for. */
  const usedBy = new Map<string, number>()
  for (const speaker of cast) if (speaker.voiceId) usedBy.set(speaker.voiceId, (usedBy.get(speaker.voiceId) ?? 0) + 1)

  const chooseVoice = (speaker: DubbingSpeakerProfile, voice: VoiceModel): void => {
    aiDubber.setSpeakerVoice(speaker.id, voice.id)
    // On to the next character still without a voice.
    const next = cast.find((other) => other.id !== speaker.id && !other.voiceId)
    setPickFor(next ? next.id : null)
    setVoiceSearch('')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (panel) setPanel(null)
      else if (pickFor) setPickFor(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, pickFor, onClose])

  const nowPlaying = playing ? segmentById.get(playing.lineId) : undefined
  const ready = segments.length > 0 && !!aiDubber.state.videoMediaId

  const card = (speaker: DubbingSpeakerProfile): JSX.Element => {
    const list = listOf(speaker)
    const at = Math.min(sampleAt[speaker.id] ?? 0, Math.max(0, list.length - 1))
    const lineId = list[at]
    const line = lineId ? segmentById.get(lineId) : undefined
    const faces = speaker.faces ?? []
    const face = faces.length > 0 ? urls.get(faces[Math.min(speaker.faceIndex ?? 0, faces.length - 1)]) : null
    const voice = voiceOf(speaker.voiceId)
    const playingThis = playing?.speakerId === speaker.id
    const unsure = speaker.unsureIds ?? []
    const lineUnsure = !!lineId && unsure.includes(lineId)
    const others = cast.filter((other) => other.id !== speaker.id)
    const open = panel?.speakerId === speaker.id ? panel.kind : null
    const hue = speaker.voiceId ? voiceHue(voices.findIndex((v) => v.id === speaker.voiceId)) : null
    return (
      <article
        key={speaker.id}
        className={`cast-card${speaker.voiceId ? ' cast-card-chosen' : ''}${pickFor === speaker.id ? ' cast-card-picking' : ''}${playingThis ? ' cast-card-playing' : ''}`}
        style={hue !== null ? ({ '--cast-hue': hue } as React.CSSProperties) : undefined}
      >
        <div className="cast-portrait">
          {face ? <img src={face} alt="" draggable={false} /> : <div className={`cast-portrait-empty cast-portrait-${speaker.gender}`}>{speaker.name.trim().slice(0, 1).toUpperCase() || '?'}</div>}
          <div className="cast-portrait-shade" />
          <button
            className={`cast-chip cast-chip-gender cast-chip-${speaker.gender}`}
            title="Male or female, from the pitch of the voice — click to change"
            onClick={() => aiDubber.setSpeakerGender(speaker.id, speaker.gender === 'male' ? 'female' : 'male')}
          >
            {speaker.gender === 'male' ? '♂ Male' : speaker.gender === 'female' ? '♀ Female' : '? Voice'}
          </button>
          <span className="cast-chip cast-chip-lines" title={`${speaker.segmentIds.length} subtitle lines · ${clock(speaker.speechSeconds ?? 0)} of speech`}>
            {speaker.segmentIds.length} line{speaker.segmentIds.length === 1 ? '' : 's'}
          </span>
          {faces.length > 1 && (
            <>
              <button className="cast-face-step cast-face-prev" title="Another picture" onClick={() => aiDubber.setSpeakerFace(speaker.id, (speaker.faceIndex ?? 0) - 1)}>
                ‹
              </button>
              <button className="cast-face-step cast-face-next" title="Another picture" onClick={() => aiDubber.setSpeakerFace(speaker.id, (speaker.faceIndex ?? 0) + 1)}>
                ›
              </button>
            </>
          )}
          <button
            className="cast-play"
            title={playingThis ? 'Stop' : 'Hear this voice in the original'}
            disabled={!lineId}
            onClick={() => (playingThis ? stop() : lineId && play(speaker.id, lineId))}
          >
            {playingThis ? (
              <span className="cast-bars" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
            ) : (
              <span aria-hidden="true">▶</span>
            )}
          </button>
          <div className="cast-portrait-foot">
            <input className="cast-name" value={speaker.name} spellCheck={false} lang="km" title="Name this character" onChange={(e) => aiDubber.renameSpeaker(speaker.id, e.target.value)} />
            <button className="cast-more" title="Same person as another card? Merge them" disabled={others.length === 0} onClick={() => setPanel(open === 'merge' ? null : { speakerId: speaker.id, kind: 'merge' })}>
              ⋯
            </button>
          </div>
          {open && (
            <div className="cast-panel">
              <div className="cast-panel-head">
                <strong>{open === 'move' ? 'This line is said by…' : 'Same person as…'}</strong>
                <button onClick={() => setPanel(null)} aria-label="Close">
                  ×
                </button>
              </div>
              <div className="cast-panel-list">
                {others.map((other) => {
                  const otherFace = other.faces?.length ? urls.get(other.faces[Math.min(other.faceIndex ?? 0, other.faces.length - 1)]) : null
                  return (
                    <button
                      key={other.id}
                      onClick={() => {
                        if (open === 'move' && lineId) aiDubber.moveSegmentsToSpeaker([lineId], other.id)
                        else if (open === 'merge') aiDubber.mergeSpeakers(speaker.id, other.id)
                        setPanel(null)
                      }}
                    >
                      {otherFace ? <img src={otherFace} alt="" /> : <span className="cast-panel-letter">{other.name.trim().slice(0, 1).toUpperCase() || '?'}</span>}
                      <span lang="km">{other.name}</span>
                      <small>{other.segmentIds.length}</small>
                    </button>
                  )
                })}
                {open === 'move' && lineId && speaker.segmentIds.length > 1 && (
                  <button
                    className="cast-panel-new"
                    onClick={() => {
                      aiDubber.moveSegmentsToSpeaker([lineId], null)
                      setPanel(null)
                    }}
                  >
                    <span className="cast-panel-letter">+</span>
                    <span>Somebody new</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className={`cast-sample${lineUnsure ? ' cast-sample-unsure' : ''}`}>
          <button className="cast-sample-step" title="The line before" disabled={list.length < 2} onClick={() => step(speaker, -1)}>
            ‹
          </button>
          <div className="cast-sample-text" title={line ? (line.segment.editedText ?? line.segment.text) : undefined}>
            <small>
              {line ? `Line ${line.number}` : 'No line'} · {list.length === 0 ? 0 : at + 1} of {list.length}
              {lineUnsure && <b> · not sure</b>}
            </small>
            <span lang="km">{line ? (line.segment.editedText ?? line.segment.text) : ''}</span>
          </div>
          <button className="cast-sample-step" title="The next line" disabled={list.length < 2} onClick={() => step(speaker, 1)}>
            ›
          </button>
        </div>

        <div className="cast-fix">
          {unsure.length > 0 ? (
            <button
              className={`cast-unsure${reviewing[speaker.id] ? ' cast-unsure-on' : ''}`}
              title="Lines the scan was not sure belong to this voice. Play them: confirm the right ones, move the others."
              onClick={() => {
                setReviewing((prev) => ({ ...prev, [speaker.id]: !prev[speaker.id] }))
                setSampleAt((prev) => ({ ...prev, [speaker.id]: 0 }))
              }}
            >
              {reviewing[speaker.id] ? `Checking ${unsure.length} unsure` : `${unsure.length} not sure`}
            </button>
          ) : (
            <span className="cast-sure">All lines sure</span>
          )}
          {lineUnsure && (
            <button className="cast-fix-button cast-fix-yes" title="Yes, this line is this voice" onClick={() => lineId && aiDubber.moveSegmentsToSpeaker([lineId], speaker.id)}>
              ✓ Right
            </button>
          )}
          <button className="cast-fix-button" title="This line is somebody else: move it to their card" disabled={!lineId || (others.length === 0 && speaker.segmentIds.length < 2)} onClick={() => setPanel(open === 'move' ? null : { speakerId: speaker.id, kind: 'move' })}>
            ⇄ Wrong voice
          </button>
        </div>

        {/* Age: a child's or an old person's lines speak in the story's
            child / old voice (Voice Model: Voices for the whole story). */}
        <div className="cast-age" role="radiogroup" aria-label="Age of this character">
          {(
            [
              ['child', '🧒 Child'],
              ['adult', 'Adult'],
              ['elder', '👴 Old']
            ] as const
          ).map(([age, label]) => {
            const current = speaker.ageCategory === 'young' || speaker.ageCategory === 'unknown' ? 'adult' : speaker.ageCategory
            return (
              <button
                key={age}
                type="button"
                role="radio"
                aria-checked={current === age}
                className={current === age ? 'cast-age-option cast-age-option-active' : 'cast-age-option'}
                title={age === 'adult' ? "A grown-up: the man's or the woman's voice" : `A ${age === 'child' ? 'child' : 'old person'}: the story's ${age === 'child' ? 'child' : 'old man / old woman'} voice for all ${speaker.segmentIds.length} lines`}
                onClick={() => aiDubber.setSpeakerAge(speaker.id, age)}
              >
                {label}
              </button>
            )
          })}
        </div>

        <button className={`cast-voice${voice ? ' cast-voice-set' : ''}`} onClick={() => setPickFor(pickFor === speaker.id ? null : speaker.id)} title="The voice model that speaks this character's lines">
          {voice ? (
            <>
              <span className={`cast-voice-avatar cast-voice-avatar-${voice.gender}`}>{voice.avatarLetter}</span>
              <span className="cast-voice-name">
                <strong lang="km">{voice.name}</strong>
                <small>{voice.description}</small>
              </span>
            </>
          ) : (
            <>
              <span className="cast-voice-avatar cast-voice-avatar-none">+</span>
              <span className="cast-voice-name">
                <strong>{speaker.voiceId ? 'A voice of another engine' : 'Choose a voice'}</strong>
                <small>{speaker.voiceId ? `Pick one of ${ENGINE_LABEL[settings.engine]}'s` : `for all ${speaker.segmentIds.length} lines`}</small>
              </span>
            </>
          )}
          <svg className="cast-voice-caret" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 4.5 6 8l3.5-3.500" />
          </svg>
        </button>
      </article>
    )
  }

  return createPortal(
    <div className="modal-overlay cast-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* Small while there is only a question or a progress bar to show;
          the full window once there are cards to lay out. */}
      <div className={`cast-window${scanning || cast.length === 0 ? ' cast-window-small' : ''}`} role="dialog" aria-label="Cast: the voices of the video">
        <header className="cast-header">
          <div className="cast-title">
            <span className="cast-title-icon" aria-hidden="true">
              <CastGlyph size={20} />
            </span>
            <div>
              <h2>Cast</h2>
              <p>{cast.length > 0 ? 'Listen to each voice, then choose the voice model that fits it.' : 'Find every voice in the video and give each one a voice model.'}</p>
            </div>
          </div>
          {cast.length > 0 && !scanning && (
            <div className="cast-stats">
              <span>
                <b>{cast.length}</b> voice{cast.length === 1 ? '' : 's'}
              </span>
              <span>
                <b>{castLineIds.size}</b> lines
              </span>
              {unsureCount > 0 && (
                <span className="cast-stat-unsure">
                  <b>{unsureCount}</b> not sure
                </span>
              )}
              <span className="cast-stat-engine">{ENGINE_LABEL[settings.engine]}</span>
            </div>
          )}
          {cast.length > 0 && !scanning && (
            <button className="cast-rescan" onClick={() => void scan()} title="Listen to the video again. The voices chosen for the lines are kept.">
              ↻ Scan again
            </button>
          )}
          <button className="cast-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {scanning && progress ? (
          <div className="cast-scanning">
            <div className="cast-scan-orb" aria-hidden="true">
              <CastGlyph size={34} />
            </div>
            <strong>{progress.message}</strong>
            <div className="cast-scan-track">
              <span style={{ width: `${Math.max(2, progress.percent)}%` }} />
            </div>
            <div className="cast-scan-steps">
              {(['audio', 'voices', 'grouping', 'faces'] as const).map((stage, i) => {
                const order = ['model', 'audio', 'voices', 'grouping', 'faces', 'ready']
                const state = order.indexOf(progress.stage) > order.indexOf(stage) ? 'done' : progress.stage === stage ? 'now' : 'next'
                return (
                  <span key={stage} className={`cast-scan-step cast-scan-step-${state}`}>
                    {i + 1}. {stage === 'audio' ? 'Sound' : stage === 'voices' ? 'Voices' : stage === 'grouping' ? 'Who is who' : 'Faces'}
                  </span>
                )
              })}
            </div>
            <button className="cast-cancel" onClick={cancelScan}>
              Cancel
            </button>
          </div>
        ) : cast.length === 0 ? (
          <div className="cast-empty">
            <div className="cast-scan-orb" aria-hidden="true">
              <CastGlyph size={34} />
            </div>
            <h3>{ready ? `Scan the voices of ${segments.length} lines` : 'Nothing to scan yet'}</h3>
            <p>
              {ready
                ? 'The app listens to every subtitle line, groups the lines by who is speaking, and shows each speaker with their face. You then play each voice and choose its voice model once — instead of line by line.'
                : 'Open AI Dubber and add the video with its subtitles (or run Auto SRT) first.'}
            </p>
            {ready && (
              <>
                <label className="cast-option" title="Music and effects under the speech make different people sound alike. Taking them out first (needs the VoxCPM2 runtime and a graphics card; done once per video) puts more lines with the right voice.">
                  <input type="checkbox" checked={removeMusic} onChange={(e) => setRemoveMusic(e.target.checked)} />
                  <span>
                    Take the music out first <small>more accurate · slower the first time</small>
                  </span>
                </label>
                <button className="cast-scan-button" onClick={() => void scan()}>
                  <CastGlyph size={16} /> Scan voices
                </button>
              </>
            )}
            {scanError && <div className="cast-error">{scanError}</div>}
          </div>
        ) : (
          <div className="cast-body">
            <div className="cast-main">
              {(scanNote || scanError || looseCount > 0) && (
                <div className="cast-notes">
                  {scanError && <div className="cast-error">{scanError}</div>}
                  {scanNote && <div className="cast-note">{scanNote}</div>}
                  {looseCount > 0 && (
                    <div className="cast-note">
                      {looseCount} line{looseCount === 1 ? ' is' : 's are'} in no voice here (nothing to hear, or added after the scan) — {looseCount === 1 ? 'it keeps' : 'they keep'} the voice set in Detect Gender.
                    </div>
                  )}
                </div>
              )}
              <div className="cast-grid">{cast.map(card)}</div>
            </div>

            {picking && (
              <aside className="cast-picker">
                <div className="cast-picker-head">
                  <div>
                    <small>Voice model for</small>
                    <strong lang="km">{picking.name}</strong>
                  </div>
                  <button aria-label="Close" onClick={() => setPickFor(null)}>
                    ×
                  </button>
                </div>
                <div className="cast-picker-tools">
                  {clonedVoices.length > 0 && (
                    <div className="cast-picker-tabs">
                      <button className={voiceTab === 'cloned' ? 'on' : ''} onClick={() => setVoiceTab('cloned')}>
                        Cloned ({clonedVoices.length})
                      </button>
                      <button className={voiceTab === 'all' ? 'on' : ''} onClick={() => setVoiceTab('all')}>
                        All ({voices.length})
                      </button>
                    </div>
                  )}
                  <input className="cast-picker-search" placeholder="Search a voice…" value={voiceSearch} onChange={(e) => setVoiceSearch(e.target.value)} />
                </div>
                {engineVoices.error && <div className="cast-error">{engineVoices.error}</div>}
                {engineVoices.loading && <div className="cast-note">Loading the voices…</div>}
                <div className="cast-picker-list">
                  {shownVoices.map((voice) => {
                    const used = usedBy.get(voice.id) ?? 0
                    const current = picking.voiceId === voice.id
                    return (
                      <button
                        key={voice.id}
                        className={`cast-picker-voice${current ? ' cast-picker-voice-on' : ''}${used > 0 ? ' cast-picker-voice-used' : ''}`}
                        style={used > 0 ? ({ '--cast-hue': voiceHue(voices.findIndex((v) => v.id === voice.id)) } as React.CSSProperties) : undefined}
                        onClick={() => chooseVoice(picking, voice)}
                      >
                        <span className={`cast-voice-avatar cast-voice-avatar-${voice.gender}`}>{voice.avatarLetter}</span>
                        <span className="cast-voice-name">
                          <strong lang="km">{voice.name}</strong>
                          <small>{voice.description}</small>
                        </span>
                        {used > 0 && (
                          <span className="cast-picker-used" title={`Speaks for ${used} character${used === 1 ? '' : 's'}`}>
                            {used}
                          </span>
                        )}
                        {current && <span className="cast-picker-tick">✓</span>}
                      </button>
                    )
                  })}
                  {!engineVoices.loading && shownVoices.length === 0 && <div className="cast-note">No voice matches.</div>}
                </div>
              </aside>
            )}
          </div>
        )}

        {cast.length > 0 && !scanning && (
          <footer className="cast-footer">
            <div className="cast-footer-progress">
              <div className="cast-footer-track">
                <span style={{ width: `${(chosenLines / Math.max(1, castLineIds.size)) * 100}%` }} />
              </div>
              <span>
                {chosenCount} of {cast.length} voices chosen · {chosenLines} of {castLineIds.size} lines
              </span>
            </div>
            <span className="cast-footer-hint">Choosing a voice sets it on all of that character's lines. Then press Generate Dubbing.</span>
            <button className="cast-done" onClick={onClose}>
              Done
            </button>
          </footer>
        )}

        {/* The line being played, from its own video: seen while heard, to
            check that the face on the card is the one speaking. */}
        <div className={`cast-player${playing ? ' cast-player-on' : ''}`}>
          <video ref={videoRef} playsInline preload="auto" />
          {nowPlaying && (
            <div className="cast-player-text">
              <small>Line {nowPlaying.number}</small>
              <span lang="km">{nowPlaying.segment.editedText ?? nowPlaying.segment.text}</span>
            </div>
          )}
          <button aria-label="Stop" onClick={stop}>
            ■
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Two faces: the Cast window's mark (also on its toolbar button). */
export function CastGlyph({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.4" />
      <path d="M2.8 19.5c.5-3.4 3-5.5 6.2-5.5s5.700 2.100 6.200 5.500" />
      <circle cx="17" cy="9.200" r="2.600" />
      <path d="M16.800 14.200c2.400.200 4 1.900 4.400 4.600" />
    </svg>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { KIRI_CLONE_MAX_SECONDS, KIRI_CLONE_MIN_SECONDS, type KiriVoice } from '@shared/kiriTts'
import { useAiDubber } from './AiDubberContext'
import { VOICE_MODELS } from './voiceModels'
import { useSavedVoices, savedVoiceToModel } from './useSavedVoices'
import { savedVoiceId } from './savedVoices'
import { kiriCopyOf } from './useKiriVoices'
import { useCopyVoxToKiri } from './useCopyVoxToKiri'
import { resolveLineVoice } from './dubbingPlan'
import { parseStoredVoxCpmSettings, getVoxCpmSettingsStorageKey } from './voxcpmSettings'

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

/** "12:34", "1:02:03" or plain seconds -> seconds; null when unreadable. */
function parseClock(text: string): number | null {
  const parts = text.trim().split(':').map((p) => p.trim())
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null
  return parts.reduce((total, part) => total * 60 + Number(part), 0)
}

interface Props {
  voices: KiriVoice[]
  onChanged: () => void
  onClose: () => void
}

/** KiriTTS's voice cloning, in one place: a new voice from the right part
 * of a recording or video (listened to first, optionally with the music
 * taken out), VoxCPM2 voices copied over, and the clones already on the
 * account. */
export function KiriCloneDialog({ voices, onChanged, onClose }: Props): JSX.Element {
  const aiDubber = useAiDubber()
  const savedVoices = useSavedVoices()
  const installDir = useMemo(() => parseStoredVoxCpmSettings(localStorage.getItem(getVoxCpmSettingsStorageKey())).installDir, [])

  // ---- a new clone
  const [source, setSource] = useState<{ path: string; fileName: string; durationSeconds: number } | null>(null)
  const [start, setStart] = useState(0)
  const [startText, setStartText] = useState('0:00')
  const [length, setLength] = useState(20)
  const [isolate, setIsolate] = useState(!!installDir)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const maxStart = source ? Math.max(0, source.durationSeconds - KIRI_CLONE_MIN_SECONDS) : 0
  const usedLength = source ? Math.min(length, Math.max(1, source.durationSeconds - start)) : length

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  useEffect(() => () => audioRef.current?.pause(), [])

  const setStartAt = (seconds: number): void => {
    const clamped = Math.min(maxStart, Math.max(0, seconds))
    setStart(clamped)
    setStartText(clock(clamped))
  }

  const pickSource = async (): Promise<void> => {
    const picked = await window.api.kiri.pickCloneSource()
    if (!picked.ok) {
      if (!picked.canceled) setStatus({ text: picked.error ?? 'Could not open that file.', error: true })
      return
    }
    stopPreview()
    setSource({ path: picked.path, fileName: picked.fileName, durationSeconds: picked.durationSeconds })
    setStart(0)
    setStartText('0:00')
    setLength(Math.min(20, Math.max(KIRI_CLONE_MIN_SECONDS, Math.floor(picked.durationSeconds))))
    if (!name.trim()) setName(picked.fileName.replace(/\.[^.]+$/, '').slice(0, 40))
    setStatus(null)
  }

  const stopPreview = (): void => {
    audioRef.current?.pause()
    setPlaying(false)
  }

  const preview = async (): Promise<void> => {
    if (!source) return
    if (playing) return stopPreview()
    const url = await window.api.dubbing.audioUrl(source.path)
    if (!url) return setStatus({ text: 'That file is missing.', error: true })
    const audio = audioRef.current ?? new Audio()
    audioRef.current = audio
    const end = start + usedLength
    audio.ontimeupdate = () => {
      if (audio.currentTime >= end) stopPreview()
    }
    audio.onended = () => setPlaying(false)
    if (audio.src !== url) audio.src = url
    const begin = (): void => {
      audio.currentTime = start
      void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    }
    if (audio.readyState >= 1) begin()
    else audio.addEventListener('loadedmetadata', begin, { once: true })
  }

  const clone = async (): Promise<void> => {
    if (!source || !name.trim() || busy) return
    stopPreview()
    setBusy(true)
    setStatus({ text: isolate ? 'Taking the voice out of the music, then cloning…' : 'Cloning…' })
    try {
      const result = await window.api.kiri.cloneVoice(name.trim(), source.path, { start, duration: usedLength, isolateVoice: isolate, installDir })
      if (result.ok) {
        setStatus({ text: `"${result.voice.name}" is ready -- pick it in the Voice Model list or in Detect Gender.` })
        setName('')
        onChanged()
      } else if (!result.canceled) setStatus({ text: result.error, error: true })
    } finally {
      setBusy(false)
    }
  }

  // ---- VoxCPM2 voices copied over
  const copier = useCopyVoxToKiri(onChanged)
  const [copyPick, setCopyPick] = useState('')
  const copyable = useMemo(
    () => [...VOICE_MODELS.filter((v) => v.id !== 'custom-voice'), ...savedVoices.map((v) => savedVoiceToModel(v, savedVoiceId(v.id)))].filter((v) => !kiriCopyOf(v.id, voices)),
    [savedVoices, voices]
  )
  const usedNotCopied = useMemo(() => {
    const used = new Set<string>()
    for (const seg of aiDubber.segments) {
      const line = aiDubber.state.segments[seg.id] ?? { voiceId: undefined, detectedGender: 'unknown' as const }
      const speakerId = aiDubber.state.segments[seg.id]?.speakerId ?? seg.speakerId
      used.add(resolveLineVoice(line, speakerId ? aiDubber.state.speakers[speakerId] : undefined, 'voxcpm2').voiceId)
    }
    return [...used].filter((id) => copyable.some((v) => v.id === id))
  }, [copyable, aiDubber.segments, aiDubber.state.segments, aiDubber.state.speakers])

  const clones = voices.filter((v) => v.cloned)

  return createPortal(
    <div className="kiri-clone-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="kiri-clone-panel" role="dialog" aria-label="Clone a voice">
        <div className="kiri-clone-head">
          <span className="kiri-clone-icon" aria-hidden="true">
            🎙
          </span>
          <div className="kiri-clone-title">
            <strong>Clone a voice</strong>
            <small>KiriTTS · a new voice from {KIRI_CLONE_MIN_SECONDS}–{KIRI_CLONE_MAX_SECONDS} seconds of one person speaking</small>
          </div>
          <button className="kiri-clone-close" aria-label="Close" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>

        <div className="kiri-clone-body">
          <section className="kiri-clone-section">
            <div className="kiri-clone-step">
              <span className="kiri-clone-step-no">1</span>
              <strong>Recording</strong>
            </div>
            <button className="kiri-clone-file" onClick={() => void pickSource()} disabled={busy}>
              {source ? (
                <>
                  <span className="kiri-clone-file-name">{source.fileName}</span>
                  <span className="kiri-clone-file-meta">{clock(source.durationSeconds)} · change</span>
                </>
              ) : (
                <span className="kiri-clone-file-name">Choose an audio or video file…</span>
              )}
            </button>

            {source && (
              <>
                <div className="kiri-clone-range">
                  <label>
                    <span>Start at</span>
                    <input
                      className="kiri-clone-start"
                      value={startText}
                      disabled={busy}
                      onChange={(e) => setStartText(e.target.value)}
                      onBlur={() => {
                        const parsed = parseClock(startText)
                        if (parsed === null) setStartText(clock(start))
                        else setStartAt(parsed)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      }}
                    />
                  </label>
                  <input
                    type="range"
                    className="kiri-clone-slider"
                    min={0}
                    max={Math.max(0, Math.floor(maxStart))}
                    step={1}
                    value={Math.floor(start)}
                    disabled={busy || maxStart <= 0}
                    onChange={(e) => setStartAt(Number(e.target.value))}
                  />
                </div>
                <div className="kiri-clone-range">
                  <label>
                    <span>Length</span>
                    <strong>{Math.round(usedLength)} s</strong>
                  </label>
                  <input
                    type="range"
                    className="kiri-clone-slider"
                    min={KIRI_CLONE_MIN_SECONDS}
                    max={KIRI_CLONE_MAX_SECONDS}
                    step={1}
                    value={length}
                    disabled={busy}
                    onChange={(e) => setLength(Number(e.target.value))}
                  />
                </div>
                <div className="kiri-clone-preview-row">
                  <button className="kiri-clone-preview" onClick={() => void preview()} disabled={busy}>
                    {playing ? '■ Stop' : '▶ Listen'} {clock(start)}–{clock(start + usedLength)}
                  </button>
                  <label className="kiri-clone-check" title={installDir ? 'Demucs keeps only the voice -- the music and effects of a drama clip would otherwise be learnt into the clone.' : 'Needs the VoxCPM2 runtime (Settings > Voice Engine).'}>
                    <input type="checkbox" checked={isolate} disabled={busy || !installDir} onChange={(e) => setIsolate(e.target.checked)} />
                    Remove music &amp; noise first
                  </label>
                </div>
              </>
            )}
            <p className="kiri-clone-tip">Best: one person only, speaking clearly and calmly — no music, no other voices, no shouting. Listen to the part before cloning.</p>
          </section>

          <section className="kiri-clone-section">
            <div className="kiri-clone-step">
              <span className="kiri-clone-step-no">2</span>
              <strong>Name</strong>
            </div>
            <div className="kiri-clone-name-row">
              <input
                className="kiri-clone-name"
                value={name}
                placeholder="e.g. តួឯកស្រី"
                disabled={busy}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void clone()
                }}
              />
              <button className="kiri-clone-go" onClick={() => void clone()} disabled={!source || !name.trim() || busy}>
                {busy ? 'Cloning…' : '🎙 Clone voice'}
              </button>
            </div>
            {status && <div className={status.error ? 'kiri-clone-status kiri-clone-status-error' : 'kiri-clone-status'}>{status.text}</div>}
          </section>

          <section className="kiri-clone-section kiri-clone-section-muted">
            <div className="kiri-clone-step">
              <span className="kiri-clone-step-no">⇪</span>
              <strong>Copy a VoxCPM2 voice</strong>
              <small>VoxCPM2 reads ~20 s on this computer, KiriTTS clones it</small>
            </div>
            {copier.job ? (
              <div className="kiri-clone-copy-row">
                <span className="kiri-clone-status">
                  Copying {copier.job.index}/{copier.job.total}: {copier.job.name} — {copier.job.phase === 'speaking' ? 'VoxCPM2 is reading a sample…' : 'KiriTTS is cloning it…'}
                </span>
                <button className="kiri-clone-link" onClick={copier.cancel}>
                  Stop
                </button>
              </div>
            ) : (
              <div className="kiri-clone-copy-row">
                <select value={copyPick} onChange={(e) => setCopyPick(e.target.value)} disabled={busy}>
                  <option value="">Choose a VoxCPM2 voice…</option>
                  {copyable.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                <button
                  className="kiri-clone-secondary"
                  disabled={!copyPick || busy}
                  onClick={() => {
                    void copier.copy([copyPick])
                    setCopyPick('')
                  }}
                >
                  Copy
                </button>
                {usedNotCopied.length > 0 && (
                  <button className="kiri-clone-secondary" disabled={busy} title={usedNotCopied.map((id) => copyable.find((v) => v.id === id)?.name).join(', ')} onClick={() => void copier.copy(usedNotCopied)}>
                    This project&apos;s voices ({usedNotCopied.length})
                  </button>
                )}
              </div>
            )}
            {copier.message && <div className="kiri-clone-status">{copier.message}</div>}
          </section>

          <section className="kiri-clone-section kiri-clone-section-muted">
            <div className="kiri-clone-step">
              <span className="kiri-clone-step-no">✓</span>
              <strong>Your cloned voices</strong>
              <small>{clones.length}</small>
            </div>
            {clones.length === 0 ? (
              <p className="kiri-clone-tip">None yet.</p>
            ) : (
              <div className="kiri-clone-chips">
                {clones.map((v) => (
                  <span key={v.id} className="kiri-clone-chip" title={v.name}>
                    {v.name}
                  </span>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body
  )
}

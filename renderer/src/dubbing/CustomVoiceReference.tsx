import { useCallback, useEffect, useRef, useState } from 'react'
import { useAiDubber } from './AiDubberContext'
import { useMicrophoneCapture } from '../timeline/useMicrophoneCapture'
import { addSavedVoice, loadSavedVoices, loadStoryNarratorVoiceId, removeSavedVoice, savedVoiceId, storeSavedVoices, storeStoryNarratorVoiceId, type SavedCustomVoice, BUILTIN_NARRATORS, narratorDisplayName, type BuiltinNarrator } from './savedVoices'
import { parseStoredVoxCpmSettings, getVoxCpmSettingsStorageKey } from './voxcpmSettings'
import { referenceClipVerdict, type ReferenceClipQuality } from '@shared/dubbing'

/** What the quality verdict means for the user, in terms of what they'll
 * hear -- the numbers behind it are in voice_clip_quality.py. */
const VERDICT_TEXT: Record<ReturnType<typeof referenceClipVerdict>, { label: string; hint: string }> = {
  good: { label: 'Clones well', hint: 'One steady voice, clean -- lines will sound like this clip.' },
  fair: { label: 'Clones OK', hint: 'Some lines may drift a little from this voice.' },
  weak: {
    label: 'Weak clip',
    hint: 'Music, noise, clipping, or an unsteady voice -- lines WILL drift to other voices. Use 8s of one clear voice with nothing underneath.'
  }
}

/** Where the recorder stops on its own. The main process only ever hands
 * the model the first 8s of a reference (voxcpmTts.ts's
 * REFERENCE_CLIP_SECONDS -- measured to clone tighter than a longer clip),
 * so past ~10s the user is just talking into a part of the clip that will
 * be cut off. A little headroom over 8 so a natural sentence can finish. */
const MAX_REFERENCE_SECONDS = 10
/** Below this there isn't enough voice for the model to clone from
 * (measured: a 5s clip clones far worse than 8s). */
const MIN_USEFUL_SECONDS = 5

const EVEN_VOICE_PREF_KEY = 'cae-even-voice-v1'

function readEvenVoicePref(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    return localStorage.getItem(EVEN_VOICE_PREF_KEY) !== '0'
  } catch {
    return true
  }
}

/** Custom Voice's reference clip: record one here, or point at an existing
 * file. Both routes go through the same prepareReferenceClip conversion in
 * the main process, because neither a browser MediaRecorder .webm nor a
 * picked .mp3 is readable by the model's own audio loader -- previously a
 * picked mp3 would simply fail deep inside the model process with no
 * explanation reaching the panel. */
/** `variant`: 'dubber' (default) is the Voice Model panel's Custom Voice
 * section, with per-subtitle Use/All buttons and the clip note. 'script'
 * is the same recorder/picker embedded in the Recap Script panel as "My
 * Voice" -- record yourself once here, and the saved voice shows up in
 * AI Dubber's grid ready to narrate the story; the subtitle-specific
 * buttons and note are left out since there is no subtitle in scope. */
export function CustomVoiceReference({ variant = 'dubber' }: { variant?: 'dubber' | 'script' } = {}): JSX.Element {
  const aiDubber = useAiDubber()
  const isScript = variant === 'script'
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clipSeconds, setClipSeconds] = useState<number | null>(null)
  const [clipQuality, setClipQuality] = useState<ReferenceClipQuality | null>(null)
  // "Even voice": level the clip (trim, even out, hold peaks) before it
  // becomes the reference. On by default -- an unevenly recorded reference
  // clones unevenly. Remembered per machine like the voices themselves.
  const [evenVoice, setEvenVoice] = useState<boolean>(() => readEvenVoicePref())
  const toggleEvenVoice = useCallback((next: boolean) => {
    setEvenVoice(next)
    try {
      localStorage.setItem(EVEN_VOICE_PREF_KEY, next ? '1' : '0')
    } catch {
      // Storage unavailable -- the choice still applies this session.
    }
  }, [])

  const [saveName, setSaveName] = useState(variant === 'script' ? 'My Voice' : '')
  const [savedVoices, setSavedVoices] = useState<SavedCustomVoice[]>(() => loadSavedVoices())
  // Script variant: which saved voice narrates the story. Picking one
  // applies it to every line of the current AI Dubber workspace (if any)
  // and to every workspace prepared from now on.
  const [narratorVoiceId, setNarratorVoiceId] = useState<string | null>(() => loadStoryNarratorVoiceId())
  const chooseNarrator = useCallback(
    (voice: SavedCustomVoice) => {
      const id = savedVoiceId(voice.id)
      const next = narratorVoiceId === id ? null : id
      setNarratorVoiceId(next)
      storeStoryNarratorVoiceId(next)
      if (next) aiDubber.setAllSegmentsVoice(next)
    },
    [narratorVoiceId, aiDubber]
  )
  // A built-in (Edge TTS) narrator: the dubber's lines get the catalog
  // card that speaks with the same Edge voice.
  const chooseBuiltinNarrator = useCallback(
    (narrator: BuiltinNarrator) => {
      const next = narratorVoiceId === narrator.id ? null : narrator.id
      setNarratorVoiceId(next)
      storeStoryNarratorVoiceId(next)
      if (next) aiDubber.setAllSegmentsVoice(narrator.dubberVoiceId)
    },
    [narratorVoiceId, aiDubber]
  )

  const mic = useMicrophoneCapture(true)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /** Writes through to storage as well as state, so the list survives a
   * reload and is visible to generateDubbing (which reads storage directly
   * rather than holding its own copy). */
  const commitSavedVoices = useCallback((next: SavedCustomVoice[]) => {
    setSavedVoices(next)
    storeSavedVoices(next)
  }, [])

  const handleSave = useCallback(() => {
    const name = saveName.trim()
    const referenceAudioPath = aiDubber.state.customVoiceReferenceAudioPath
    if (!name || !referenceAudioPath) return
    commitSavedVoices(
      addSavedVoice(savedVoices, {
        id: crypto.randomUUID(),
        name,
        referenceAudioPath,
        createdAt: new Date().toISOString()
      })
    )
    setSaveName('')
  }, [saveName, aiDubber.state.customVoiceReferenceAudioPath, savedVoices, commitSavedVoices])

  const handleDelete = useCallback(
    (id: string) => {
      commitSavedVoices(removeSavedVoice(savedVoices, id))
      if (narratorVoiceId === savedVoiceId(id)) {
        setNarratorVoiceId(null)
        storeStoryNarratorVoiceId(null)
      }
    },
    [savedVoices, commitSavedVoices, narratorVoiceId]
  )

  const stopTicking = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current)
    tickRef.current = null
  }, [])

  /** Shared by "picked a file" and "finished recording" -- convert, measure,
   * then adopt. Only a clip that actually converted becomes the reference,
   * so the stored path is always something the model can read. */
  const adoptSource = useCallback(
    async (sourcePath: string) => {
      setBusy(true)
      setError(null)
      try {
        // The install folder is what makes the quality verdict possible
        // (measured by the runtime's own speaker encoder); without one the
        // clip is still prepared, just not judged.
        const installDir = parseStoredVoxCpmSettings(typeof localStorage === 'undefined' ? null : localStorage.getItem(getVoxCpmSettingsStorageKey())).installDir
        const result = await window.api.dubbing.prepareReferenceClip(`custom-voice-${Date.now()}`, sourcePath, installDir || undefined, evenVoice)
        if (!result.ok) {
          setError(result.error)
          return
        }
        if (result.durationSeconds < MIN_USEFUL_SECONDS) {
          setError(`That clip is only ${result.durationSeconds.toFixed(1)}s. Aim for ${MIN_USEFUL_SECONDS}-${MAX_REFERENCE_SECONDS}s of clear speech.`)
          return
        }
        setClipSeconds(result.durationSeconds)
        setClipQuality(result.quality ?? null)
        aiDubber.setCustomVoiceReferenceAudio(result.outputPath)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [aiDubber, evenVoice]
  )

  const startRecording = useCallback(async () => {
    setError(null)
    try {
      if (!mic.streamRef.current) await mic.openMic()
      const stream = mic.streamRef.current
      if (!stream) {
        setError('No microphone available.')
        return
      }
      chunksRef.current = []
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        void (async () => {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          chunksRef.current = []
          const bytes = new Uint8Array(await blob.arrayBuffer())
          const savedPath = await window.api.media.saveGeneratedFile(`custom-voice-${Date.now()}.webm`, bytes)
          await adoptSource(savedPath)
        })()
      }
      recorder.start()
      recorderRef.current = recorder
      setElapsed(0)
      setRecording(true)
      tickRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [mic, adoptSource])

  const stopRecording = useCallback(() => {
    stopTicking()
    setRecording(false)
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  }, [stopTicking])

  // Hard stop at the ceiling: anything past it is trimmed away by the
  // converter regardless, so letting it run just wastes the user's breath.
  useEffect(() => {
    if (recording && elapsed >= MAX_REFERENCE_SECONDS) stopRecording()
  }, [recording, elapsed, stopRecording])

  useEffect(() => {
    return () => {
      stopTicking()
      const recorder = recorderRef.current
      recorderRef.current = null
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null
        recorder.stop()
      }
    }
  }, [stopTicking])

  const hasReference = !!aiDubber.state.customVoiceReferenceAudioPath

  return (
    <div className={isScript ? 'ai-dubber-custom-voice-setup ai-dubber-custom-voice-setup-script' : 'ai-dubber-custom-voice-setup'}>
      {!isScript && <div className="scene-properties-group-title">Custom Voice reference</div>}
      <p className="ai-dubber-custom-voice-hint">
        {isScript
          ? 'Record about 8 seconds of yourself reading a few lines, or choose a clean recording of your voice. Saved voices appear in AI Dubber under Custom, ready to narrate the whole story in your voice.'
          : 'Record about 8 seconds of clear, steady speech in one voice, or choose an audio file. Every line is cloned from the first 8s.'}
      </p>

      <label className="ai-dubber-even-voice" title="Trims the silence, evens out loud and quiet words and holds the peaks before the clip is used, so every generated line clones from one steady level">
        <input type="checkbox" checked={evenVoice} onChange={(e) => toggleEvenVoice(e.target.checked)} disabled={busy || recording} />
        <span className="ai-dubber-even-voice-text">
          <span className="ai-dubber-even-voice-label">Even voice</span>
          <span className="ai-dubber-even-voice-hint">Steady level, no peaks -- applied when the recording is prepared</span>
        </span>
      </label>

      <div className="ai-dubber-custom-voice-actions">
        {recording ? (
          <button className="ai-dubber-custom-voice-record ai-dubber-custom-voice-record-active" onClick={stopRecording}>
            <span className="ai-dubber-custom-voice-stop-square" />
            Stop ({MAX_REFERENCE_SECONDS - elapsed}s)
          </button>
        ) : (
          <button className="ai-dubber-custom-voice-record" disabled={busy} onClick={() => void startRecording()}>
            <span className="ai-dubber-custom-voice-record-dot" />
            {hasReference ? 'Record again' : 'Record voice'}
          </button>
        )}
        <button
          className="narration-setup-secondary-button"
          disabled={busy || recording}
          onClick={() => {
            void window.api.media.pickFiles().then((paths) => {
              if (paths[0]) void adoptSource(paths[0])
            })
          }}
        >
          Choose file…
        </button>
      </div>

      {recording && (
        <div className="voiceover-recorder-level-track">
          <div className="voiceover-recorder-level-bar" ref={mic.levelBarRef} />
        </div>
      )}

      {busy && <div className="ai-dubber-custom-voice-status">Preparing reference…</div>}
      {error && <div className="voiceover-recorder-error">{error}</div>}
      {mic.error && !error && <div className="voiceover-recorder-error">{mic.error}</div>}

      {hasReference && !busy && (
        <div className="ai-dubber-custom-voice-ready">
          ✓ Reference ready{clipSeconds !== null ? ` (${clipSeconds.toFixed(1)}s)` : ''}{evenVoice ? ' · evened' : ''}
        </div>
      )}

      {/* Whether this clip will actually hold one voice across every line
          -- the clip decides that, not any generation setting, so it's
          said here, before sixty lines come out in the wrong voice. */}
      {hasReference && !busy && clipQuality && (() => {
        const verdict = referenceClipVerdict(clipQuality)
        return (
          <div className={`ai-dubber-clip-quality ai-dubber-clip-quality-${verdict}`} title={`voice consistency ${clipQuality.consistency.toFixed(2)}`}>
            <span className="ai-dubber-clip-quality-label">{VERDICT_TEXT[verdict].label}</span>
            <span className="ai-dubber-clip-quality-hint">{VERDICT_TEXT[verdict].hint}</span>
          </div>
        )
      })()}

      {/* Naming it is what turns a one-off recording into a voice you can
          keep: saved voices show up as their own cards in the grid above, so
          a script with several characters can have a real voice each. Saved
          per machine, not per project -- see savedVoices.ts. */}
      {hasReference && !busy && (
        <div className="ai-dubber-custom-voice-save-row">
          <input
            className="ai-dubber-voice-search"
            type="text"
            placeholder={isScript ? 'Voice name (e.g. My Voice)' : 'Character name (e.g. Wang Lin)'}
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
            }}
          />
          <button className="ai-dubber-custom-voice-save" disabled={!saveName.trim()} onClick={handleSave}>
            Save voice
          </button>
        </div>
      )}

      {isScript && (
        <div className="ai-dubber-custom-voice-pick-hint">
          {narratorVoiceId ? 'Narrator: ' : 'Tap a voice to narrate the story with it'}
          {narratorVoiceId && <strong>{narratorDisplayName(narratorVoiceId) ?? '—'}</strong>}
        </div>
      )}

      {/* Built-in narrators: no recording needed, and a fixed voice means
          every sentence comes out in exactly the same voice -- the trade
          is that they need internet and can't sound like you. */}
      {isScript && (
        <div className="ai-dubber-saved-voice-list">
          {BUILTIN_NARRATORS.map((n) => (
            <div
              key={n.id}
              className={narratorVoiceId === n.id ? 'ai-dubber-saved-voice-row ai-dubber-saved-voice-row-narrator' : 'ai-dubber-saved-voice-row'}
              role="radio"
              aria-checked={narratorVoiceId === n.id}
              onClick={() => chooseBuiltinNarrator(n)}
            >
              <span className="ai-dubber-saved-voice-radio" aria-hidden />
              <span className="ai-dubber-saved-voice-name" title="Microsoft Edge neural voice -- spoken online, no recording or model needed">
                {n.name}
              </span>
              <span className="ai-dubber-saved-voice-tag">{n.hint}</span>
            </div>
          ))}
        </div>
      )}

      {savedVoices.length > 0 && (
        <div className="ai-dubber-saved-voice-list">
          {savedVoices.map((v) => (
            <div
              key={v.id}
              className={isScript && narratorVoiceId === savedVoiceId(v.id) ? 'ai-dubber-saved-voice-row ai-dubber-saved-voice-row-narrator' : 'ai-dubber-saved-voice-row'}
              role={isScript ? 'radio' : undefined}
              aria-checked={isScript ? narratorVoiceId === savedVoiceId(v.id) : undefined}
              onClick={isScript ? () => chooseNarrator(v) : undefined}
            >
              {isScript && <span className="ai-dubber-saved-voice-radio" aria-hidden />}
              <span className="ai-dubber-saved-voice-name" title={v.referenceAudioPath}>
                {v.name}
              </span>
              {!isScript && (
              <button
                className="ai-dubber-saved-voice-use"
                disabled={!aiDubber.selectedSubtitleId}
                title={aiDubber.selectedSubtitleId ? `Use ${v.name} for the selected subtitle` : 'Select a subtitle row on the left first'}
                onClick={() => {
                  if (aiDubber.selectedSubtitleId) aiDubber.setSegmentVoice(aiDubber.selectedSubtitleId, savedVoiceId(v.id))
                }}
              >
                Use
              </button>
              )}
              {!isScript && (
              <button className="ai-dubber-saved-voice-all" title={`Use ${v.name} for EVERY subtitle`} onClick={() => aiDubber.setAllSegmentsVoice(savedVoiceId(v.id))}>
                All
              </button>
              )}
              <button
                className="ai-dubber-saved-voice-delete"
                title={`Delete ${v.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  handleDelete(v.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Optional, and never sent to the model -- VoxCPM2's cloning takes no
          transcript (its CLI rejects --prompt-text without --prompt-audio).
          Kept only as a note to yourself about what the clip says. */}
      {!isScript && (
        <input
          className="ai-dubber-voice-search"
          type="text"
          placeholder="Note: what does this clip say? (optional)"
          value={aiDubber.state.customVoiceReferenceText ?? ''}
          onChange={(e) => aiDubber.setCustomVoiceReferenceText(e.target.value)}
        />
      )}
    </div>
  )
}

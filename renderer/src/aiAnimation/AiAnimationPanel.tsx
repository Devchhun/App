import { useCallback, useEffect, useRef, useState } from 'react'
import { ANIMATION_GENRES, ANIMATION_MINUTES, ANIMATION_STYLES, ANIMATION_VOICES, type AnimationCaption, type AnimationGenre, type AnimationProgress, type AnimationRequest, type AnimationResult, type AnimationStyle } from '@shared/aiAnimation'
import { useProject } from '../project/ProjectContext'
import type { Transcript, TranscriptSegment } from '@shared/transcription'
import { useTranscript } from '../transcript/TranscriptContext'
import { useMedia } from '../media/MediaContext'
import { useSequence } from '../sequence/SequenceContext'
import { usePlaybackControls } from '../playback/PlaybackContext'
import { assetFromMediaItem } from '../media/assetFromMediaItem'
import { findOrCreateTrack, type OccupiedRange } from '../timeline/trackModel'
import { ExportIcon, FolderIcon, PlusIcon } from '../nav/icons'

/** The AI Animation tab (right sidebar, after AI Story): a topic in, a
 * narrated animated film out, drawn with the Kuanimation kit. The work
 * happens in the main process (app/main/animation/kuanimationService.ts);
 * the finished MP4 lands in Media, one click from the Timeline. */

const FORM_KEY = 'cae-ai-animation-form-v1'
const RESULT_KEY = 'cae-ai-animation-last-v1'

interface FormState { brief: string; style: AnimationStyle; voice: string; minutes: number; width: 1280 | 1920; burnSubtitles: boolean; music: boolean; genre: AnimationGenre; source: 'topic' | 'script'; script: string }

const DEFAULT_FORM: FormState = { brief: '', style: 'pencil', voice: 'km-KH-PisethNeural', minutes: 1, width: 1280, burnSubtitles: true, music: true, genre: 'general', source: 'topic', script: '' }
const FAILED_KEY = 'cae-ai-animation-failed-v1'
/** The AI Story tab's recap script (useRecapNarration writes it). */
const RECAP_SCRIPT_PREFIX = 'cae-ai-script-v1:'
/** The service's cap: about ten minutes of narration. */
const MAX_SCRIPT_CHARS = 9000

/** How long a script reads: Khmer ≈ 0.1 s a character, English ≈ 0.4 s a word. */
function scriptMinutes(script: string, language: 'km' | 'en'): number {
  const text = script.trim()
  if (!text) return 0
  const seconds = language === 'km' ? text.replace(/\s+/g, '').length * 0.1 : text.split(/\s+/).length * 0.4
  return seconds * 1.15 / 60
}

/** The film's narration as the imported video's transcript: it shows on the
 * Timeline's caption track and feeds captions export and the AI Dubber. */
function captionsTranscript(mediaId: string, captions: AnimationCaption[]): Transcript {
  const segments: TranscriptSegment[] = captions.map((caption, i) => ({
    id: `anim-${i}-${caption.startTime.toFixed(3)}`,
    words: [{ text: caption.text, startTime: caption.startTime, endTime: caption.endTime, confidence: 1 }],
    startTime: caption.startTime,
    endTime: caption.endTime,
    language: 'auto',
    confidence: 1,
    text: caption.text,
    needsReview: false
  }))
  return { mediaId, segments, requestedLanguage: 'auto', generatedAt: new Date().toISOString(), audioSourcePath: '', source: 'srt' }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // A full or blocked storage only loses the remembered form.
  }
}

const PHASE_LABEL: Record<AnimationProgress['phase'], string> = {
  writing: 'Writing the story',
  voicing: 'Recording the voice',
  staging: 'Animating the scenes',
  checking: 'Checking the animation',
  directing: 'AI director review',
  rendering: 'Drawing the film',
  mixing: 'Mixing the sound',
  done: 'Done'
}

export function AiAnimationPanel(): JSX.Element {
  const { items, importPaths } = useMedia()
  const { transcripts, setImportedTranscript } = useTranscript()
  const captionsAttached = useRef(new Set<string>())
  const { sequence, insertClip, ensureTrack } = useSequence()
  const { getCurrentTime } = usePlaybackControls()
  const [form, setForm] = useState<FormState>(() => readJson(FORM_KEY, DEFAULT_FORM))
  const [jobId, setJobId] = useState<string | null>(null)
  const [progress, setProgress] = useState<AnimationProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AnimationResult | null>(() => readJson<AnimationResult | null>(RESULT_KEY, null))
  /** A film that stopped part-way and can continue (kept across restarts). */
  const [failedFolder, setFailedFolder] = useState<string | null>(() => { try { return localStorage.getItem(FAILED_KEY) } catch { return null } })
  const { projectId } = useProject()

  useEffect(() => writeJson(FORM_KEY, form), [form])
  useEffect(() => window.api.aiAnimation.onProgress((event) => {
    if (event.jobId === jobId) setProgress((current) => ({ ...event, preview: event.preview ?? current?.preview }))
  }), [jobId])

  const patch = (next: Partial<FormState>): void => setForm((current) => ({ ...current, ...next }))

  const rememberFailed = (folder: string | null): void => {
    setFailedFolder(folder)
    try { if (folder) localStorage.setItem(FAILED_KEY, folder); else localStorage.removeItem(FAILED_KEY) } catch { /* only the Continue button is lost */ }
  }

  const generate = async (resumeFolder?: string): Promise<void> => {
    const usingScript = form.source === 'script'
    if (!resumeFolder && !(usingScript ? form.script.trim() : form.brief.trim())) {
      setError(usingScript ? 'Paste the script first.' : 'Describe what the film should be about first.')
      return
    }
    const id = `ai-animation-${Date.now()}`
    setJobId(id)
    setError(null)
    setProgress({ jobId: id, phase: 'writing', percent: 0, message: resumeFolder ? 'Continuing where it stopped…' : 'Starting…' })
    const request: AnimationRequest = {
      jobId: id,
      brief: usingScript ? '' : form.brief,
      script: usingScript ? form.script : undefined,
      genre: form.genre,
      style: form.style,
      voice: form.voice,
      minutes: form.minutes,
      width: form.width,
      burnSubtitles: form.burnSubtitles,
      music: form.music,
      ...(resumeFolder ? { resumeFolder } : {})
    }
    const answer = await window.api.aiAnimation.generate(request)
    setJobId(null)
    setProgress(null)
    if (!answer.ok) {
      if (!answer.canceled) setError(answer.error)
      // Whatever was finished (plan, voice, chapters) is kept for Continue.
      rememberFailed(answer.folder ?? resumeFolder ?? null)
      return
    }
    rememberFailed(null)
    setResult(answer.data)
    writeJson(RESULT_KEY, answer.data)
    // Into Media right away, so it can go onto the Timeline.
    void importPaths([answer.data.outputPath])
  }

  const imported = result ? items.find((item) => item.originalPath === result.outputPath) : undefined

  // Once the film is in Media, its narration becomes its captions (once --
  // a transcript the user has since edited is left alone).
  useEffect(() => {
    if (!imported || !result?.captions?.length || transcripts[imported.id] || captionsAttached.current.has(imported.id)) return
    captionsAttached.current.add(imported.id)
    setImportedTranscript(imported.id, captionsTranscript(imported.id, result.captions))
  }, [imported, result, transcripts, setImportedTranscript])

  const addToTimeline = useCallback(() => {
    if (!imported?.readyToUse) return
    const duration = imported.metadata?.durationSeconds ?? result?.durationSeconds ?? 5
    const occupied: OccupiedRange[] = sequence.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
    const at = getCurrentTime()
    const routing = findOrCreateTrack(sequence.tracks, occupied, at, duration, 'video')
    if (routing.newTrack) ensureTrack(routing.newTrack)
    insertClip(assetFromMediaItem(imported), at, routing.trackId)
  }, [imported, result, sequence.clips, sequence.tracks, getCurrentTime, ensureTrack, insertClip])

  const busy = Boolean(jobId)
  const language = ANIMATION_VOICES.find((v) => v.id === form.voice)?.language ?? 'km'
  const scriptLength = form.script.trim().length
  const scriptTooLong = scriptLength > MAX_SCRIPT_CHARS
  const recapScript = (): string => { try { return localStorage.getItem(`${RECAP_SCRIPT_PREFIX}${projectId ?? 'draft'}`) ?? '' } catch { return '' } }
  const canStart = form.source === 'script' ? scriptLength > 0 && !scriptTooLong : form.brief.trim().length > 0

  return (
    <section className="video-story-recap video-story-recap-open">
      <div className="video-story-panel-title">
        <span className="video-story-title-icon">✦</span>
        <span><strong>AI Animation</strong><small>A topic or your own script in, a narrated animated film out</small></span>
      </div>
      <div className="video-story-controls ai-animation">
        <div className="ai-animation-field">
          <span>Story world</span>
          <div className="ai-animation-segments">
            {ANIMATION_GENRES.map((genre) => (
              <button key={genre.id} type="button" title={genre.hint} disabled={busy} className={form.genre === genre.id ? 'ai-animation-chip active' : 'ai-animation-chip'} onClick={() => patch({ genre: genre.id, ...(form.genre !== genre.id ? { style: genre.style } : {}) })}>{genre.label}</button>
            ))}
          </div>
        </div>

        <div className="ai-animation-field">
          <span>Narration</span>
          <div className="ai-animation-segments">
            <button type="button" disabled={busy} className={form.source === 'topic' ? 'ai-animation-chip active' : 'ai-animation-chip'} onClick={() => patch({ source: 'topic' })}>Topic — AI writes it</button>
            <button type="button" disabled={busy} className={form.source === 'script' ? 'ai-animation-chip active' : 'ai-animation-chip'} onClick={() => patch({ source: 'script' })}>My script</button>
          </div>
        </div>

        {form.source === 'topic' ? (
          <label className="video-story-context-label">
            <span>What is the film about?</span>
            <textarea value={form.brief} disabled={busy} placeholder={form.genre === 'xianxia' ? 'ឧ. ក្មេងកំព្រាម្នាក់ត្រូវនិកាយបណ្តេញចេញ ក្រោយមករកឃើញដាវបុរាណ ហើយហាត់គុនសងសឹក…' : language === 'km' ? 'ឧ. ក្មេងប្រុសម្នាក់ដាំដើមឈើមួយដើម ហើយមើលវាធំឡើងរហូតក្លាយជាព្រៃ…' : 'e.g. How a seed becomes a sunflower, for kids…'} onChange={(event) => patch({ brief: event.target.value })} />
          </label>
        ) : (
          <label className="video-story-context-label ai-animation-script">
            <span>Your narration script <em>Kept word for word</em></span>
            <textarea value={form.script} disabled={busy} placeholder="បិទភ្ជាប់ Script សម្រាយរឿងរបស់អ្នកនៅទីនេះ — AI នឹងរក្សាពាក្យទាំងអស់ ហើយគូររូបតាម…" onChange={(event) => patch({ script: event.target.value })} />
            <span className="ai-animation-script-meta">
              <small className={scriptTooLong ? 'ai-animation-warn' : ''}>{scriptLength.toLocaleString()} characters · about {Math.max(0, scriptMinutes(form.script, language)).toFixed(1)} min{scriptTooLong ? ` — too long, max ~${MAX_SCRIPT_CHARS.toLocaleString()} (10 min)` : ''}</small>
              <button type="button" className="story-photo-add" disabled={busy} title="Use the recap script from the AI Story tab" onClick={() => { const text = recapScript(); if (text) patch({ script: text }); else setError('No recap script yet -- write one in the AI Story tab first.') }}>Use Recap Script</button>
            </span>
          </label>
        )}

        <div className="ai-animation-field">
          <span>Look</span>
          <div className="ai-animation-styles">
            {ANIMATION_STYLES.map((style) => (
              <button key={style.id} type="button" title={style.hint} disabled={busy} className={form.style === style.id ? 'ai-animation-chip active' : 'ai-animation-chip'} onClick={() => patch({ style: style.id })}>{style.label}</button>
            ))}
          </div>
        </div>

        <label className="ai-animation-field">
          <span>Narrator voice</span>
          <select className="ai-animation-select" value={form.voice} disabled={busy} onChange={(event) => patch({ voice: event.target.value })}>
            {ANIMATION_VOICES.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
          </select>
        </label>

        {form.source === 'topic' && (
          <div className="ai-animation-field">
            <span>Length {form.minutes > 3 && <em className="ai-animation-hint">made chapter by chapter</em>}</span>
            <div className="ai-animation-segments">
              {ANIMATION_MINUTES.map((minutes) => (
                <button key={minutes} type="button" disabled={busy} className={form.minutes === minutes ? 'ai-animation-chip active' : 'ai-animation-chip'} onClick={() => patch({ minutes })}>{minutes} min</button>
              ))}
            </div>
          </div>
        )}
        <div className="ai-animation-field">
          <span>Quality</span>
          <div className="ai-animation-segments">
            {([1280, 1920] as const).map((width) => (
              <button key={width} type="button" disabled={busy} title={width === 1280 ? 'Faster to make' : 'Sharper, takes longer'} className={form.width === width ? 'ai-animation-chip active' : 'ai-animation-chip'} onClick={() => patch({ width })}>{width === 1280 ? '720p' : '1080p'}</button>
            ))}
          </div>
        </div>

        <label className="video-story-auto">
          <input type="checkbox" checked={form.music} disabled={busy} onChange={(event) => patch({ music: event.target.checked })} />
          <span className="video-story-switch" aria-hidden><span /></span>
          <span className="video-story-auto-copy"><strong>Music &amp; sound effects</strong><small>Mood music under the voice, sounds on the action</small></span>
        </label>
        <label className="video-story-auto">
          <input type="checkbox" checked={form.burnSubtitles} disabled={busy} onChange={(event) => patch({ burnSubtitles: event.target.checked })} />
          <span className="video-story-switch" aria-hidden><span /></span>
          <span className="video-story-auto-copy"><strong>Subtitles on the video</strong><small>{form.burnSubtitles ? 'Drawn into the picture; an SRT is saved too' : 'Picture only; use the SRT as captions'}</small></span>
        </label>

        {busy && progress && (
          <div className="video-story-progress video-story-progress-visible">
            <div className="video-story-progress-head"><strong>{PHASE_LABEL[progress.phase]}</strong><span>{progress.percent}%</span></div>
            <progress max={100} value={progress.percent} />
            <span>{progress.message}</span>
            {progress.preview && <img className="ai-animation-preview" src={progress.preview} alt="Frames from the film" />}
          </div>
        )}
        {error && <div className="voiceover-recorder-error">{error}</div>}

        <div className="video-story-actions">
          <button className="video-story-analyze-button" disabled={busy || !canStart} onClick={() => void generate()}><span>✦</span>{busy ? 'Working…' : result ? 'Make Another Film' : 'Make Film'}</button>
          {jobId && <button className="video-story-cancel-button" onClick={() => void window.api.aiAnimation.cancel(jobId)}>Cancel</button>}
        </div>
        {failedFolder && !busy && (
          <div className="ai-animation-resume">
            <span>The last film stopped part-way. What was finished is kept.</span>
            <span className="ai-animation-result-tools">
              <button type="button" className="story-photo-add" title="Continue the stopped film from where it stopped" onClick={() => void generate(failedFolder)}>Continue</button>
              <button type="button" className="story-icon-button story-icon-danger" title="Forget it" onClick={() => rememberFailed(null)}>✕</button>
            </span>
          </div>
        )}

        {result && !busy && (
          <div className="ai-animation-result">
            <div className="ai-animation-result-head">
              <strong>{result.title}</strong>
              <small>{Math.round(result.durationSeconds)} s · saved to Media{result.captions?.length ? ` · ${result.captions.length} subtitles` : ''}</small>
            </div>
            {result.note && <small className="ai-animation-warn">{result.note}</small>}
            {result.preview && <img className="ai-animation-preview" src={result.preview} alt="Frames from the film" />}
            <div className="ai-animation-result-actions">
              <button type="button" className="story-photo-add" disabled={!imported?.readyToUse} title={imported?.readyToUse ? 'Put the film at the playhead' : 'Still importing into Media…'} onClick={addToTimeline}><PlusIcon size={12} /> Add to Timeline</button>
              <span className="ai-animation-result-tools">
                {result.srtPath && <button type="button" className="story-photo-add" title="Save the subtitles as an SRT file" onClick={() => void window.api.aiAnimation.saveSrt(result.srtPath)}><ExportIcon size={12} /> SRT</button>}
                {result.srtEnglishPath && <button type="button" className="story-photo-add" title="Save the English subtitles as an SRT file" onClick={() => void window.api.aiAnimation.saveSrt(result.srtEnglishPath!)}><ExportIcon size={12} /> SRT EN</button>}
                <button type="button" className="story-icon-button" title="Open the film's folder" onClick={() => void window.api.aiAnimation.openFolder(result.folder)}><FolderIcon size={14} /></button>
              </span>
            </div>
          </div>
        )}
        <p className="ai-animation-note">Gemini writes the story and the drawing code; Edge TTS speaks it; AI Animation draws it.</p>
      </div>
    </section>
  )
}

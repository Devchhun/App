import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { kiriExpectedSeconds } from '@shared/kiriTts'
import { useAiDubber } from '../dubbing/AiDubberContext'
import { ENGINE_LABEL, useEngineVoices } from '../dubbing/engineVoices'
import { resolveLineVoice } from '../dubbing/dubbingPlan'
import { kiriCopyOf } from '../dubbing/useKiriVoices'
import { parseStoredVoxCpmSettings, getVoxCpmSettingsStorageKey, type DubbingEngine } from '../dubbing/voxcpmSettings'

const ENGINES: DubbingEngine[] = ['voxcpm2', 'edge-tts', 'kiritts']

/** The engine Settings has, as the editor's first choice. */
function storedEngine(): DubbingEngine {
  try {
    return parseStoredVoxCpmSettings(localStorage.getItem(getVoxCpmSettingsStorageKey())).engine
  } catch {
    return 'voxcpm2'
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** Where the user last dragged the panel: it opens there again (this
 * session); the first time, in the middle of the window. */
let lastPanelPos: { left: number; top: number } | null = null

interface Props {
  segmentId: string
  /** Just made by "Add Subtitle Here": an empty line is taken away again
   * on close, and its length follows the words typed. */
  isNew: boolean
  onClose: () => void
}

/** A subtitle's text and its voice, right on the Timeline: type the line,
 * pick the engine (VoxCPM2, Edge TTS or KiriTTS) and a voice, Generate --
 * the clip lands under it on the dub track. Opened from the subtitle row's
 * right-click menu, in the middle of the window; dragged by its header to
 * wherever it is out of the way, and left open while the Timeline is used
 * (play the line, scrub) until closed. */
export function SubtitleQuickEditor({ segmentId, isNew, onClose }: Props): JSX.Element | null {
  const aiDubber = useAiDubber()
  const segment = aiDubber.segments.find((s) => s.id === segmentId)
  const segState = aiDubber.getSegmentState(segmentId)
  const [text, setText] = useState(() => segment?.editedText ?? segment?.text ?? '')
  // An existing line's text arrives with it when it was not there yet.
  const loadedRef = useRef(!!segment)
  useEffect(() => {
    if (loadedRef.current || !segment) return
    loadedRef.current = true
    setText(segment.editedText ?? segment.text)
  }, [segment])
  const [engine, setEngine] = useState<DubbingEngine>(storedEngine)
  const { voices, loading, error: voicesError } = useEngineVoices(engine)
  const [voiceByEngine, setVoiceByEngine] = useState<Partial<Record<DubbingEngine, string>>>({})
  // Generate waits for the typed text to be in the subtitle first (the
  // generator reads the line as the Timeline has it).
  const [pending, setPending] = useState<{ engine: DubbingEngine; voiceId: string } | null>(null)
  const [requested, setRequested] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0, ready: false })
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  // The line's own voice in this engine (as Generate Dubbing would pick it),
  // when the engine has it; else the first of its gender; else the first.
  const defaultVoice = useMemo(() => {
    if (voices.length === 0) return ''
    const speakerId = segState.speakerId ?? segment?.speakerId
    const { voiceId, gender } = resolveLineVoice(segState, speakerId ? aiDubber.state.speakers[speakerId] : undefined, engine, (id) => kiriCopyOf(id))
    if (voices.some((v) => v.id === voiceId)) return voiceId
    return (voices.find((v) => v.gender === gender) ?? voices[0]).id
  }, [voices, segState, segment?.speakerId, aiDubber.state.speakers, engine])
  const voiceId = voiceByEngine[engine] && voices.some((v) => v.id === voiceByEngine[engine]) ? voiceByEngine[engine]! : defaultVoice

  // Inside the window whatever happens (it grows, the window shrinks).
  const clampToWindow = (left: number, top: number): { left: number; top: number } => {
    const rect = rootRef.current?.getBoundingClientRect()
    const width = rect?.width ?? 320
    const height = rect?.height ?? 240
    return { left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - height - 8)) }
  }
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const start = lastPanelPos ?? { left: (window.innerWidth - rect.width) / 2, top: (window.innerHeight - rect.height) / 2 }
    setPos({ ...clampToWindow(start.left, start.top), ready: true })
    textRef.current?.focus()
    textRef.current?.setSelectionRange(textRef.current.value.length, textRef.current.value.length)
    const keepInside = (): void => setPos((current) => ({ ...clampToWindow(current.left, current.top), ready: true }))
    const observer = new ResizeObserver(keepInside)
    observer.observe(el)
    window.addEventListener('resize', keepInside)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', keepInside)
    }
    // A line just added is in the list from the next render on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!segment])

  const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    dragRef.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    setPos({ ...clampToWindow(e.clientX - drag.dx, e.clientY - drag.dy), ready: true })
  }
  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    lastPanelPos = { left: pos.left, top: pos.top }
  }

  const saved = (segment?.editedText ?? segment?.text ?? '') === text.trim()
  const save = (): void => {
    if (!segment) return
    const words = text.trim()
    // A new line runs as long as its words take to say (never into the
    // next line): it starts at 2 s, which is short for a sentence. The
    // length goes first: it rewrites the whole list as this render has it,
    // and the text set after it lands on top instead of being wiped.
    if (isNew && words) {
      const index = aiDubber.segments.findIndex((s) => s.id === segmentId)
      const next = aiDubber.segments[index + 1]
      const wanted = segment.startTime + Math.max(2, kiriExpectedSeconds(words) + 0.4)
      const end = next && next.startTime > segment.startTime + 0.5 ? Math.min(wanted, next.startTime - 0.05) : wanted
      if (Math.abs(end - segment.endTime) > 0.05) aiDubber.updateSegmentTiming(segmentId, 'end', end)
    }
    if (!saved) aiDubber.updateSegmentText(segmentId, words)
  }

  // What closing keeps: the typed text -- or, for a line added and left
  // empty, nothing (the line goes).
  const persist = (): void => {
    if (isNew && !text.trim() && !(segment?.editedText ?? segment?.text)) aiDubber.removeSubtitle(segmentId)
    else save()
  }
  const closedRef = useRef(false)
  const close = (): void => {
    closedRef.current = true
    persist()
    onClose()
  }
  // Replaced by another subtitle's panel (a right-click on another line)
  // without being closed: what was typed is still kept.
  const persistRef = useRef(persist)
  persistRef.current = persist
  useEffect(
    () => () => {
      if (!closedRef.current) persistRef.current()
    },
    []
  )

  // The subtitle went away (deleted elsewhere): nothing to edit. (A line
  // just added is not there on the very first render -- not "gone".)
  const seenRef = useRef(false)
  useEffect(() => {
    if (segment) seenRef.current = true
    else if (seenRef.current) onClose()
  }, [segment, onClose])

  useEffect(() => {
    if (!pending || !segment) return
    if ((segment.editedText ?? segment.text) !== text.trim()) return
    aiDubber.generateSegmentWith(segmentId, pending.engine, pending.voiceId)
    setPending(null)
    setRequested(true)
  }, [pending, segment, text, segmentId, aiDubber])

  // Another line being made (as the Voice Model panel tells it: the
  // progress counter stays after a run ends, the line statuses do not).
  const running = aiDubber.segments.some((s) => s.id !== segmentId && aiDubber.getSegmentState(s.id).status === 'generating')
  const generating = segState.status === 'generating' || !!pending
  const canGenerate = !!text.trim() && !!voiceId && !running && !generating
  const generate = (): void => {
    if (!canGenerate) return
    save()
    setPending({ engine, voiceId })
  }

  if (!segment) return null
  const status = generating
    ? { kind: 'busy', label: `Making the voice with ${ENGINE_LABEL[engine]}…` }
    : requested && segState.status === 'generated'
      ? { kind: 'done', label: 'Voice ready — it is on the dub track under this line.' }
      : requested && segState.status === 'needs-review'
        ? { kind: 'error', label: aiDubber.state.generationError ?? 'The voice could not be made for this line.' }
        : running
          ? { kind: 'info', label: 'Another generation is running — wait for it to finish.' }
          : null

  return (
    <div
      ref={rootRef}
      className="subtitle-quick-editor"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      role="dialog"
      aria-label="Subtitle"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          close()
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="subtitle-quick-editor-head" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} title="Drag to move">
        <span className="subtitle-quick-editor-grip" aria-hidden>
          ⋮⋮
        </span>
        <span className="subtitle-quick-editor-title">{isNew ? 'New subtitle' : 'Subtitle'}</span>
        <span className="subtitle-quick-editor-time">
          {formatTime(segment.startTime)} – {formatTime(segment.endTime)}
        </span>
        <button className="subtitle-quick-editor-close" onClick={close} aria-label="Close" title="Close (Esc)">
          ✕
        </button>
      </div>
      <textarea
        ref={textRef}
        className="subtitle-quick-editor-text"
        lang="km"
        rows={2}
        value={text}
        placeholder="Type what this line says…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            generate()
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            close()
          }
        }}
      />
      <div className="subtitle-quick-editor-engines" role="tablist" aria-label="Voice engine">
        {ENGINES.map((option) => (
          <button key={option} role="tab" aria-selected={engine === option} className={engine === option ? 'subtitle-quick-editor-engine subtitle-quick-editor-engine-active' : 'subtitle-quick-editor-engine'} onClick={() => setEngine(option)}>
            {ENGINE_LABEL[option]}
          </button>
        ))}
      </div>
      <label className="subtitle-quick-editor-voice">
        <span>Voice</span>
        <select value={voiceId} disabled={voices.length === 0} onChange={(e) => setVoiceByEngine((current) => ({ ...current, [engine]: e.target.value }))}>
          {voices.length === 0 && <option value="">{loading ? 'Loading voices…' : 'No voices'}</option>}
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.gender === 'male' ? ' · Male' : v.gender === 'female' ? ' · Female' : ''}
            </option>
          ))}
        </select>
      </label>
      {voicesError && <p className="subtitle-quick-editor-status subtitle-quick-editor-status-error">{voicesError}</p>}
      {status && <p className={`subtitle-quick-editor-status subtitle-quick-editor-status-${status.kind}`}>{status.kind === 'busy' && <span className="subtitle-quick-editor-spinner" aria-hidden />}{status.label}</p>}
      <div className="subtitle-quick-editor-actions">
        <span className="subtitle-quick-editor-hint">Enter save · Ctrl+Enter generate</span>
        <button
          className="subtitle-quick-editor-save"
          onClick={() => {
            save()
            onClose()
          }}
          disabled={!text.trim()}
        >
          Save
        </button>
        <button className="subtitle-quick-editor-generate" onClick={generate} disabled={!canGenerate} title={!text.trim() ? 'Type the line first' : running ? 'Another generation is running' : undefined}>
          {segState.generatedClipId ? 'Generate again' : 'Generate voice'}
        </button>
      </div>
    </div>
  )
}

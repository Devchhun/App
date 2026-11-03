import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { kiriVoiceId, kiriVoiceOf } from '@shared/kiriTts'
import { BUILTIN_NARRATORS, findBuiltinNarrator, isSavedVoiceId, loadStoryNarratorVoiceId, savedVoiceId, storeStoryNarratorVoiceId, subscribeStoryNarrator } from '../dubbing/savedVoices'
import { useSavedVoices } from '../dubbing/useSavedVoices'
import { useKiriVoices } from '../dubbing/useKiriVoices'
import { ENGINE_LABEL } from '../dubbing/engineVoices'
import { CustomVoiceReference } from '../dubbing/CustomVoiceReference'
import type { DubbingEngine } from '../dubbing/voxcpmSettings'
import { useUiState } from '../nav/UiStateContext'
import { useRecapNarration, type RecapProgress } from './useRecapNarration'
import { AUTO_GENERATE_RECAP_VOICE_EVENT, CANCEL_RECAP_VOICE_EVENT, RECAP_PROGRESS_EVENT, recapProgressNow } from './videoStoryEvents'

const ENGINES: DubbingEngine[] = ['voxcpm2', 'edge-tts', 'kiritts']

function engineOf(voiceId: string | null): DubbingEngine {
  if (kiriVoiceOf(voiceId ?? undefined)) return 'kiritts'
  if (findBuiltinNarrator(voiceId)) return 'edge-tts'
  if (voiceId && isSavedVoiceId(voiceId)) return 'voxcpm2'
  return 'kiritts'
}

/** Where the user last dragged it: it opens there again (this session). */
let lastPanelPos: { left: number; top: number } | null = null

/** The story narrator's voice, in a panel that floats over the editor
 * (opened by the Recap Script's microphone badge, dragged by its header):
 * pick the engine -- VoxCPM2 (your own recorded voice), Edge TTS or
 * KiriTTS -- and the voice, then Generate voice reads the whole Recap
 * Script as one clip. The generating itself is the header's Recap button's
 * (App.tsx), so it carries on and is placed even when this is closed. */
export function NarratorVoicePanel({ onClose }: { onClose: () => void }): JSX.Element {
  const { openSettings } = useUiState()
  const recap = useRecapNarration()
  const [narrator, setNarrator] = useState<string | null>(() => loadStoryNarratorVoiceId())
  useEffect(() => subscribeStoryNarrator(setNarrator), [])
  const [engine, setEngine] = useState<DubbingEngine>(() => engineOf(loadStoryNarratorVoiceId()))
  const saved = useSavedVoices()
  const kiri = useKiriVoices(engine === 'kiritts')
  const [progress, setProgress] = useState<RecapProgress | null>(() => recapProgressNow())
  useEffect(() => {
    const follow = (event: Event): void => setProgress((event as CustomEvent<RecapProgress | null>).detail ?? null)
    window.addEventListener(RECAP_PROGRESS_EVENT, follow)
    return () => window.removeEventListener(RECAP_PROGRESS_EVENT, follow)
  }, [])

  const voices: Array<{ id: string; name: string }> =
    engine === 'kiritts'
      ? kiri.state.status === 'ready'
        ? kiri.state.voices.map((v) => ({ id: kiriVoiceId(v.id), name: `${v.name}${v.cloned ? ' (my clone)' : ''}${v.gender === 'male' ? ' · Male' : v.gender === 'female' ? ' · Female' : ''}` }))
        : []
      : engine === 'edge-tts'
        ? BUILTIN_NARRATORS.map((n) => ({ id: n.id, name: `${n.name} · ${n.hint}` }))
        : saved.map((v) => ({ id: savedVoiceId(v.id), name: v.name }))
  const chosen = narrator && voices.some((v) => v.id === narrator) ? narrator : ''
  const voicesNote =
    engine === 'kiritts' && kiri.state.status === 'no-key'
      ? 'Add your KiriTTS API key in Settings > AI API Keys.'
      : engine === 'kiritts' && kiri.state.status === 'error'
        ? kiri.state.error
        : engine === 'voxcpm2' && voices.length === 0
          ? 'No recorded voice yet -- record or choose one below.'
          : null

  // ---- floating and dragging, as the Subtitle editor does ----
  const rootRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0, ready: false })
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const clampToWindow = (left: number, top: number): { left: number; top: number } => {
    const rect = rootRef.current?.getBoundingClientRect()
    const width = rect?.width ?? 340
    const height = rect?.height ?? 260
    return { left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - height - 8)) }
  }
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const start = lastPanelPos ?? { left: (window.innerWidth - rect.width) / 2, top: (window.innerHeight - rect.height) / 2 }
    setPos({ ...clampToWindow(start.left, start.top), ready: true })
    const keepInside = (): void => setPos((current) => ({ ...clampToWindow(current.left, current.top), ready: true }))
    const observer = new ResizeObserver(keepInside)
    observer.observe(el)
    window.addEventListener('resize', keepInside)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', keepInside)
    }
  }, [])
  const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    dragRef.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag) setPos({ ...clampToWindow(e.clientX - drag.dx, e.clientY - drag.dy), ready: true })
  }
  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    lastPanelPos = { left: pos.left, top: pos.top }
  }

  const canGenerate = !!chosen && !recap.blocker && !progress
  const status = progress
    ? {
        kind: 'busy',
        label:
          progress.stage === 'generating'
            ? `Making the voice… part ${progress.completed} of ${progress.total}`
            : progress.stage === 'stitching'
              ? 'Joining the parts into one narration…'
              : 'Placing it on the Timeline…'
      }
    : recap.blocker === 'no-script'
      ? { kind: 'info', label: 'Write or paste the script in Recap Script first.' }
      : recap.blocker === 'no-engine' && chosen
        ? { kind: 'error', label: 'VoxCPM2 needs its install folder: Settings > Voice Engine.' }
        : chosen
          ? { kind: 'info', label: `${recap.lineCount} part${recap.lineCount === 1 ? '' : 's'}, read as one continuous clip on a Recap track at the start of the Timeline.` }
          : null

  return createPortal(
    <div
      ref={rootRef}
      className="subtitle-quick-editor narrator-voice-panel"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      role="dialog"
      aria-label="Narrator voice"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <div className="subtitle-quick-editor-head" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} title="Drag to move">
        <span className="subtitle-quick-editor-grip" aria-hidden>
          ⋮⋮
        </span>
        <span className="subtitle-quick-editor-title">Narrator voice / សំឡេងនិទាន</span>
        <button className="subtitle-quick-editor-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          ✕
        </button>
      </div>
      <div className="subtitle-quick-editor-engines" role="tablist" aria-label="Voice engine">
        {ENGINES.map((option) => (
          <button key={option} role="tab" aria-selected={engine === option} className={engine === option ? 'subtitle-quick-editor-engine subtitle-quick-editor-engine-active' : 'subtitle-quick-editor-engine'} onClick={() => setEngine(option)}>
            {ENGINE_LABEL[option]}
          </button>
        ))}
      </div>
      <label className="subtitle-quick-editor-voice">
        <span>Voice</span>
        <select value={chosen} disabled={voices.length === 0 || !!progress} onChange={(e) => e.target.value && storeStoryNarratorVoiceId(e.target.value)}>
          {voices.length === 0 && <option value="">{engine === 'kiritts' && (kiri.state.status === 'loading' || kiri.state.status === 'idle') ? 'Loading voices…' : 'No voices'}</option>}
          {voices.length > 0 && !chosen && <option value="">Choose a voice…</option>}
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      {voicesNote && <p className="subtitle-quick-editor-status subtitle-quick-editor-status-info">{voicesNote}</p>}
      {engine === 'voxcpm2' && (
        <div className="narrator-voice-panel-record">
          <CustomVoiceReference variant="script" />
        </div>
      )}
      {status && (
        <p className={`subtitle-quick-editor-status subtitle-quick-editor-status-${status.kind}`}>
          {status.kind === 'busy' && <span className="subtitle-quick-editor-spinner" aria-hidden />}
          {status.label}
          {recap.blocker === 'no-engine' && chosen && !progress && (
            <>
              {' '}
              <button type="button" className="inline-link-button" onClick={() => openSettings('voice')}>
                Open Settings
              </button>
            </>
          )}
        </p>
      )}
      <div className="subtitle-quick-editor-actions">
        <span className="subtitle-quick-editor-hint">The whole Recap Script</span>
        {progress ? (
          <button className="subtitle-quick-editor-save" onClick={() => window.dispatchEvent(new Event(CANCEL_RECAP_VOICE_EVENT))}>
            Stop
          </button>
        ) : null}
        <button
          className="subtitle-quick-editor-generate"
          disabled={!canGenerate}
          title={!chosen ? 'Choose a voice first' : recap.blocker === 'no-script' ? 'Write the script first' : undefined}
          onClick={() => window.dispatchEvent(new Event(AUTO_GENERATE_RECAP_VOICE_EVENT))}
        >
          Generate voice
        </button>
      </div>
    </div>,
    document.body
  )
}

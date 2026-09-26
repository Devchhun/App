import { useCallback, useEffect, useRef, useState } from 'react'
import { useProject } from '../project/ProjectContext'
import { useAiSuggestions } from '../suggestions/AiSuggestionsContext'
import { useUiState } from '../nav/UiStateContext'
import { useConfirm } from '../ui/ConfirmDialog'
import { MicrophoneIcon } from '../nav/icons'
import { CustomVoiceReference } from '../dubbing/CustomVoiceReference'
import { SCRIPT_CHANGED_EVENT } from './useRecapNarration'
import { loadStoryNarratorVoiceId, subscribeSavedVoices, subscribeStoryNarrator, narratorDisplayName } from '../dubbing/savedVoices'
import type { ScriptTransformMode, GenerateSuggestionsError } from '@shared/suggestions'

const STORAGE_PREFIX = 'cae-ai-script-v1:'

function storageKey(projectId: string | null): string {
  return `${STORAGE_PREFIX}${projectId ?? 'draft'}`
}

function readStored(projectId: string | null): string {
  if (typeof localStorage === 'undefined') return ''
  try {
    return localStorage.getItem(storageKey(projectId)) ?? ''
  } catch {
    return ''
  }
}

function narratorNameFor(voiceId: string | null): string | null {
  return narratorDisplayName(voiceId)
}

function describeError(error: GenerateSuggestionsError): string {
  switch (error.kind) {
    case 'auth':
      return 'The Anthropic API key was rejected. Check it in Settings › AI Suggestions.'
    case 'rate-limit':
      return `Rate limited by the API${error.retryAfterSeconds ? ` -- try again in ${error.retryAfterSeconds}s` : ''}.`
    case 'network':
      return 'No connection to the API. Check your network and try again.'
    case 'timeout':
      return 'The request timed out. Try again, or with a shorter script.'
    case 'canceled':
      return 'Canceled.'
    default:
      return error.message || 'Something went wrong.'
  }
}

/** Recap Script / សរសេររឿង AI -- the left-column workspace behind the rail's
 * AI button. One big script box, kept per project in localStorage (the
 * text is scratch work, not part of the project file), with two cloud
 * actions on it: AI Rewrite (polish for narration) and Summarize (condense
 * to a recap). Both replace the text and keep the previous version one
 * click away, so trying an action is never destructive. */
export function AiScriptPanel(): JSX.Element {
  const { projectId } = useProject()
  const { hasApiKey } = useAiSuggestions()
  const { openSettings } = useUiState()
  const confirm = useConfirm()
  const [text, setText] = useState(() => readStored(projectId))
  const [busy, setBusy] = useState<ScriptTransformMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previous, setPrevious] = useState<{ text: string; mode: ScriptTransformMode } | null>(null)
  // "My Voice": the drawer behind the sparkle badge where the user records
  // (or picks) their own voice to narrate the story with.
  const [voiceOpen, setVoiceOpen] = useState(false)
  // The chosen narrator's name, kept current as the drawer picks / deletes.
  const [narratorName, setNarratorName] = useState<string | null>(() => narratorNameFor(loadStoryNarratorVoiceId()))
  useEffect(() => {
    const refresh = (): void => setNarratorName(narratorNameFor(loadStoryNarratorVoiceId()))
    const offA = subscribeStoryNarrator(refresh)
    const offB = subscribeSavedVoices(refresh)
    return () => {
      offA()
      offB()
    }
  }, [])
  const requestIdRef = useRef<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Follow the project: each one keeps its own scratch script.
  const loadedForRef = useRef<string | null>(projectId)
  useEffect(() => {
    if (loadedForRef.current === projectId) return
    loadedForRef.current = projectId
    setText(readStored(projectId))
    setPrevious(null)
    setError(null)
  }, [projectId])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try {
      if (text) localStorage.setItem(storageKey(projectId), text)
      else localStorage.removeItem(storageKey(projectId))
    } catch {
      // Storage unavailable/full -- the text still lives for this session.
    }
    window.dispatchEvent(new Event(SCRIPT_CHANGED_EVENT))
  }, [text, projectId])

  // Gemini Video Story lives in the right sidebar and writes into this
  // same per-project Recap script. Keep an already-open script panel in
  // sync immediately; when it is closed, its normal mount read does this.
  useEffect(() => {
    const refreshExternalScript = (): void => {
      const next = readStored(projectId)
      setText((current) => current === next ? current : next)
    }
    window.addEventListener(SCRIPT_CHANGED_EVENT, refreshExternalScript)
    return () => window.removeEventListener(SCRIPT_CHANGED_EVENT, refreshExternalScript)
  }, [projectId])

  // Cancel whatever is in flight if the panel goes away mid-request.
  useEffect(() => {
    return () => {
      if (requestIdRef.current) void window.api.ai.cancelRequest(requestIdRef.current)
    }
  }, [])

  const run = useCallback(
    async (mode: ScriptTransformMode) => {
      const source = text.trim()
      if (!source || busy) return
      const requestId = crypto.randomUUID()
      requestIdRef.current = requestId
      setBusy(mode)
      setError(null)
      try {
        const result = await window.api.ai.transformScript(requestId, source, mode)
        if (requestIdRef.current !== requestId) return
        if (result.ok) {
          setPrevious({ text, mode })
          setText(result.data)
        } else if (result.error.kind !== 'canceled') {
          setError(describeError(result.error))
        }
      } finally {
        if (requestIdRef.current === requestId) {
          requestIdRef.current = null
          setBusy(null)
        }
      }
    },
    [text, busy]
  )

  const cancel = (): void => {
    if (requestIdRef.current) void window.api.ai.cancelRequest(requestIdRef.current)
  }

  const clear = async (): Promise<void> => {
    if (!text) return
    const ok = await confirm({ title: 'Clear the script?', message: 'The text in the box will be removed. This cannot be undone.', confirmLabel: 'Clear', danger: true })
    if (!ok) return
    setText('')
    setPrevious(null)
    setError(null)
    textareaRef.current?.focus()
  }

  const restore = (): void => {
    if (!previous) return
    setText(previous.text)
    setPrevious(null)
  }

  const charCount = text.length
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0

  return (
    <div className="ai-script-panel">
      <div className="ai-script-card">
        <div className="ai-script-head">
          {/* The badge is the My Voice toggle: record / choose your own
              voice for narrating the story (see CustomVoiceReference's
              'script' variant below). */}
          <button
            type="button"
            className={voiceOpen ? 'ai-script-badge ai-script-badge-active ai-script-badge-open' : 'ai-script-badge ai-script-badge-active'}
            title={voiceOpen ? 'Hide My Voice' : 'My Voice / សម្លេងខ្ញុំ -- record or choose your own voice to narrate the story'}
            aria-pressed={voiceOpen}
            onClick={() => setVoiceOpen((v) => !v)}
          >
            <MicrophoneIcon size={13} />
          </button>
          <span className="ai-script-title" title="Recap Script / សរសេររឿង AI">
            <span className="ai-script-title-en">Recap Script</span>
            <span className="ai-script-title-sep">/</span>
            <span className="ai-script-title-km">សរសេររឿង AI</span>
          </span>
          <span className="ai-script-count" title={`${wordCount} words`}>
            <span className="ai-script-count-n">{charCount.toLocaleString()}</span>
            <span className="ai-script-count-sep">/</span>
            Unlimited
          </span>
        </div>

        {narratorName && (
          <button type="button" className="ai-script-narrator" title="Story narrator voice -- click to change" onClick={() => setVoiceOpen(true)}>
            <span className="ai-script-narrator-dot" />
            Narrator: <strong>{narratorName}</strong>
          </button>
        )}

        {voiceOpen && (
          <div className="ai-script-voice-drawer">
            <div className="ai-script-voice-drawer-head">
              <MicrophoneIcon size={13} />
              <span>My Voice / សម្លេងខ្ញុំ</span>
              <button type="button" className="ai-script-voice-drawer-close" title="Close" onClick={() => setVoiceOpen(false)}>
                ×
              </button>
            </div>
            <CustomVoiceReference variant="script" />
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="ai-script-text editor-scroll"
          value={text}
          disabled={busy !== null}
          spellCheck={false}
          placeholder="Paste or write your recap script here… / បិទភ្ជាប់ ឬសរសេរស្គ្រីបរឿងនៅទីនេះ"
          onChange={(e) => setText(e.target.value)}
        />

        {(error || previous || busy) && (
          <div className="ai-script-status">
            {busy && (
              <span className="ai-script-status-busy">
                {busy === 'rewrite' ? 'Rewriting…' : 'Summarizing…'}
                <button type="button" className="inline-link-button" onClick={cancel}>
                  Cancel
                </button>
              </span>
            )}
            {!busy && error && <span className="ai-script-status-error">{error}</span>}
            {!busy && !error && previous && (
              <span>
                {previous.mode === 'rewrite' ? 'Rewritten.' : 'Summarized.'}{' '}
                <button type="button" className="inline-link-button" onClick={restore}>
                  Restore previous
                </button>
              </span>
            )}
          </div>
        )}

        {!hasApiKey && (
          <div className="ai-script-status ai-script-status-hint">
            AI actions need an Anthropic API key.{' '}
            <button type="button" className="inline-link-button" onClick={() => openSettings('aiSuggestions')}>
              Add it in Settings
            </button>
          </div>
        )}

        <div className="ai-script-actions">
          <button type="button" className="ai-script-button ai-script-button-rewrite" disabled={!text.trim() || busy !== null || !hasApiKey} onClick={() => void run('rewrite')}>
            AI Rewrite
          </button>
          <button type="button" className="ai-script-button ai-script-button-summarize" disabled={!text.trim() || busy !== null || !hasApiKey} onClick={() => void run('summarize')}>
            Summarize
          </button>
          <span className="ai-script-actions-spacer" />
          <button type="button" className="ai-script-button ai-script-button-clear" disabled={!text || busy !== null} onClick={() => void clear()}>
            Clear
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GeminiRouterSnapshot } from '@shared/geminiKeyPool'
import { GeminiRouterBoundary, GeminiRouterView } from '@shared/geminiRouterView'

const REFRESH_MS = 1000

/** The Router screen over the whole window. The main process holds the keys;
 * this only ever receives their masked state. */
export function GeminiRouterOverlay({ onClose }: { onClose: () => void }): JSX.Element {
  const [snapshot, setSnapshot] = useState<GeminiRouterSnapshot | null>(null)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      window.api.videoStoryNarration
        .routerStatus()
        .then((next) => {
          if (alive) setSnapshot(next)
        })
        .catch((e: unknown) => {
          if (alive) setError(e instanceof Error ? e.message : String(e))
        })
    }
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      setSnapshot(await window.api.videoStoryNarration.testRouterKeys())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
    }
  }

  return createPortal(
    <div className="gemini-router-overlay" role="dialog" aria-modal="true" aria-label="Gemini router">
      {snapshot ? (
        <GeminiRouterBoundary onClose={onClose}>
          <GeminiRouterView snapshot={snapshot} testing={testing} onTest={() => void test()} onClose={onClose} />
        </GeminiRouterBoundary>
      ) : (
        <div className="gemini-router-loading">
          {error ?? 'Loading…'}
          <button className="settings-button" onClick={onClose}>Close</button>
        </div>
      )}
    </div>,
    document.body
  )
}

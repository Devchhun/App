import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  componentStack: string | null
}

/** Without this, any render-time exception in the provider tree (a corrupted
 * localStorage value, a malformed persisted project, etc.) unmounts the
 * entire app with nothing left on screen -- the window's own backgroundColor
 * (near-black, see main/index.ts) then just sits there forever with no
 * indication anything went wrong. This turns that into a visible, actionable
 * screen instead of a silent black window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Unhandled render error:', error, info.componentStack)
    this.setState({ componentStack: info.componentStack ?? null })
    // Best-effort: the on-screen error is only visible while this window stays
    // open with someone watching it. Persisting it to a file means a crash
    // that isn't screenshotted in time is still diagnosable afterward.
    void window.api?.reportCrash({
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined
    })
  }

  render(): ReactNode {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 32,
          background: 'var(--bg, #070b10)',
          color: 'var(--text, #f4f7fb)',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center'
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>Creative AI Editor hit an error and couldn't continue</div>
        <div style={{ color: 'var(--text-dim, #a8b2bd)', maxWidth: 560, fontSize: 13 }}>
          This is usually caused by corrupted saved settings or a damaged project file. Reloading may fix it -- if it
          keeps happening, the message below will help diagnose it.
        </div>
        <pre
          style={{
            maxWidth: 640,
            maxHeight: 200,
            overflow: 'auto',
            textAlign: 'left',
            background: 'var(--surface, #101821)',
            border: '1px solid var(--border, #1d2935)',
            borderRadius: 6,
            padding: 12,
            fontSize: 12,
            color: 'var(--danger, #ff5364)'
          }}
        >
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
          {componentStack ? `\n\nComponent stack:${componentStack}` : ''}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 20px',
            borderRadius: 6,
            border: 'none',
            background: 'var(--accent, #1687ff)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          Reload
        </button>
      </div>
    )
  }
}

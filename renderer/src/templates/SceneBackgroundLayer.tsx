import type { SceneBackground } from '@shared/templates'
import { hexToRgba } from './templateShared'

/** Background paint behind a scene's foreground content -- sits above the
 * `<video>` element and below the editable graphic content (never intercepts
 * pointer events). `progress` is the caller's own deterministic 0-1 reveal
 * value (derived from the scene's enterProgress via `remap`), never
 * wall-clock time. Defaults to 'transparent': the underlying video stays
 * fully visible unless a scene explicitly (or its template's own default)
 * opts into Dim Video / Gradient Overlay / Solid. */
export function SceneBackgroundLayer({
  background,
  fallbackColor,
  progress,
  defaultMode = 'transparent'
}: {
  background?: SceneBackground
  fallbackColor: string
  progress: number
  defaultMode?: SceneBackground['mode']
}): JSX.Element | null {
  const mode = background?.mode ?? defaultMode ?? 'transparent'
  if (mode === 'transparent') return null

  const color = background?.glowColor ?? fallbackColor
  const intensityPct = background?.intensity ?? (mode === 'solid' ? 90 : 55)
  const intensity = Math.max(0, Math.min(100, intensityPct)) / 100
  if (intensity <= 0) return null

  return (
    <div className="scene-bg-layer" style={{ opacity: progress }}>
      {mode === 'dim-video' && <div className="scene-bg-dim" style={{ background: `rgba(2, 4, 8, ${0.75 * intensity})` }} />}

      {mode === 'gradient-overlay' && (
        <>
          <div className="scene-bg-gradient" style={{ opacity: intensity }} />
          <div className="scene-bg-grid" style={{ opacity: 0.5 * intensity }} />
          <div
            className="scene-bg-glow scene-bg-glow-primary"
            style={{ background: `radial-gradient(circle at 30% 25%, ${hexToRgba(color, 0.4 * intensity)}, transparent 60%)` }}
          />
          <div
            className="scene-bg-glow scene-bg-glow-secondary"
            style={{ background: `radial-gradient(circle at 75% 80%, ${hexToRgba(color, 0.25 * intensity)}, transparent 55%)` }}
          />
        </>
      )}

      {mode === 'solid' && <div className="scene-bg-solid" style={{ background: hexToRgba(color, intensity) }} />}
    </div>
  )
}

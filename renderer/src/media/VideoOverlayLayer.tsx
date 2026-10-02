import { useMemo, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useAiDubber } from '../dubbing/AiDubberContext'
import { clampRegion, subtitleSideMarginsPct, SUBTITLE_FONT_FAMILY, SUBTITLE_LINE_HEIGHT, type BlurRegion, type OverlayLine, type SubtitleOverlayStyle } from '@shared/videoOverlay'

/** The AI Dubber's "on video" layer in the Player: blur boxes over the
 * original subtitles and the dubbed subtitles drawn on the picture -- sized
 * from the stage the same way Export sizes them from the output frame
 * (shared/videoOverlay.ts), so what is seen here is what gets burned in.
 * While the Subtitle & Blur panel is open the boxes can be dragged and
 * resized right on the picture. */
export function VideoOverlayLayer({ stageSize, currentTime }: { stageSize: { width: number; height: number } | null; currentTime: number }): JSX.Element | null {
  const { videoOverlay, setVideoOverlay, overlayLines, overlayEditing } = useAiDubber()
  const { subtitles, blur } = videoOverlay
  const text = useMemo(() => activeText(overlayLines, currentTime), [overlayLines, currentTime])
  if (!stageSize || (!subtitles.enabled && !blur.enabled)) return null
  const H = stageSize.height
  const sigma = (blur.strength * H) / 720

  const updateRegion = (id: string, next: BlurRegion): void =>
    setVideoOverlay((current) => ({ ...current, blur: { ...current.blur, regions: current.blur.regions.map((r) => (r.id === id ? clampRegion(next) : r)) } }))
  const removeRegion = (id: string): void =>
    setVideoOverlay((current) => ({ ...current, blur: { ...current.blur, regions: current.blur.regions.filter((r) => r.id !== id) } }))

  const fontPx = (subtitles.fontSizePct / 100) * H
  const outlinePx = (subtitles.outlinePct / 100) * H
  const textStyle: CSSProperties = {
    fontFamily: `'${SUBTITLE_FONT_FAMILY}', 'Khmer UI', sans-serif`,
    fontSize: fontPx,
    lineHeight: SUBTITLE_LINE_HEIGHT,
    color: subtitles.color,
    ...(subtitles.background
      ? { background: hexToRgba(subtitles.backgroundColor, subtitles.backgroundOpacity), padding: `${fontPx * 0.06}px ${fontPx * 0.18}px` }
      : outlinePx > 0
        ? { WebkitTextStroke: `${outlinePx * 2}px ${subtitles.outlineColor}`, paintOrder: 'stroke fill' }
        : {})
  }

  return (
    <div className="video-overlay-layer">
      {blur.enabled &&
        blur.regions.map((region) => (
          <BlurBox key={region.id} region={region} sigma={sigma} editing={overlayEditing} stageSize={stageSize} onChange={(next) => updateRegion(region.id, next)} onRemove={() => removeRegion(region.id)} />
        ))}
      {/* Only a real line: between lines the picture shows nothing (a
          "Subtitle" placeholder used to stand in while the panel was open).
          Placing it is done by dragging a line that is on screen. */}
      {subtitles.enabled && text && (
        <DraggableSubtitle
          style={subtitles}
          editing={overlayEditing}
          stageSize={stageSize}
          onMove={(patch) => setVideoOverlay((current) => ({ ...current, subtitles: { ...current.subtitles, ...patch } }))}
        >
          <span className="video-overlay-subtitle-text" style={textStyle}>
            {text}
          </span>
        </DraggableSubtitle>
      )}
    </div>
  )
}

/** The subtitle block; while the panel is open it can be dragged anywhere
 * (its centre across the frame, its distance from the bottom). */
function DraggableSubtitle({
  style,
  editing,
  stageSize,
  onMove,
  children
}: {
  style: SubtitleOverlayStyle
  editing: boolean
  stageSize: { width: number; height: number }
  onMove: (patch: Pick<SubtitleOverlayStyle, 'xPct' | 'bottomPct'>) => void
  children: JSX.Element
}): JSX.Element {
  const drag = useRef<{ x: number; y: number; xPct: number; bottomPct: number } | null>(null)
  const sides = subtitleSideMarginsPct(style.xPct)
  return (
    <div
      className={`video-overlay-subtitle${editing ? ' video-overlay-subtitle-editing' : ''}`}
      style={{ bottom: `${style.bottomPct}%`, left: `${sides.left}%`, right: `${sides.right}%` }}
      title={editing ? 'Drag to place the subtitles' : undefined}
      onPointerDown={(e) => {
        if (!editing) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, y: e.clientY, xPct: style.xPct, bottomPct: style.bottomPct }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const xPct = Math.min(90, Math.max(10, d.xPct + ((e.clientX - d.x) / stageSize.width) * 100))
        const bottomPct = Math.min(90, Math.max(0, d.bottomPct - ((e.clientY - d.y) / stageSize.height) * 100))
        onMove({ xPct: Math.round(xPct * 10) / 10, bottomPct: Math.round(bottomPct * 10) / 10 })
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
    >
      {children}
    </div>
  )
}

/** The line(s) on screen at `time` -- lines are in time order. */
function activeText(lines: OverlayLine[], time: number): string {
  const on: string[] = []
  for (const line of lines) {
    if (line.start > time) break
    if (time < line.end && line.text.trim()) on.push(line.text.trim())
  }
  return on.join('\n')
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return `rgba(0,0,0,${alpha})`
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`
}

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se'

function BlurBox({
  region,
  sigma,
  editing,
  stageSize,
  onChange,
  onRemove
}: {
  region: BlurRegion
  sigma: number
  editing: boolean
  stageSize: { width: number; height: number }
  onChange: (next: BlurRegion) => void
  onRemove: () => void
}): JSX.Element {
  const drag = useRef<{ mode: DragMode; x: number; y: number; start: BlurRegion } | null>(null)

  const begin = (mode: DragMode) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (!editing) return
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { mode, x: e.clientX, y: e.clientY, start: region }
  }
  const move = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / stageSize.width
    const dy = (e.clientY - d.y) / stageSize.height
    const s = d.start
    if (d.mode === 'move') return onChange({ ...s, x: s.x + dx, y: s.y + dy })
    const left = d.mode === 'nw' || d.mode === 'sw'
    const top = d.mode === 'nw' || d.mode === 'ne'
    const x = left ? Math.min(s.x + dx, s.x + s.w - 0.02) : s.x
    const y = top ? Math.min(s.y + dy, s.y + s.h - 0.02) : s.y
    const w = left ? s.w - (x - s.x) : s.w + dx
    const h = top ? s.h - (y - s.y) : s.h + dy
    onChange({ ...s, x, y, w, h })
  }
  const end = (e: ReactPointerEvent<HTMLElement>): void => {
    if (drag.current && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    drag.current = null
  }

  return (
    <div
      className={`video-overlay-blur${editing ? ' video-overlay-blur-editing' : ''}`}
      style={{
        left: `${region.x * 100}%`,
        top: `${region.y * 100}%`,
        width: `${region.w * 100}%`,
        height: `${region.h * 100}%`,
        backdropFilter: `blur(${sigma}px)`,
        WebkitBackdropFilter: `blur(${sigma}px)`
      }}
      onPointerDown={begin('move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      title={editing ? 'Drag to move · drag a corner to resize' : undefined}
    >
      {editing && (
        <>
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <span key={corner} className={`video-overlay-blur-handle video-overlay-blur-handle-${corner}`} onPointerDown={begin(corner)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
          ))}
          <button
            className="video-overlay-blur-remove"
            title="Remove this blur box"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
          >
            ×
          </button>
        </>
      )}
    </div>
  )
}

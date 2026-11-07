import { Component, useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { GeminiKeyState, GeminiRouterEvent, GeminiRouterSnapshot } from './geminiKeyPool'
import { declutter, defaultPanelBox, fitCamera, fitPanelBox, globeRadius, HOME_CAMERA, homePosition, HUB_HOME, linkPath, mapScale, nodeRadius, panCamera, PANEL_MIN, project, unproject, wrapLon, zoomCamera, type GeoPoint, type PanelBox, type RouterCamera, type RouterMode, type RouterPanelId } from './geminiRouterGeo'
import { COUNTRY_LABELS, LAND_GRID_BITS, LAND_GRID_STEP, LAND_RINGS } from './geminiWorldData'
import './geminiRouter.css'

/** The Router screen, the same on the computer and the phone: the world fills
 * the screen, each Gemini key a numbered node on it, coloured by what it can do
 * right now. The world, the keys and (on a computer) the panels over them can
 * all be dragged. The numbers come from the pool (shared/geminiKeyPool.ts);
 * where a key sits is only where it is drawn, since a key has no real location. */

const STATE_LABEL: Record<GeminiKeyState, string> = {
  active: 'In use',
  ready: 'Ready',
  minute: 'Per-minute limit',
  quota: 'Out of quota',
  refused: 'Refused'
}
const HUB = '__hub'
const STORE_KEY = 'cae.router.layout'
const DRAG_THRESHOLD = 4
const PHONE_WIDTH = 760

const pad = (n: number): string => String(n).padStart(2, '0')
const clock = (at: number): string => {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const backIn = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.round((at - now) / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`
}
/** The end of a masked key, enough to tell keys apart. */
const tail = (mask: string): string => mask.slice(mask.indexOf('…'))

// ------------------------------------------------------------ what is remembered

interface Scene {
  mode: RouterMode
  cameras: Record<RouterMode, RouterCamera>
  /** Keys and the hub moved by hand, by masked key. */
  positions: Record<string, GeoPoint>
}

type PanelPlaces = Partial<Record<RouterPanelId, PanelBox>>

interface SavedLayout {
  scene?: Scene
  places?: PanelPlaces
}

const homeScene = (): Scene => ({ mode: 'map', cameras: { globe: { ...HOME_CAMERA.globe }, map: { ...HOME_CAMERA.map } }, positions: {} })

function readLayout(): SavedLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as SavedLayout
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}

function writeLayout(patch: SavedLayout): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...readLayout(), ...patch }))
  } catch {
    // Only the arrangement is lost.
  }
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function readScene(): Scene {
  const home = homeScene()
  const saved = readLayout().scene
  if (!saved) return home
  const camera = (mode: RouterMode): RouterCamera => {
    const c = saved.cameras?.[mode]
    return c && finite(c.lat) && finite(c.lon) && finite(c.zoom) ? c : home.cameras[mode]
  }
  const positions: Record<string, GeoPoint> = {}
  for (const [name, p] of Object.entries(saved.positions ?? {})) if (p && finite(p.lat) && finite(p.lon)) positions[name] = p
  return { mode: saved.mode === 'globe' ? 'globe' : 'map', cameras: { globe: camera('globe'), map: camera('map') }, positions }
}

function readPlaces(): PanelPlaces {
  const saved = readLayout().places ?? {}
  const out: PanelPlaces = {}
  for (const id of ['keys', 'activity'] as RouterPanelId[]) {
    const box = saved[id]
    if (box && finite(box.x) && finite(box.y) && finite(box.w) && finite(box.h)) out[id] = box
  }
  return out
}

// ------------------------------------------------------------ drawing the world

const RAD = Math.PI / 180

/** Land dots for the globe, decoded once: sin lat, cos lat, lon in radians.
 * Rows near the poles are thinned, or the dots would crowd together there. */
let landDots: Float32Array | null = null
function getLandDots(): Float32Array {
  if (landDots) return landDots
  const bytes = atob(LAND_GRID_BITS)
  const columns = Math.round(360 / LAND_GRID_STEP)
  const rows = Math.round(180 / LAND_GRID_STEP)
  const out: number[] = []
  for (let row = 0; row < rows; row++) {
    const lat = 90 - (row + 0.5) * LAND_GRID_STEP
    const every = Math.max(1, Math.round(1 / Math.max(0.12, Math.cos(lat * RAD))))
    for (let column = 0; column < columns; column += every) {
      const at = row * columns + column
      if (bytes.charCodeAt(at >> 3) & (1 << (at & 7))) out.push(Math.sin(lat * RAD), Math.cos(lat * RAD), (-180 + (column + 0.5) * LAND_GRID_STEP) * RAD)
    }
  }
  landDots = new Float32Array(out)
  return landDots
}

let landRings: Float32Array[] | null = null
function getLandRings(): Float32Array[] {
  if (!landRings) landRings = LAND_RINGS.map((ring) => new Float32Array(ring.split(',').map((n) => Number(n) / 10)))
  return landRings
}

function drawGlobe(ctx: CanvasRenderingContext2D, width: number, height: number, camera: RouterCamera): void {
  const radius = globeRadius(width, height, camera.zoom)
  const cx = width / 2
  const cy = height / 2
  ctx.fillStyle = '#12171e'
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fill()

  const lat0 = camera.lat * RAD
  const lon0 = camera.lon * RAD
  const sin0 = Math.sin(lat0)
  const cos0 = Math.cos(lat0)

  // Land, as dots, fading towards the edge as a lit sphere does.
  const dots = getLandDots()
  const size = Math.max(1.2, Math.min(2.6, radius / 165))
  const shades = ['rgba(150, 162, 178, 0.22)', 'rgba(170, 181, 196, 0.46)', 'rgba(196, 205, 217, 0.74)']
  const paths: Path2D[] = [new Path2D(), new Path2D(), new Path2D()]
  for (let i = 0; i < dots.length; i += 3) {
    const sinLat = dots[i]
    const cosLat = dots[i + 1]
    const delta = dots[i + 2] - lon0
    const cosDelta = Math.cos(delta)
    const z = sin0 * sinLat + cos0 * cosLat * cosDelta
    if (z <= 0.05) continue
    const x = cx + radius * cosLat * Math.sin(delta)
    const y = cy - radius * (cos0 * sinLat - sin0 * cosLat * cosDelta)
    paths[z < 0.4 ? 0 : z < 0.72 ? 1 : 2].rect(x - size / 2, y - size / 2, size, size)
  }
  paths.forEach((path, i) => {
    ctx.fillStyle = shades[i]
    ctx.fill(path)
  })
}

function drawMap(ctx: CanvasRenderingContext2D, width: number, height: number, camera: RouterCamera): void {
  const scale = mapScale(width, height, camera.zoom)
  const world = Math.PI * 2 * scale
  const worldX = (lon: number): number => (lon - camera.lon) * RAD * scale
  const centre = project({ lat: 0, lon: camera.lon }, 'map', camera, width, height).y
  const mercatorY = (lat: number): number => centre - Math.log(Math.tan(Math.PI / 4 + (Math.max(-82, Math.min(82, lat)) * RAD) / 2)) * scale
  const land = new Path2D()
  for (const ring of getLandRings()) {
    let crossed = false
    for (let i = 0; i < ring.length; i += 2) {
      const x = worldX(ring[i])
      const y = mercatorY(ring[i + 1])
      // A step across the date line (Fiji) must not be drawn across the world.
      const jump = i > 0 && Math.abs(ring[i] - ring[i - 2]) > 180
      if (jump) crossed = true
      if (i === 0 || jump) land.moveTo(x, y)
      else land.lineTo(x, y)
    }
    if (!crossed) land.closePath()
  }
  // The world repeats sideways: as many copies as it takes to fill the view.
  const first = Math.floor((-width / 2 - world / 2) / world)
  const last = Math.ceil((width / 2 + world / 2) / world)
  ctx.fillStyle = '#1d2530'
  for (let copy = first; copy <= last; copy++) {
    ctx.save()
    ctx.translate(width / 2 + copy * world, 0)
    ctx.fill(land)
    ctx.restore()
  }
  // Names only once zoomed in far enough to need them.
  const shown = scale < 340 ? 0 : scale < 620 ? 24 : scale < 1100 ? 70 : COUNTRY_LABELS.length
  ctx.font = '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(176, 188, 205, 0.4)'
  for (let i = 0; i < shown; i++) {
    const [name, lat, lon] = COUNTRY_LABELS[i]
    const x = width / 2 + wrapLon(lon - camera.lon) * RAD * scale
    const y = mercatorY(lat)
    if (x > -60 && x < width + 60 && y > -12 && y < height + 12) ctx.fillText(name, x, y)
  }
}

// ------------------------------------------------------------ the world

interface Gesture {
  pointers: Map<number, { x: number; y: number }>
  /** The key or hub being dragged; null: the world itself. */
  target: string | null
  index: number | null
  startX: number
  startY: number
  moved: boolean
  pinch: number | null
}

export interface RouterMapHandle {
  mode: RouterMode
  setMode: (mode: RouterMode) => void
  reset: () => void
}

function RouterMap({ snapshot, selected, onSelect, onReady }: { snapshot: GeminiRouterSnapshot; selected: number | null; onSelect: (index: number | null) => void; onReady: (handle: RouterMapHandle) => void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 900, height: 600 })
  const sizeRef = useRef(size)
  sizeRef.current = size
  const [scene, setScene] = useState<Scene>(readScene)
  const sceneRef = useRef(scene)
  const frame = useRef(0)
  const gesture = useRef<Gesture>({ pointers: new Map(), target: null, index: null, startX: 0, startY: 0, moved: false, pinch: null })
  const [grabbing, setGrabbing] = useState(false)

  useEffect(() => {
    const element = box.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setSize({ width, height })
    })
    watch.observe(element)
    return () => watch.disconnect()
  }, [])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const { width, height } = size
  const { mode } = scene
  const camera = fitCamera(mode, scene.cameras[mode], width, height)
  const { lat: camLat, lon: camLon, zoom: camZoom } = camera

  useEffect(() => {
    const element = canvas.current
    const ctx = element?.getContext('2d')
    if (!element || !ctx) return
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    element.width = Math.round(width * ratio)
    element.height = Math.round(height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const view = { lat: camLat, lon: camLon, zoom: camZoom }
    if (mode === 'globe') drawGlobe(ctx, width, height, view)
    else drawMap(ctx, width, height, view)
  }, [camLat, camLon, camZoom, height, mode, width])

  /** One redraw a frame, however fast the pointer reports. */
  const update = useCallback((next: Scene): void => {
    sceneRef.current = next
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      setScene(sceneRef.current)
    })
  }, [])
  const save = (): void => writeLayout({ scene: sceneRef.current })

  const zoomBy = useCallback(
    (factor: number): void => {
      const current = sceneRef.current
      const { width: w, height: h } = sizeRef.current
      update({ ...current, cameras: { ...current.cameras, [current.mode]: zoomCamera(current.mode, fitCamera(current.mode, current.cameras[current.mode], w, h), factor, w, h) } })
    },
    [update]
  )

  // The header's buttons act on the world through this.
  useEffect(() => {
    onReady({
      mode,
      setMode: (next) => {
        update({ ...sceneRef.current, mode: next })
        writeLayout({ scene: sceneRef.current })
      },
      reset: () => {
        update({ ...homeScene(), mode: sceneRef.current.mode })
        writeLayout({ scene: sceneRef.current })
      }
    })
  }, [mode, onReady, update])

  // A wheel over the world zooms it, and must not scroll what is around it.
  useEffect(() => {
    const element = box.current
    if (!element) return
    let timer = 0
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      zoomBy(Math.exp(-event.deltaY * 0.0012))
      window.clearTimeout(timer)
      timer = window.setTimeout(() => writeLayout({ scene: sceneRef.current }), 300)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
      window.clearTimeout(timer)
    }
  }, [zoomBy])

  const at = (event: ReactPointerEvent): { x: number; y: number } => {
    const rect = box.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button > 0) return
    const g = gesture.current
    const point = at(event)
    g.pointers.set(event.pointerId, point)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Only dragging past the edge is lost.
    }
    if (g.pointers.size === 1) {
      const hit = (event.target as Element).closest?.('[data-node]')
      const name = hit?.getAttribute('data-node') ?? null
      g.target = name
      g.index = name !== null && name !== HUB ? Number(hit?.getAttribute('data-index')) : null
      g.startX = point.x
      g.startY = point.y
      g.moved = false
      g.pinch = null
      setGrabbing(true)
    } else if (g.pointers.size === 2) {
      // Two fingers: zooming, not dragging.
      const [a, b] = [...g.pointers.values()]
      g.pinch = Math.hypot(a.x - b.x, a.y - b.y)
      g.target = null
      g.moved = true
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    const last = g.pointers.get(event.pointerId)
    if (!last) return
    const point = at(event)
    g.pointers.set(event.pointerId, point)
    if (g.pinch !== null && g.pointers.size >= 2) {
      const [a, b] = [...g.pointers.values()]
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      if (g.pinch > 0 && distance > 0) zoomBy(distance / g.pinch)
      g.pinch = distance
      return
    }
    if (!g.moved && Math.hypot(point.x - g.startX, point.y - g.startY) < DRAG_THRESHOLD) return
    g.moved = true
    const current = sceneRef.current
    const view = fitCamera(current.mode, current.cameras[current.mode], width, height)
    if (g.target) {
      const place = unproject(point.x, point.y, current.mode, view, width, height)
      if (place) update({ ...current, positions: { ...current.positions, [g.target]: place } })
    } else {
      update({ ...current, cameras: { ...current.cameras, [current.mode]: panCamera(current.mode, view, point.x - last.x, point.y - last.y, width, height) } })
    }
  }

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current
    if (!g.pointers.delete(event.pointerId)) return
    if (g.pointers.size > 0) return
    setGrabbing(false)
    if (g.moved) save()
    else if (g.index !== null && event.type === 'pointerup') onSelect(selected === g.index ? null : g.index)
    g.target = null
    g.index = null
    g.pinch = null
  }

  /** The arrow keys move a key too, for anyone not using a pointer. */
  const onNodeKey = (event: ReactKeyboardEvent, name: string, index: number | null, place: GeoPoint): void => {
    if ((event.key === 'Enter' || event.key === ' ') && index !== null) {
      event.preventDefault()
      onSelect(selected === index ? null : index)
      return
    }
    const steps: Record<string, [number, number]> = { ArrowUp: [2, 0], ArrowDown: [-2, 0], ArrowLeft: [0, -2], ArrowRight: [0, 2] }
    const step = steps[event.key]
    if (!step) return
    event.preventDefault()
    const current = sceneRef.current
    update({ ...current, positions: { ...current.positions, [name]: { lat: Math.max(-82, Math.min(82, place.lat + step[0])), lon: wrapLon(place.lon + step[1]) } } })
    save()
  }

  const count = snapshot.keys.length
  const radius = nodeRadius(width, height)
  const hubPlace = scene.positions[HUB] ?? HUB_HOME
  const hubProjected = project(hubPlace, mode, camera, width, height)
  const places = snapshot.keys.map((key, i) => scene.positions[key.mask] ?? homePosition(i, count))
  const projected = places.map((place) => project(place, mode, camera, width, height))
  // Keys placed by hand stay put; the rest make room. Keys behind the globe
  // take no part: they are not competing for that space.
  const facing = projected.map((p, i) => ({ p, i })).filter(({ p }) => p.z > 0)
  const spread = declutter(
    [{ x: hubProjected.x, y: hubProjected.y, pinned: true }, ...facing.map(({ p, i }) => ({ x: p.x, y: p.y, pinned: !!scene.positions[snapshot.keys[i].mask] }))],
    radius * 2 + 14
  )
  const shown = projected.map((p) => ({ x: p.x, y: p.y, z: p.z }))
  facing.forEach(({ i }, order) => {
    shown[i] = { ...shown[i], ...spread[order + 1] }
  })
  const hubSeen = hubProjected.z > 0

  return (
    <div className={`grt-canvas${grabbing ? ' is-grabbing' : ''}`} ref={box} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
      <canvas ref={canvas} style={{ width, height }} aria-hidden />
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Gemini router with ${count} keys, shown on a ${mode}`}>
        {hubSeen &&
          shown.map((p, i) => {
            if (p.z <= 0) return null
            const key = snapshot.keys[i]
            return <path key={`${key.mask}-${i}`} className={`grt-link grt-link-${key.state}`} d={linkPath(hubProjected, p, mode, width, height)} />
          })}
        {hubSeen &&
          shown.map((p, i) => {
            const key = snapshot.keys[i]
            if (p.z <= 0 || key.answered === 0) return null
            // Mounted anew by each answer: a dot runs from the key to the hub.
            return <circle key={`${key.mask}-${i}-${key.answered}`} className="grt-pulse" r="2.5" style={{ offsetPath: `path('${linkPath(p, hubProjected, mode, width, height)}')` }} />
          })}
        <g className={`grt-hub${hubSeen ? '' : ' is-behind'}`} data-node={HUB} role="button" tabIndex={0} aria-label="Router hub. Drag to move" onKeyDown={(event) => onNodeKey(event, HUB, null, hubPlace)}>
          <circle className="grt-hit" cx={hubProjected.x} cy={hubProjected.y} r={18} />
          <circle className="grt-hub-ring" cx={hubProjected.x} cy={hubProjected.y} r={8} />
          <circle className="grt-hub-core" cx={hubProjected.x} cy={hubProjected.y} r={3} />
        </g>
        {shown.map((p, i) => {
          const key = snapshot.keys[i]
          const isSelected = selected === i
          const seen = p.z > 0
          return (
            <g
              key={`${key.mask}-${i}`}
              className={`grt-node grt-node-${key.state}${isSelected ? ' is-selected' : ''}${seen ? '' : ' is-behind'}`}
              data-node={key.mask}
              data-index={i}
              role="button"
              tabIndex={seen ? 0 : -1}
              aria-label={`Slot ${pad(i)}, ${key.mask}: ${STATE_LABEL[key.state]}. Drag to move`}
              onKeyDown={(event) => onNodeKey(event, key.mask, i, places[i])}
              onClick={(event) => {
                // A click with no pointer behind it: a screen reader's.
                if (event.detail === 0) onSelect(isSelected ? null : i)
              }}
            >
              <circle className="grt-hit" cx={p.x} cy={p.y} r={radius + 9} />
              <circle className="grt-node-disc" cx={p.x} cy={p.y} r={radius} />
              <text className="grt-node-num" x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central">{i}</text>
              <text className="grt-node-label" x={p.x} y={p.y + radius + 14} textAnchor="middle">{tail(key.mask)}</text>
            </g>
          )
        })}
      </svg>
      {count === 0 && <p className="grt-empty">No keys yet. Add them on the key card, then open the Router again.</p>}
      <div className="grt-zoom" onPointerDown={(event) => event.stopPropagation()}>
        <button aria-label="Zoom in" onClick={() => { zoomBy(1.3); save() }}>+</button>
        <button aria-label="Zoom out" onClick={() => { zoomBy(1 / 1.3); save() }}>−</button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------ the panels

/** A panel over the world: drag it by its title, size it by its corner. It is
 * only as tall as what it holds. On a phone the panels stack under the world. */
function Panel({ id, title, box, stageHeight, floating, z, onFront, onPlace, onDone, children }: { id: RouterPanelId; title: string; box: PanelBox; stageHeight: number; floating: boolean; z: number; onFront: () => void; onPlace: (box: PanelBox) => void; onDone: () => void; children: ReactNode }): JSX.Element {
  const element = useRef<HTMLElement>(null)
  const drag = useRef<{ kind: 'move' | 'size'; x: number; y: number; from: PanelBox } | null>(null)
  const begin = (kind: 'move' | 'size') => (event: ReactPointerEvent<HTMLElement>): void => {
    if (!floating || event.button > 0) return
    event.stopPropagation()
    // Sizing starts from how tall it is now, not how tall it may grow.
    const h = kind === 'size' ? element.current?.offsetHeight ?? box.h : box.h
    drag.current = { kind, x: event.clientX, y: event.clientY, from: { ...box, h } }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Only dragging past the edge is lost.
    }
  }
  const moveTo = (event: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current
    if (!d) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    onPlace(d.kind === 'move' ? { ...d.from, x: d.from.x + dx, y: d.from.y + dy } : { ...d.from, w: d.from.w + dx, h: d.from.h + dy })
  }
  const end = (): void => {
    if (drag.current) onDone()
    drag.current = null
  }
  const style: CSSProperties | undefined = floating ? { left: box.x, top: box.y, width: box.w, maxHeight: Math.min(box.h, stageHeight - box.y), zIndex: z, minWidth: PANEL_MIN[id].w } : undefined
  return (
    <section ref={element} className={`grt-win grt-win-${id}${floating ? ' is-floating' : ''}`} style={style} aria-label={title} onPointerDownCapture={onFront}>
      <header
        className="grt-win-title"
        tabIndex={floating ? 0 : -1}
        aria-label={floating ? `${title}. Drag to move, or use the arrow keys` : undefined}
        onPointerDown={begin('move')}
        onPointerMove={moveTo}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(event) => {
          if (!floating) return
          const steps: Record<string, [number, number]> = { ArrowUp: [0, -16], ArrowDown: [0, 16], ArrowLeft: [-16, 0], ArrowRight: [16, 0] }
          const step = steps[event.key]
          if (!step) return
          event.preventDefault()
          onPlace({ ...box, x: box.x + step[0], y: box.y + step[1] })
          onDone()
        }}
      >
        {title}
      </header>
      <div className="grt-win-body">{children}</div>
      {floating && <span className="grt-win-grip" aria-hidden onPointerDown={begin('size')} onPointerMove={moveTo} onPointerUp={end} onPointerCancel={end} />}
    </section>
  )
}

/** Good news is plain; only what needs attention gets a colour. */
const EVENT_TONE: Record<GeminiRouterEvent['kind'], string> = {
  answer: '',
  move: 'grt-fg-text',
  minute: 'grt-fg-minute',
  quota: 'grt-fg-quota',
  refused: 'grt-fg-refused',
  test: ''
}

/** A fault in the Router stays in the Router: the rest of the app, and the
 * project open in it, carry on. "Try again" also clears the saved arrangement,
 * in case that is what it could not handle. */
export class GeminiRouterBoundary extends Component<{ onClose: () => void; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  private retry = (): void => {
    try {
      localStorage.removeItem(STORE_KEY)
    } catch {
      // Then only the arrangement stays as it was.
    }
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="grt grt-failed" role="alert">
        <strong>The Router could not open.</strong>
        <p>Your project is not affected. {error.message}</p>
        <div>
          <button className="grt-test" onClick={this.retry}>Try again</button>
          <button className="grt-test" onClick={this.props.onClose}>Close</button>
        </div>
      </div>
    )
  }
}

export interface GeminiRouterViewProps {
  snapshot: GeminiRouterSnapshot
  testing: boolean
  onTest: () => void
  onClose: () => void
  closeLabel?: string
}

const PANEL_ORDER: RouterPanelId[] = ['keys', 'activity']

export function GeminiRouterView({ snapshot, testing, onTest, onClose, closeLabel = 'Close Router' }: GeminiRouterViewProps): JSX.Element {
  const [selected, setSelected] = useState<number | null>(null)
  const [places, setPlaces] = useState<PanelPlaces>(readPlaces)
  const placesRef = useRef(places)
  const [order, setOrder] = useState<RouterPanelId[]>(PANEL_ORDER)
  const [map, setMap] = useState<RouterMapHandle | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState({ width: 1200, height: 700 })
  const [floating, setFloating] = useState(() => typeof window === 'undefined' || window.innerWidth > PHONE_WIDTH)

  useEffect(() => {
    const element = stage.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setStageSize({ width, height })
      setFloating(window.innerWidth > PHONE_WIDTH)
    })
    watch.observe(element)
    return () => watch.disconnect()
  }, [])

  const { keys, events } = snapshot
  const now = Date.now()
  const working = keys.filter((key) => key.state === 'active' || key.state === 'ready').length

  const boxOf = (id: RouterPanelId): PanelBox => fitPanelBox(id, places[id] ?? defaultPanelBox(id, stageSize.width, stageSize.height), stageSize.width, stageSize.height)
  const place = (id: RouterPanelId, box: PanelBox): void => {
    const next = { ...placesRef.current, [id]: fitPanelBox(id, box, stageSize.width, stageSize.height) }
    placesRef.current = next
    setPlaces(next)
  }
  const savePlaces = (): void => writeLayout({ places: placesRef.current })
  const front = (id: RouterPanelId): void => setOrder((list) => (list[list.length - 1] === id ? list : [...list.filter((other) => other !== id), id]))
  const reset = (): void => {
    map?.reset()
    placesRef.current = {}
    setPlaces({})
    setOrder(PANEL_ORDER)
    writeLayout({ places: {} })
  }
  const panelProps = (id: RouterPanelId) => ({ id, box: boxOf(id), stageHeight: stageSize.height, floating, z: 10 + order.indexOf(id), onFront: () => front(id), onPlace: (box: PanelBox) => place(id, box), onDone: savePlaces })

  return (
    <div className="grt">
      <header className="grt-head">
        <strong className="grt-name">Gemini Router</strong>
        <span className={`grt-status${keys.length === 0 || working === 0 ? ' is-down' : ''}`}>
          {keys.length === 0 ? 'No keys' : `${working} of ${keys.length} keys can answer`}
        </span>
        <span className="grt-head-gap" />
        <div className="grt-seg" role="group" aria-label="View">
          <button className={map?.mode === 'map' ? 'is-on' : ''} aria-pressed={map?.mode === 'map'} onClick={() => map?.setMode('map')}>Map</button>
          <button className={map?.mode === 'globe' ? 'is-on' : ''} aria-pressed={map?.mode === 'globe'} onClick={() => map?.setMode('globe')}>Globe</button>
        </div>
        <button className="grt-btn" title="Put the keys, the view and the panels back" onClick={reset}>Reset</button>
        <button className="grt-btn grt-close" onClick={onClose} aria-label={closeLabel}>×</button>
      </header>

      <div className="grt-stage" ref={stage}>
        <RouterMap snapshot={snapshot} selected={selected} onSelect={setSelected} onReady={setMap} />

        <Panel {...panelProps('keys')} title="Keys">
          <ul className="grt-keys">
            {keys.map((key, i) => {
              const isSelected = selected === i
              return (
                <li key={`${key.mask}-${i}`} className={isSelected ? 'is-selected' : ''}>
                  <button className="grt-key" aria-expanded={isSelected} onClick={() => setSelected(isSelected ? null : i)}>
                    <i className={`grt-mark grt-bg-${key.state}`} />
                    <span className="grt-key-num">{i}</span>
                    <span className="grt-key-name">{tail(key.mask)}</span>
                    <span className={`grt-key-state grt-state-${key.state}`}>{STATE_LABEL[key.state]}</span>
                  </button>
                  {isSelected && (
                    <dl className="grt-detail">
                      <div><dt>Key</dt><dd>{key.mask}</dd></div>
                      {key.backAt !== null && <div><dt>Back in</dt><dd>{backIn(key.backAt, now)}</dd></div>}
                      <div><dt>Model</dt><dd>{key.model ?? 'Not used yet'}</dd></div>
                      <div><dt>Answered</dt><dd>{key.answered}</dd></div>
                    </dl>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="grt-keys-foot">
            <button className="grt-test" title="Asks each key for one word: up to one request from each" disabled={testing || keys.length === 0} onClick={onTest}>{testing ? 'Testing…' : 'Test all keys'}</button>
            <small>{snapshot.answered} answered, {snapshot.moves} moved since {clock(snapshot.since).slice(0, 5)}</small>
          </div>
        </Panel>

        <Panel {...panelProps('activity')} title="Activity">
          {events.length === 0 ? (
            <p className="grt-quiet">Nothing yet.</p>
          ) : (
            <ol className="grt-log">
              {events.map((event) => (
                <li key={event.id}>
                  <time>{clock(event.at)}</time>
                  <b>{tail(event.mask)}</b>
                  <span className={EVENT_TONE[event.kind]}>{event.text}</span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  )
}

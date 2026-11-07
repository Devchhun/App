/** The Router screen's world and panels: the globe and flat-map projections,
 * how the camera moves, how keys avoid each other, where panels may go. Pure
 * maths, so it can be tested without a screen. Where a key sits on the world
 * is only where it is drawn: a key has no real location. */

export interface GeoPoint {
  lat: number
  lon: number
}

export type RouterMode = 'globe' | 'map'

export interface RouterCamera {
  lat: number
  lon: number
  zoom: number
}

export interface ScreenPoint {
  x: number
  y: number
  /** Above 0: on the side of the globe facing the viewer. Always 1 on the map. */
  z: number
}

/** Where the hub starts: Cambodia, where this app's users are. */
export const HUB_HOME: GeoPoint = { lat: 11.6, lon: 104.9 }
/** Pulled back a little, so the panels at the sides leave every key in view. */
export const HOME_CAMERA: Record<RouterMode, RouterCamera> = {
  map: { lat: 8, lon: 104.9, zoom: 0.72 },
  globe: { lat: 8, lon: 104.9, zoom: 0.94 }
}

const ZOOM_LIMITS: Record<RouterMode, [number, number]> = { globe: [0.7, 3.5], map: [0.05, 10] }
const MAX_MAP_LAT = 82
const MAX_GLOBE_TILT = 70

const RAD = Math.PI / 180
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))
/** Into -180..180. */
export const wrapLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180

export function globeRadius(width: number, height: number, zoom: number): number {
  return (Math.min(width, height) / 2) * 0.88 * zoom
}

/** Pixels for one radian of longitude on the flat map. */
export function mapScale(width: number, height: number, zoom: number): number {
  return Math.min(width, height) * 0.45 * zoom
}

const mercator = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + (clamp(lat, -MAX_MAP_LAT, MAX_MAP_LAT) * RAD) / 2))
const inverseMercator = (y: number): number => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD
const MAP_TOP = mercator(MAX_MAP_LAT)

/** The camera as this screen can show it. The flat map never shrinks below the
 * screen or slides off it, so no empty band shows above or below the world and
 * no second copy shows beside it until it is dragged there. */
export function fitCamera(mode: RouterMode, camera: RouterCamera, width: number, height: number): RouterCamera {
  if (mode === 'globe') return { ...camera, lat: clamp(camera.lat, -MAX_GLOBE_TILT, MAX_GLOBE_TILT), zoom: clamp(camera.zoom, ...ZOOM_LIMITS.globe) }
  const smallest = Math.max(height / (2 * MAP_TOP), width / (2 * Math.PI)) / mapScale(width, height, 1)
  const zoom = clamp(camera.zoom, Math.max(smallest, ZOOM_LIMITS.map[0]), Math.max(smallest, ZOOM_LIMITS.map[1]))
  const room = Math.max(0, MAP_TOP - height / 2 / mapScale(width, height, zoom))
  return { lon: camera.lon, zoom, lat: inverseMercator(clamp(mercator(camera.lat), -room, room)) }
}

export function project(point: GeoPoint, mode: RouterMode, camera: RouterCamera, width: number, height: number): ScreenPoint {
  const dLon = wrapLon(point.lon - camera.lon) * RAD
  if (mode === 'map') {
    const scale = mapScale(width, height, camera.zoom)
    return { x: width / 2 + dLon * scale, y: height / 2 - (mercator(point.lat) - mercator(camera.lat)) * scale, z: 1 }
  }
  const radius = globeRadius(width, height, camera.zoom)
  const lat = point.lat * RAD
  const lat0 = camera.lat * RAD
  return {
    x: width / 2 + radius * Math.cos(lat) * Math.sin(dLon),
    y: height / 2 - radius * (Math.cos(lat0) * Math.sin(lat) - Math.sin(lat0) * Math.cos(lat) * Math.cos(dLon)),
    z: Math.sin(lat0) * Math.sin(lat) + Math.cos(lat0) * Math.cos(lat) * Math.cos(dLon)
  }
}

/** The point of the world under a screen position; null beside the globe. */
export function unproject(x: number, y: number, mode: RouterMode, camera: RouterCamera, width: number, height: number): GeoPoint | null {
  const dx = x - width / 2
  const dy = height / 2 - y
  if (mode === 'map') {
    const scale = mapScale(width, height, camera.zoom)
    return { lat: clamp(inverseMercator(mercator(camera.lat) + dy / scale), -MAX_MAP_LAT, MAX_MAP_LAT), lon: wrapLon(camera.lon + dx / scale / RAD) }
  }
  const radius = globeRadius(width, height, camera.zoom)
  const rho = Math.hypot(dx, dy)
  if (rho > radius) return null
  if (rho === 0) return { lat: camera.lat, lon: camera.lon }
  const c = Math.asin(rho / radius)
  const lat0 = camera.lat * RAD
  const lat = Math.asin(Math.cos(c) * Math.sin(lat0) + (dy * Math.sin(c) * Math.cos(lat0)) / rho)
  const lon = Math.atan2(dx * Math.sin(c), rho * Math.cos(lat0) * Math.cos(c) - dy * Math.sin(lat0) * Math.sin(c))
  return { lat: lat / RAD, lon: wrapLon(camera.lon + lon / RAD) }
}

/** The camera after a drag of the empty world by (dx, dy) pixels. */
export function panCamera(mode: RouterMode, camera: RouterCamera, dx: number, dy: number, width: number, height: number): RouterCamera {
  if (mode === 'map') {
    const scale = mapScale(width, height, camera.zoom)
    return fitCamera(mode, { ...camera, lon: wrapLon(camera.lon - dx / scale / RAD), lat: clamp(inverseMercator(mercator(camera.lat) + dy / scale), -MAX_MAP_LAT, MAX_MAP_LAT) }, width, height)
  }
  const radius = globeRadius(width, height, camera.zoom)
  return { ...camera, lon: wrapLon(camera.lon - dx / radius / RAD), lat: clamp(camera.lat + dy / radius / RAD, -MAX_GLOBE_TILT, MAX_GLOBE_TILT) }
}

export function zoomCamera(mode: RouterMode, camera: RouterCamera, factor: number, width: number, height: number): RouterCamera {
  return fitCamera(mode, { ...camera, zoom: camera.zoom * factor }, width, height)
}

/** The line between two places on screen: straight on the map, bowed away from
 * the centre on the globe, as a line over a sphere looks. */
export function linkPath(a: { x: number; y: number }, b: { x: number; y: number }, mode: RouterMode, width: number, height: number): string {
  if (mode === 'map') return `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`
  const midX = (a.x + b.x) / 2
  const midY = (a.y + b.y) / 2
  const bowX = midX + (midX - width / 2) * 0.22
  const bowY = midY + (midY - height / 2) * 0.22
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)}Q${bowX.toFixed(1)} ${bowY.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
}

/** Where a key starts until it is dragged: spiralling out from the hub. */
export function homePosition(index: number, count: number): GeoPoint {
  const reach = 26 + 20 * Math.sqrt(count > 1 ? index / (count - 1) : 0)
  // The first keys, closest to the hub, start away from its label below it.
  const angle = index * 2.39996 - 0.75
  return { lat: HUB_HOME.lat + Math.sin(angle) * reach * 0.8, lon: wrapLon(HUB_HOME.lon + Math.cos(angle) * reach) }
}

/** A key's circle: just big enough for its slot number. */
export function nodeRadius(width: number, height: number): number {
  return clamp(Math.min(width, height) * 0.017, 11, 13)
}

export interface PlacedPoint {
  x: number
  y: number
  /** Stays where it is: the hub, or a key placed by hand. */
  pinned: boolean
}

/** Screen positions with crowded points pushed apart, so a far-out view never
 * piles keys on one another. Only what is drawn moves, not the saved places. */
export function declutter(points: PlacedPoint[], minDistance: number): { x: number; y: number }[] {
  const out = points.map((p) => ({ ...p }))
  for (let round = 0; round < 24; round++) {
    let moved = false
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]
        const b = out[j]
        if (a.pinned && b.pinned) continue
        let dx = b.x - a.x
        let dy = b.y - a.y
        let distance = Math.hypot(dx, dy)
        if (distance >= minDistance) continue
        if (distance < 0.01) {
          // On the very same spot: apart in a direction of their own.
          const angle = (i + 1) * 2.39996 + j
          dx = Math.cos(angle)
          dy = Math.sin(angle)
          distance = 1
        }
        const push = minDistance - distance
        const ux = dx / distance
        const uy = dy / distance
        const aShare = a.pinned ? 0 : b.pinned ? 1 : 0.5
        const bShare = b.pinned ? 0 : a.pinned ? 1 : 0.5
        a.x -= ux * push * aShare
        a.y -= uy * push * aShare
        b.x += ux * push * bShare
        b.y += uy * push * bShare
        moved = true
      }
    }
    if (!moved) break
  }
  return out.map(({ x, y }) => ({ x, y }))
}

// ------------------------------------------------------------ floating panels

export type RouterPanelId = 'keys' | 'activity'

/** `h` is as tall as a panel may grow: it is only as tall as what it holds. */
export interface PanelBox {
  x: number
  y: number
  w: number
  h: number
}

export const PANEL_MIN: Record<RouterPanelId, { w: number; h: number }> = {
  keys: { w: 220, h: 120 },
  activity: { w: 220, h: 90 }
}

const MARGIN = 14
/** A panel's title always stays on the stage, to be dragged back by. */
const TITLE_HEIGHT = 34

/** Where a panel sits until it is moved: keys on the left, activity on the right. */
export function defaultPanelBox(id: RouterPanelId, stageWidth: number, stageHeight: number): PanelBox {
  if (id === 'keys') return { x: MARGIN, y: MARGIN, w: 252, h: stageHeight - MARGIN * 2 }
  const w = 288
  return { x: stageWidth - w - MARGIN, y: MARGIN, w, h: Math.max(160, stageHeight * 0.42) }
}

/** A panel kept on the stage however the window has changed since it was placed. */
export function fitPanelBox(id: RouterPanelId, box: PanelBox, stageWidth: number, stageHeight: number): PanelBox {
  const min = PANEL_MIN[id]
  const w = clamp(box.w, min.w, Math.max(min.w, stageWidth))
  return { w, h: Math.max(min.h, box.h), x: clamp(box.x, 0, Math.max(0, stageWidth - w)), y: clamp(box.y, 0, Math.max(0, stageHeight - TITLE_HEIGHT)) }
}

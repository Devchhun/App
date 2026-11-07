import { describe, expect, it } from 'vitest'
import { declutter, defaultPanelBox, fitCamera, fitPanelBox, HOME_CAMERA, homePosition, HUB_HOME, linkPath, mapScale, nodeRadius, panCamera, PANEL_MIN, project, unproject, wrapLon, zoomCamera, type RouterMode, type RouterPanelId } from './geminiRouterGeo'

const MODES: RouterMode[] = ['globe', 'map']
const SCREENS: [string, number, number][] = [
  ['computer', 1400, 790],
  ['small window', 1000, 560],
  ['phone', 366, 322]
]

describe('project and unproject', () => {
  for (const mode of MODES) {
    it(`find the same point again on the ${mode}`, () => {
      const camera = { lat: 20, lon: 100, zoom: 1.3 }
      for (const point of [{ lat: 11.6, lon: 104.9 }, { lat: 40, lon: 130 }, { lat: -10, lon: 80 }, { lat: 0, lon: 100 }]) {
        const screen = project(point, mode, camera, 800, 600)
        const back = unproject(screen.x, screen.y, mode, camera, 800, 600)
        expect(back?.lat).toBeCloseTo(point.lat, 5)
        expect(back?.lon).toBeCloseTo(point.lon, 5)
      }
    })

    it(`put the camera's point in the middle of the ${mode}`, () => {
      const home = HOME_CAMERA[mode]
      const p = project({ lat: home.lat, lon: home.lon }, mode, home, 800, 600)
      expect(p.x).toBeCloseTo(400)
      expect(p.y).toBeCloseTo(300)
      expect(p.z).toBeGreaterThan(0)
    })
  }

  it('finds nothing beside the globe', () => {
    expect(unproject(2, 2, 'globe', HOME_CAMERA.globe, 800, 600)).toBeNull()
  })

  it('knows what is behind the globe', () => {
    expect(project({ lat: -14, lon: -75 }, 'globe', HOME_CAMERA.globe, 800, 600).z).toBeLessThan(0)
  })

  it('takes the short way across the date line on the map', () => {
    const p = project({ lat: 0, lon: -179 }, 'map', { lat: 0, lon: 179, zoom: 1 }, 800, 600)
    expect(p.x).toBeGreaterThan(400)
    expect(p.x).toBeLessThan(440)
  })
})

describe('moving the camera', () => {
  it('spins the globe and pans the map with the finger', () => {
    for (const mode of MODES) {
      const point = { lat: 14, lon: 110 }
      const before = project(point, mode, HOME_CAMERA[mode], 800, 600)
      const moved = panCamera(mode, HOME_CAMERA[mode], 40, 0, 800, 600)
      expect(project(point, mode, moved, 800, 600).x).toBeGreaterThan(before.x)
    }
  })

  it('stops the globe at the poles', () => {
    let camera = HOME_CAMERA.globe
    for (let i = 0; i < 40; i++) camera = panCamera('globe', camera, 0, 200, 800, 600)
    expect(camera.lat).toBeLessThanOrEqual(70)
    expect(Number.isFinite(camera.lat)).toBe(true)
    expect(fitCamera('globe', { lat: -85, lon: 104, zoom: 1 }, 800, 600).lat).toBe(-70)
  })

  it('keeps the globe zoom within limits', () => {
    expect(zoomCamera('globe', HOME_CAMERA.globe, 100, 800, 600).zoom).toBe(3.5)
    expect(zoomCamera('globe', HOME_CAMERA.globe, 0.001, 800, 600).zoom).toBe(0.7)
  })

  it('wraps longitude', () => {
    expect(wrapLon(190)).toBeCloseTo(-170)
    expect(wrapLon(-190)).toBeCloseTo(170)
    expect(wrapLon(45)).toBeCloseTo(45)
  })
})

describe('the flat map fills the screen', () => {
  for (const [name, width, height] of SCREENS) {
    const worldEdges = (camera: { lat: number; lon: number; zoom: number }): { top: number; bottom: number } => ({
      top: project({ lat: 82, lon: camera.lon }, 'map', camera, width, height).y,
      bottom: project({ lat: -82, lon: camera.lon }, 'map', camera, width, height).y
    })

    it(`leaves no empty band however far out, on a ${name}`, () => {
      const camera = zoomCamera('map', { lat: -60, lon: 40, zoom: 1 }, 0.001, width, height)
      const { top, bottom } = worldEdges(camera)
      expect(top).toBeLessThanOrEqual(0.01)
      expect(bottom).toBeGreaterThanOrEqual(height - 0.01)
    })

    it(`shows the world once, not twice, at its smallest, on a ${name}`, () => {
      const camera = fitCamera('map', { ...HOME_CAMERA.map, zoom: 0.001 }, width, height)
      expect(Math.PI * 2 * mapScale(width, height, camera.zoom)).toBeGreaterThanOrEqual(width - 0.01)
    })

    it(`cannot be dragged off the top or bottom, on a ${name}`, () => {
      let camera = fitCamera('map', HOME_CAMERA.map, width, height)
      for (const dy of [5000, -9000]) {
        camera = panCamera('map', camera, 0, dy, width, height)
        const { top, bottom } = worldEdges(camera)
        expect(top).toBeLessThanOrEqual(0.01)
        expect(bottom).toBeGreaterThanOrEqual(height - 0.01)
      }
    })
  }

  it('starts no key under the panels, on a computer', () => {
    for (const [width, height] of [[1400, 808], [1052, 620]]) {
      const left = defaultPanelBox('keys', width, height)
      const right = defaultPanelBox('activity', width, height)
      const camera = fitCamera('map', HOME_CAMERA.map, width, height)
      for (let count = 1; count <= 12; count++) {
        for (let i = 0; i < count; i++) {
          const p = project(homePosition(i, count), 'map', camera, width, height)
          expect(p.x - 13).toBeGreaterThanOrEqual(left.x + left.w)
          expect(p.x + 13).toBeLessThanOrEqual(right.x)
        }
      }
    }
  })

  it('repairs a camera saved far out by an older version', () => {
    const camera = fitCamera('map', { lat: 14, lon: 105, zoom: 0.25 }, 1400, 790)
    expect(camera.zoom).toBeGreaterThan(0.25)
  })
})

describe('where keys start', () => {
  for (const mode of MODES) {
    for (const [name, width, height] of SCREENS) {
      it(`keeps up to 12 keys on screen and off the hub, on the ${name} ${mode}`, () => {
        for (let count = 1; count <= 12; count++) {
          const radius = nodeRadius(width, height)
          const camera = fitCamera(mode, HOME_CAMERA[mode], width, height)
          const hub = project(HUB_HOME, mode, camera, width, height)
          const nodes = Array.from({ length: count }, (_, i) => project(homePosition(i, count), mode, camera, width, height))
          for (const node of nodes) {
            expect(node.z).toBeGreaterThan(0)
            expect(node.x).toBeGreaterThanOrEqual(radius)
            expect(node.x).toBeLessThanOrEqual(width - radius)
            expect(node.y).toBeGreaterThanOrEqual(radius)
            expect(node.y).toBeLessThanOrEqual(height - radius)
            expect(Math.hypot(node.x - hub.x, node.y - hub.y)).toBeGreaterThan(radius * 2)
          }
        }
      })
    }
  }
})

describe('declutter', () => {
  const free = (x: number, y: number): { x: number; y: number; pinned: boolean } => ({ x, y, pinned: false })

  it('leaves points alone that have room', () => {
    expect(declutter([free(0, 0), free(100, 0)], 40)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }])
  })

  it('pushes a pile of keys apart', () => {
    const out = declutter(Array.from({ length: 8 }, () => free(300, 300)), 40)
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) expect(Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y)).toBeGreaterThanOrEqual(39)
    }
  })

  it('never moves the hub or a key placed by hand', () => {
    const out = declutter([{ x: 10, y: 10, pinned: true }, free(12, 10), { x: 300, y: 10, pinned: true }], 40)
    expect(out[0]).toEqual({ x: 10, y: 10 })
    expect(out[2]).toEqual({ x: 300, y: 10 })
    expect(Math.hypot(out[1].x - 10, out[1].y - 10)).toBeGreaterThanOrEqual(39.9)
  })

  it('leaves two hand-placed keys where they were put, even touching', () => {
    const out = declutter([{ x: 10, y: 10, pinned: true }, { x: 12, y: 10, pinned: true }], 40)
    expect(out).toEqual([{ x: 10, y: 10 }, { x: 12, y: 10 }])
  })
})

describe('links', () => {
  it('is one straight line on the map, bowed on the globe', () => {
    expect(linkPath({ x: 10, y: 10 }, { x: 90, y: 30 }, 'map', 800, 600)).toMatch(/^M[\d. -]+L[\d. -]+$/)
    expect(linkPath({ x: 10, y: 10 }, { x: 90, y: 30 }, 'globe', 800, 600)).toMatch(/^M[\d. -]+Q[\d. -]+$/)
  })
})

describe('panels', () => {
  const IDS: RouterPanelId[] = ['keys', 'activity']

  it('start on the stage, on any window from small to large', () => {
    for (const [width, height] of [[800, 500], [1052, 600], [1400, 790], [2560, 1300]]) {
      for (const id of IDS) {
        const box = fitPanelBox(id, defaultPanelBox(id, width, height), width, height)
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.x + box.w).toBeLessThanOrEqual(width)
        expect(box.y).toBeLessThan(height)
      }
    }
  })

  it('come back onto the stage when the window shrinks, title showing', () => {
    expect(fitPanelBox('activity', { x: 2000, y: 1500, w: 288, h: 300 }, 1000, 600)).toEqual({ x: 712, y: 566, w: 288, h: 300 })
  })

  it('never get narrower or shorter than they can show', () => {
    const box = fitPanelBox('keys', { x: 0, y: 0, w: 10, h: 10 }, 1000, 600)
    expect(box.w).toBe(PANEL_MIN.keys.w)
    expect(box.h).toBe(PANEL_MIN.keys.h)
  })
})

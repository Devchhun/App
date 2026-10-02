import { describe, expect, it } from 'vitest'
import { assColor, assText, assTime, buildAssSubtitles, buildOverlayFilterSteps, clampRegion, createDefaultVideoOverlaySettings, ffmpegFilterPath, sanitizeVideoOverlaySettings } from './videoOverlay'

describe('ASS pieces', () => {
  it('colours are &HAABBGGRR', () => {
    expect(assColor('#ff8000')).toBe('&H000080FF')
    expect(assColor('#000000', 0.5)).toBe('&H80000000')
  })
  it('times are h:mm:ss.cc', () => {
    expect(assTime(0)).toBe('0:00:00.00')
    expect(assTime(3725.456)).toBe('1:02:05.46')
  })
  it('text cannot open override blocks and keeps its line breaks', () => {
    expect(assText('ក {\\b1} ខ\nគ')).toBe('ក （＼b1） ខ\\Nគ')
  })
})

describe('buildAssSubtitles', () => {
  it('sizes the style to the frame and lists the lines in time order', () => {
    const style = createDefaultVideoOverlaySettings().subtitles
    const ass = buildAssSubtitles([{ start: 5, end: 6, text: 'ខ' }, { start: 1, end: 2.5, text: 'ក' }, { start: 3, end: 3, text: 'empty' }], style, { width: 1280, height: 720 })
    expect(ass).toContain('PlayResY: 720')
    // 5.5% of 720 = 39.6 px em, x1.586 for libass's sizing.
    expect(ass).toContain('Style: Default,Battambang,63,&H00FFFFFF')
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue'))
    expect(events).toEqual(['Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,ក', 'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,ខ'])
  })
  it('a background box uses border style 3 in the box colour', () => {
    const style = { ...createDefaultVideoOverlaySettings().subtitles, background: true, backgroundColor: '#102030', backgroundOpacity: 1 }
    expect(buildAssSubtitles([], style, { width: 1920, height: 1080 })).toMatch(/&H00302010,&H00000000,-1,0,0,0,100,100,0,0,3,/)
  })
})

describe('regions and settings', () => {
  it('keeps a box inside the frame', () => {
    expect(clampRegion({ id: 'a', x: 0.9, y: -1, w: 0.5, h: 0 })).toEqual({ id: 'a', x: 0.5, y: 0, w: 0.5, h: 0.02 })
  })
  it('makes saved settings whole', () => {
    const s = sanitizeVideoOverlaySettings({ subtitles: { fontSizePct: 99, color: 'red' } as never })
    expect(s.subtitles.fontSizePct).toBe(15)
    expect(s.subtitles.color).toBe('#ffffff')
    expect(s.blur.regions).toHaveLength(1)
  })
})

describe('buildOverlayFilterSteps', () => {
  const frame = { width: 1280, height: 720 }
  it('escapes Windows paths for the filter graph', () => {
    expect(ffmpegFilterPath('C:\\Users\\a b\\x.ass')).toBe("'C\\:/Users/a b/x.ass'")
  })
  it('blurs each box (even pixel sizes) then draws the subtitles, ending on the output label', () => {
    const blur = { enabled: true, strength: 14, regions: [{ id: 'r', x: 0.1, y: 0.8, w: 0.8, h: 0.13 }] }
    const steps = buildOverlayFilterSteps('in', 'out', frame, { blur, assPath: 'C:\\t\\s.ass', fontsDir: 'C:\\f' })
    expect(steps).toEqual([
      '[in]split=2[blurbg0][blurfg0]',
      '[blurfg0]crop=1024:94:128:576,gblur=sigma=14[blurbox0]',
      '[blurbg0][blurbox0]overlay=128:576[blurred0]',
      "[blurred0]ass=shaping=complex:filename='C\\:/t/s.ass':fontsdir='C\\:/f'[out]"
    ])
  })
  it('blur only, or nothing at all', () => {
    const blur = { enabled: true, strength: 7, regions: [{ id: 'r', x: 0, y: 0, w: 0.5, h: 0.5 }] }
    expect(buildOverlayFilterSteps('in', 'out', frame, { blur }).pop()).toBe('[blurbg0][blurbox0]overlay=0:0[out]')
    expect(buildOverlayFilterSteps('in', 'out', frame, { blur: { ...blur, enabled: false } })).toEqual([])
  })
})

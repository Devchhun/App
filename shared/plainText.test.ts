import { describe, expect, it } from 'vitest'
import { buildAssTexts, plainTextLook, PLAIN_TEXT_POSITION, type TextOverlay } from './plainText'

const text = (patch: Partial<TextOverlay> = {}): TextOverlay => ({
  start: 1,
  end: 4,
  text: 'សួស្តី',
  position: PLAIN_TEXT_POSITION,
  look: plainTextLook({}),
  fadeInSeconds: 0.4,
  fadeOutSeconds: 0.4,
  ...patch
})

const dialogue = (ass: string): string => ass.split('\n').find((l) => l.startsWith('Dialogue')) ?? ''

describe('plainTextLook', () => {
  it('is the words alone by default: white, outlined, shadowed, no box', () => {
    const look = plainTextLook({})
    expect(look).toMatchObject({ color: '#ffffff', background: false, shadow: true, align: 'center' })
    expect(look.strokeWidth).toBeGreaterThan(0)
  })
})

describe('buildAssTexts', () => {
  it('places a text in the middle of its box, sized for the frame, with its fade', () => {
    const line = dialogue(buildAssTexts([text()], { width: 1920, height: 1080 }))
    expect(line).toContain('0:00:01.00,0:00:04.00,Text')
    expect(line).toContain(String.raw`\an5\pos(960,540)`)
    expect(line).toContain(String.raw`\fad(400,400)`)
    expect(line).toContain(',192,192,0,,') // wraps inside the box (10%..90%)
  })

  it('scales with the frame height and uses the box style when a background is on', () => {
    const boxed = text({ look: { ...plainTextLook({}), background: true, backgroundColor: '#ff0000', backgroundOpacity: 50 } })
    const line = dialogue(buildAssTexts([boxed], { width: 1280, height: 720 }))
    expect(line).toContain(',Box,')
    expect(line).toContain(String.raw`\3c&H0000FF&`)
    expect(line).toContain(String.raw`\3a&H80&`)
    expect(line).toContain(String.raw`\pos(640,360)`)
  })

  it('aligns left and right to the box sides', () => {
    expect(buildAssTexts([text({ look: { ...plainTextLook({}), align: 'left' } })], { width: 1000, height: 1000 })).toContain(String.raw`\an4\pos(100,500)`)
    expect(buildAssTexts([text({ look: { ...plainTextLook({}), align: 'right' } })], { width: 1000, height: 1000 })).toContain(String.raw`\an6\pos(900,500)`)
  })
})

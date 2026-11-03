import { describe, expect, it } from 'vitest'
import { isTypingTarget, shortcutKey } from './shortcutKey'

describe('shortcutKey', () => {
  it('reads the key from its place on the keyboard, whatever layout types', () => {
    // Khmer layout: S types ស, Z types ឋ, the space bar a zero-width space.
    expect(shortcutKey({ code: 'KeyS', key: 'ស' })).toBe('s')
    expect(shortcutKey({ code: 'KeyZ', key: 'ឋ' })).toBe('z')
    expect(shortcutKey({ code: 'Space', key: '​' })).toBe(' ')
    expect(shortcutKey({ code: 'KeyA', key: 'A' })).toBe('a')
    expect(shortcutKey({ code: 'Equal', key: '+' })).toBe('=')
    expect(shortcutKey({ code: 'NumpadSubtract', key: '-' })).toBe('-')
    expect(shortcutKey({ code: 'Backslash', key: '\\' })).toBe('\\')
    expect(shortcutKey({ code: 'Digit1', key: '!' })).toBe('1')
  })

  it('leaves keys with names as they are', () => {
    expect(shortcutKey({ code: 'ArrowLeft', key: 'ArrowLeft' })).toBe('ArrowLeft')
    expect(shortcutKey({ code: 'Delete', key: 'Delete' })).toBe('Delete')
    expect(shortcutKey({ code: '', key: 'Escape' })).toBe('Escape')
  })

  it('knows a field being typed in', () => {
    expect(isTypingTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

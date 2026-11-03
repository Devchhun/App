/** The key a keyboard shortcut means, read from the key's place on the
 * keyboard (`code`) rather than the character it types (`key`): with the
 * Khmer layout on, S types ស, Z types ឋ and the space bar a zero-width
 * space -- and not one shortcut worked. Letters come back lower-case,
 * digits as digits, the space bar as ' ', = / - / \ as themselves; any
 * other key (arrows, Delete, Escape, Home...) as its own `key`. */
export function shortcutKey(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  const code = e.code ?? ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  switch (code) {
    case 'Space':
      return ' '
    case 'Equal':
    case 'NumpadAdd':
      return '='
    case 'Minus':
    case 'NumpadSubtract':
      return '-'
    case 'Backslash':
      return '\\'
  }
  return e.key.length === 1 ? e.key.toLowerCase() : e.key
}

/** Typing into a field: its own keys, never a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  const tag = el?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(el?.isContentEditable)
}

/** A window in front of the editor (Settings, a confirm box, Export, Cast,
 * Auto SRT...): the Timeline's keys wait -- Delete removed clips behind a
 * dialog, Space played behind it. */
export function isWindowOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('.modal-overlay, .cast-window, .auto-srt-panel, .kiri-clone-panel')
}

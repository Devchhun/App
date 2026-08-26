import type { KeyboardEvent } from 'react'
import { useHistory } from './HistoryContext'

/** Spread onto any continuously-editable control (text input, textarea,
 * number input) so keystroke-by-keystroke edits collapse into one history
 * entry on blur or Enter, instead of one entry per keystroke. */
export function useHistoryFieldProps(): {
  onFocus: () => void
  onBlur: () => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
} {
  const { beginTransaction, endTransaction } = useHistory()
  return {
    onFocus: () => beginTransaction(),
    onBlur: () => endTransaction(),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter') e.currentTarget.blur()
    }
  }
}

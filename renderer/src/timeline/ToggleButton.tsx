import type { ReactNode } from 'react'

interface Props {
  icon: ReactNode
  label: string
  /** Shown in the tooltip after the label, e.g. "(M)" -- purely informational,
   * does not register the shortcut itself (each shortcut is wired once in
   * its own hook, not per-button). */
  shortcut?: string
  active: boolean
  disabled?: boolean
  onClick: () => void
}

/** One generic toggle button for the Timeline toolbar's right-hand group
 * (Magnet/Ripple/Linkage/Snapping/Skimmer) -- avoids five near-identical
 * copy-pasted buttons. Active state uses the app's existing cyan/blue accent
 * (.timeline-tool-button-active, already used elsewhere for the disabled
 * "Selection tool" placeholder) so it reads consistently with the rest of
 * the toolbar. */
export function ToggleButton({ icon, label, shortcut, active, disabled, onClick }: Props): JSX.Element {
  const title = shortcut ? `${label} (${shortcut})` : label
  return (
    <button
      className={active ? 'timeline-tool-button timeline-tool-button-active' : 'timeline-tool-button'}
      title={title}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

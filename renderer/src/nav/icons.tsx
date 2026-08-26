// Small hand-rolled icon set (no icon library dependency) shared by the
// titlebar and icon rail. All icons share a 20x20 viewBox / stroke style.
type IconProps = { size?: number }

const base = { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export function PlusIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M10 4v12M4 10h12" />
    </svg>
  )
}

export function MediaIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M8 8.5l4.5 2.5L8 13.5v-5z" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function TranscriptIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M4 4h12M4 8h12M4 12h8M4 16h5" />
    </svg>
  )
}

export function SparkleIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M10 3l1.4 4.6L16 9l-4.6 1.4L10 15l-1.4-4.6L4 9l4.6-1.4L10 3z" />
    </svg>
  )
}

export function TemplatesIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <rect x="3" y="3" width="6" height="6" rx="1.2" />
      <rect x="11" y="3" width="6" height="6" rx="1.2" />
      <rect x="3" y="11" width="6" height="6" rx="1.2" />
      <rect x="11" y="11" width="6" height="6" rx="1.2" />
    </svg>
  )
}

export function SettingsIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4M15.1 15.1l-1.4-1.4M6.3 6.3L4.9 4.9" />
    </svg>
  )
}

export function HelpIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M7.8 7.8a2.2 2.2 0 1 1 3.1 2c-.7.5-1 .9-1 1.7" />
      <circle cx="10" cy="14" r="0.15" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function UndoIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M6 5L3 8l3 3M3 8h8a4.5 4.5 0 1 1 0 9h-1" />
    </svg>
  )
}

export function RedoIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M14 5l3 3-3 3M17 8H9a4.5 4.5 0 1 0 0 9h1" />
    </svg>
  )
}

export function ChatIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M3 4.5h14v9H8l-3.5 3v-3H3v-9z" />
    </svg>
  )
}

export function ExportIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M10 3v9M6.5 8L10 12l3.5-4M4 15h12v2H4z" />
    </svg>
  )
}

export function UpdateIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M4 8a6 6 0 0 1 10.5-3.9M16 4v4h-4" />
      <path d="M16 12a6 6 0 0 1-10.5 3.9M4 16v-4h4" />
    </svg>
  )
}

export function MinimizeIcon({ size = 12 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2 6h8" />
    </svg>
  )
}

export function MaximizeIcon({ size = 12 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="2.5" y="2.5" width="7" height="7" />
    </svg>
  )
}

export function CloseIcon({ size = 12 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
    </svg>
  )
}

// Preview transport controls

export function PlayIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path d="M6 4.5l10 5.5-10 5.5v-11z" />
    </svg>
  )
}

export function PauseIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <rect x="5" y="4.5" width="3.5" height="11" rx="1" />
      <rect x="11.5" y="4.5" width="3.5" height="11" rx="1" />
    </svg>
  )
}

export function SkipStartIcon({ size = 14 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <rect x="4" y="4" width="2" height="12" />
      <path d="M16 4.5v11l-9-5.5 9-5.5z" />
    </svg>
  )
}

export function SkipEndIcon({ size = 14 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <rect x="14" y="4" width="2" height="12" />
      <path d="M4 4.5v11l9-5.5-9-5.5z" />
    </svg>
  )
}

export function StepBackIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path d="M14 4.5v11l-9-5.5 9-5.5z" />
    </svg>
  )
}

export function StepForwardIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path d="M6 4.5v11l9-5.5-9-5.5z" />
    </svg>
  )
}

export function CameraIcon({ size = 14 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M3 6.5h2.5L7 4.5h6L14.5 6.5H17v9H3v-9z" />
      <circle cx="10" cy="11" r="2.6" />
    </svg>
  )
}

export function VolumeIcon({ size = 14, muted = false }: IconProps & { muted?: boolean }): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M3 8v4h3l4 3V5L6 8H3z" fill="currentColor" stroke="none" />
      {muted ? <path d="M13 7.5l4 5M17 7.5l-4 5" /> : <path d="M13.5 6.5a5 5 0 0 1 0 7M15.7 4.3a8 8 0 0 1 0 11.4" />}
    </svg>
  )
}

export function FullscreenIcon({ size = 14 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4" />
    </svg>
  )
}

// Timeline toolbar

export function SelectionArrowIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <path d="M4 3l11 7-4.8 1.1L13 16l-2.3 1L8.2 12 5 14.5z" />
    </svg>
  )
}

export function ScissorsIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <circle cx="5.5" cy="5.5" r="2.2" />
      <circle cx="5.5" cy="14.5" r="2.2" />
      <path d="M7.2 6.8L17 15M7.2 13.2L17 5" />
    </svg>
  )
}

export function TrashIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M4 6h12M8 6V4.5h4V6M6 6l.7 10a1 1 0 0 0 1 1h4.6a1 1 0 0 0 1-1L14 6" />
    </svg>
  )
}

export function TextToolIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M5 5h10M10 5v10" />
    </svg>
  )
}

export function ZoomOutGlyphIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="M17 17l-4-4M6 8.5h5" />
    </svg>
  )
}

// Media panel

export function FilterIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M3 4h14l-5.5 6.5V16l-3 1.5v-7L3 4z" />
    </svg>
  )
}

export function GridViewIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="11" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="11" width="6" height="6" rx="1" />
      <rect x="11" y="11" width="6" height="6" rx="1" />
    </svg>
  )
}

export function ListViewIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <rect x="3" y="4" width="4" height="4" rx="0.8" />
      <rect x="3" y="12" width="4" height="4" rx="0.8" />
      <path d="M9.5 6h7.5M9.5 14h7.5" />
    </svg>
  )
}

export function ShieldCheckIcon({ size = 12 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M10 2.5l6 2.2v4.6c0 4-2.6 6.9-6 8.2-3.4-1.3-6-4.2-6-8.2V4.7l6-2.2z" />
      <path d="M7.2 10l1.9 1.9L13 7.8" />
    </svg>
  )
}

export function ChipIcon({ size = 12 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <rect x="6" y="6" width="8" height="8" rx="1.2" />
      <path d="M8 2.5v3M12 2.5v3M8 14.5v3M12 14.5v3M2.5 8h3M2.5 12h3M14.5 8h3M14.5 12h3" />
    </svg>
  )
}

// Preview panel

export function MenuDotsIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <circle cx="10" cy="4.5" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="10" cy="15.5" r="1.5" />
    </svg>
  )
}

// Timeline track headers (moved here from TimelineTrackHeaders.tsx so the
// new clip/gap context menus and clip lock badge can share the exact same
// glyphs instead of redrawing them).

export function EyeIcon({ open = true, size = 13 }: IconProps & { open?: boolean }): JSX.Element {
  return open ? (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" />
      <circle cx="10" cy="10" r="2.4" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d="M3 3l14 14M2 10s3-5.5 8-5.5c1.6 0 3 .4 4.1 1M18 10s-1.2 2.2-3.4 3.7M7.6 7.6a2.4 2.4 0 0 0 3.3 3.3" />
    </svg>
  )
}

export function LockIcon({ locked = true, size = 13 }: IconProps & { locked?: boolean }): JSX.Element {
  return locked ? (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <rect x="5" y="9" width="10" height="7" rx="1.4" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <rect x="5" y="9" width="10" height="7" rx="1.4" />
      <path d="M7 9V6.5a3 3 0 0 1 5.7-1.3" />
    </svg>
  )
}

/** One small glyph per TimelineTrackKind, shown as the leading icon in each
 * track header row (see TimelineTrackHeaders.tsx) -- previously there was no
 * per-kind icon at all, just the text label, making it hard to tell a
 * track's kind at a glance in a narrow header column. */
export function VideoTrackIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <rect x="2.5" y="4.5" width="15" height="11" rx="1.6" />
      <path d="M7.8 8v4l3.4-2z" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function AudioTrackIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M3 11v-2M6.3 13.5v-7M9.6 15v-10M12.9 13.5v-7M16.2 11v-2" />
    </svg>
  )
}

export function GraphicTrackIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="1.6" />
      <path d="M6 13l3-4 2.4 2.8L13.5 8l3.5 5" />
      <circle cx="6.3" cy="7" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function TextTrackIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M4 5h12M10 5v10" />
    </svg>
  )
}

export function CaptionTrackIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <rect x="2.5" y="5" width="15" height="10" rx="1.6" />
      <path d="M5.5 9.2h3M5.5 11.6h5.5M11.5 9.2h3" strokeLinecap="round" />
    </svg>
  )
}

// CapCut-style Timeline toolbar (left/right groups -- see TimelineToolbar.tsx)

export function TrimIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M5 3v14M15 3v14" />
      <path d="M5 7h4M11 7h4" strokeDasharray="0" />
      <path d="M5 13h4M11 13h4" />
    </svg>
  )
}

export function MagnetIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M6 3v7a4 4 0 0 0 8 0V3" />
      <path d="M6 3H3v7M14 3h3v7" />
      <path d="M3 7h3M14 7h3" />
    </svg>
  )
}

export function RippleIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M3 6.5a3.5 3.5 0 0 1 7 0v7a3.5 3.5 0 0 0 7 0" />
      <path d="M13 10l3.5 3.5L13 17" />
    </svg>
  )
}

export function LinkIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M8.5 11.5l3-3" />
      <path d="M9 6l1.2-1.2a3 3 0 0 1 4.2 4.2L13 10" />
      <path d="M11 14l-1.2 1.2a3 3 0 0 1-4.2-4.2L7 9.8" />
    </svg>
  )
}

export function UnlinkIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M9 6l1.2-1.2a3 3 0 0 1 4.2 4.2L13 10" />
      <path d="M11 14l-1.2 1.2a3 3 0 0 1-4.2-4.2L7 9.8" />
      <path d="M3 3l14 14" />
    </svg>
  )
}

export function ZoomInGlyphIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="M8.5 6v5M6 8.5h5" />
      <path d="M13 13l4 4" />
    </svg>
  )
}

export function ZoomToFitIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4" />
    </svg>
  )
}

export function MarqueeIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <rect x="3" y="3" width="14" height="14" rx="1.5" strokeDasharray="3 2.5" />
    </svg>
  )
}

export function MicrophoneIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7 17.5h6" />
    </svg>
  )
}

export function RecordDotIcon({ size = 12 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
      <circle cx="10" cy="10" r="7" />
    </svg>
  )
}

export function ChevronDownIcon({ size = 10 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M4.5 7l5.5 6 5.5-6" />
    </svg>
  )
}

export function HandToolIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M7 11V4.5a1.2 1.2 0 0 1 2.4 0V10M9.4 10V3.6a1.2 1.2 0 0 1 2.4 0V10M11.8 10V4.6a1.2 1.2 0 0 1 2.4 0V11M14.2 11v-2a1.2 1.2 0 0 1 2.4 0v4.5c0 2.8-2 5-4.8 5h-1.6c-1.8 0-2.8-.6-3.8-2l-2.2-3.2c-.5-.7-.3-1.5.3-1.9.6-.4 1.4-.2 1.9.4L7 13" />
    </svg>
  )
}

export function RangeToolIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M5 4v12M15 4v12" />
      <path d="M5 10h10" strokeDasharray="2.2 2.2" />
    </svg>
  )
}

export function RollEditIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M10 3v14" />
      <path d="M5 7l-2.5 3L5 13M15 7l2.5 3L15 13" />
    </svg>
  )
}

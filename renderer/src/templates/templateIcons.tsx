// Locally-bundled, license-clean SVG icon set backing the Icon Registry and
// Picker (Properties > Design > Icon). The id type and category mapping live
// in shared/templates.ts (so the Scene data model can reference them without
// the shared package importing from renderer); this file owns the actual
// hand-drawn SVG components and the searchable-picker helpers.
import type { TemplateIconId } from '@shared/templates'
import { TEMPLATE_ICON_IDS, TEMPLATE_ICON_CATEGORY_LABELS, TEMPLATE_ICON_CATEGORY } from '@shared/templates'

export type { TemplateIconId }
export { TEMPLATE_ICON_IDS, TEMPLATE_ICON_CATEGORY_LABELS, TEMPLATE_ICON_CATEGORY }

type IconProps = { size?: number; color?: string }

const base = { viewBox: '0 0 20 20', fill: 'none' as const, strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const TEMPLATE_ICON_LABELS: Record<TemplateIconId, string> = {
  warning: 'Warning',
  security: 'Security',
  bank: 'Bank',
  money: 'Money',
  device: 'Device',
  location: 'Location',
  person: 'Person',
  statistics: 'Statistics',
  check: 'Check',
  question: 'Question',
  arrow: 'Arrow',
  social: 'Social',
  message: 'Message',
  calendar: 'Calendar',
  briefcase: 'Briefcase',
  chip: 'Processor'
}

function Warning({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <path d="M10 3l8 14H2z" />
      <path d="M10 8.5v3.5" />
      <circle cx="10" cy="14.5" r="0.2" fill={color} />
    </svg>
  )
}

function Security({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <path d="M10 2.5l6 2.2v4.6c0 4-2.6 6.9-6 8.2-3.4-1.3-6-4.2-6-8.2V4.7l6-2.2z" />
      <path d="M7.2 10l1.9 1.9L13 7.8" />
    </svg>
  )
}

function Bank({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <path d="M3 8l7-4.5L17 8M4 8h12v7H4zM4 15h12M7 8v7M13 8v7" />
    </svg>
  )
}

function Money({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <rect x="2.5" y="5.5" width="15" height="9" rx="1.5" />
      <circle cx="10" cy="10" r="2.2" />
      <path d="M5 8v0M15 12v0" />
    </svg>
  )
}

function Device({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <rect x="4" y="2.5" width="12" height="15" rx="1.5" />
      <path d="M8.5 15.2h3" />
    </svg>
  )
}

function Location({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <path d="M10 18s6-5.5 6-10a6 6 0 1 0-12 0c0 4.5 6 10 6 10z" />
      <circle cx="10" cy="8" r="2.2" />
    </svg>
  )
}

function Person({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <circle cx="10" cy="6.5" r="3.2" />
      <path d="M3.5 17c1.2-3.6 4-5.5 6.5-5.5s5.3 1.9 6.5 5.5" />
    </svg>
  )
}

function Statistics({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <path d="M3 17V9M9 17V4M15 17v-6" />
      <path d="M2.5 17.5h15" />
    </svg>
  )
}

function Check({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M6.8 10.2l2.2 2.2 4.2-4.6" />
    </svg>
  )
}

function Question({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M7.8 7.8a2.2 2.2 0 1 1 3.1 2c-.7.5-1 .9-1 1.7" />
      <circle cx="10" cy="14" r="0.15" fill={color} />
    </svg>
  )
}

function Arrow({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <path d="M4 10h12M11 5.5L16.5 10 11 14.5" />
    </svg>
  )
}

function Social({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <circle cx="5" cy="10" r="2.2" />
      <circle cx="15" cy="5" r="2.2" />
      <circle cx="15" cy="15" r="2.2" />
      <path d="M6.9 8.9L13.1 6M6.9 11.1L13.1 14" />
    </svg>
  )
}

function Message({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <path d="M3 5.5h14v9H8l-3.5 3v-3H3z" />
      <path d="M6.5 9h7M6.5 12h4.5" />
    </svg>
  )
}

function Calendar({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <rect x="3" y="4.5" width="14" height="12.5" rx="1.5" />
      <path d="M3 8.5h14M6.5 2.5v4M13.5 2.5v4" />
      <circle cx="7" cy="12" r="0.2" fill={color} />
      <circle cx="10" cy="12" r="0.2" fill={color} />
      <circle cx="13" cy="12" r="0.2" fill={color} />
    </svg>
  )
}

function Briefcase({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <rect x="2.5" y="6.5" width="15" height="9.5" rx="1.5" />
      <path d="M7 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h3.4A1.3 1.3 0 0 1 13 4.8v1.7" />
      <path d="M2.5 10.5h15" />
    </svg>
  )
}

function Chip({ size = 16, color = 'currentColor' }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} {...base} stroke={color}>
      <rect x="6" y="6" width="8" height="8" rx="1" />
      <path d="M8.5 6V3M11.5 6V3M8.5 17v-3M11.5 17v-3M6 8.5H3M6 11.5H3M17 8.5h-3M17 11.5h-3" />
    </svg>
  )
}

const TEMPLATE_ICON_COMPONENTS: Record<TemplateIconId, (props: IconProps) => JSX.Element> = {
  warning: Warning,
  security: Security,
  bank: Bank,
  money: Money,
  device: Device,
  location: Location,
  person: Person,
  statistics: Statistics,
  check: Check,
  question: Question,
  arrow: Arrow,
  social: Social,
  message: Message,
  calendar: Calendar,
  briefcase: Briefcase,
  chip: Chip
}

export function TemplateIcon({ id, size, color }: { id: TemplateIconId } & IconProps): JSX.Element {
  const Component = TEMPLATE_ICON_COMPONENTS[id]
  return <Component size={size} color={color} />
}

/** Validates a possibly-stale/foreign icon id (from an older project file or
 * hand-edited JSON) against the current registry. Returns null instead of
 * throwing so the renderer can fall back safely (skip the icon) rather than crash. */
export function resolveTemplateIconId(id: string | undefined | null): TemplateIconId | null {
  if (!id) return null
  return (TEMPLATE_ICON_IDS as string[]).includes(id) ? (id as TemplateIconId) : null
}

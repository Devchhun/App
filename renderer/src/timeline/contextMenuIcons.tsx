import type { ReactNode } from 'react'

/** A glyph for every Timeline context-menu entry, chosen by the entry's
 * label so the menus themselves (Timeline.tsx builds several) need no
 * per-item icon plumbing. Labels are matched by prefix, which covers the
 * numbered "Move to Video 3" / "Link Selected (2 clips)" forms. */

const base = { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

function glyph(path: string): ReactNode {
  return (
    <svg width={15} height={15} {...base} aria-hidden>
      <path d={path} />
    </svg>
  )
}

const ICONS: Array<[string, string]> = [
  ['Cut', 'M6.5 4.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8.2 7.6 16 3.5M8.2 12.4 16 16.5M8.2 7.6l4.3 2.4M8.2 12.4l4.3-2.4'],
  ['Copy', 'M7 7h9v9H7zM4 13V4h9'],
  ['Paste', 'M7 4h6v2H7zM5 5h10v11H5zM8 9h4M8 12h4'],
  ['Duplicate', 'M4 4h9v9H4zM7 16h9V7'],
  ['Split at Playhead', 'M10 3v14M5 7l5 3-5 3M15 7l-5 3 5 3'],
  ['Trim Start', 'M4 4v12M4 10h11M11 6l4 4-4 4'],
  ['Trim End', 'M16 4v12M16 10H5M9 6l-4 4 4 4'],
  ['Ripple Trim', 'M4 4v12M4 10h6M8 7l3 3-3 3M13 6h3M13 10h3M13 14h3'],
  ['Ripple Delete', 'M4 10h5M12 10h4M7 5l3 5-3 5M13 5l-3 5 3 5'],
  ['Delete Keyframe', 'M10 3l7 7-7 7-7-7zM7 10h6'],
  ['Delete', 'M4 6h12M8 6V4.5h4V6M6 6l.7 10a1 1 0 0 0 1 1h4.6a1 1 0 0 0 1-1L14 6'],
  ['Disable', 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM5 5l10 10'],
  ['Enable', 'M4 10l4 4 8-8'],
  ['Link Selected', 'M8 12a3 3 0 0 1 0-4l2-2a3 3 0 0 1 4 4l-1 1M12 8a3 3 0 0 1 0 4l-2 2a3 3 0 0 1-4-4l1-1'],
  ['Unlink', 'M8 12a3 3 0 0 1 0-4l1-1M12 8a3 3 0 0 1 0 4l-1 1M4 4l12 12'],
  ['Relink Original Audio', 'M3 10c3-4 6-4 9 0s6 4 5 0M14 3l3 3-3 3'],
  ['Extract to Audio', 'M4 13V7l5 1v5zM12 8a3 3 0 0 1 0 4M14 6a6 6 0 0 1 0 8'],
  ['Remove Background', 'M4 4h12v12H4zM7 13l3-4 2 2.5 1.5-1.5L16 13M4 4l12 12'],
  ['Removing Background', 'M4 4h12v12H4zM7 13l3-4 2 2.5 1.5-1.5L16 13'],
  ['Remove Vocal', 'M10 3a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 9a5 5 0 0 0 10 0M10 14v3M4 4l12 12'],
  ['Group', 'M3 7h6v6H3zM11 7h6v6h-6z'],
  ['Replace Media', 'M4 10a6 6 0 0 1 10-4.5M16 10a6 6 0 0 1-10 4.5M14 3v3h-3M6 17v-3h3'],
  ['Reset Attributes', 'M4 10a6 6 0 1 1 2 4.5M4 6v4h4'],
  ['Speed', 'M3 12a7 7 0 0 1 14 0M10 12l3-4M10 12a1 1 0 1 0 0 .1'],
  ['Freeze Frame', 'M10 3v14M4 6.5l12 7M4 13.5l12-7M8 4l2 2 2-2M8 16l2-2 2 2'],
  ['Move to', 'M10 3v14M6 7l4-4 4 4M6 13l4 4 4-4'],
  ['Bring Forward', 'M10 16V5M5 10l5-5 5 5'],
  ['Send Backward', 'M10 4v11M5 10l5 5 5-5'],
  ['Reveal in Media', 'M3 5h5l2 2h7v8H3zM10 9v4M8 11h4'],
  ['Properties', 'M4 6h12M4 10h12M4 14h12M7 6v0M7 10v0M7 14v0'],
  ['Add Subtitle', 'M3 5h14v10H3zM6 9h4M6 12h7M14 7v4M12 9h4'],
  ['Edit Subtitle', 'M3 5h14v10H3zM6 12h3M11 13l4-4 1.5 1.5-4 4H11z'],
  ['Generate with', 'M4 12V8M7 15V5M10 13V7M13 11l4-2v6l-4-2z'],
  ['Add Marker', 'M5 3h10l-2 3 2 3H5zM5 3v14'],
  ['Set In Point', 'M5 4v12M5 10h10M11 6l4 4-4 4'],
  ['Set Out Point', 'M15 4v12M15 10H5M9 6l-4 4 4 4'],
  ['Clear In', 'M5 4v12M15 4v12M5 10h10M4 4l12 12'],
  ['Fit Timeline', 'M3 10h14M6 7l-3 3 3 3M14 7l3 3-3 3'],
  ['Add Video Track', 'M3 6h14v9H3zM7 6v9M13 6v9M10 2v2'],
  ['Add Audio Track', 'M4 12V8M7 15V5M10 13V7M13 15V5M16 12V8'],
  ['Select All', 'M4 4h12v12H4zM7 10l2 2 4-4'],
  ['Remove Gap', 'M4 10h4M12 10h4M8 7l-3 3 3 3M12 7l3 3-3 3'],
  ['Remove All Gaps', 'M3 10h3M8 10h4M14 10h3M6 7l-3 3 3 3M14 7l3 3-3 3']
]

export function iconForMenuLabel(label: string): ReactNode {
  const hit = ICONS.find(([prefix]) => label.startsWith(prefix))
  return hit ? glyph(hit[1]) : null
}

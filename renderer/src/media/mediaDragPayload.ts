// Custom drag-payload shape for dragging one or more Media assets from the
// Media panel onto the Timeline (see MediaListItem.tsx's onDragStart and
// Timeline.tsx's onDrop). A dedicated MIME type rather than reusing the OS
// file-drop path (ImportPanel.tsx's handleDrop) -- this is an in-app drag of
// already-known mediaIds, not raw filesystem paths.
export const MEDIA_DRAG_MIME_TYPE = 'application/x-timeline-media'

export interface MediaDragPayload {
  mediaIds: string[]
}

// `dataTransfer.getData()` is only readable on the `drop` event itself, not
// during `dragover` -- a standard HTML5 DnD restriction (security-motivated
// for cross-origin drags, but this drag never leaves the same renderer
// process). The live ghost-preview needs the dragged ids on every dragover
// tick, so onDragStart also stashes them here as plain in-memory state,
// read imperatively (not via React state/context, since nothing needs to
// re-render when a drag merely starts -- only the drop target's dragover
// handler reads this, on demand).
let currentDragMediaIds: string[] | null = null

export function setCurrentDragMediaIds(ids: string[] | null): void {
  currentDragMediaIds = ids
}

export function getCurrentDragMediaIds(): string[] | null {
  return currentDragMediaIds
}

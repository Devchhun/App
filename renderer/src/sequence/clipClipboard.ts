// In-memory Cut/Copy/Paste (spec section 15) -- module-scope state, same
// lightweight pattern as renderer/src/media/mediaDragPayload.ts's drag
// side-channel. No OS-clipboard integration exists anywhere in this app;
// clipboard CONTENTS don't need to be undoable/persisted themselves, only
// the PASTE action does (via the normal auto-recorded sequence mutation),
// so plain module state is enough -- no new context/provider needed.
import type { ProjectSequence, TimelineClip } from '@shared/project'
import { computeSequenceDuration } from '@shared/project'

export interface ClipboardEntry {
  clips: TimelineClip[]
}

type IdFactory = () => string
const defaultMakeId: IdFactory = () => crypto.randomUUID()

let clipboard: ClipboardEntry | null = null

/** Snapshots the given clips (decoupled from live state -- later edits to
 * the originals never change what's in the clipboard). */
export function copyToClipboard(clips: TimelineClip[]): void {
  clipboard = { clips: clips.map((c) => ({ ...c })) }
}

export function getClipboard(): ClipboardEntry | null {
  return clipboard
}

export function clearClipboard(): void {
  clipboard = null
}

/** Pastes the clipboard's clips at `atTime` on `trackId`, preserving their
 * relative time offsets from each other (anchored to the earliest copied
 * clip's original startTime). A copied clip that was on a DIFFERENT track
 * than the earliest one (e.g. a linked audio partner on A1) keeps its OWN
 * original track rather than being remapped onto `trackId` -- there's no
 * generically-correct "equivalent track" to remap an arbitrary second track
 * to. A linked pair keeps its link to each other's paste-copy only if both
 * sides were copied together (mirrors sequenceOps.duplicateClips' existing
 * rule); pasted clips never inherit a stale groupId or lock. Returns the
 * unchanged sequence and an empty id list when the clipboard is empty. */
export function pasteClipsAt(sequence: ProjectSequence, atTime: number, trackId: string, makeId: IdFactory = defaultMakeId): { sequence: ProjectSequence; newClipIds: string[] } {
  const entry = getClipboard()
  if (!entry || entry.clips.length === 0) return { sequence, newClipIds: [] }

  const minStart = Math.min(...entry.clips.map((c) => c.startTime))
  const anchorTrackId = entry.clips[0].trackId
  const idMap = new Map<string, string>()
  for (const c of entry.clips) idMap.set(c.id, makeId())

  const pasted: TimelineClip[] = entry.clips.map((c) => ({
    ...c,
    id: idMap.get(c.id)!,
    startTime: Math.max(0, atTime + (c.startTime - minStart)),
    trackId: c.trackId === anchorTrackId ? trackId : c.trackId,
    locked: false,
    groupId: undefined,
    linkedClipId: c.linkedClipId && idMap.has(c.linkedClipId) ? idMap.get(c.linkedClipId) : undefined
  }))

  const clips = [...sequence.clips, ...pasted]
  return { sequence: { ...sequence, clips, duration: computeSequenceDuration(clips) }, newClipIds: pasted.map((c) => c.id) }
}

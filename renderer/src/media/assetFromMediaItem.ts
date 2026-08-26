import type { MediaItem } from '@shared/media'
import type { InsertableAsset } from '../sequence/sequenceOps'

/** Converts a live MediaItem into the shape sequenceOps.insertClip needs.
 * Shared by ImportPanel.tsx's "+Add to Timeline" button and Timeline.tsx's
 * drag-and-drop-from-Media-panel handler -- one conversion, not two. */
export function assetFromMediaItem(item: MediaItem): InsertableAsset {
  return {
    mediaId: item.id,
    type: item.assetType ?? (item.kind === 'audio' ? 'audio' : 'video'),
    sourceDurationSeconds: item.metadata?.durationSeconds ?? 0,
    hasAudio: item.metadata?.hasAudio
  }
}

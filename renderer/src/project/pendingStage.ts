import type { MediaProcessingStage } from '@shared/media'
import type { MediaSource } from '@shared/project'

/** Normalizes a live MediaItem.stage into MediaSource.pendingStage's
 * narrower vocabulary. Resuming on reopen always re-runs the full pipeline
 * from the top (cache-skipping whatever's already on disk), so the exact
 * value here is mostly informational (what to show before the resumed
 * pipeline's first progress event arrives) rather than a precise resume
 * point -- 'validating'/'probing'/'queued' all collapse to 'thumbnail',
 * the first stage that could still have real work left. */
export function pendingStageFor(stage: MediaProcessingStage): MediaSource['pendingStage'] {
  switch (stage) {
    case 'ready':
      return undefined
    case 'error':
    case 'canceled':
    case 'waveform':
    case 'proxy':
      return stage
    default:
      return 'thumbnail'
  }
}

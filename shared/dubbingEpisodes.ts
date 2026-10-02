// AI Dubber series mode: several episodes (one video each) transcribed
// together, then dubbed one at a time. The open episode is the ordinary live
// workspace plus the project Timeline; the others wait in
// DubbingWorkspaceState.episodes with their own subtitle setup and Timeline,
// and are swapped in when opened. Pure helpers only -- the swapping itself is
// AiDubberContext's.

import type { DubbingEpisode, DubbingEpisodeWorkspace, DubbingWorkspaceState } from './dubbing'

/** "EP2.mp4" before "EP10.mp4" -- the order a person numbers episodes in. */
export function compareEpisodeNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/** Adds videos not in the list yet as waiting episodes; the list stays in
 * file-name order. Returns the same array when nothing was new. */
export function withEpisodesAdded(episodes: DubbingEpisode[], videos: { mediaId: string; fileName: string }[]): DubbingEpisode[] {
  const known = new Set(episodes.map((episode) => episode.mediaId))
  const added = videos.filter((video) => !known.has(video.mediaId) && (known.add(video.mediaId), true))
  if (added.length === 0) return episodes
  return [...episodes, ...added.map((video): DubbingEpisode => ({ mediaId: video.mediaId, fileName: video.fileName, status: 'waiting' }))].sort((a, b) =>
    compareEpisodeNames(a.fileName, b.fileName)
  )
}

/** The per-episode part of the live workspace. */
export function episodeWorkspaceOf(state: DubbingWorkspaceState): DubbingEpisodeWorkspace {
  return {
    srtFileName: state.srtFileName,
    generatedSrtPath: state.generatedSrtPath,
    genderDetectionStatus: state.genderDetectionStatus === 'detecting' ? 'idle' : state.genderDetectionStatus,
    segments: state.segments,
    speakers: state.speakers
  }
}

/** The live workspace with `mediaId` open: series-wide settings (Custom
 * Voice reference, the episode list) stay, everything per episode comes from
 * `workspace` -- or starts empty for an episode with no subtitles yet. */
export function withEpisodeOpen(state: DubbingWorkspaceState, mediaId: string, workspace: DubbingEpisodeWorkspace | undefined): DubbingWorkspaceState {
  return {
    ...state,
    active: true,
    videoMediaId: mediaId,
    srtFileName: workspace?.srtFileName,
    generatedSrtPath: workspace?.generatedSrtPath,
    genderDetectionStatus: workspace?.genderDetectionStatus ?? 'idle',
    segments: workspace?.segments ?? {},
    speakers: workspace?.speakers ?? {},
    generationProgress: undefined,
    generationError: undefined,
    generationNote: undefined
  }
}

/** `video.mp4` -> `video.srt`, for saving every episode's subtitles. */
export function episodeSrtFileName(videoFileName: string): string {
  const base = videoFileName.replace(/\.[^./\\]+$/, '')
  return `${base || 'episode'}.srt`
}

/** Episodes Auto SRT still has to do, in order. */
export function episodesToTranscribe(episodes: DubbingEpisode[]): string[] {
  return episodes.filter((episode) => episode.status === 'waiting' || episode.status === 'failed').map((episode) => episode.mediaId)
}

/** Two failures in a row with the same reason (no key, no credits, offline)
 * would fail every remaining episode the same way -- stop instead. */
export function isSeriesWideFailure(previousError: string | undefined, error: string): boolean {
  return !!previousError && previousError === error
}

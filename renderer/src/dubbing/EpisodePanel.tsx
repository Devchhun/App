import { useState } from 'react'
import { useTranscript } from '../transcript/TranscriptContext'
import { useAiDubber } from './AiDubberContext'
import type { DubbingEpisode } from '@shared/dubbing'

/** AI Dubber series mode: every episode, its Auto SRT status, and the one
 * open for dubbing (see shared/dubbingEpisodes.ts). Shown on the Add Video
 * screen once two or more videos are added, and folded into the subtitle
 * editor's header (EpisodeBar) while an episode is open. */
export function EpisodeList(): JSX.Element | null {
  const aiDubber = useAiDubber()
  const { transcripts } = useTranscript()
  const { episodes, episodeJob, episodeMessage } = aiDubber
  if (episodes.length === 0) return null
  const withSubtitles = episodes.filter((e) => e.status === 'done').length
  const toTranscribe = episodes.filter((e) => e.status === 'waiting' || e.status === 'failed').length
  const openId = aiDubber.state.videoMediaId

  const statusText = (episode: DubbingEpisode): string => {
    if (episode.status === 'transcribing') return episodeJob?.mediaId === episode.mediaId ? `${Math.round(episodeJob.percent)}%` : '…'
    if (episode.status === 'done') {
      const lines = transcripts[episode.mediaId]?.segments.length ?? 0
      return `${lines} line${lines === 1 ? '' : 's'}`
    }
    return episode.status === 'failed' ? 'Failed' : 'Waiting'
  }

  return (
    <div className="ai-dubber-episodes">
      <div className="ai-dubber-episodes-head">
        <strong>Episodes</strong>
        <span className="ai-dubber-count-badge">
          {withSubtitles}/{episodes.length} SRT
        </span>
        <div className="ai-dubber-episodes-actions">
          {episodeJob ? (
            <button className="ai-dubber-remove-srt-button" onClick={aiDubber.cancelEpisodeTranscription}>
              Stop
            </button>
          ) : (
            <button
              className="ai-dubber-episodes-primary"
              disabled={toTranscribe === 0}
              title="Gemini Auto SRT (speaker detection) for every episode that has no subtitles yet, one after another"
              onClick={() => void aiDubber.transcribeEpisodes()}
            >
              ✦ Auto SRT all{toTranscribe > 0 ? ` (${toTranscribe})` : ''}
            </button>
          )}
          <button className="ai-dubber-remove-srt-button" disabled={withSubtitles === 0} title="Save every episode's SRT into a folder (one file per video)" onClick={() => void aiDubber.saveEpisodeSrts()}>
            Save SRTs
          </button>
          <button className="ai-dubber-remove-srt-button" title="Add more episode videos" onClick={() => void aiDubber.importVideos()}>
            + Add
          </button>
        </div>
      </div>

      {episodeJob && (
        <div className="ai-dubber-episodes-progress">
          <span>
            {episodes.findIndex((e) => e.mediaId === episodeJob.mediaId) + 1}/{episodes.length} · {episodeJob.message}
          </span>
          <span className="ai-dubber-speaker-progress-track">
            <span style={{ width: `${episodeJob.percent}%` }} />
          </span>
        </div>
      )}
      {episodeMessage && (
        <div className="ai-dubber-analysis-message">
          <span>{episodeMessage}</span>
          <button aria-label="Dismiss" onClick={aiDubber.dismissEpisodeMessage}>
            ×
          </button>
        </div>
      )}
      {aiDubber.episodeSwitchBlocked && <small className="ai-dubber-episodes-hint">Generating — other episodes open once it finishes.</small>}

      <ol className="ai-dubber-episode-list">
        {episodes.map((episode, index) => {
          const isOpen = episode.mediaId === openId
          return (
            <li key={episode.mediaId} className={isOpen ? 'ai-dubber-episode ai-dubber-episode-open' : 'ai-dubber-episode'}>
              <span className="ai-dubber-episode-index">{index + 1}</span>
              <span className="ai-dubber-episode-name" title={episode.fileName}>
                {episode.fileName}
              </span>
              <span className={`ai-dubber-episode-status ai-dubber-episode-status-${episode.status}`} title={episode.error}>
                {statusText(episode)}
              </span>
              <button className="ai-dubber-remove-srt-button" disabled={isOpen || aiDubber.episodeSwitchBlocked} onClick={() => aiDubber.openEpisode(episode.mediaId)}>
                {isOpen ? 'Open' : 'Dub'}
              </button>
              {!isOpen && episode.mediaId !== aiDubber.state.timelineEpisodeId && episode.status !== 'transcribing' && (
                <button className="ai-dubber-episode-remove" aria-label={`Remove ${episode.fileName} from the episodes`} title="Remove from the episodes" onClick={() => aiDubber.removeEpisode(episode.mediaId)}>
                  ×
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** Compact episode switcher for the subtitle editor's header: previous /
 * pick / next, and the full list one click away. */
export function EpisodeBar(): JSX.Element | null {
  const aiDubber = useAiDubber()
  const { episodes, episodeJob } = aiDubber
  // Open while there is Auto SRT left to do, so its button is in sight.
  const [expanded, setExpanded] = useState(() => episodes.some((e) => e.status !== 'done'))
  if (episodes.length < 2) return null
  const openIndex = episodes.findIndex((e) => e.mediaId === aiDubber.state.videoMediaId)
  const blocked = aiDubber.episodeSwitchBlocked
  const go = (index: number): void => {
    const target = episodes[index]
    if (target) aiDubber.openEpisode(target.mediaId)
  }
  return (
    <>
      <div className="ai-dubber-episode-bar">
        <button className="ai-dubber-remove-srt-button" aria-label="Previous episode" disabled={blocked || openIndex <= 0} onClick={() => go(openIndex - 1)}>
          ‹
        </button>
        <select className="ai-dubber-episode-select" value={aiDubber.state.videoMediaId ?? ''} disabled={blocked} onChange={(e) => aiDubber.openEpisode(e.target.value)}>
          {episodes.map((episode, index) => (
            <option key={episode.mediaId} value={episode.mediaId}>
              {`${index + 1}. ${episode.fileName}${episode.status === 'done' ? '' : episode.status === 'failed' ? ' (failed)' : ' (no SRT yet)'}`}
            </option>
          ))}
        </select>
        <button className="ai-dubber-remove-srt-button" aria-label="Next episode" disabled={blocked || openIndex < 0 || openIndex >= episodes.length - 1} onClick={() => go(openIndex + 1)}>
          ›
        </button>
        <button className={`ai-dubber-remove-srt-button${expanded ? ' ai-dubber-episode-bar-toggle-on' : ''}`} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {episodeJob ? `Auto SRT ${Math.round(episodeJob.percent)}%` : `Episodes ${openIndex + 1}/${episodes.length}`}
        </button>
      </div>
      {expanded && <EpisodeList />}
    </>
  )
}

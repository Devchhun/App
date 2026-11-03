import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAiDubber } from './AiDubberContext'
import { useConfirm } from '../ui/ConfirmDialog'
import { AUTO_SRT_AT_ONCE_CHOICES, loadAutoSrtAtOnce, saveAutoSrtAtOnce } from './autoSrtAtOnce'
import type { AutoSrtTextSource } from '@shared/transcription'

const TEXT_SOURCES: { id: AutoSrtTextSource; label: string; title: string }[] = [
  { id: 'auto', label: 'Auto', title: 'Reads the subtitles drawn into the picture when the video has them (exact words and times, no Gemini credits); otherwise Gemini listens' },
  { id: 'screen', label: 'Subtitles in video', title: 'Always read the subtitles burned into the picture (Chinese / English) -- no Gemini needed' },
  { id: 'voice', label: 'Listen (Gemini)', title: 'Gemini listens to the voices -- for videos without subtitles in the picture' }
]

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

/** Auto SRT (Gemini), as a panel over the app: Batch Load puts every
 * episode on the Timeline end to end in episode order, then each video is
 * transcribed one at a time and its SRT lands on the Timeline under it --
 * video 1's under video 1, video 2's under video 2. Works the same for a
 * single video already on the Timeline (one row). */
export function AutoSrtPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const aiDubber = useAiDubber()
  const { batchRows, batchJob, batchJobs, batchMessage, autoSrtTextSource, setAutoSrtTextSource } = aiDubber
  const [transcribeOnLoad, setTranscribeOnLoad] = useState(true)
  const [atOnce, setAtOnceState] = useState(loadAutoSrtAtOnce)
  const setAtOnce = (n: number): void => {
    setAtOnceState(n)
    saveAutoSrtAtOnce(n)
  }
  // Save SRTs: one file per video (as before), or one file for them all.
  const [srtJoined, setSrtJoinedState] = useState(() => {
    try {
      return localStorage.getItem('cae.saveSrtsJoined') === '1'
    } catch {
      return false
    }
  })
  const setSrtJoined = (on: boolean): void => {
    setSrtJoinedState(on)
    try {
      localStorage.setItem('cae.saveSrtsJoined', on ? '1' : '0')
    } catch {
      // Remembered for this session only.
    }
  }
  const [loading, setLoading] = useState(false)
  const confirm = useConfirm()
  const running = !!batchJob
  // One row per video: the clips of one file that follow each other on the
  // Timeline (Video Sync cuts a film into dozens) are listed -- and
  // transcribed -- together.
  const groups = useMemo(() => {
    const out: { key: string; fileName: string; clipIds: string[]; startTime: number; endTime: number; lines: number; gapCount: number; gapClipIds: string[]; status: 'waiting' | 'transcribing' | 'done' | 'failed'; error?: string; unclearSeconds: number }[] = []
    for (const row of batchRows) {
      const last = out[out.length - 1]
      const sameVideo = last && batchRows.find((r) => r.clipId === last.clipIds[last.clipIds.length - 1])?.mediaId === row.mediaId
      const group = sameVideo
        ? last
        : (out[out.push({ key: row.clipId, fileName: row.fileName, clipIds: [], startTime: row.startTime, endTime: row.endTime, lines: 0, gapCount: 0, gapClipIds: [], status: row.status, unclearSeconds: 0 }) - 1] as (typeof out)[number])
      group.clipIds.push(row.clipId)
      group.endTime = row.endTime
      group.lines += row.lines
      group.unclearSeconds += row.unclearSeconds ?? 0
      if (row.status === 'done' && row.gaps.length > 0) {
        group.gapCount += row.gaps.length
        group.gapClipIds.push(row.clipId)
      }
      // The group shows its busiest state: transcribing > failed > waiting > done.
      const rank = { transcribing: 3, failed: 2, waiting: 1, done: 0 } as const
      if (rank[row.status] > rank[group.status]) group.status = row.status
      group.error ??= row.error
    }
    return out
  }, [batchRows])
  const waiting = groups.filter((g) => g.status === 'waiting' || g.status === 'failed').length
  const done = groups.filter((g) => g.status === 'done').length

  const clearAll = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Clear Auto SRT',
      message: `Take ${groups.length === 1 ? 'the video' : `all ${groups.length} videos`} off the Timeline, with their subtitles and dubbing? The files themselves stay on your computer.`,
      confirmLabel: 'Clear',
      danger: true
    })
    if (ok) aiDubber.clearBatchVideos()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleBatchLoad = async (): Promise<void> => {
    setLoading(true)
    try {
      await aiDubber.batchLoadVideos(transcribeOnLoad)
    } finally {
      setLoading(false)
    }
  }

  const statusText = (row: (typeof groups)[number]): string => {
    if (row.status === 'transcribing') return `${Math.round(row.clipIds.map((id) => batchJobs[id]).find(Boolean)?.percent ?? 0)}%`
    if (row.status === 'done') return `${row.lines} line${row.lines === 1 ? '' : 's'}`
    return row.status === 'failed' ? 'Failed' : 'Waiting'
  }

  const fillGaps = async (clipIds: string[]): Promise<void> => {
    for (const clipId of clipIds) await aiDubber.fillBatchGaps(clipId)
  }

  return createPortal(
    <div className="auto-srt-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="auto-srt-panel" role="dialog" aria-label="Auto SRT">
        <div className="auto-srt-head">
          <span className="ai-dubber-auto-srt-popover-icon" aria-hidden="true">
            ✦
          </span>
          <div className="auto-srt-title">
            <strong>Auto SRT</strong>
            <small>several videos at once · subtitles in the picture or Gemini · speakers matched</small>
          </div>
          <button className="auto-srt-close" aria-label="Close Auto SRT" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="auto-srt-actions">
          <button className="auto-srt-batch-load" onClick={() => void handleBatchLoad()} disabled={loading || running} title="Pick every episode: they go onto the Timeline one after another, in episode order">
            📁 {loading ? 'Loading…' : 'Batch Load'}
          </button>
          {running ? (
            <button className="ai-dubber-remove-srt-button" onClick={aiDubber.cancelBatch}>
              Stop
            </button>
          ) : (
            // After a Stop (or the app closed mid-run) it carries on from the
            // first video with no subtitles yet: those already done are kept.
            <button
              className="ai-dubber-episodes-primary"
              disabled={waiting === 0}
              onClick={() => void aiDubber.transcribeBatch()}
              title={done > 0 && waiting > 0 ? `Carry on: the ${waiting} video${waiting === 1 ? '' : 's'} with no subtitles yet, several at a time -- the ${done} done are kept` : 'Transcribe each video with no subtitles yet, several at a time (At once below)'}
            >
              {done > 0 && waiting > 0 ? `▶ Continue · ${waiting} left` : `✦ Transcribe ${waiting > 0 ? `${waiting} video${waiting === 1 ? '' : 's'}` : 'all'}`}
            </button>
          )}
          <span className="auto-srt-actions-right">
          <span className="auto-srt-save">
            <button
              className="ai-dubber-remove-srt-button"
              disabled={done === 0}
              onClick={() => void aiDubber.saveBatchSrts(srtJoined)}
              title={srtJoined ? 'Save ONE SRT for all the videos, joined end to end in Timeline time, into a folder' : "Save one SRT per video (in that video's own time) into a folder"}
            >
              {srtJoined ? 'Save SRT (joined)' : 'Save SRTs'}
            </button>
            <select className="auto-srt-save-mode" value={srtJoined ? 'joined' : 'each'} onChange={(e) => setSrtJoined(e.target.value === 'joined')} aria-label="How the SRTs are saved" title="How the SRTs are saved">
              <option value="each">One per video</option>
              <option value="joined">One file, all joined</option>
            </select>
          </span>
          <button
            className="auto-srt-clear"
            disabled={groups.length === 0 || running}
            onClick={() => void clearAll()}
            title="Clear: take every video in this list off the Timeline (with its subtitles and dub) to start again"
            aria-label="Clear"
          >
            🗑
          </button>
          </span>
        </div>
        <div className="auto-srt-settings">
        <div className="auto-srt-setting-row">
          <span className="auto-srt-source-label">Text from</span>
        <div className="auto-srt-source" role="radiogroup" aria-label="Text from">
          {TEXT_SOURCES.map((source) => (
            <button
              key={source.id}
              type="button"
              role="radio"
              aria-checked={autoSrtTextSource === source.id}
              className={autoSrtTextSource === source.id ? 'auto-srt-source-option active' : 'auto-srt-source-option'}
              disabled={running}
              title={source.title}
              onClick={() => setAutoSrtTextSource(source.id)}
            >
              {source.label}
            </button>
          ))}
        </div>
        </div>
        <label className="auto-srt-setting-row" title="More at once is faster, and works the computer (and Gemini) harder. Takes effect on the next Transcribe.">
          <span className="auto-srt-source-label">At once</span>
          <select className="auto-srt-save-mode auto-srt-at-once" value={atOnce} onChange={(e) => setAtOnce(Number(e.target.value))} disabled={running} aria-label="Videos transcribed at once">
            {AUTO_SRT_AT_ONCE_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} video{n === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        </label>
        <label className="auto-srt-option">
          <input type="checkbox" checked={transcribeOnLoad} onChange={(e) => setTranscribeOnLoad(e.target.checked)} />
          Transcribe the videos right after Batch Load
        </label>
        </div>

        {batchJob && (
          <div className="ai-dubber-episodes-progress">
            <span>{batchJob.message}</span>
            <span className="ai-dubber-speaker-progress-track">
              <span style={{ width: `${batchJob.percent}%` }} />
            </span>
          </div>
        )}
        {batchMessage && (
          <div className="ai-dubber-analysis-message">
            <span>{batchMessage}</span>
            <button aria-label="Dismiss" onClick={aiDubber.dismissBatchMessage}>
              ×
            </button>
          </div>
        )}

        {groups.length === 0 ? (
          <div className="auto-srt-empty">No video on the Timeline yet — use Batch Load to add your episodes.</div>
        ) : (
          <ol className="ai-dubber-episode-list auto-srt-list">
            {groups.map((row, index) => (
              <li key={row.key} className={row.status === 'transcribing' ? 'ai-dubber-episode ai-dubber-episode-open' : 'ai-dubber-episode'}>
                <span className="ai-dubber-episode-index">{index + 1}</span>
                <span className="ai-dubber-episode-name" title={row.fileName}>
                  {row.fileName}
                  {row.clipIds.length > 1 && <small className="auto-srt-parts"> · {row.clipIds.length} parts</small>}
                </span>
                <span className="auto-srt-time">
                  {formatClock(row.startTime)}–{formatClock(row.endTime)}
                </span>
                <span className={`ai-dubber-episode-status ai-dubber-episode-status-${row.status}`} title={row.error}>
                  {statusText(row)}
                </span>
                {/* Stretches with no line: possibly missed dialogue -- shown,
                    and sent back to Gemini on their own with Fill gaps. */}
                {row.status === 'done' && row.gapCount > 0 && (
                  <button
                    className="auto-srt-gaps"
                    disabled={running}
                    onClick={() => void fillGaps(row.gapClipIds)}
                    title={`${row.gapCount} stretch${row.gapCount === 1 ? '' : 'es'} with no lines${row.unclearSeconds ? ` · about ${Math.round(row.unclearSeconds)}s Gemini could not read cleanly` : ''}. Click to send only these stretches back to Gemini (Fill gaps).`}
                  >
                    ⚠ {row.gapCount} gap{row.gapCount === 1 ? '' : 's'} · Fill
                  </button>
                )}
                <button
                  className="ai-dubber-remove-srt-button"
                  disabled={running}
                  onClick={() => void aiDubber.transcribeBatch(row.clipIds)}
                  title={row.status === 'done' ? 'Transcribe this video again (replaces its subtitles)' : 'Transcribe this video'}
                >
                  {row.status === 'done' ? 'Redo' : 'Transcribe'}
                </button>
              </li>
            ))}
          </ol>
        )}
        <small className="auto-srt-note">Each video&apos;s SRT goes onto the Timeline under that video. {autoSrtTextSource === 'voice' ? 'Gemini credits are used per video.' : 'Videos with subtitles in the picture are read from it (free, exact); the others use Gemini credits.'}</small>
      </div>
    </div>,
    document.body
  )
}

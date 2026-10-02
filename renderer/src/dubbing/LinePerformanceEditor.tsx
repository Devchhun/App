import {
  DUBBING_EMOTIONS,
  DUBBING_ENERGIES,
  DUBBING_PACES,
  EMOTION_LABELS,
  buildLineControl,
  lineLoudnessTargetLufs,
  neutralPerformance,
  type DubbingEmotion,
  type DubbingEnergy,
  type DubbingLineDebug,
  type DubbingPace,
  type LinePerformance
} from '@shared/dubbingPerformance'
import { useAiDubber } from './AiDubberContext'

/** Emoji shown on a row's emotion chip -- quick to scan down a long script. */
export const EMOTION_ICON: Record<DubbingEmotion, string> = {
  neutral: '🙂',
  calm: '😌',
  serious: '😐',
  happy: '😄',
  excited: '🤩',
  sad: '😢',
  crying: '😭',
  fear: '😨',
  shocked: '😲',
  angry: '😠',
  shout: '📢',
  whisper: '🤫'
}

const PACE_LABELS: Record<DubbingPace, string> = { very_slow: 'Very slow', slow: 'Slow', normal: 'Normal', fast: 'Fast', very_fast: 'Very fast' }
const SOURCE_LABELS: Record<LinePerformance['analysisSource'], string> = { ai: 'AI', rules: 'Auto', manual: 'Manual' }

/** The row's compact emotion chip ("😠 Angry 80 · AI"). */
export function EmotionChip({ performance, onClick }: { performance?: LinePerformance; onClick: () => void }): JSX.Element {
  if (!performance) {
    return (
      <button className="ai-dubber-emotion-chip ai-dubber-emotion-chip-empty" title="No performance yet -- decided automatically at Generate, or set it here" onClick={onClick}>
        🎭
      </button>
    )
  }
  return (
    <button
      className={`ai-dubber-emotion-chip${performance.analysisSource === 'manual' ? ' ai-dubber-emotion-chip-manual' : ''}`}
      title={`${EMOTION_LABELS[performance.emotion]} ${performance.emotionIntensity}/100 · ${performance.speakingStyle || 'no style'} · ${SOURCE_LABELS[performance.analysisSource]}`}
      onClick={onClick}
    >
      {EMOTION_ICON[performance.emotion]} {performance.emotionIntensity}
      {performance.analysisSource === 'manual' ? ' ✎' : ''}
    </button>
  )
}

/** Per-line performance controls: Emotion, Intensity, Speaking Style, Pace,
 * Energy, Delivery, Performance Prompt -- plus Auto Detect / Reset /
 * Regenerate. Every edit here marks the line 'manual', so automatic
 * analysis never overwrites it again until Auto Detect is used on it.
 * What is shown is exactly what generation will use: the preview under the
 * fields is the control VoxCPM2 will receive for this line. */
export function LinePerformanceEditor({ segmentId, voiceDescription }: { segmentId: string; voiceDescription?: string }): JSX.Element {
  const aiDubber = useAiDubber()
  const segState = aiDubber.getSegmentState(segmentId)
  const perf = segState.performance
  const shown = perf ?? neutralPerformance('rules')
  const set = (patch: Partial<LinePerformance>): void => aiDubber.setSegmentPerformance(segmentId, patch)
  const generating = segState.status === 'generating'

  return (
    <div className="ai-dubber-performance">
      <div className="ai-dubber-performance-head">
        <strong>Performance</strong>
        <span className="ai-dubber-performance-source">{perf ? SOURCE_LABELS[perf.analysisSource] : 'Not analysed yet'}</span>
        <span className="ai-dubber-performance-actions">
          <button title="Detect this line's emotion again with Gemini, reading the lines around it (replaces a manual setting)" disabled={aiDubber.analysisRunning} onClick={() => void aiDubber.detectEmotions([segmentId])}>
            Auto Detect
          </button>
          <button title="Forget this line's performance -- it is decided automatically again" disabled={!perf} onClick={() => aiDubber.resetSegmentPerformance(segmentId)}>
            Reset
          </button>
          <button title="Make a new take of this line (a different performance seed)" disabled={generating} onClick={() => aiDubber.regenerateSegment(segmentId)}>
            {generating ? 'Generating…' : 'Regenerate'}
          </button>
        </span>
      </div>
      <div className="ai-dubber-performance-grid">
        <label className="ai-dubber-detail-field">
          Emotion
          <select value={shown.emotion} onChange={(e) => set({ emotion: e.target.value as DubbingEmotion })}>
            {DUBBING_EMOTIONS.map((emotion) => (
              <option key={emotion} value={emotion}>
                {EMOTION_ICON[emotion]} {EMOTION_LABELS[emotion]}
              </option>
            ))}
          </select>
        </label>
        <label className="ai-dubber-detail-field ai-dubber-performance-intensity">
          Intensity
          <input type="range" min={0} max={100} step={5} value={shown.emotionIntensity} onChange={(e) => set({ emotionIntensity: Number(e.target.value) })} />
          <span>{shown.emotionIntensity}</span>
        </label>
        <label className="ai-dubber-detail-field">
          Pace
          <select value={shown.pace} onChange={(e) => set({ pace: e.target.value as DubbingPace })}>
            {DUBBING_PACES.map((pace) => (
              <option key={pace} value={pace}>
                {PACE_LABELS[pace]}
              </option>
            ))}
          </select>
        </label>
        <label className="ai-dubber-detail-field">
          Energy
          <select value={shown.energy} onChange={(e) => set({ energy: e.target.value as DubbingEnergy })}>
            {DUBBING_ENERGIES.map((energy) => (
              <option key={energy} value={energy}>
                {energy}
              </option>
            ))}
          </select>
        </label>
        <label className="ai-dubber-detail-field ai-dubber-performance-wide">
          Style
          <input type="text" placeholder="e.g. breathy, stunned, hesitant" value={shown.speakingStyle} onChange={(e) => set({ speakingStyle: e.target.value })} />
        </label>
        <label className="ai-dubber-detail-field ai-dubber-performance-wide">
          Delivery
          <input type="text" placeholder="e.g. start softly, more urgent at the end" value={shown.delivery} onChange={(e) => set({ delivery: e.target.value })} />
        </label>
        <label className="ai-dubber-detail-field ai-dubber-performance-wide">
          Prompt
          <input type="text" placeholder="Extra direction for the voice (English works best)" value={shown.customPrompt ?? ''} onChange={(e) => set({ customPrompt: e.target.value })} />
        </label>
      </div>
      <div className="ai-dubber-performance-preview" title="The exact control VoxCPM2 receives for this line (a recorded voice has no voice description)">
        {buildLineControl(voiceDescription, shown)}
        <em> · level {lineLoudnessTargetLufs(shown)} LUFS</em>
      </div>
    </div>
  )
}

const fmt = (value: number | null | undefined, digits = 2): string => (value === null || value === undefined ? '–' : value.toFixed(digits))

/** What generation actually did for this line (Debug view). */
export function LineDebugView({ debug, speaker }: { debug?: DubbingLineDebug; speaker?: string }): JSX.Element {
  if (!debug) return <div className="ai-dubber-debug ai-dubber-debug-empty">No generation data yet for this line.</div>
  return (
    <div className="ai-dubber-debug">
      <div className="ai-dubber-debug-grid">
        <span>Speaker</span>
        <b>{speaker ?? '–'}</b>
        <span>Voice ID</span>
        <b>{debug.voiceId}</b>
        <span>Emotion</span>
        <b>
          {debug.emotion ? `${EMOTION_LABELS[debug.emotion]} ${debug.intensity ?? ''}` : '–'}
        </b>
        <span>Style / Pace / Energy</span>
        <b>
          {debug.style || '–'} / {debug.pace ?? '–'} / {debug.energy ?? '–'}
        </b>
        <span>Seed</span>
        <b>{debug.seed ?? '–'}</b>
        <span>Attempt</span>
        <b>{debug.attempt ? `${debug.attempt} of ${debug.attempts ?? debug.attempt}` : '–'}</b>
        <span>Speaker similarity</span>
        <b>{fmt(debug.similarity, 3)}</b>
        <span>Pitch shift vs reference</span>
        <b>{debug.pitchDriftSt === null || debug.pitchDriftSt === undefined ? '–' : `${debug.pitchDriftSt > 0 ? '+' : ''}${debug.pitchDriftSt.toFixed(2)} st`}</b>
        <span>Expressiveness</span>
        <b>
          {fmt(debug.expressiveness)}
          {debug.flat ? ' (flat)' : ''}
        </b>
        <span>Naturalness / Timing</span>
        <b>
          {fmt(debug.naturalness)} / {fmt(debug.timing)}
        </b>
        <span>Score</span>
        <b>{fmt(debug.score, 3)}</b>
        <span>Generated duration</span>
        <b>{debug.generatedSeconds !== undefined ? `${debug.generatedSeconds.toFixed(2)} s` : '–'}</b>
        <span>Level / pitch fix</span>
        <b>
          {debug.loudnessTargetLufs ?? '–'} LUFS / {debug.pitchCorrectionSt ? `${debug.pitchCorrectionSt} st` : 'none'}
        </b>
      </div>
      <div className="ai-dubber-debug-control">
        <span>Final VoxCPM2 control</span>
        <code>{debug.control ?? '(none -- Edge TTS or a line without a performance)'}</code>
      </div>
    </div>
  )
}

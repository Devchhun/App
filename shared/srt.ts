// Pure, dependency-free SRT (SubRip) subtitle parsing for the Story Narration
// Workspace. Produces the exact same `TranscriptSegment` shape the AI
// transcription pipeline does (shared/transcription.ts), so every existing
// consumer (CaptionsTrack.tsx, VoiceoverRecorder.tsx's segment stepping) can
// render/step through SRT-imported segments with no changes of their own --
// see TranscriptContext for how a parsed result becomes a `Transcript`.
import type { TranscriptSegment } from './transcription'

export interface SrtParseIssue {
  /** 0-based index of the raw (blank-line-separated) block in the file. */
  blockIndex: number
  reason: string
}

export interface SrtParseResult {
  segments: TranscriptSegment[]
  issues: SrtParseIssue[]
}

/** First text line of the data cue an AI Dubber SRT export carries (its
 * dubbing setup -- see shared/dubbingSrt.ts). Lives here so the parser can
 * skip that cue on every import path without importing dubbingSrt.ts. */
export const DUBBING_SRT_MARKER = 'NOTE creative-ai-editor dubbing v1'

// Accepts both the standard comma decimal separator and a period (seen from
// some non-standard exporters), and 1-3 digit fraction lengths.
const TIMESTAMP_RE = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/

function timeToSeconds(h: string, m: string, s: string, frac: string): number {
  const millis = Number(frac.padEnd(3, '0').slice(0, 3))
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + millis / 1000
}

/** Parses raw SRT text into TranscriptSegments, tolerating and reporting
 * malformed blocks instead of throwing -- a single bad block never corrupts
 * or drops the rest of the file. Order is preserved exactly as it appears in
 * the file (SRT sequence numbers are read but not relied on for ordering,
 * since they're frequently just 1,2,3... and not authoritative). */
export function parseSrtToSegments(text: string): SrtParseResult {
  const cleaned = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const blocks = cleaned
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)

  const segments: TranscriptSegment[] = []
  const issues: SrtParseIssue[] = []

  blocks.forEach((block, blockIndex) => {
    const lines = block.split('\n')
    // Not dialogue: a NOTE comment block (WebVTT's keyword), or the
    // zero-length data cue holding an exported SRT's dubbing setup
    // (shared/dubbingSrt.ts). Skipped silently, never reported as broken.
    if (/^NOTE(\s|$)/.test(lines[0]) || lines.some((line) => line.startsWith(DUBBING_SRT_MARKER))) return
    const timestampLineIndex = lines.findIndex((l) => TIMESTAMP_RE.test(l))
    if (timestampLineIndex === -1) {
      issues.push({ blockIndex, reason: 'No valid timestamp line (expected HH:MM:SS,mmm --> HH:MM:SS,mmm)' })
      return
    }

    const match = lines[timestampLineIndex].match(TIMESTAMP_RE)!
    const startTime = timeToSeconds(match[1], match[2], match[3], match[4])
    const endTime = timeToSeconds(match[5], match[6], match[7], match[8])
    if (!(endTime > startTime)) {
      issues.push({ blockIndex, reason: 'End time is not after start time' })
      return
    }

    // Everything after the timestamp line is the (possibly multi-line) text.
    const text = lines
      .slice(timestampLineIndex + 1)
      .join('\n')
      .trim()
    if (!text) {
      issues.push({ blockIndex, reason: 'Empty subtitle text' })
      return
    }

    segments.push({
      id: `srt-${blockIndex}-${startTime.toFixed(3)}`,
      // SRT carries no word-level timing -- one synthetic word spanning the
      // whole segment satisfies TranscriptSegment's shape without inventing
      // per-word timing data that doesn't exist.
      words: [{ text, startTime, endTime, confidence: 1 }],
      startTime,
      endTime,
      language: 'auto',
      confidence: 1,
      text,
      needsReview: false
    })
  })

  return { segments, issues }
}

export interface DurationValidationResult {
  segments: TranscriptSegment[]
  warnings: string[]
}

export function secondsToSrtTimestamp(value: number): string {
  const totalMs = Math.max(0, Math.round(value * 1000))
  const ms = totalMs % 1000
  const seconds = Math.floor(totalMs / 1000) % 60
  const minutes = Math.floor(totalMs / 60_000) % 60
  const hours = Math.floor(totalMs / 3_600_000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

/** Serializes transcript lines without changing their array order or timing.
 * Speaker identity stays in project metadata rather than polluting dialogue
 * text with labels that would later be spoken by TTS. */
export function transcriptSegmentsToSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((segment, index) => `${index + 1}\n${secondsToSrtTimestamp(segment.startTime)} --> ${secondsToSrtTimestamp(segment.endTime)}\n${(segment.editedText ?? segment.text).trim()}`)
    .join('\n\n') + (segments.length ? '\n' : '')
}

/** Flags (never silently drops) a segment whose start/end falls outside the
 * video's real duration -- marks it `needsReview` and returns a human-
 * readable summary for the setup UI. A small tolerance absorbs harmless
 * float/container rounding between the SRT author's source and the actual
 * decoded duration. */
export function validateSegmentsAgainstDuration(segments: TranscriptSegment[], videoDurationSeconds: number): DurationValidationResult {
  const TOLERANCE_SECONDS = 0.25
  let outOfRangeCount = 0

  const validated = segments.map((seg) => {
    const outOfRange = seg.startTime < 0 || seg.endTime > videoDurationSeconds + TOLERANCE_SECONDS
    if (!outOfRange) return seg
    outOfRangeCount += 1
    return { ...seg, needsReview: true }
  })

  const warnings: string[] = []
  if (outOfRangeCount > 0) {
    const plural = outOfRangeCount === 1 ? 'segment' : 'segments'
    const verb = outOfRangeCount === 1 ? 'has' : 'have'
    warnings.push(`${outOfRangeCount} ${plural} extend beyond the video's duration (${videoDurationSeconds.toFixed(1)}s) and ${verb} been marked Needs Review.`)
  }

  return { segments: validated, warnings }
}

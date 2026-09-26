export interface NarrationTimingStatus {
  label: string
  className: string
}

/** Recording Assistant's timing-feedback readout -- purely a function of the
 * target (SRT segment) duration and how long the current take actually ran,
 * never adjusting either value: this app never silently time-stretches or
 * speed-changes a recorded take (see the Story Narration spec's "safe
 * narration optimization" requirement), so this is read-only feedback, not
 * a fitting algorithm. `recordedSeconds <= 0` means nothing has been
 * recorded yet for this segment. */
export function timingStatus(targetSeconds: number, recordedSeconds: number): NarrationTimingStatus {
  if (recordedSeconds <= 0) return { label: '—', className: '' }
  const diff = recordedSeconds - targetSeconds
  if (recordedSeconds > targetSeconds + 0.5) return { label: `Exceeds subtitle range by ${diff.toFixed(1)}s`, className: 'narration-timing-bad' }
  if (recordedSeconds < targetSeconds - targetSeconds * 0.3 && targetSeconds > 1) return { label: 'Too short', className: 'narration-timing-warn' }
  return { label: 'Good timing', className: 'narration-timing-good' }
}

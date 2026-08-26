export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** HH:MM:SS:FF timecode, matching the Player transport format in most NLEs. */
export function formatTimecode(seconds: number, frameRate = 30): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00:00'
  const totalFrames = Math.floor(seconds * frameRate)
  const fps = Math.max(1, Math.round(frameRate))
  const frames = totalFrames % fps
  const totalSeconds = Math.floor(totalFrames / fps)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`
}

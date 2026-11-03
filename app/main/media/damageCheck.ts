import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { dialog, type BrowserWindow } from 'electron'
import { cacheKeyForFile, ensureCacheDir } from './cache'
import { ffmpegPath } from './ffmpeg'

/** One file's check is given up after this long (and the file kept: never
 * turn away a video that could not be judged). A two-minute episode takes
 * a fifth of a second. */
const CHECK_TIMEOUT_MS = 30_000
/** Checks running at once. */
const PARALLEL = 4

/** What a damaged video's card and clip say. */
export const DAMAGED_VIDEO_MESSAGE = 'This video file is damaged: its download was cut off partway, so most of it cannot be played. Download it again, then replace it.'

const VIDEO_FILE = /\.(mp4|m4v|mov|mkv|webm|ts|flv|avi)$/i

/** ffmpeg, run to its end; what it wrote to stderr (capped). */
function ffmpegErrors(args: string[]): Promise<{ text: string; timedOut: boolean; failedToStart: boolean }> {
  return new Promise((resolve) => {
    let text = ''
    let settled = false
    const finish = (timedOut: boolean, failedToStart = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ text, timedOut, failedToStart })
    }
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    const timer = setTimeout(() => {
      proc.kill()
      finish(true)
    }, CHECK_TIMEOUT_MS)
    proc.stderr.on('data', (chunk: Buffer) => {
      if (text.length < 20_000) text += chunk.toString()
    })
    proc.on('error', () => finish(false, true))
    proc.on('close', () => finish(false))
  })
}

/** Whether a video file's picture data is broken partway through -- the
 * usual result of a download that was cut off: the file has its full
 * length on paper, but past some point its data is garbage ("Invalid NAL
 * unit size"). Such a file cannot be converted for preview, and the player
 * stalls where the garbage starts. Every video packet is read through once
 * without decoding (H.264 / HEVC: the two that carry sized units); other
 * kinds, and anything that cannot be judged, count as fine. */
export async function isDamagedVideo(filePath: string, requirePicture = false): Promise<boolean> {
  if (!VIDEO_FILE.test(filePath)) return false
  const head = await ffmpegErrors(['-hide_banner', '-nostdin', '-i', filePath])
  if (head.failedToStart || head.timedOut) return false
  const codec = /Stream #\d+:\d+[^\n]*Video:\s*(\w+)/.exec(head.text)?.[1]?.toLowerCase()
  // A "video" with sound only: the download kept one of its two parts.
  if (!codec) return requirePicture && /Stream #\d+:\d+.*Audio:/.test(head.text)
  const filter = codec === 'hevc' ? 'hevc_mp4toannexb' : codec === 'h264' ? 'h264_mp4toannexb' : null
  if (!filter) return false
  const scan = await ffmpegErrors(['-hide_banner', '-nostdin', '-v', 'error', '-i', filePath, '-map', '0:v:0', '-c', 'copy', '-bsf:v', filter, '-f', 'null', '-'])
  if (scan.failedToStart || scan.timedOut) return false
  // ffmpeg 6 says it of the filter ("Error applying bitstream filters to a
  // packet", repeated for every packet past the break); others name the
  // broken unit itself.
  return /Error applying bitstream filters|Invalid NAL unit size|Error splitting the input into NAL units|Invalid data found when processing input|moov atom not found/i.test(scan.text)
}

/** Whether a video is damaged (a file with no picture counts), asked of
 * ffmpeg once per file: the check reads the whole file through, so a file
 * found whole is marked in its own cache folder -- which belongs to its
 * path, size and date, so a file downloaded again is checked again.
 * Without the mark every video of a project was read through each time
 * the project was opened, and twice when it was added (the file dialog,
 * then the import). */
export async function isDamagedVideoOnce(filePath: string): Promise<boolean> {
  if (!VIDEO_FILE.test(filePath)) return false
  let mark: string | null = null
  try {
    mark = join(await ensureCacheDir(await cacheKeyForFile(filePath)), 'intact-v1')
  } catch {
    // No cache folder to be had: checked every time.
  }
  if (mark && existsSync(mark)) return false
  const damaged = await isDamagedVideo(filePath, true)
  if (!damaged && mark) await writeFile(mark, '').catch(() => undefined)
  return damaged
}

/** The damaged ones among `paths`, in their order. `requirePicture`: a
 * video file with no picture in it counts too (where a film is asked for). */
export async function findDamagedVideos(paths: string[], requirePicture = false): Promise<string[]> {
  const damaged = new Array<boolean>(paths.length).fill(false)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < paths.length; i = next++) damaged[i] = await (requirePicture ? isDamagedVideoOnce(paths[i]) : isDamagedVideo(paths[i])).catch(() => false)
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, paths.length) }, worker))
  return paths.filter((_, i) => damaged[i])
}

/** Picked files without the damaged videos; the user is told which were
 * left out and why (one window, however many there are). */
export async function withoutDamagedVideos(win: BrowserWindow | null, paths: string[], requirePicture = false): Promise<string[]> {
  const damaged = await findDamagedVideos(paths, requirePicture)
  if (damaged.length === 0) return paths
  const names = damaged.map((p) => basename(p))
  const shown = names.slice(0, 12).join('\n') + (names.length > 12 ? `\n… and ${names.length - 12} more` : '')
  const options = {
    type: 'warning' as const,
    title: 'Damaged video',
    message: damaged.length === 1 ? 'One video is damaged and was left out.' : `${damaged.length} videos are damaged and were left out.`,
    detail: `${shown}\n\nThese files are incomplete -- their download was cut off partway, so most or all of the picture cannot be read. Download them again, then add them.`,
    buttons: ['OK']
  }
  if (win) await dialog.showMessageBox(win, options)
  else await dialog.showMessageBox(options)
  const bad = new Set(damaged)
  return paths.filter((p) => !bad.has(p))
}

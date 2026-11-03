import type { ProjectSequence, TimelineClip } from '@shared/project'
import { computeSequenceDuration } from '@shared/project'
import { DEFAULT_BACKGROUND_BLUR } from '@shared/clipAdjust'
import { MANGA_CUTOUT_SCALE, MANGA_DIP_SECONDS, mangaClipMotion, panelSeconds, trioPlacement, type MangaLine, type MangaMotion } from '@shared/mangaRecap'
import { ensureTrack, findOrCreateTrack, getMainVideoTrackId, type OccupiedRange } from '../timeline/trackModel'

/** A picture of a group, once it is in Media. */
export interface PlacedPicture {
  imageMediaId: string
  imageSize: { width?: number; height?: number }
  focusX: number
  focusY: number
  /** The character cut out of the picture (in Media), and how it moves. */
  cutoutMediaId?: string | null
  motion?: MangaMotion
}

/** A group of pictures shown together and the passage told over it. */
export interface PlacedGroup {
  pictures: PlacedPicture[]
  /** A voice file of its own (when the passages were not joined into one
   * narration); null: none. */
  audioMediaId: string | null
  audioSeconds: number
  /** Silence after the voice (MangaGroupResult.pauseAfter). */
  pauseAfter?: number
  lines: MangaLine[]
}

export interface MangaPlacement {
  sequence: ProjectSequence
  /** The subtitles, in Timeline seconds, for Add Text on a text track. */
  subtitles: Array<{ text: string; start: number; end: number }>
  start: number
  end: number
}

const IDENTITY = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 }

/** The groups one after another, after whatever is already on the main
 * video track, each as long as its passage; the narration on one audio
 * track under them.
 *
 * One picture to a group: shown whole and still, as big as the frame
 * allows, with a blurred fill around it. (Scrolling a tall one from top to
 * bottom, and before that a slow pan, were tried and turned down: moving
 * pictures were hard to watch and made the user dizzy.) Its character, cut
 * out, moves a little on a track above it -- breathing, floating or
 * trembling -- drawn a touch larger so the outline behind never shows.
 *
 * More than one (`backdrops` given, 16:9): side by side, each in its third of
 * the frame on a track of its own, all in full view for the whole passage,
 * over the group's blurred backdrop on the main track. */
export function placeMangaGroups(
  sequence: ProjectSequence,
  groups: PlacedGroup[],
  aspect: '16:9' | '9:16' | '1:1',
  makeId: () => string = () => crypto.randomUUID(),
  /** The whole narration as one file (MangaResult.narrationPath, in Media):
   * one clip under all the groups instead of a clip per group. */
  narration?: { mediaId: string; seconds: number },
  /** Side by side: each group's blurred backdrop (media id, or null). */
  backdrops?: Array<string | null>
): MangaPlacement {
  let tracks = sequence.tracks
  let mainId = getMainVideoTrackId(tracks)
  if (!mainId) {
    const routing = findOrCreateTrack(tracks, [], 0, 1, 'video')
    if (routing.newTrack) tracks = ensureTrack(tracks, { ...routing.newTrack, isMain: true })
    mainId = routing.trackId
  }
  const main = mainId
  const start = sequence.clips.filter((c) => c.trackId === main).reduce((end, c) => Math.max(end, c.startTime + c.duration), 0)
  const durations = groups.map((g) => panelSeconds(g.audioSeconds, g.pauseAfter))
  const end = start + durations.reduce((sum, d) => sum + d, 0)

  const occupied: OccupiedRange[] = sequence.clips.map((c) => ({ trackId: c.trackId, startTime: c.startTime, endTime: c.startTime + c.duration }))
  const voiceRouting = findOrCreateTrack(tracks, occupied, start, Math.max(0.1, end - start), 'audio')
  if (voiceRouting.newTrack) tracks = ensureTrack(tracks, { ...voiceRouting.newTrack, name: 'Manga Voice' })

  // Side by side: a track per column above the main track.
  const columnCount = backdrops ? Math.max(0, ...groups.map((g) => g.pictures.length)) : 0
  const columns: string[] = []
  const taken: OccupiedRange[] = [...occupied, { trackId: main, startTime: start, endTime: end }]
  for (let k = 0; k < columnCount; k++) {
    const routing = findOrCreateTrack(tracks, taken, start, Math.max(0.1, end - start), 'video')
    if (routing.newTrack) tracks = ensureTrack(tracks, { ...routing.newTrack, name: `Panels ${k + 1}` })
    taken.push({ trackId: routing.trackId, startTime: start, endTime: end })
    columns.push(routing.trackId)
  }

  // One picture at a time: a track above the main one for the characters.
  let characters: string | null = null
  if (!backdrops && groups.some((g) => g.pictures.some((p) => p.cutoutMediaId && mangaClipMotion(p.motion)))) {
    const routing = findOrCreateTrack(tracks, taken, start, Math.max(0.1, end - start), 'video')
    if (routing.newTrack) tracks = ensureTrack(tracks, { ...routing.newTrack, name: 'Characters' })
    taken.push({ trackId: routing.trackId, startTime: start, endTime: end })
    characters = routing.trackId
  }

  const clips: TimelineClip[] = []
  const subtitles: MangaPlacement['subtitles'] = []
  let at = start
  // Every picture dips to dark into the next (shared/pictureFade.ts).
  const dip = { pictureFadeIn: MANGA_DIP_SECONDS, pictureFadeOut: MANGA_DIP_SECONDS }
  groups.forEach((group, g) => {
    const duration = durations[g]
    const image = (picture: PlacedPicture, trackId: string, extra: Partial<TimelineClip>): void => {
      clips.push({ id: makeId(), mediaId: picture.imageMediaId, type: 'image', trackId, startTime: at, duration, sourceIn: 0, sourceOut: undefined, locked: false, ...dip, ...extra })
    }
    if (backdrops) {
      const backdrop = backdrops[g]
      if (backdrop) clips.push({ id: makeId(), mediaId: backdrop, type: 'image', trackId: main, startTime: at, duration, sourceIn: 0, sourceOut: undefined, locked: false, ...dip })
      group.pictures.forEach((picture, k) => {
        const place = trioPlacement(picture.imageSize, k)
        image(picture, columns[k], { transform: { ...IDENTITY, x: place.x, scaleX: place.scale, scaleY: place.scale } })
      })
    } else {
      for (const picture of group.pictures.slice(0, 1)) {
        image(picture, main, { backgroundBlur: DEFAULT_BACKGROUND_BLUR, transform: { ...IDENTITY } })
        const motion = mangaClipMotion(picture.motion)
        if (characters && picture.cutoutMediaId && motion) {
          clips.push({ id: makeId(), mediaId: picture.cutoutMediaId, type: 'image', trackId: characters, startTime: at, duration, sourceIn: 0, sourceOut: undefined, locked: false, transform: { ...IDENTITY, scaleX: MANGA_CUTOUT_SCALE, scaleY: MANGA_CUTOUT_SCALE }, motion, ...dip })
        }
      }
    }
    if (group.audioSeconds > 0) {
      if (!narration && group.audioMediaId) clips.push({ id: makeId(), mediaId: group.audioMediaId, type: 'audio', trackId: voiceRouting.trackId, startTime: at, duration: group.audioSeconds, sourceIn: 0, sourceOut: group.audioSeconds, locked: false })
      // The last line stays up through the pause: no blank between groups.
      group.lines.forEach((line, k) => subtitles.push({ text: line.text, start: at + line.start, end: k === group.lines.length - 1 ? at + duration : at + line.end }))
    }
    at += duration
  })

  if (narration) {
    const seconds = Math.min(narration.seconds, end - start)
    clips.push({ id: makeId(), mediaId: narration.mediaId, type: 'audio', trackId: voiceRouting.trackId, startTime: start, duration: seconds, sourceIn: 0, sourceOut: seconds, locked: false })
  }
  const allClips = [...sequence.clips, ...clips]
  return { sequence: { ...sequence, tracks, clips: allClips, duration: computeSequenceDuration(allClips) }, subtitles, start, end }
}

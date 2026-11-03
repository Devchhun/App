/** The Cast window: the voices of a video found by listening, each shown
 * with its speaker's face, so one voice model is chosen per character
 * instead of one per subtitle line (Detect Gender).
 *
 * The listening is done in the main process (app/main/ai/castScanService.ts):
 * every line's sound becomes a voice print (python-worker's
 * cast_voices_runner.py), the prints are grouped here, and each group gets
 * faces cut from the frames its lines are spoken over. */
import { VOICE_GENDER_RULE } from './castGenderRule'
import { predictGender } from './speakerDiarization'
import type { SpeakerGender } from './transcription'

/** One subtitle line to listen to: its file and its time in that file. */
export interface CastScanLine {
  id: string
  path: string
  start: number
  end: number
}

export interface CastScanRequest {
  jobId: string
  lines: CastScanLine[]
  /** Take the music and effects out before listening (the speech stem the
   * Auto SRT makes; used as it is when already made). More accurate, and
   * slow the first time. */
  removeMusic: boolean
  /** Where VoxCPM2 is installed, if known: its runtime does the removing. */
  voxCpmInstallDir?: string
}

/** One voice found in the video. */
export interface CastGroup {
  /** Its lines, in the order they were given. */
  lineIds: string[]
  /** Those of them placed here without being sure (too short to tell, or
   * not much like the rest). */
  unsureIds: string[]
  /** Its clearest lines, the best first -- what to play to hear the voice. */
  sampleIds: string[]
  gender: SpeakerGender
  genderConfidence: number
  /** Seconds of speech in all its lines. */
  seconds: number
  /** Portraits cut from its lines' frames (file paths), the best first. */
  faces: string[]
  /** The voice itself: the middle of its lines' prints. */
  embedding: number[]
}

export interface CastScanResult {
  groups: CastGroup[]
  /** Lines with nothing to hear (silence, or too short): in no group. */
  unheardIds: string[]
  /** Whether the music was taken out first for (nearly) all lines. */
  speechOnly: boolean
}

export interface CastScanProgress {
  jobId: string
  stage: 'model' | 'audio' | 'voices' | 'grouping' | 'faces' | 'ready'
  /** 0-100 */
  percent: number
  message: string
}

/** A line's voice print (see cast_voices_runner.py). */
export interface VoicePrint {
  id: string
  /** Unit length. */
  embedding: number[]
  /** The line's own length. */
  seconds: number
  f0?: number | null
  voiced?: number
}

export interface VoiceGroup {
  lineIds: string[]
  unsureIds: string[]
  sampleIds: string[]
  centroid: number[]
  f0Hz?: number
  voicedRatio: number
  seconds: number
  /** The male/female rule's answer over the group's lines (above zero: a
   * man's voice) -- undefined when the prints are not the kind the rule
   * was fitted on. */
  genderScore?: number
}

/** How alike two prints of one person are, at the least, for their lines to
 * be put together. Lower joins different people, higher splits one person
 * into several. Measured on two dubbed stories with every line's voice
 * chosen by hand (196 and 47 lines, 8 and 6 voices): with the music taken
 * out first, 0.45 gave 10 and 6 groups, 85% and 89% of the lines in a group
 * whose other lines had the same hand-picked voice; on the full mix (music
 * under the speech pulls every print towards every other) 0.40 gave 10 and
 * 6 groups at 81% and 80%. And on four episodes of a series (195 lines):
 * 0.48 split the lead's 73 lines over three groups, 0.45 kept them whole. */
export const VOICE_THRESHOLD_SPEECH_ONLY = 0.45
export const VOICE_THRESHOLD_MIX = 0.4

/** A line this long or longer says enough about a voice to found a group;
 * a shorter one only joins a group already there (in the test above the
 * longer lines agreed with the hand-picked voice 88% of the time, the
 * shorter ones 63%). */
const CORE_SECONDS = 1
/** More core lines than this are grouped from the longest ones (the
 * grouping keeps a square table of them in memory). */
const CORE_MOST = 5000
/** A group of this few lines joins its nearest neighbour when it is nearly
 * close enough -- one person's odd line or two, not a character. */
const SMALL_GROUP = 2
const SMALL_GROUP_SLACK = 0.08
/** A line less like its group than the threshold plus this is marked "not
 * sure", to be checked by ear. On the hand-labelled test that flagged 32 of
 * 195 lines, 18 of them really in the wrong group, and left 7% of the rest
 * disagreeing with the hand-picked voice (11% with no flagging at all). */
const UNSURE_MARGIN = 0.04
const SAMPLES = 12

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) sum += a[i] * b[i]
  return sum
}

function unit(values: ArrayLike<number>): Float32Array {
  const out = new Float32Array(values.length)
  let norm = 0
  for (let i = 0; i < values.length; i++) norm += values[i] * values[i]
  norm = Math.sqrt(norm)
  if (norm > 1e-9) for (let i = 0; i < values.length; i++) out[i] = values[i] / norm
  return out
}

function meanOf(vectors: Float32Array[]): Float32Array {
  const out = new Float32Array(vectors[0]?.length ?? 0)
  for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i]
  return unit(out)
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** The lines grouped by voice: average-linkage clustering of the longer
 * lines (two groups join while their lines are, on average, at least
 * `threshold` alike), then the short lines each to the nearest group. The
 * biggest group first. */
export function groupVoicePrints(prints: VoicePrint[], threshold: number): VoiceGroup[] {
  const usable = prints.filter((p) => p.embedding.length > 0)
  if (usable.length === 0) return []
  const vectors = usable.map((p) => unit(p.embedding))
  let core = usable.map((_, i) => i).filter((i) => usable[i].seconds >= CORE_SECONDS)
  if (core.length < 2) core = usable.map((_, i) => i)
  if (core.length > CORE_MOST) core = [...core].sort((a, b) => usable[b].seconds - usable[a].seconds).slice(0, CORE_MOST)

  // sim[a * n + b]: the mean likeness between group a's and group b's lines.
  const n = core.length
  const sim = new Float32Array(n * n)
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const s = dot(vectors[core[a]], vectors[core[b]])
      sim[a * n + b] = s
      sim[b * n + a] = s
    }
  }
  const size = new Int32Array(n).fill(1)
  const alive = new Uint8Array(n).fill(1)
  const members: number[][] = core.map((i) => [i])
  // Each group's most alike other group.
  const nearest = new Int32Array(n).fill(-1)
  const nearestSim = new Float32Array(n).fill(-2)
  const findNearest = (a: number): void => {
    let best = -1
    let bestSim = -2
    for (let b = 0; b < n; b++) {
      if (b === a || !alive[b]) continue
      const s = sim[a * n + b]
      if (s > bestSim) {
        bestSim = s
        best = b
      }
    }
    nearest[a] = best
    nearestSim[a] = bestSim
  }
  for (let a = 0; a < n; a++) findNearest(a)
  for (;;) {
    let a = -1
    let top = -2
    for (let i = 0; i < n; i++) {
      if (alive[i] && nearestSim[i] > top) {
        top = nearestSim[i]
        a = i
      }
    }
    if (a < 0 || top < threshold) break
    const b = nearest[a]
    const total = size[a] + size[b]
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === a || k === b) continue
      const s = (size[a] * sim[a * n + k] + size[b] * sim[b * n + k]) / total
      sim[a * n + k] = s
      sim[k * n + a] = s
    }
    size[a] = total
    alive[b] = 0
    members[a].push(...members[b])
    members[b] = []
    findNearest(a)
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === a) continue
      if (nearest[k] === a || nearest[k] === b) findNearest(k)
      else if (sim[k * n + a] > nearestSim[k]) {
        nearest[k] = a
        nearestSim[k] = sim[k * n + a]
      }
    }
  }

  let groups = members.filter((m) => m.length > 0).sort((x, y) => y.length - x.length)
  // One odd line or two: into the nearest real group when nearly close enough.
  const kept = groups.filter((g) => g.length > SMALL_GROUP)
  if (kept.length > 0) {
    const keptCentroids = kept.map((g) => meanOf(g.map((i) => vectors[i])))
    for (const small of groups.filter((g) => g.length <= SMALL_GROUP)) {
      const centre = meanOf(small.map((i) => vectors[i]))
      let best = 0
      let bestSim = -2
      keptCentroids.forEach((c, k) => {
        const s = dot(c, centre)
        if (s > bestSim) {
          bestSim = s
          best = k
        }
      })
      if (bestSim >= threshold - SMALL_GROUP_SLACK) kept[best].push(...small)
      else kept.push(small)
    }
    groups = kept
  }

  const centroids = groups.map((g) => meanOf(g.map((i) => vectors[i])))
  const groupOf = new Int32Array(usable.length).fill(-1)
  groups.forEach((g, k) => g.forEach((i) => (groupOf[i] = k)))
  const likeness = new Float32Array(usable.length)
  for (let i = 0; i < usable.length; i++) {
    if (groupOf[i] >= 0) {
      likeness[i] = dot(centroids[groupOf[i]], vectors[i])
      continue
    }
    let best = 0
    let bestSim = -2
    centroids.forEach((c, k) => {
      const s = dot(c, vectors[i])
      if (s > bestSim) {
        bestSim = s
        best = k
      }
    })
    groupOf[i] = best
    likeness[i] = bestSim
  }

  return groups
    .map((_, k) => {
      const lines = usable.map((_, i) => i).filter((i) => groupOf[i] === k)
      const pitches = lines.map((i) => usable[i].f0).filter((f): f is number => typeof f === 'number' && f > 0)
      return {
        lineIds: lines.map((i) => usable[i].id),
        unsureIds: lines.filter((i) => likeness[i] < threshold + UNSURE_MARGIN).map((i) => usable[i].id),
        // The clearest lines: most like the voice, and long enough to hear it.
        sampleIds: [...lines]
          .sort((x, y) => likeness[y] * Math.min(usable[y].seconds, 4) - likeness[x] * Math.min(usable[x].seconds, 4))
          .slice(0, SAMPLES)
          .map((i) => usable[i].id),
        centroid: Array.from(centroids[k], (v) => Math.round(v * 1e5) / 1e5),
        f0Hz: median(pitches),
        genderScore: voiceGenderScore(lines.map((i) => vectors[i])),
        voicedRatio: lines.reduce((sum, i) => sum + (usable[i].voiced ?? 0), 0) / Math.max(1, lines.length),
        seconds: lines.reduce((sum, i) => sum + usable[i].seconds, 0)
      }
    })
    .sort((x, y) => y.lineIds.length - x.lineIds.length)
}

/** The male/female rule (castGenderRule.ts) over a group's prints: the
 * mean of each line's answer. Undefined for prints of another size. */
export function voiceGenderScore(prints: ArrayLike<number>[]): number | undefined {
  const { weights, offset } = VOICE_GENDER_RULE
  if (prints.length === 0 || prints.some((print) => print.length !== weights.length)) return undefined
  let sum = 0
  for (const print of prints) sum += dot(weights, print) + offset
  return sum / prints.length
}

/** A group is called male or female only this far from the line; nearer,
 * it is left unknown (shown as such, to be set by ear). On the series
 * test every group told right scored 0.02 or more either way. */
const GENDER_SURE = 0.015

/** Male or female for a voice group (never used for who is who): by the
 * rule fitted on voice prints; by median pitch only where the prints are
 * not the rule's kind. */
export function groupGender(group: Pick<VoiceGroup, 'f0Hz' | 'voicedRatio' | 'genderScore'>): { gender: SpeakerGender; confidence: number } {
  if (group.genderScore === undefined) return predictGender(group.f0Hz, Math.max(group.voicedRatio, group.f0Hz ? 0.5 : 0))
  if (Math.abs(group.genderScore) < GENDER_SURE) return { gender: 'unknown', confidence: 0 }
  return { gender: group.genderScore > 0 ? 'male' : 'female', confidence: Math.min(0.95, 0.5 + Math.abs(group.genderScore) * 4) }
}

/** Which of a group's lines to look for its face in: its clearest lines
 * that are long enough for the shot to be of the speaker, spread over the
 * video (two lines of one scene show the same picture). */
export function faceCandidates(sampleIds: string[], lines: Map<string, { path: string; start: number; end: number }>, most = 5): string[] {
  const picked: string[] = []
  for (const id of sampleIds) {
    const line = lines.get(id)
    if (!line || line.end - line.start < 0.8) continue
    const near = picked.some((other) => {
      const o = lines.get(other)
      return !!o && o.path === line.path && Math.abs((o.start + o.end) / 2 - (line.start + line.end) / 2) < 4
    })
    if (near) continue
    picked.push(id)
    if (picked.length >= most) break
  }
  // A voice with only short or bunched lines still gets a picture.
  for (const id of sampleIds) {
    if (picked.length >= Math.min(most, 2)) break
    if (!picked.includes(id) && lines.has(id)) picked.push(id)
  }
  return picked
}

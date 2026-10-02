// AI Dubber -- per-line PERFORMANCE: how a line is acted, not just who says
// it. Shared by the renderer (analysis fallback, UI, planning), the main
// process (prompt building, loudness) and, through the per-line job the
// main process writes, the VoxCPM2 runner (retry scoring).
//
// Why this exists: before it, every line of one voice went to VoxCPM2 with
// the same voice-level control ("... Do not perform dialogue ...") and the
// same seed, was accepted or retried on speaker similarity and pitch drift
// alone (so a shouted or crying take -- higher pitch -- was treated as "the
// wrong speaker"), pulled back toward the reference pitch, and levelled to
// the same -18 LUFS as a whisper. The result read like a script.
//
// Pipeline: lines -> buildLineContexts -> analyzer (Gemini with context, or
// analyzeLineByRules locally) -> LinePerformance on each line -> the main
// process builds a per-line control (buildLineControl) and an emotion
// profile (emotionProfile) the runner scores takes against -> loudness per
// emotion (lineLoudnessTargetLufs).

export const DUBBING_EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'fear', 'shocked', 'crying', 'excited', 'serious', 'calm', 'whisper', 'shout'] as const
export type DubbingEmotion = (typeof DUBBING_EMOTIONS)[number]

export const DUBBING_PACES = ['very_slow', 'slow', 'normal', 'fast', 'very_fast'] as const
export type DubbingPace = (typeof DUBBING_PACES)[number]

export const DUBBING_ENERGIES = ['low', 'medium', 'high'] as const
export type DubbingEnergy = (typeof DUBBING_ENERGIES)[number]

export type PauseLength = 'short' | 'medium' | 'long'

export interface PerformancePauseHint {
  /** The word (as written in the line) the pause comes after. */
  after: string
  duration: PauseLength
}

/** Where a line's performance came from. 'ai' = Gemini with context,
 * 'rules' = the local analyzer (punctuation, emotion tags, neighbours),
 * 'manual' = the user set it -- never overwritten by automatic analysis
 * until the user asks for Auto Detect on that line again. */
export type PerformanceSource = 'ai' | 'rules' | 'manual'

export interface LinePerformance {
  emotion: DubbingEmotion
  /** 0-100. */
  emotionIntensity: number
  /** A few words: "breathy, stunned, hesitant". */
  speakingStyle: string
  pace: DubbingPace
  energy: DubbingEnergy
  /** How the delivery moves through the line. */
  delivery: string
  pauseHints: PerformancePauseHint[]
  emphasisWords: string[]
  analysisSource: PerformanceSource
  /** Extra direction the user typed ("Performance Prompt"), appended to
   * the control as-is. */
  customPrompt?: string
}

export const EMOTION_LABELS: Record<DubbingEmotion, string> = {
  neutral: 'Neutral',
  happy: 'Happy',
  sad: 'Sad',
  angry: 'Angry',
  fear: 'Fear',
  shocked: 'Shocked',
  crying: 'Crying',
  excited: 'Excited',
  serious: 'Serious',
  calm: 'Calm',
  whisper: 'Whisper',
  shout: 'Shout'
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : fallback
}
const shortText = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)

/** A plain, conversational delivery -- what a line gets when nothing says
 * otherwise. Still "not reading": the control built from it asks for a
 * natural, spoken delivery. */
export function neutralPerformance(source: PerformanceSource = 'rules'): LinePerformance {
  return { emotion: 'neutral', emotionIntensity: 30, speakingStyle: 'natural, conversational', pace: 'normal', energy: 'medium', delivery: '', pauseHints: [], emphasisWords: [], analysisSource: source }
}

/** Validates anything that claims to be a LinePerformance -- Gemini output,
 * a project file, an imported SRT -- into a well-formed one, or null when
 * it isn't even an object with an emotion. Unknown enum values fall back to
 * the neutral default rather than failing the whole line. */
export function sanitizePerformance(raw: unknown, source?: PerformanceSource): LinePerformance | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.emotion !== 'string') return null
  const pauseHints = Array.isArray(value.pauseHints)
    ? value.pauseHints
        .map((hint) => (hint && typeof hint === 'object' ? (hint as Record<string, unknown>) : null))
        .filter((hint): hint is Record<string, unknown> => !!hint && typeof hint.after === 'string' && hint.after.trim().length > 0)
        .slice(0, 6)
        .map((hint) => ({ after: shortText(hint.after, 40), duration: oneOf(hint.duration, ['short', 'medium', 'long'] as const, 'short') }))
    : []
  const emphasisWords = Array.isArray(value.emphasisWords) ? value.emphasisWords.map((word) => shortText(word, 40)).filter(Boolean).slice(0, 6) : []
  const customPrompt = shortText(value.customPrompt, 400)
  return {
    emotion: oneOf(value.emotion, DUBBING_EMOTIONS, 'neutral'),
    emotionIntensity: clampInt(value.emotionIntensity, 0, 100, 50),
    speakingStyle: shortText(value.speakingStyle, 120),
    pace: oneOf(value.pace, DUBBING_PACES, 'normal'),
    energy: oneOf(value.energy, DUBBING_ENERGIES, 'medium'),
    delivery: shortText(value.delivery, 240),
    pauseHints,
    emphasisWords,
    analysisSource: source ?? oneOf(value.analysisSource, ['ai', 'rules', 'manual'] as const, 'rules'),
    ...(customPrompt ? { customPrompt } : {})
  }
}

// ---------------------------------------------------------------------------
// Emotion tags in subtitle text: "(យំ)", "[laughs]" ...
// cleanTextForSpeech (renderer/src/dubbing/ttsTextCleaning.ts) removes every
// bracketed note before the text reaches the voice engine -- which used to
// throw away the only emotion cue an SRT has. They are read here FIRST.

const TAG_RULES: Array<[RegExp, DubbingEmotion]> = [
  [/យំ|សោក|crying|cries|cry|sob|sobbing|tearful|哭|泣/i, 'crying'],
  [/សើច|laugh|laughs|laughing|giggle|chuckle|笑/i, 'happy'],
  [/ស្រែក|shout|shouting|shouts|yell|yelling|scream|screaming|喊|吼|叫/i, 'shout'],
  [/ខ្សឹប|whisper|whispers|whispering|murmur|低声|小声/i, 'whisper'],
  [/ភ័យ|ខ្លាច|fear|afraid|scared|terrified|trembl|害怕|恐惧/i, 'fear'],
  [/ខឹង|angry|anger|furious|rage|growl|生气|愤怒/i, 'angry'],
  [/ភ្ញាក់ផ្អើល|gasp|gasps|shocked|surprised|惊/i, 'shocked'],
  [/កំសត់|sad|sigh|sighs|sadly|伤心|叹/i, 'sad'],
  [/រំភើប|excited|cheer|cheering|兴奋/i, 'excited']
]

const BRACKETED_NOTE = /[([（【]([^)\]）】]*)[)\]）】]/g

/** The emotions named by the bracketed notes in a line, in order, plus the
 * raw note texts (for the analyzer's context). */
export function extractEmotionTags(text: string): { emotions: DubbingEmotion[]; tags: string[] } {
  const emotions: DubbingEmotion[] = []
  const tags: string[] = []
  for (const match of text.matchAll(BRACKETED_NOTE)) {
    const note = match[1].trim()
    if (!note) continue
    tags.push(note)
    for (const [pattern, emotion] of TAG_RULES) {
      if (pattern.test(note)) {
        if (!emotions.includes(emotion)) emotions.push(emotion)
        break
      }
    }
  }
  return { emotions, tags }
}

// ---------------------------------------------------------------------------
// Context builder

export interface PerformanceInputLine {
  id: string
  /** The line as written (tags included) -- analysis reads the tags. */
  text: string
  /** Display name of whoever says it, when known. */
  speaker?: string
  isNarrator?: boolean
  startTime: number
  endTime: number
}

export interface ContextNeighbour {
  speaker?: string
  text: string
}

export interface LineContext {
  id: string
  text: string
  speaker?: string
  isNarrator?: boolean
  durationSeconds: number
  /** Trailing punctuation of the line ("!", "?!", "…"). */
  punctuation: string
  tagEmotions: DubbingEmotion[]
  tags: string[]
  previous: ContextNeighbour[]
  next: ContextNeighbour[]
  previousSpeaker?: string
  nextSpeaker?: string
}

export const CONTEXT_WINDOW_LINES = 3

/** Trailing punctuation, normalized: "!!!" -> "!", "?!" stays, "..." -> "…". */
export function punctuationOf(text: string): string {
  const stripped = text.replace(BRACKETED_NOTE, '').trim()
  const match = /[!?！？.。…។៕,，~\-—]+$/u.exec(stripped)
  if (!match) return ''
  const marks = match[0].replace(/\.{2,}/g, '…').replace(/！/g, '!').replace(/？/g, '?')
  const hasQ = marks.includes('?')
  const hasX = marks.includes('!')
  if (hasQ && hasX) return '?!'
  if (hasX) return '!'
  if (hasQ) return '?'
  if (marks.includes('…')) return '…'
  if (/[—\-~]/.test(marks)) return '—'
  return marks.slice(-1)
}

/** For every line: the lines around it (±CONTEXT_WINDOW_LINES), who speaks
 * before and after, how long it has on screen, its punctuation and tags.
 * The analyzer never sees a line alone -- that is what keeps a scene's
 * emotion continuous instead of line-by-line coin flips. */
export function buildLineContexts(lines: PerformanceInputLine[], window = CONTEXT_WINDOW_LINES): LineContext[] {
  return lines.map((line, index) => {
    const tags = extractEmotionTags(line.text)
    const neighbour = (other: PerformanceInputLine): ContextNeighbour => ({ speaker: other.speaker, text: other.text.replace(/\s+/g, ' ').trim() })
    return {
      id: line.id,
      text: line.text.replace(/\s+/g, ' ').trim(),
      speaker: line.speaker,
      isNarrator: line.isNarrator,
      durationSeconds: Math.max(0, Math.round((line.endTime - line.startTime) * 100) / 100),
      punctuation: punctuationOf(line.text),
      tagEmotions: tags.emotions,
      tags: tags.tags,
      previous: lines.slice(Math.max(0, index - window), index).map(neighbour),
      next: lines.slice(index + 1, index + 1 + window).map(neighbour),
      previousSpeaker: lines[index - 1]?.speaker,
      nextSpeaker: lines[index + 1]?.speaker
    }
  })
}

// ---------------------------------------------------------------------------
// Local analyzer: what a line gets without Gemini (no key, offline, out of
// credits) and what Generate uses for any line nobody analyzed. Reads the
// emotion tags first, then punctuation and length, then the neighbours for
// continuity. Deliberately conservative: a plain line stays neutral.

const STYLE_BY_EMOTION: Record<DubbingEmotion, { style: string; pace: DubbingPace; energy: DubbingEnergy; delivery: string; intensity: number }> = {
  neutral: { style: 'natural, conversational', pace: 'normal', energy: 'medium', delivery: '', intensity: 30 },
  calm: { style: 'calm, gentle, relaxed', pace: 'slow', energy: 'low', delivery: 'even and unhurried', intensity: 35 },
  serious: { style: 'firm, serious, measured', pace: 'normal', energy: 'medium', delivery: 'steady, weight on the key words', intensity: 50 },
  happy: { style: 'warm, bright, smiling', pace: 'normal', energy: 'medium', delivery: 'light and lively, a smile in the voice', intensity: 60 },
  excited: { style: 'excited, eager, bright', pace: 'fast', energy: 'high', delivery: 'rising energy, quick and animated', intensity: 70 },
  sad: { style: 'sad, soft, heavy', pace: 'slow', energy: 'low', delivery: 'quiet and heavy, trailing off at the end', intensity: 60 },
  crying: { style: 'crying, choked, trembling', pace: 'slow', energy: 'low', delivery: 'voice breaking, uneven breaths, trembling', intensity: 80 },
  fear: { style: 'afraid, tense, shaky', pace: 'fast', energy: 'medium', delivery: 'tense and breathy, voice unsteady', intensity: 70 },
  shocked: { style: 'stunned, breathy, disbelieving', pace: 'slow', energy: 'medium', delivery: 'starts caught off guard, then more urgent', intensity: 70 },
  angry: { style: 'angry, hard, forceful', pace: 'fast', energy: 'high', delivery: 'sharp and forceful, hitting the key words hard', intensity: 75 },
  shout: { style: 'shouting, loud, projected', pace: 'fast', energy: 'high', delivery: 'full voice, projected across a distance', intensity: 85 },
  whisper: { style: 'whispering, hushed, breathy', pace: 'slow', energy: 'low', delivery: 'barely voiced, close and secretive', intensity: 70 }
}

function performanceFor(emotion: DubbingEmotion, intensity: number, source: PerformanceSource): LinePerformance {
  const s = STYLE_BY_EMOTION[emotion]
  return { emotion, emotionIntensity: Math.round(Math.min(100, Math.max(0, intensity))), speakingStyle: s.style, pace: s.pace, energy: s.energy, delivery: s.delivery, pauseHints: [], emphasisWords: [], analysisSource: source }
}

export function analyzeLineByRules(ctx: LineContext): LinePerformance {
  const plain = ctx.text.replace(BRACKETED_NOTE, '').trim()
  // 1. What the subtitle says outright.
  if (ctx.tagEmotions.length > 0) {
    const emotion = ctx.tagEmotions[0]
    const boost = ctx.punctuation === '!' || ctx.punctuation === '?!' ? 10 : 0
    return performanceFor(emotion, STYLE_BY_EMOTION[emotion].intensity + boost, 'rules')
  }
  // 2. Punctuation and shape.
  const exclamations = (plain.match(/[!！]/g) ?? []).length
  const latin = plain.replace(/[^A-Za-z]/g, '')
  const allCaps = latin.length >= 4 && latin === latin.toUpperCase()
  if (ctx.punctuation === '?!' || /!\?|\?!/.test(plain)) return performanceFor('shocked', 72, 'rules')
  if (allCaps || exclamations >= 2) return performanceFor('shout', 80, 'rules')
  if (ctx.punctuation === '!') {
    // An exclamation inside an already-heated exchange is anger; alone it is emphasis.
    const heated = [...ctx.previous, ...ctx.next].some((n) => /[!！]/.test(n.text) || extractEmotionTags(n.text).emotions.some((e) => e === 'angry' || e === 'shout'))
    return heated ? performanceFor('angry', 70, 'rules') : performanceFor('excited', 55, 'rules')
  }
  if (ctx.punctuation === '…' || ctx.punctuation === '—') {
    const p = performanceFor('sad', 45, 'rules')
    return { ...p, speakingStyle: 'hesitant, trailing off', delivery: 'hesitant, letting the end trail away' }
  }
  if (ctx.punctuation === '?') {
    const p = neutralPerformance('rules')
    return { ...p, speakingStyle: 'natural, questioning', delivery: 'genuinely asking, rising at the end' }
  }
  return neutralPerformance('rules')
}

/** Rules analysis for a whole script, with continuity: a plain line between
 * two lines of the same strong emotion from the same speaker inherits it at
 * lower intensity, instead of snapping to neutral in the middle of a fight
 * or a crying scene. */
export function analyzePerformancesByRules(lines: PerformanceInputLine[]): Record<string, LinePerformance> {
  const contexts = buildLineContexts(lines)
  const raw = contexts.map(analyzeLineByRules)
  const out: Record<string, LinePerformance> = {}
  contexts.forEach((ctx, i) => {
    let perf = raw[i]
    if (perf.emotion === 'neutral') {
      const before = raw[i - 1]
      const after = raw[i + 1]
      const sameSpeaker = (j: number): boolean => !ctx.speaker || contexts[j]?.speaker === ctx.speaker
      if (before && after && before.emotion === after.emotion && before.emotion !== 'neutral' && sameSpeaker(i - 1) && sameSpeaker(i + 1)) {
        perf = performanceFor(before.emotion, Math.round((before.emotionIntensity + after.emotionIntensity) / 2) - 20, 'rules')
      }
    }
    out[ctx.id] = perf
  })
  return out
}

// ---------------------------------------------------------------------------
// Prompt builder -- the control text VoxCPM2 receives, per line.

/** The identity half of every control: WHO speaks. Short on purpose. The
 * old lock ("STRICT VOICE LOCK ... Do not perform dialogue ...") was long and
 * forbade acting; the reference clip pins the voice, this sentence only
 * keeps the model from switching to another person. */
export const VOICE_IDENTITY_LOCK = 'Keep exactly the same speaker identity, gender, age, and vocal character as the reference voice. Do not switch speaker or imitate another person. Speak only the provided subtitle content.'

const PACE_WORDS: Record<DubbingPace, string> = { very_slow: 'very slow', slow: 'slow', normal: 'natural', fast: 'fast', very_fast: 'very fast' }

/** The performance half: how THIS line is acted. One line of text -- the
 * runner's input is one job per line and VoxCPM2 reads the control as
 * "(control)text". */
export function buildPerformanceInstruction(p: LinePerformance): string {
  const parts: string[] = []
  if (p.emotion === 'neutral' && p.emotionIntensity <= 40 && !p.delivery && !p.customPrompt && p.pauseHints.length === 0 && p.emphasisWords.length === 0) {
    parts.push('Performance: natural conversational delivery, like a real person talking in the scene.')
  } else {
    parts.push(`Performance: emotion ${p.emotion}, intensity ${p.emotionIntensity}/100.`)
    if (p.speakingStyle) parts.push(`Style: ${p.speakingStyle}.`)
    parts.push(`Pace: ${PACE_WORDS[p.pace]}. Energy: ${p.energy}.`)
    if (p.delivery) parts.push(`Delivery: ${p.delivery}.`)
    if (p.pauseHints.length > 0) parts.push(`Pause ${p.pauseHints.map((h) => `${h.duration === 'short' ? 'briefly' : h.duration === 'long' ? 'clearly' : 'a moment'} after "${h.after}"`).join(', ')}.`)
    if (p.emphasisWords.length > 0) parts.push(`Stress ${p.emphasisWords.map((w) => `"${w}"`).join(', ')}.`)
  }
  if (p.customPrompt) parts.push(p.customPrompt.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().replace(/([^.!?])$/, '$1.'))
  parts.push('Use natural conversational timing and pauses. Do not sound like reading a script.')
  return parts.join(' ')
}

/** The full per-line control. `voiceDescription` is a catalog voice's own
 * short description ("adult male Khmer voice, deep"); a recorded voice has
 * none -- its reference clip IS the description. Parentheses are removed:
 * VoxCPM2 reads the control as "(control)text", so a ")" inside would end
 * it early and the rest would be spoken aloud. */
export function buildLineControl(voiceDescription: string | undefined, performance: LinePerformance): string {
  const identity = voiceDescription ? `${VOICE_IDENTITY_LOCK} Voice: ${voiceDescription.replace(/[()]/g, ' ').trim()}.` : VOICE_IDENTITY_LOCK
  return `${identity} ${buildPerformanceInstruction(performance)}`.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Emotion profiles -- what the runner accepts, and what post-processing does.

export interface EmotionProfile {
  emotion: DubbingEmotion
  intensity: number
  /** Semitones a take's median pitch may sit from the reference's before it
   * counts as another speaker. null = pitch is not a reason to retry at all
   * (shouting, crying, whispering move pitch legitimately). */
  pitchToleranceSemitones: number | null
  /** Pull the kept take's pitch back toward the reference afterwards.
   * Only for neutral lines -- on an expressive one it undoes the acting. */
  pitchCorrect: boolean
  /** Speaker-similarity floor. Shouting, crying and whispering change a
   * voice's spectrum, so the same person scores lower on them. */
  similarityFloor: number
  /** Whisper has little or no voiced pitch -- never judge it on f0. */
  usePitch: boolean
  /** What "acted" looks like for this emotion, as the runner measures it:
   *  'raise'   median pitch raised above the reference voice's
   *            (angry, shout, excited, shocked, happy)
   *  'whisper' a low voiced share
   *  'none'    not judged (neutral, calm, serious, sad, crying, fear --
   *            a calm take may be calm; crying may go up or down)
   * Measured on VoxCPM2 itself: acted angry/shocked/shout takes sat +2..+8
   * semitones above the reference, flat ones around 0; whispered takes
   * were 0.45 voiced against 0.6+ when merely spoken quietly. */
  expression: 'raise' | 'whisper' | 'none'
  /** Semitones of raise that count as fully acted ('raise' only). */
  targetRaiseSt: number | null
  /** Retry a take whose expression came out under half of that (or, for a
   * whisper, still mostly voiced). Only for strongly-acted lines
   * (intensity >= 60) -- a mild line is never rejected for being mild. */
  flatCheck: boolean
  /** The two halves of a take must agree at least this much (speaker
   * similarity): the voice may not change part-way through a line. */
  consistencyFloor: number
}

const EXPRESSIVE: DubbingEmotion[] = ['angry', 'shout', 'excited', 'crying', 'fear', 'shocked', 'happy', 'sad', 'whisper']

export function isExpressiveEmotion(emotion: DubbingEmotion): boolean {
  return EXPRESSIVE.includes(emotion)
}

/** The standard (pre-performance) acceptance values -- the ones neutral and
 * calm lines still use. Same numbers as voxcpmTts.ts's
 * VOICE_MATCH_THRESHOLD / VOICE_PITCH_TOLERANCE_SEMITONES. */
export const NEUTRAL_SIMILARITY_FLOOR = 0.8
export const NEUTRAL_PITCH_TOLERANCE = 2
/** First half vs second half of a take (voxcpm_batch_runner.py's
 * VoiceMatcher.halves): measured 0.75-0.9 on takes that kept one voice
 * (median 0.82), 0.68-0.73 on takes whose voice changed part-way. */
export const VOICE_CONSISTENCY_FLOOR = 0.74

/** The VOICE comes first, emotion second. Every emotion keeps a pitch
 * limit and a similarity floor close to neutral's, because both were
 * measured to be what "the same person" means on this model (72 takes):
 * speaker similarity to the voice averaged 0.90 for takes within 0-4
 * semitones of the reference pitch, 0.87 at 4-6 st (lowest 0.76) and 0.83
 * beyond -- the old notes' "148 Hz one line, 211 Hz the next = another
 * speaker". So a line may be acted up to ~4 st above the voice's own
 * pitch, never more; a take past its limit is retried, and whatever still
 * exceeds it is pulled back to the limit (not to neutral). */
export function emotionProfile(p: LinePerformance | undefined, options: { voiceLock?: boolean } = {}): EmotionProfile {
  const profile = emotionProfileFor(p)
  return options.voiceLock ? lockedProfile(profile) : profile
}

/** Settings > Voice tone > Locked: the voice matters more than the acting.
 * Every emotion keeps only ~60% of its pitch room (never under neutral's
 * 2 st), the similarity floor goes up by 0.02, and the halves must agree a
 * little more -- a take has to stay closer to the character's own voice to
 * be kept, so lines sound more alike and less acted. */
export function lockedProfile(profile: EmotionProfile): EmotionProfile {
  const tolerance = profile.pitchToleranceSemitones === null ? null : Math.max(NEUTRAL_PITCH_TOLERANCE, Math.round(profile.pitchToleranceSemitones * 0.6 * 10) / 10)
  return {
    ...profile,
    pitchToleranceSemitones: tolerance,
    similarityFloor: Math.round((profile.similarityFloor + 0.02) * 100) / 100,
    consistencyFloor: Math.round((profile.consistencyFloor + 0.02) * 100) / 100,
    targetRaiseSt: profile.targetRaiseSt === null || tolerance === null ? profile.targetRaiseSt : Math.round(Math.min(profile.targetRaiseSt, tolerance * 0.85) * 100) / 100
  }
}

function emotionProfileFor(p: LinePerformance | undefined): EmotionProfile {
  const emotion = p?.emotion ?? 'neutral'
  const intensity = Math.min(100, Math.max(0, p?.emotionIntensity ?? 30))
  const k = intensity / 100
  const strong = intensity >= 60
  const base: EmotionProfile = {
    emotion,
    intensity,
    pitchToleranceSemitones: NEUTRAL_PITCH_TOLERANCE,
    pitchCorrect: true,
    similarityFloor: NEUTRAL_SIMILARITY_FLOOR,
    usePitch: true,
    expression: 'none',
    targetRaiseSt: null,
    flatCheck: false,
    consistencyFloor: VOICE_CONSISTENCY_FLOOR
  }
  // An acted take is expected to rise, but its target always stays inside
  // the voice's pitch limit -- expression can never ask for a new voice.
  const raise = (limit: number, min: number, span: number): Pick<EmotionProfile, 'expression' | 'targetRaiseSt' | 'flatCheck'> => ({
    expression: 'raise',
    targetRaiseSt: Math.round(Math.min(limit * 0.85, min + span * k) * 100) / 100,
    flatCheck: strong
  })
  switch (emotion) {
    case 'neutral':
    case 'calm':
    case 'serious':
      return base
    case 'happy':
      return { ...base, pitchToleranceSemitones: 3, pitchCorrect: false, ...raise(3, 0.8, 1.2), flatCheck: intensity >= 70 }
    case 'sad':
      return { ...base, pitchToleranceSemitones: 3, pitchCorrect: false }
    case 'shocked':
      return { ...base, pitchToleranceSemitones: 4, pitchCorrect: false, ...raise(4, 1.2, 2) }
    case 'excited':
    case 'angry':
      return { ...base, pitchToleranceSemitones: 4, pitchCorrect: false, ...raise(4, 1.2, 2.2) }
    case 'shout':
      return { ...base, pitchToleranceSemitones: 4.5, pitchCorrect: false, similarityFloor: 0.78, ...raise(4.5, 1.5, 2.5) }
    case 'crying':
    case 'fear':
      return { ...base, pitchToleranceSemitones: 3.5, pitchCorrect: false, similarityFloor: 0.78 }
    case 'whisper':
      return { ...base, pitchToleranceSemitones: null, pitchCorrect: false, similarityFloor: 0.78, usePitch: false, expression: 'whisper', flatCheck: strong }
  }
}

/** The same performance, held back: what the runner's last-resort "safe"
 * take is told when every normal take drifted off the character's voice.
 * Same emotion (the line still means the same), at most intensity 40, no
 * dramatic delivery or extra direction -- measured: the far-off takes were
 * the most extreme ones (+6.6..+9.2 st, similarity 0.54-0.77). */
export function restrainedPerformance(p: LinePerformance): LinePerformance {
  return {
    ...p,
    emotionIntensity: Math.min(p.emotionIntensity, 40),
    speakingStyle: p.speakingStyle ? `restrained, ${p.speakingStyle}` : 'restrained',
    delivery: '',
    pauseHints: [],
    customPrompt: undefined
  }
}

/** Loudness each line is brought to. The old master put EVERY line at -18
 * LUFS, so a whisper came out as loud as a shout. Offsets from -18 LU, grown
 * with intensity (at intensity 0 half the offset, at 100 all of it). The
 * true-peak ceiling and limiter in dubbingMaster.ts still hold every line --
 * a shout is louder, never clipped.
 *
 * Kept small on purpose: the first table (whisper -9, calm -2.5, angry +3,
 * shout +5) measured 13 dB between lines of one episode -- calm lines at
 * -23 to -28 dB against angry ones at -16 -- and over music that reads as
 * uneven volume, not as acting. The acting is in the voice; loudness only
 * leans with it. */
const LOUDNESS_OFFSET_LU: Record<DubbingEmotion, number> = {
  whisper: -4.5,
  sad: -1.5,
  crying: -1,
  calm: -1,
  fear: -0.75,
  neutral: 0,
  serious: 0,
  shocked: 0.25,
  happy: 0.5,
  excited: 1,
  angry: 1.5,
  shout: 2.5
}

export const DUB_STANDARD_LUFS = -18

export function lineLoudnessTargetLufs(p: LinePerformance | undefined): number {
  if (!p) return DUB_STANDARD_LUFS
  const k = Math.min(1, Math.max(0, p.emotionIntensity / 100))
  const offset = LOUDNESS_OFFSET_LU[p.emotion] * (0.5 + 0.5 * k)
  return Math.round((DUB_STANDARD_LUFS + offset) * 10) / 10
}

/** How many dB of peak the limiter may take off a line so a loud
 * performance can actually reach its level (see dubbingMaster.ts's
 * computeMasterGainDb). 0 for everything that is not meant to be loud. */
export function lineLimiterAllowanceDb(p: LinePerformance | undefined): number {
  if (!p) return 0
  const k = Math.min(1, Math.max(0, p.emotionIntensity / 100))
  if (p.emotion === 'shout') return Math.round(5 * (0.5 + 0.5 * k) * 10) / 10
  if (p.emotion === 'angry' || p.emotion === 'excited') return Math.round(3 * (0.5 + 0.5 * k) * 10) / 10
  return 0
}

/** Two neighbouring lines may be read as one take only when they are acted
 * the same way -- a take has one control. */
export function samePerformance(a: LinePerformance | undefined, b: LinePerformance | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.emotion === b.emotion && Math.abs(a.emotionIntensity - b.emotionIntensity) <= 15 && a.pace === b.pace && a.energy === b.energy && (a.customPrompt ?? '') === (b.customPrompt ?? '') && a.delivery === b.delivery
}

/** What the runner and the post-processing report back per line. */
export interface DubbingLineDebug {
  voiceId: string
  emotion?: DubbingEmotion
  intensity?: number
  style?: string
  pace?: DubbingPace
  energy?: DubbingEnergy
  /** The exact control VoxCPM2 received (null = none). */
  control: string | null
  seed?: number
  /** 1-based attempt that was kept, of `attempts`. */
  attempt?: number
  attempts?: number
  similarity?: number | null
  pitchDriftSt?: number | null
  pitchVariationSt?: number | null
  energyVariationDb?: number | null
  expressiveness?: number | null
  naturalness?: number | null
  timing?: number | null
  score?: number | null
  flat?: boolean
  generatedSeconds?: number
  loudnessTargetLufs?: number
  pitchCorrectionSt?: number
}

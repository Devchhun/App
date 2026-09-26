import { app } from 'electron'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { GoogleGenAI, FileState } from '@google/genai'
import { runFfmpeg, cancelJob, CanceledError } from '../media/jobRunner'
import {
  mergeNarrationScenes,
  narrativeMediaRange,
  planVideoChunks,
  type RegenerateNarrationSceneRequest,
  type VideoStoryNarrationProgress,
  type VideoStoryNarrationRequest,
  type VideoStoryNarrationResult,
  type VideoStoryNarrationScene
} from '@shared/videoStoryNarration'
import type { TranscriptSegment } from '@shared/transcription'
import { getGeminiApiKey } from './geminiApiKeyStore'
import { explainGeminiError, isRetryableError, sleepUnlessCanceled } from './geminiErrors'

const active = new Map<string, AbortController>()
const activeFfmpeg = new Map<string, string>()
const MODEL = process.env.GEMINI_VIDEO_MODEL?.trim() || 'gemini-2.5-flash'
// Actor/action attribution degrades when too many character exchanges are
// packed into one upload. Ninety-second chunks keep enough continuity for a
// story beat while letting the model inspect gestures and identify who did
// each action instead of compressing several people into one vague summary.
const MAX_CHUNK_SECONDS = 90
/** A dropped connection mid-upload used to end the whole job with a bare
 * "fetch failed". The upload + model call of a chunk are retried instead;
 * the encode is not repeated. */
const MAX_NETWORK_ATTEMPTS = 3
const RETRY_DELAYS_MS = [3000, 8000]
/** gemini-2.5-flash's own output ceiling, stated so it is not left to a
 * default, with thinking capped well inside it. */
const NARRATION_MAX_OUTPUT_TOKENS = 65536
const NARRATION_THINKING_BUDGET = 8192
/** Recovery for an answer that stopped before its JSON closed: re-ask only
 * for the time not yet covered (at least this long), or split a chunk no
 * shorter than MIN_SPLIT_SECONDS in two -- at most this many levels deep. */
const MIN_RECOVERY_SECONDS = 6
const MIN_SPLIT_SECONDS = 24
const MAX_RECOVERY_DEPTH = 2

function fmtRange(start: number, end: number): string {
  const f = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  return `${f(start)}–${f(end)}`
}

interface CharacterIdentityLock {
  canonicalName: string
  aliases: string[]
  visualIdentity: string
}

interface AnalyzedRange {
  scenes: VideoStoryNarrationScene[]
  identityLocks: CharacterIdentityLock[]
}

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scenes', 'characterIdentities'],
  properties: {
    characterIdentities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['canonicalName', 'aliases', 'visualIdentity'],
        properties: {
          canonicalName: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
          visualIdentity: { type: 'string' }
        }
      }
    },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['startTime', 'endTime', 'dialogueSummary', 'visibleAction', 'khmerNarration', 'confidence'],
        properties: {
          startTime: { type: 'number' },
          endTime: { type: 'number' },
          dialogueSummary: { type: 'string' },
          visibleAction: { type: 'string' },
          khmerNarration: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        }
      }
    }
  }
}

const languageRepairSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['repairs'],
  properties: {
    repairs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'dialogueSummary', 'visibleAction', 'khmerNarration'],
        properties: {
          id: { type: 'string' },
          dialogueSummary: { type: 'string' },
          visibleAction: { type: 'string' },
          khmerNarration: { type: 'string' }
        }
      }
    }
  }
}

const OBVIOUS_ENGLISH_WORD = /\b(?:brother|sister|father|mother|handsome|beautiful|come|only|then|even|still|want|help|half|died|early|damn|such|there|with|without|because|before|after|how|what|when|where|this|that|these|those|have|has|had|can|could|would|should|boy|girl|man|woman)\b/i

/** Confirmed proper names may intentionally stay Romanized, but Han
 * characters, parenthetical English glosses, and ordinary English prose may
 * never leak into the final Khmer voiceover. */
export function narrationNeedsLanguageRepair(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text) || /\([^)]*[A-Za-z][^)]*\)/u.test(text) || OBVIOUS_ENGLISH_WORD.test(text)
}

function scenesNeedLanguageRepair(scenes: VideoStoryNarrationScene[]): boolean {
  return scenes.some((scene) =>
    [scene.dialogueSummary, scene.visibleAction, scene.khmerNarration].some(narrationNeedsLanguageRepair)
  )
}

function assertNotCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new CanceledError()
}

function srtExcerpt(segments: TranscriptSegment[], startTime: number, endTime: number): string {
  const rows = segments
    .filter((segment) => segment.endTime >= startTime && segment.startTime <= endTime)
    .map((segment, index) => {
      const localStart = Math.max(0, segment.startTime - startTime)
      const localEnd = Math.max(localStart, segment.endTime - startTime)
      return `[SRT-${index + 1} | clip ${localStart.toFixed(3)}-${localEnd.toFixed(3)}s | original ${segment.startTime.toFixed(3)}-${segment.endTime.toFixed(3)}s] ${segment.editedText ?? segment.text}`
    })
  return rows.length ? rows.join('\n') : '(No dialogue in this range.)'
}

/** The chunk-local excerpt aligns words to pictures, while this whole-story
 * reference lets a later subtitle resolve an earlier person's name,
 * relationship, or already-established purpose. Without it, each 90-second
 * request was forced to forget facts confirmed outside its own upload. */
function fullStorySrtReference(segments: TranscriptSegment[]): string {
  if (segments.length === 0) return '(No full-story SRT was supplied.)'
  return segments
    .map((segment, index) => `[FULL-SRT-${index + 1} | ${segment.startTime.toFixed(3)}-${segment.endTime.toFixed(3)}s] ${segment.editedText ?? segment.text}`)
    .join('\n')
}

/** Exported so the prompt contract can be tested without calling Gemini. */
export function buildPrompt(args: {
  startTime: number
  endTime: number
  segments: TranscriptSegment[]
  characterContext: string
  previousNarration?: string
  regeneration?: boolean
  firstChunk?: boolean
  identityLocks?: CharacterIdentityLock[]
}): string {
  const duration = args.endTime - args.startTime
  // One scene becomes one short paragraph of the finished script, so the
  // budget has to be generous enough for every gesture to get its own beat
  // instead of several actions being squashed into one vague sentence.
  const maxScenes = Math.max(6, Math.min(26, Math.ceil(duration / 6)))
  return `You are an accuracy-first editor creating a detailed, natural Khmer story recap from an attached VIDEO CLIP and its SRT evidence.
Return JSON matching the schema. All startTime/endTime values MUST be absolute seconds in the original video, inside ${args.startTime.toFixed(3)}-${args.endTime.toFixed(3)}.

TIMELINE MAPPING (critical): the attached clip starts at local 0.000s, which equals original-video ${args.startTime.toFixed(3)}s. Each SRT row below supplies BOTH clip-local and original-video timestamps. Match pictures to dialogue using the clip-local timestamp, but return original-video timestamps.

STORY-AGNOSTIC MODE (mandatory):
- This workflow must work for any story, country, language, period, or genre: modern, historical, fantasy, cultivation, romance, comedy, crime, mystery, horror, action, animation, documentary-style fiction, or mixed genre.
- Begin every new source video with an empty story model. Learn its cast, aliases, relationships, world rules, ranks, factions, places, objects, powers, and terminology only from THIS video's SRT, optional user context, and visible evidence.
- Never assume that a visual trope has the same meaning across stories. A costume does not prove a rank, a glow does not prove magic, a uniform does not prove an occupation, and a familiar genre pattern does not prove a relationship or motive.
- The CONTENT changes for every story, but the RECAP FORM stays fixed: brief intro once -> chronological scene setup -> confirmed actor -> concrete action/gesture -> SRT-backed dialogue or meaning -> immediate result -> natural transition.
- Preserve story-specific terminology instead of forcing it into terminology from another genre. Translate ordinary meaning into natural Khmer; keep a confirmed proper name or untranslatable named term in its locked canonical form.

Rules:
1. SRT IS THE PRIMARY AND AUTHORITATIVE SOURCE for plot, dialogue, names, relationships, motives, history, causes, and consequences. Translate its meaning accurately into Khmer before summarizing it. Never replace SRT meaning with a visual guess.
2. VIDEO IS SUPPORTING EVIDENCE ONLY for clearly visible present-tense actions, gestures, obvious facial expressions, location changes, doors, entries/exits, fights, powers, and important visible events. A picture alone is not evidence of identity, relationship, motive, backstory, or dialogue.
3. Every plot fact in dialogueSummary and khmerNarration must be directly supported by supplied SRT/context. Clearly visible actions may be narrated even during a dialogue-free interval, but they must stay literal observations and must not introduce names, motives, relationships, causes, or consequences the SRT does not supply. A reaction physically shown on screen -- tears, a smile, a flinch, kneeling, a shocked or angry face, a hand covering someone's mouth, turning away -- IS such an observation: narrate what the character visibly shows ("X ឃើញបែបនោះ ក៏ភ័យយ៉ាងខ្លាំង"), never a hidden thought, plan, or feeling.
4. Never invent, predict, reinterpret, or dramatize events. Never guess a speaker, name, unseen feeling, intention, relationship, off-screen event, or identity. Use neutral references when uncertain.
5. Omit production logos, legal cards, opening/ending themes, promotional montages, repeated establishing shots, and credits unless the supplied SRT clearly makes them part of the plot.
6. Combine adjacent SRT lines only when the SAME characters, place, action, and immediate event continue. Start a new scene whenever the acting character changes, an object changes hands, someone enters/exits, a reaction changes the situation, a fight/power/action begins or ends, or the story moves to a new place or time. Do NOT merge different actors' actions into one vague beat. Return at most ${maxScenes} meaningful scenes for this ${duration.toFixed(1)} second clip.
7. ACTOR-ACTION ACCURACY IS MANDATORY. For every visible event, verify in order: WHO performs it -> WHAT exact action/gesture they perform -> WHO/WHAT receives or is affected by it -> WHAT immediately visible result follows. Never transfer one character's action, words, object, reaction, or outcome to another character.
8. visibleAction must be a complete, literal subject-action-object statement for that exact time range. Name the confirmed character. If identity is not confirmed, use a stable neutral visual reference such as "the man holding the sword" or "the woman beside the door"; never guess a name. Avoid ambiguous subjects such as "he", "she", or "they" when more than one possible person is visible.
9. khmerNarration must be fluent, natural spoken Khmer and must combine the grounded SRT meaning with the clearly visible character actions in exact chronological order. It may be detailed enough to preserve every story-relevant gesture, exchange, entrance/exit, attack, defense, use of an object/power, and clear reaction. Avoid repetition and decorative appearance descriptions.
10. Before returning each scene, silently cross-check its beginning, middle, and end against the video and SRT. If actor identity or action direction remains uncertain, state it neutrally and lower confidence instead of choosing a character.
11. Confidence is 0-1. Lower it whenever speaker identity, action ownership, action target/direction, translation, timing, or visual evidence is uncertain.
${args.regeneration ? '12. Regenerate only this requested scene range; do not expand outside it.' : ''}

NO DOUBLE-TELLING ACROSS SCENES:
- Read the previous narration and every scene you are returning as one continuous script. Each action, shouted line, explanation, relationship, and plot fact must be narrated exactly once at the earliest scene where it belongs.
- Two differently worded sentences that describe the same event are still duplicates. Do not describe an action plus a group's reaction in one scene and then repeat the same reaction plus action in reverse order in the next scene. Keep that complete beat once, then advance to the next new event.
- A later scene may refer briefly to an earlier event only when a new consequence requires it; it must never retell the full earlier event.

SPEAKER, INNER-VOICE, AND TERMINOLOGY FIDELITY:
- Determine separately whether a line is spoken aloud, shouted by a visible group, an off-screen character's speech, or a character's inner voice. Do not label every voice-over as the storyteller/narrator.
- When the evidence identifies a line as a confirmed character's private thought or inner voice, attribute it to that exact character with natural Khmer meaning “the character thought to themself”, not as “the narrator continued”. Never convert a character's thought into an objective plot fact.
- Preserve exact story concepts and ranks from SRT/context. “Immortal” must be translated as “អមតៈ”; “deity/god” may be “ទេព” only when the source actually says deity/god. Never simplify one into the other. Apply the same rule to cultivation ranks, sect titles, species, places, and named powers.

WHOLE-STORY CONTEXT AND CAUSAL RETELLING:
- Use the FULL-STORY SRT reference below to resolve identities, family relationships, aliases, and the confirmed purpose of a visible action even when that confirming subtitle falls outside this 90-second clip.
- This permission resolves known context; it does not permit invention. The current clip still controls what physically happens and when.
- Once the whole story confirms a visible person's name and relationship, use that confirmed name and may introduce only the relationship the evidence supplies. Do not fall back to clothing, age, body, or appearance labels after identity is known.
- When the sequence explicitly establishes why a character performs a visible action, narrate the complete causal action: CONFIRMED CHARACTER + CURRENT ACTION + CONFIRMED PURPOSE + BENEFICIARY. Do not flatten it to a visually true but story-incomplete action, and do not borrow a purpose from a different event.
- Connect WHO + ACTION + CONFIRMED PURPOSE + BENEFICIARY/RESULT whenever the causal link is explicit in the full SRT and surrounding event sequence.
- Do not reveal a future twist, outcome, death, betrayal, or secret before the story reaches it. Use later SRT only to resolve identity/relationship and the purpose of the action currently on screen, not to spoil later events.

LANGUAGE AND CANONICAL-NAME LOCK (mandatory):
- dialogueSummary, visibleAction, and khmerNarration must be natural Khmer. Do not copy Han/Chinese characters, pinyin, English dialogue, English glosses, or parenthetical translations into any of these fields.
- The only non-Khmer words allowed in those three fields are confirmed proper names written in their locked canonical spelling. Translate every other word into Khmer.
- Once SRT/context confirms a visible person's canonical name, use that exact locked name for the remainder of this chunk and every later chunk. Never revert to clothing, hair, colour, age, body, or appearance labels merely because the shot changes.
- Treat contextual aliases as references to the same person only when SRT/video context confirms that mapping. Output the locked canonical name, not the alias and not the descriptor.
- A descriptor is permitted only before identity is confirmed or when identity genuinely remains uncertain. The instant the name is confirmed, the canonical name replaces that descriptor in all later narration.
- Return characterIdentities as an internal continuity ledger. Include only identities confirmed by SRT/context: canonicalName is the one exact spelling to use; aliases are alternate forms encountered in SRT; visualIdentity is a short internal visual reminder. Never put visualIdentity wording into narration after the canonical name is known.
- Bad output: Chinese text followed by an English gloss, or a known character described only by clothing. Good output: a natural Khmer sentence that uses the story's own locked canonical name directly.

LOCKED IDENTITIES FROM EARLIER CHUNKS (continuity evidence; preserve these spellings):
${args.identityLocks?.length ? JSON.stringify(args.identityLocks) : '(none yet)'}

GESTURE COVERAGE (the finished recap is judged on this):
- Sweep the clip beat by beat. Every deliberate physical action a character performs must appear in some scene's khmerNarration at its correct point in time. Leaving a gesture out is as bad as inventing one.
- Name the gesture with a concrete Khmer verb, never a summary word: ចាប់ស្មា, ខ្ទប់មាត់, លុតជង្គង់, ទះដៃ, រុញ, ទាញ, គប់, ស្រែក, ខាំ, ទាត់, ច្របាច់ក, ប្រញាប់រត់, ងាកមើល, ចង្អុល, ប្រគល់ឲ្យ, ទទួលយក, ដកចេញ, ខ្ទាតធ្លាក់. "គាត់ធ្វើអ្វីមួយ" or "មានសកម្មភាពមួយ" is never acceptable.
- Every gesture carries its owner and its target: WHO -> EXACT ACTION -> ON WHOM/WHAT -> the immediately visible result. With two or more people in frame, repeat the confirmed name instead of "គាត់"/"នាង".
- Keep the on-screen order. If a character kneels and then speaks, the kneeling is narrated first.
- Track objects: who holds it, who hands it over, who takes it, and where it ends up.
- Never compress a fight or a chain of actions into one sentence. Each strike, block, fall, stand-up, dodge, and use of a weapon or power is its own narrated action.

KHMER NARRATOR STYLE:
- Write khmerNarration as a connected storyteller script, not as captions, bullet points, a screenplay, or a visual inspection report.
- Use natural transitions where appropriate, such as “សាច់រឿងចាប់ផ្តើមឡើង...”, “នៅពេលនោះ...”, “ប៉ុន្តែភ្លាមៗនោះ...”, “បន្ទាប់មក...”, “យ៉ាងណាមិញ...”, and “សាច់រឿងកាត់ត្រឡប់មក...”. Vary them and do not force one into every sentence.
- Retell dialogue mostly as smooth indirect narration. Keep a short direct quote only when it is important or dramatic.
- Prefer clear medium-length sentences and connected paragraphs. Use a confirmed character name after SRT/context establishes it; before that, use a neutral reference.
- Describe what the event means for the ongoing scene only when that meaning is explicit in SRT/context. Do not add opinions, hidden thoughts, hype, or unsupported explanations.
- Write like a human Khmer movie recapper: identify the acting character first, describe the character's meaningful physical action clearly, then connect the SRT-backed dialogue/meaning and immediate consequence. The result must feel like continuous storytelling, not raw subtitle translation.
- When two or more characters share a scene, repeat their confirmed names as needed. Clarity about who acts is more important than avoiding repeated names.
- Dialogue ownership and physical-action ownership are separate evidence questions. A subtitle near a face does not prove that person spoke it, and a speaker's subtitle does not prove that speaker performed the visible action.
- A character's audible inner monologue remains that character's thought. Attribute it to the confirmed character with “គិតក្នុងចិត្តថា” or equivalent natural Khmer; never introduce an unsupported “អ្នកនិទានរឿង”.
- Never use camera-report phrasing such as “រូបភាពបង្ហាញ”, “ត្រូវបានបង្ហាញ”, “ឈុតនេះបង្ហាញ”, or repeatedly describe hair, clothing, colors, close-ups, and framing.
- Do not repeat the same dialogue in dialogueSummary and then pad khmerNarration with a shot description. khmerNarration must read like the final voiceover a Khmer recap narrator would record.
- Each scene's khmerNarration is ONE short paragraph of the finished script: usually one to three sentences. Never write a long block -- split a long beat across consecutive scenes instead.
- Announce a real cut when the story moves to another place, time, or group: "សាច់រឿងកាត់មកកន្លែងមួយទៀត។", "សាច់រឿងកាត់ត្រឡប់មកកាន់ [ឈ្មោះ] វិញ។", "សាច់រឿងកាត់ត្រឡប់ទៅអតីតកាល។", "សាច់រឿងកាត់ត្រឡប់មកបច្ចុប្បន្នវិញ។" Do not use them between two shots of the same scene.
- The first time the SRT confirms who someone is, introduce them in one sentence -- the name plus the role or relationship the SRT gives, for example "គាត់មានឈ្មោះថា ... ហើយក៏ជាបងប្រុសរបស់ ..."។
- Keep a shouted, short, dramatic line as a direct quote standing on its own, for example "បងប្រុស ស៊ូៗ!". Retell everything else indirectly with ប្រាប់ថា / សួរថា / ឆ្លើយថា / និយាយថា.
- Narrate a visible reaction where the face or body shows it: "ឃើញបែបនោះ ក៏ភ័យ", "សប្បាយចិត្តមែនទែន", "តក់ស្លុតភ្លាមៗ".
${args.firstChunk && !args.regeneration ? '- The first returned scene only opens as the STYLE BLUEPRINT below describes: a short greeting to the viewers, one sentence saying that the story chosen for today is worth watching, a short invitation to begin, then straight into “សាច់រឿងចាប់ផ្តើមឡើង ដោយបង្ហាញឲ្យឃើញ...”. Never repeat the welcome in later scenes or chunks.' : '- Continue naturally from the previous narration. Do not add another greeting or restart the story.'}

VIDEO + SRT STORYTELLING ORDER:
- Inspect the opening from its first frame. The opening may contain dialogue or may be silent; never assume one or the other from the presence of an intro/title image.
- If the opening has no SRT dialogue, narrate only the few important actions, gestures, entrances/exits, or location changes that are clearly visible. Do not say that the scene is silent and do not fill the gap with invented plot.
- If dialogue is present from the opening, first establish the clearly visible acting character and action, then retell the SRT meaning as natural indirect Khmer narration. Keep the actor name explicit whenever another nearby character could be confused with them.
- For every later story beat, preserve all story-relevant visible actions at their correct chronological points, then connect them with the SRT-backed meaning. Do not translate line by line and do not output a detached checklist of gestures.
- Include meaningful gestures and reactions: pointing, reaching, handing/taking/hiding an object, kneeling, bowing, turning toward someone, blocking, attacking, defending, falling, standing up, opening/closing something, entering/leaving, deliberate facial reaction, or using a power/tool. Omit only meaningless repetition, blinking, camera movement, and purely decorative shots.
- If A acts on B, explicitly preserve that direction: "A strikes B" must never become "B strikes A". If an object moves from A to B, state who gives/drops/throws it and who receives/picks it up.
- During a dialogue-free gap, visible action may carry the narration. As soon as SRT dialogue resumes, return to its meaning as the main story source and use visuals only as brief support.
- The final Khmer should flow as one storyteller's recap: opening setup, essential visible action, SRT-grounded explanation, and a natural transition to the next event. Never let visual description overwhelm or contradict the dialogue.

STYLE BLUEPRINT -- applies to every story without importing content from any other story:
- Use the rhythm learned from a natural Khmer movie recap: brief viewer welcome only at the beginning, chronological scene setup, named actor before action, concrete gesture, SRT-backed meaning, immediate result, then a natural transition.
- This is a structure and tone guide only. Every name, relationship, place, object, power, rank, action, purpose, and event must come exclusively from THIS video's SRT/context and visible evidence.
- Never copy a name, character, place, object, or plot event from an example, a previous project, or another story.

Optional character/story context (use only where confirmed by video/SRT; it is not evidence):
${args.characterContext.trim() || '(none)'}

Previous narration is style/continuity context only. It is NOT factual evidence; do not copy or repeat it:
${args.previousNarration?.trim() || '(none)'}

FULL-STORY SRT REFERENCE -- use for identity, relationship, and confirmed purpose; never move future events into the current time:
${fullStorySrtReference(args.segments)}

CURRENT-CLIP SRT dialogue with absolute timestamps -- use this for precise video/dialogue alignment:
${srtExcerpt(args.segments, args.startTime, args.endTime)}`
}

/** Every COMPLETE object in the JSON array under `key`, even when the text
 * stops part-way through (an answer cut off by the output limit, or a
 * repetition loop that ran into it). Walks the characters tracking string
 * and nesting state; an object that never closed is simply not returned.
 * The whole answer is otherwise thrown away over its last half-written
 * scene -- measured with this model on Auto SRT, a run that ends like that
 * is what "Gemini returned invalid JSON" was. */
export function extractCompleteArrayItems(text: string, key: string): unknown[] {
  const keyMatch = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text)
  if (!keyMatch) return []
  const items: unknown[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let objectStart = -1
  for (let i = keyMatch.index + keyMatch[0].length; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) objectStart = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && objectStart >= 0) {
        try {
          items.push(JSON.parse(text.slice(objectStart, i + 1)))
        } catch {
          // A malformed object ends the usable part.
          break
        }
        objectStart = -1
      }
    } else if (ch === ']' && depth === 0) break
  }
  return items
}

/** A chunk's answer, read leniently: `complete` is false when the JSON did
 * not parse and only the scenes that came back whole were kept. */
function parseScenes(text: string, startTime: number, endTime: number, idPrefix: string): AnalyzedRange & { complete: boolean } {
  let parsed: unknown
  let complete = true
  try {
    parsed = JSON.parse(text)
  } catch {
    complete = false
    parsed = { scenes: extractCompleteArrayItems(text, 'scenes'), characterIdentities: extractCompleteArrayItems(text, 'characterIdentities') }
  }
  const allScenes = (parsed as { scenes?: unknown })?.scenes
  if (!Array.isArray(allScenes)) throw new Error('Gemini response did not contain scenes.')
  // A loop repeats the same narration scene after scene: keep the first.
  const rawScenes = allScenes.filter((raw, index) => {
    const narration = String((raw as Record<string, unknown>)?.khmerNarration ?? '').trim()
    return !narration || index === 0 || narration !== String((allScenes[index - 1] as Record<string, unknown>)?.khmerNarration ?? '').trim()
  })
  // Some model versions may return timestamps relative to the uploaded
  // physical chunk despite being asked for original-video seconds. Detect
  // that shape once for the whole response and translate it deterministically.
  const chunkDuration = endTime - startTime
  const numericStarts = rawScenes.map((raw) => Number((raw as Record<string, unknown>).startTime)).filter(Number.isFinite)
  const usesLocalTimes = startTime > 1 && numericStarts.length > 0 && numericStarts.every((value) => value < startTime - 0.5 && value <= chunkDuration + 1)
  const scenes = rawScenes.map((raw, index) => {
    const value = raw as Record<string, unknown>
    const rawStart = Number(value.startTime) + (usesLocalTimes ? startTime : 0)
    const rawEnd = Number(value.endTime) + (usesLocalTimes ? startTime : 0)
    const start = Math.max(startTime, Math.min(endTime - 0.05, rawStart))
    const end = Math.max(start + 0.05, Math.min(endTime, rawEnd))
    return {
      id: `${idPrefix}-${index + 1}`,
      startTime: start,
      endTime: end,
      dialogueSummary: String(value.dialogueSummary ?? '').trim(),
      visibleAction: String(value.visibleAction ?? '').trim(),
      khmerNarration: String(value.khmerNarration ?? '').trim(),
      confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : 0
    }
  })
  const rawIdentities = (parsed as { characterIdentities?: unknown }).characterIdentities
  const identityLocks: CharacterIdentityLock[] = Array.isArray(rawIdentities)
    ? rawIdentities.flatMap((raw) => {
        const value = raw as Record<string, unknown>
        const canonicalName = String(value.canonicalName ?? '').trim()
        if (!canonicalName) return []
        const aliases = Array.isArray(value.aliases)
          ? value.aliases.map((alias) => String(alias).trim()).filter(Boolean)
          : []
        return [{ canonicalName, aliases, visualIdentity: String(value.visualIdentity ?? '').trim() }]
      })
    : []
  return { scenes, identityLocks, complete }
}

function mergeIdentityLocks(current: CharacterIdentityLock[], incoming: CharacterIdentityLock[]): CharacterIdentityLock[] {
  const merged = current.map((identity) => ({ ...identity, aliases: [...identity.aliases] }))
  for (const candidate of incoming) {
    const candidateNames = [candidate.canonicalName, ...candidate.aliases].map((name) => name.toLocaleLowerCase())
    const existing = merged.find((identity) =>
      [identity.canonicalName, ...identity.aliases].some((name) => candidateNames.includes(name.toLocaleLowerCase()))
    )
    if (!existing) {
      merged.push({ ...candidate, aliases: [...new Set(candidate.aliases)] })
      continue
    }
    existing.aliases = [...new Set([...existing.aliases, candidate.canonicalName, ...candidate.aliases])]
      .filter((alias) => alias.toLocaleLowerCase() !== existing.canonicalName.toLocaleLowerCase())
    if (!existing.visualIdentity && candidate.visualIdentity) existing.visualIdentity = candidate.visualIdentity
  }
  return merged
}

/** One last whole-script pass is intentionally separate from per-chunk video
 * analysis. A chunk can be locally correct yet repeat the final beat of the
 * preceding chunk, mislabel an inner voice, or drift on a translated rank.
 * This pass may copy-edit only; it receives no permission to add plot. */
async function polishNarrationContinuity(
  ai: GoogleGenAI,
  scenes: VideoStoryNarrationScene[],
  identityLocks: CharacterIdentityLock[],
  characterContext: string,
  signal: AbortSignal
): Promise<VideoStoryNarrationScene[]> {
  if (scenes.length === 0) return scenes

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: `Copy-edit ALL supplied scenes as one continuous Khmer recap without changing any fact, actor, action direction, chronology, timestamp, or scene id.
- Return one repair entry for EVERY supplied scene, in the same order. Do not add, remove, combine, or rename scene ids.
- Compare adjacent scenes semantically. Each action, line of dialogue, explanation, relationship, and plot fact may appear only once. If two differently worded sentences describe the same event, keep it in the earliest fitting scene and remove only the repeated clause from the later scene. Preserve every genuinely new action or fact.
- Never repeat the same setup with subject/object order reversed (for example, “a character acts while a group reacts” followed by “the group reacts while the character performs that same action”).
- Keep dialogue ownership exact. Distinguish spoken dialogue, a group shout, off-screen speech, and a character's inner voice. A confirmed inner voice must be attributed to that exact character as a private thought, never as an unnamed storyteller or “អ្នកនិទានរឿង”.
- Rewrite Chinese/Han text, English dialogue, English explanations, and parenthetical translations into natural spoken Khmer.
- Delete the foreign original and parentheses after translating; never return bilingual text.
- Preserve confirmed proper names in their exact locked canonical spelling. Every other word must be Khmer.
- Apply the locked canonical name whenever the input uses one of its aliases. Do not replace a known name with clothing, hair, colour, age, or appearance descriptors.
- Do not invent identities. If no identity is locked, keep a genuine proper name as written but translate the surrounding language.
- Preserve exact terminology. Translate “immortal” as “អមតៈ”. Use “ទេព” only when the source actually means deity/god; never substitute “ទេព” for “អមតៈ”. Do not simplify cultivation ranks, sect titles, species, places, or named powers into a different concept.
- Do not turn a character's opinion, suspicion, wish, or inner thought into an objective narrator statement.
- dialogueSummary and visibleAction remain concise factual evidence fields. khmerNarration remains the natural final voiceover, normally one to three connected sentences.

Locked identities:
${identityLocks.length ? JSON.stringify(identityLocks) : '(none)'}

Confirmed user context:
${characterContext.trim() || '(none)'}

Complete chronological script to repair:
${JSON.stringify(scenes.map(({ id, startTime, endTime, dialogueSummary, visibleAction, khmerNarration }) => ({ id, startTime, endTime, dialogueSummary, visibleAction, khmerNarration })))}` }] }],
    config: { temperature: 0.05, responseMimeType: 'application/json', responseJsonSchema: languageRepairSchema, abortSignal: signal }
  })

  const parsed = JSON.parse(response.text || '{}') as { repairs?: Array<Partial<VideoStoryNarrationScene> & { id?: string }> }
  const repairs = new Map((parsed.repairs ?? []).filter((item): item is Partial<VideoStoryNarrationScene> & { id: string } => Boolean(item.id)).map((item) => [item.id, item]))
  return scenes.map((scene) => {
    const repair = repairs.get(scene.id)
    if (!repair) return scene
    return {
      ...scene,
      dialogueSummary: String(repair.dialogueSummary ?? scene.dialogueSummary).trim(),
      visibleAction: String(repair.visibleAction ?? scene.visibleAction).trim(),
      khmerNarration: String(repair.khmerNarration ?? scene.khmerNarration).trim()
    }
  })
}

async function waitForFile(ai: GoogleGenAI, name: string, signal: AbortSignal): Promise<{ uri: string; mimeType: string }> {
  for (;;) {
    assertNotCanceled(signal)
    const file = await ai.files.get({ name })
    if (file.state === FileState.ACTIVE && file.uri) return { uri: file.uri, mimeType: file.mimeType || 'video/mp4' }
    if (file.state === FileState.FAILED) throw new Error(file.error?.message || 'Gemini could not process the uploaded video.')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1500)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new CanceledError()) }, { once: true })
    })
  }
}

async function analyzeRange(ai: GoogleGenAI, options: {
  jobId: string
  rootJobId?: string
  videoPath: string
  sourceStart: number
  sourceEnd: number
  segments: TranscriptSegment[]
  characterContext: string
  previousNarration?: string
  regeneration?: boolean
  firstChunk?: boolean
  identityLocks?: CharacterIdentityLock[]
  signal: AbortSignal
  onEncodeProgress?: (percent: number) => void
  onStage?: (stage: 'uploading' | 'analyzing', attempt: number) => void
  /** How many times this range has already been re-requested in pieces
   * (see the recovery after the answer arrives) -- bounds the recursion. */
  recoveryDepth?: number
}): Promise<AnalyzedRange> {
  const workDir = join(app.getPath('temp'), 'creative-ai-video-story', options.jobId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const chunkPath = join(workDir, 'chunk.mp4')
  await mkdir(workDir, { recursive: true })
  let remoteName: string | undefined
  try {
    const duration = options.sourceEnd - options.sourceStart
    const ffmpegJobId = `${options.jobId}:ffmpeg`
    if (options.rootJobId) activeFfmpeg.set(options.rootJobId, ffmpegJobId)
    await runFfmpeg(ffmpegJobId, [
      '-y', '-ss', String(options.sourceStart), '-i', options.videoPath, '-t', String(duration),
      '-map', '0:v:0', '-map', '0:a?', '-vf', 'scale=min(1280\\,iw):-2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', chunkPath
    ], { totalDurationSeconds: duration, onProgress: options.onEncodeProgress })
    if (options.rootJobId) activeFfmpeg.delete(options.rootJobId)
    assertNotCanceled(options.signal)
    let lastError: unknown
    let answer: { text: string; finishReason: string } | null = null
    for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS && !answer; attempt++) {
      try {
        options.onStage?.('uploading', attempt)
        const uploaded = await ai.files.upload({ file: chunkPath, config: { mimeType: 'video/mp4', abortSignal: options.signal } })
        if (!uploaded.name) throw new Error('Gemini upload did not return a file name.')
        remoteName = uploaded.name
        const file = await waitForFile(ai, uploaded.name, options.signal)
        options.onStage?.('analyzing', attempt)
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: [{ role: 'user', parts: [
            { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
            { text: buildPrompt({ startTime: options.sourceStart, endTime: options.sourceEnd, segments: options.segments, characterContext: options.characterContext, previousNarration: options.previousNarration, regeneration: options.regeneration, firstChunk: options.firstChunk, identityLocks: options.identityLocks }) }
          ] }],
          config: {
            temperature: 0.15,
            // Thinking tokens are spent from the same budget as the answer;
            // capped so reasoning can never crowd out the JSON itself.
            maxOutputTokens: NARRATION_MAX_OUTPUT_TOKENS,
            thinkingConfig: { thinkingBudget: NARRATION_THINKING_BUDGET },
            responseMimeType: 'application/json',
            responseJsonSchema: responseSchema,
            abortSignal: options.signal
          }
        })
        answer = { text: response.text || '', finishReason: String(response.candidates?.[0]?.finishReason ?? '') }
      } catch (error) {
        if (error instanceof CanceledError || options.signal.aborted) throw error
        lastError = error
        if (attempt >= MAX_NETWORK_ATTEMPTS || !isRetryableError(error)) break
        // A half-uploaded chunk is useless to the retry; drop it first.
        if (remoteName) {
          await ai.files.delete({ name: remoteName }).catch(() => undefined)
          remoteName = undefined
        }
        await sleepUnlessCanceled(RETRY_DELAYS_MS[attempt - 1] ?? 8000, options.signal)
      }
    }
    if (!answer) throw new Error(explainGeminiError(lastError))

    const parsed = parseScenes(answer.text, options.sourceStart, options.sourceEnd, options.jobId)
    if (parsed.complete) return { scenes: parsed.scenes, identityLocks: parsed.identityLocks }

    // The answer stopped before its JSON closed (the output limit, or a
    // repetition loop running into it). Recover instead of failing the
    // whole narration over one chunk.
    console.warn(`[video-story] ${fmtRange(options.sourceStart, options.sourceEnd)} answer incomplete (${answer.finishReason || 'no finish reason'}, ${answer.text.length} chars, ${parsed.scenes.length} whole scenes kept)`)
    const depth = options.recoveryDepth ?? 0
    const canRecover = depth < MAX_RECOVERY_DEPTH
    if (parsed.scenes.length > 0) {
      // Keep the scenes that came back whole; ask again only for the time
      // after the last of them.
      const lastEnd = Math.max(...parsed.scenes.map((scene) => scene.endTime))
      if (!canRecover || options.sourceEnd - lastEnd < MIN_RECOVERY_SECONDS) return { scenes: parsed.scenes, identityLocks: parsed.identityLocks }
      const rest = await analyzeRange(ai, {
        ...options,
        jobId: `${options.jobId}-rest`,
        sourceStart: lastEnd,
        firstChunk: false,
        previousNarration: parsed.scenes.slice(-3).map((scene) => scene.khmerNarration).join(' '),
        identityLocks: mergeIdentityLocks(options.identityLocks ?? [], parsed.identityLocks),
        recoveryDepth: depth + 1
      })
      return { scenes: [...parsed.scenes, ...rest.scenes], identityLocks: mergeIdentityLocks(parsed.identityLocks, rest.identityLocks) }
    }
    if (canRecover && duration >= MIN_SPLIT_SECONDS) {
      // Nothing usable at all: a shorter clip means a shorter answer.
      const middle = options.sourceStart + duration / 2
      const first = await analyzeRange(ai, { ...options, jobId: `${options.jobId}-a`, sourceEnd: middle, recoveryDepth: depth + 1 })
      const second = await analyzeRange(ai, {
        ...options,
        jobId: `${options.jobId}-b`,
        sourceStart: middle,
        firstChunk: false,
        previousNarration: first.scenes.slice(-3).map((scene) => scene.khmerNarration).join(' ') || options.previousNarration,
        identityLocks: mergeIdentityLocks(options.identityLocks ?? [], first.identityLocks),
        recoveryDepth: depth + 1
      })
      return { scenes: [...first.scenes, ...second.scenes], identityLocks: mergeIdentityLocks(first.identityLocks, second.identityLocks) }
    }
    throw new Error(`Gemini's answer for ${fmtRange(options.sourceStart, options.sourceEnd)} could not be read (${answer.finishReason || 'no finish reason'}, ${answer.text.length} characters). Try Analyze and Generate again.`)
  } finally {
    if (options.rootJobId) activeFfmpeg.delete(options.rootJobId)
    if (remoteName) await ai.files.delete({ name: remoteName }).catch(() => undefined)
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function cancelVideoStoryNarration(jobId: string): boolean {
  const controller = active.get(jobId)
  if (!controller) return false
  controller.abort()
  const ffmpegJobId = activeFfmpeg.get(jobId)
  if (ffmpegJobId) cancelJob(ffmpegJobId)
  return true
}

export async function generateVideoStoryNarration(request: VideoStoryNarrationRequest, onProgress: (progress: VideoStoryNarrationProgress) => void): Promise<VideoStoryNarrationResult> {
  if (active.has(request.jobId)) throw new Error('A narration job with this id is already running.')
  const controller = new AbortController()
  active.set(request.jobId, controller)
  const apiKey = await getGeminiApiKey()
  if (!apiKey) throw new Error('Gemini API key is not configured. Add it under Settings > AI API Keys.')
  const ai = new GoogleGenAI({ apiKey })
  try {
    onProgress({ jobId: request.jobId, phase: 'preparing', percent: 1, message: 'Preparing video and subtitles…' })
    const range = narrativeMediaRange(request.videoDurationSeconds, request.segments)
    const chunks = planVideoChunks(request.videoDurationSeconds, request.segments, MAX_CHUNK_SECONDS, 2, range.startTime, range.endTime)
    if (chunks.length === 0) throw new Error('The selected video has no usable duration.')
    const scenes: VideoStoryNarrationScene[] = []
    let identityLocks: CharacterIdentityLock[] = []
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]
      const base = (index / chunks.length) * 90
      onProgress({ jobId: request.jobId, phase: 'chunking', percent: Math.round(3 + base), message: `Preparing scene chunk ${index + 1} of ${chunks.length}…`, currentChunk: index + 1, totalChunks: chunks.length })
      const generated = await analyzeRange(ai, {
        jobId: `${request.jobId}-${index + 1}`,
        rootJobId: request.jobId,
        videoPath: request.videoPath,
        sourceStart: chunk.startTime,
        sourceEnd: chunk.endTime,
        segments: request.segments,
        characterContext: request.characterContext,
        previousNarration: scenes.slice(-6).map((scene) => scene.khmerNarration).join(' '),
        identityLocks,
        firstChunk: index === 0,
        signal: controller.signal,
        onEncodeProgress: (p) => onProgress({ jobId: request.jobId, phase: 'uploading', percent: Math.round(3 + base + (p / chunks.length) * 0.2), message: `Encoding chunk ${index + 1} of ${chunks.length}…`, currentChunk: index + 1, totalChunks: chunks.length }),
        onStage: (stage, attempt) => onProgress({ jobId: request.jobId, phase: stage, percent: Math.round(5 + base), message: `${stage === 'uploading' ? `Uploading chunk ${index + 1} of ${chunks.length} securely` : `Gemini is analyzing chunk ${index + 1} of ${chunks.length}`}${attempt > 1 ? ` (retry ${attempt} of ${MAX_NETWORK_ATTEMPTS})` : ''}…`, currentChunk: index + 1, totalChunks: chunks.length })
      })
      scenes.push(...generated.scenes)
      identityLocks = mergeIdentityLocks(identityLocks, generated.identityLocks)
      onProgress({ jobId: request.jobId, phase: 'analyzing', percent: Math.round(3 + ((index + 1) / chunks.length) * 90), message: `Analyzed chunk ${index + 1} of ${chunks.length}.`, currentChunk: index + 1, totalChunks: chunks.length })
    }
    onProgress({ jobId: request.jobId, phase: 'merging', percent: 96, message: 'Merging scenes and removing overlap…' })
    let mergedScenes = mergeNarrationScenes(scenes)
    try {
      mergedScenes = await polishNarrationContinuity(ai, mergedScenes, identityLocks, request.characterContext, controller.signal)
      // A model can occasionally preserve a quoted bilingual fragment even
      // after being told to translate it. Retry the copy-edit once, only when
      // deterministic validation still sees Han or ordinary English leakage.
      if (scenesNeedLanguageRepair(mergedScenes)) {
        mergedScenes = await polishNarrationContinuity(ai, mergedScenes, identityLocks, request.characterContext, controller.signal)
      }
    } catch (err) {
      if (err instanceof CanceledError || controller.signal.aborted) throw err
      console.warn(`[video-story] final continuity/language polish skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
    const result: VideoStoryNarrationResult = { scenes: mergedScenes, generatedAt: new Date().toISOString(), model: MODEL, sourceSrtFileName: request.sourceSrtFileName }
    onProgress({ jobId: request.jobId, phase: 'complete', percent: 100, message: 'Narration ready.' })
    return result
  } finally {
    active.delete(request.jobId)
  }
}

export async function regenerateVideoStoryScene(request: RegenerateNarrationSceneRequest): Promise<VideoStoryNarrationScene> {
  const controller = new AbortController()
  active.set(request.jobId, controller)
  const apiKey = await getGeminiApiKey()
  if (!apiKey) throw new Error('Gemini API key is not configured. Add it under Settings > AI API Keys.')
  const ai = new GoogleGenAI({ apiKey })
  try {
    const analyzed = await analyzeRange(ai, {
      jobId: request.jobId,
      videoPath: request.videoPath,
      sourceStart: Math.max(0, request.scene.startTime),
      sourceEnd: Math.min(request.videoDurationSeconds, request.scene.endTime),
      segments: request.segments,
      characterContext: request.characterContext,
      previousNarration: [request.previousNarration, request.nextNarration].filter(Boolean).join('\n'),
      regeneration: true,
      signal: controller.signal
    })
    if (!analyzed.scenes[0]) throw new Error('Gemini returned no narration for the selected scene.')
    let regeneratedScenes = analyzed.scenes
    try {
      regeneratedScenes = await polishNarrationContinuity(ai, analyzed.scenes, analyzed.identityLocks, request.characterContext, controller.signal)
      if (scenesNeedLanguageRepair(regeneratedScenes)) {
        regeneratedScenes = await polishNarrationContinuity(ai, regeneratedScenes, analyzed.identityLocks, request.characterContext, controller.signal)
      }
    } catch (err) {
      if (err instanceof CanceledError || controller.signal.aborted) throw err
      console.warn(`[video-story] regenerated-scene polish skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { ...(regeneratedScenes[0] ?? analyzed.scenes[0]), id: request.scene.id }
  } finally {
    active.delete(request.jobId)
  }
}

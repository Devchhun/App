/** AI Animation (right sidebar tab): a topic in, a narrated animated film
 * out, drawn by the Kuanimation runtime (resources/kuanimation). Gemini
 * writes the voice-over lines and the scene code, Edge TTS speaks the lines,
 * a hidden window draws every frame and ffmpeg packs the MP4. See
 * app/main/animation/kuanimationService.ts. */

export type AnimationStyle = 'pencil' | 'wash' | 'haze' | 'paper' | 'marker'

/** A story world with its own props, direction and music. */
export type AnimationGenre = 'general' | 'xianxia'

export const ANIMATION_GENRES: Array<{ id: AnimationGenre; label: string; hint: string; style: AnimationStyle }> = [
  { id: 'general', label: 'General', hint: 'Any story, explainer or kids\' tale', style: 'pencil' },
  { id: 'xianxia', label: 'Xianxia 仙侠', hint: 'Ancient Chinese immortal cultivation: sects, flying swords, qi', style: 'haze' }
]

/** Lengths offered for a film made from a topic (a script sets its own). */
export const ANIMATION_MINUTES = [1, 2, 3, 5, 10]

export const ANIMATION_STYLES: Array<{ id: AnimationStyle; label: string; hint: string }> = [
  { id: 'pencil', label: 'Pencil sketch', hint: 'Graphite + coloured pencil on paper' },
  { id: 'wash', label: 'Watercolour', hint: 'Sunny watercolour cartoon' },
  { id: 'haze', label: 'Painted forest', hint: 'Hazy painted animation' },
  { id: 'paper', label: 'Paper diorama', hint: 'Cut paper on a stage' },
  { id: 'marker', label: 'Felt-tip', hint: 'Marker outlines, red curtains' }
]

export const ANIMATION_VOICES: Array<{ id: string; label: string; language: 'km' | 'en' }> = [
  { id: 'km-KH-PisethNeural', label: 'Khmer · Piseth (male)', language: 'km' },
  { id: 'km-KH-SreymomNeural', label: 'Khmer · Sreymom (female)', language: 'km' },
  { id: 'en-US-AndrewNeural', label: 'English · Andrew (male)', language: 'en' },
  { id: 'en-US-AriaNeural', label: 'English · Aria (female)', language: 'en' }
]

export interface AnimationRequest {
  jobId: string
  /** What the film is about, in the user's words (any language). */
  brief: string
  /** The narrator's own script: when given, its words are the voice-over,
   * split into lines and scenes but never rewritten. */
  script?: string
  genre: AnimationGenre
  /** Continue a film that stopped part-way (its folder under animations). */
  resumeFolder?: string
  style: AnimationStyle
  /** Edge TTS voice id; its language is the film's language. */
  voice: string
  /** Target length in minutes (the voice sets the exact length). */
  minutes: number
  /** Output width: 1280 (720p, faster) or 1920 (1080p). */
  width: 1280 | 1920
  /** Draw the subtitles into the picture. Off when the SRT will be used as
   * captions instead, so they are not shown twice. */
  burnSubtitles: boolean
  /** Mood music and sound effects under the voice. */
  music: boolean
}

/** One narrator line as a caption, in film seconds. */
export interface AnimationCaption {
  startTime: number
  endTime: number
  /** The line as shown (the film's language). */
  text: string
  /** Its English translation, when the film is not in English. */
  text2: string
}

export type AnimationPhase = 'writing' | 'voicing' | 'staging' | 'checking' | 'directing' | 'rendering' | 'mixing' | 'done'

export interface AnimationProgress {
  jobId: string
  phase: AnimationPhase
  percent: number
  message: string
  /** A contact sheet (JPEG data URL) once the film first draws. */
  preview?: string
}

export interface AnimationResult {
  title: string
  outputPath: string
  folder: string
  durationSeconds: number
  preview?: string
  /** The narration as captions, and the SRT files written from them. */
  captions: AnimationCaption[]
  srtPath: string
  /** English SRT from the translations (Khmer films only). */
  srtEnglishPath?: string
  /** Something the user should know about the result (e.g. a script whose
   * lines did not keep every word). */
  note?: string
}

/** A failure keeps the film's folder, so the job can continue from where it stopped. */
export type AnimationIpcResult = { ok: true; data: AnimationResult } | { ok: false; error: string; canceled?: boolean; folder?: string }

export const AI_ANIMATION_IPC = {
  generate: 'ai-animation:generate',
  cancel: 'ai-animation:cancel',
  progress: 'ai-animation:progress',
  openFolder: 'ai-animation:open-folder',
  saveSrt: 'ai-animation:save-srt'
} as const

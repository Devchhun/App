import type { DubbingEngine } from './voxcpmSettings'

/** "Story voices" (Voice Model panel): the voices picked for a story,
 * remembered per engine -- a man's and a woman's, and, when picked, a
 * child's, an old man's and an old woman's. They are also the voice of
 * every line that has no voice of its own: by its gender, and by its
 * character's age where that is set (Cast window: Child / Adult / Old). */
export interface StoryVoices {
  male: string
  female: string
  child?: string
  oldMale?: string
  oldFemale?: string
}

export function storyVoicesKey(engine: DubbingEngine): string {
  return `cae.twoVoices.${engine}`
}

/** Only what was picked and remembered; nothing when no pick was made. */
export function loadStoryVoices(engine: DubbingEngine): StoryVoices | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(storyVoicesKey(engine)) ?? 'null') as Partial<StoryVoices> | null
    if (!saved || typeof saved.male !== 'string' || typeof saved.female !== 'string' || !saved.male || !saved.female) return undefined
    const optional = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
    return { male: saved.male, female: saved.female, child: optional(saved.child), oldMale: optional(saved.oldMale), oldFemale: optional(saved.oldFemale) }
  } catch {
    return undefined
  }
}

/** The story voice for a line of this gender and age: a child's voice for
 * a child, an old man's / old woman's for the old, else the man's or the
 * woman's (an age with no voice picked for it falls back to these). An
 * unknown gender speaks in the man's voice, as "Use for all" counts it. */
export function storyVoiceFor(voices: StoryVoices, gender: 'male' | 'female' | 'unknown', age: string | undefined): string {
  if (age === 'child' && voices.child) return voices.child
  if (age === 'old' || age === 'elder') {
    if (gender === 'female' && voices.oldFemale) return voices.oldFemale
    if (gender !== 'female' && voices.oldMale) return voices.oldMale
  }
  return gender === 'female' ? voices.female : voices.male
}

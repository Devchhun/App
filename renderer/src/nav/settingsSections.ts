export type SettingsCategoryId = 'appearance' | 'transcription' | 'apiKeys' | 'aiSuggestions' | 'localAi' | 'story' | 'voice' | 'license' | 'updates' | 'about'

export interface SettingsCategory {
  id: SettingsCategoryId
  label: string
  /** Which icon the rail draws beside the label -- resolved to a component
   * in SettingsDialog rather than stored here, so this module stays free of
   * JSX and can be unit-tested as plain data. */
  icon: 'appearance' | 'transcript' | 'sparkle' | 'chip' | 'story' | 'voice' | 'license' | 'updates' | 'about'
  /** Extra words this category should match on when searching -- the labels
   * people actually type ("gpu", "dark mode", "voxcpm") are rarely the same
   * words as the section heading. */
  keywords: string
  /** The AI tool panels (suggestions, planner, story) are full working
   * panels that used to live in the right sidebar, not rows of settings --
   * SettingsDialog embeds the panel itself and widens to fit it. */
  kind?: 'tool'
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: 'appearance', label: 'Appearance', icon: 'appearance', keywords: 'theme dark light mode colour color contrast' },
  { id: 'transcription', label: 'Transcription', icon: 'transcript', keywords: 'whisper model language khmer english download transcribe subtitles cudnn cublas ctranslate2 driver detect test device' },
  { id: 'apiKeys', label: 'AI API Keys', icon: 'sparkle', keywords: 'gemini google api key cloud video story narration secure encrypted' },
  { id: 'aiSuggestions', label: 'AI Suggestions', icon: 'sparkle', keywords: 'ai suggestions generate graphics cloud anthropic claude titles captions', kind: 'tool' },
  { id: 'localAi', label: 'Local AI Planner', icon: 'chip', keywords: 'local ai planner ollama scene plan model offline', kind: 'tool' },
  { id: 'story', label: 'Story Visuals', icon: 'story', keywords: 'story visuals narrative graph connected scenes', kind: 'tool' },
  { id: 'voice', label: 'Voice Engine', icon: 'voice', keywords: 'voxcpm edge tts dubbing ai voice engine device gpu cuda cpu install folder python' },
  { id: 'license', label: 'License', icon: 'license', keywords: 'license key activate activation machine id serial expire plan deactivate' },
  { id: 'updates', label: 'Updates', icon: 'updates', keywords: 'update version upgrade download install release' },
  { id: 'about', label: 'About', icon: 'about', keywords: 'version app build info' }
]

export function isToolCategory(id: SettingsCategoryId): boolean {
  return SETTINGS_CATEGORIES.find((c) => c.id === id)?.kind === 'tool'
}

/** Categories whose label or keywords contain every whitespace-separated
 * term in `query` (AND, not OR -- typing "voice gpu" should narrow, not
 * widen). An empty/blank query matches everything, so the sidebar shows its
 * full list until someone actually types. */
export function matchSettingsCategories(query: string, categories: SettingsCategory[] = SETTINGS_CATEGORIES): SettingsCategory[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return categories
  return categories.filter((category) => {
    const haystack = `${category.label} ${category.keywords}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

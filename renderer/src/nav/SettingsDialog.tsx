import { useMemo, useState } from 'react'
import { useUiState } from './UiStateContext'
import { SettingsPanel } from './SettingsPanel'
import { AiSuggestionsPanel } from '../suggestions/AiSuggestionsPanel'
import { LocalAiPanel } from '../localAi/LocalAiPanel'
import { StoryVisualsPanel } from '../story/StoryVisualsPanel'
import { SettingsIcon, SunIcon, TranscriptIcon, SparkleIcon, ChipIcon, StoryIcon, MicrophoneIcon, UpdateIcon, HelpIcon, LockIcon } from './icons'
import { SETTINGS_CATEGORIES, isToolCategory, matchSettingsCategories, type SettingsCategoryId } from './settingsSections'

const CATEGORY_ICONS = {
  appearance: SunIcon,
  transcript: TranscriptIcon,
  sparkle: SparkleIcon,
  chip: ChipIcon,
  story: StoryIcon,
  voice: MicrophoneIcon,
  license: LockIcon,
  updates: UpdateIcon,
  about: HelpIcon
} as const

/** The AI tool panels -- working panels rather than rows of preferences,
 * so they get the whole content pane to themselves (and a wider dialog). */
function ToolPanel({ category }: { category: SettingsCategoryId }): JSX.Element | null {
  switch (category) {
    case 'aiSuggestions':
      return <AiSuggestionsPanel />
    case 'localAi':
      return <LocalAiPanel />
    case 'story':
      return <StoryVisualsPanel />
    default:
      return null
  }
}

/** Settings as its own app-level dialog rather than a left-column view.
 * What's in it -- theme, update checks, which TTS engine runs -- applies to
 * the whole application, so taking over the Media/Templates column to show
 * it was the wrong shape: it hid the project you were working on to display
 * something unrelated to it.
 *
 * Laid out as a preferences window (category rail on the left, one section
 * at a time on the right, search across the lot) rather than one long
 * scroll, so a setting is found by narrowing rather than by reading past
 * everything else on the way to it. */
export function SettingsDialog(): JSX.Element | null {
  const { settingsOpen, setSettingsOpen, settingsCategory: category, setSettingsCategory: setCategory } = useUiState()
  const [search, setSearch] = useState('')

  const matches = useMemo(() => matchSettingsCategories(search), [search])

  // Typing narrows the rail; if what's selected drops out of the results,
  // follow the search to the first thing that DID match rather than showing
  // an empty pane next to a list that no longer contains the selection.
  const activeCategory = matches.some((c) => c.id === category) ? category : matches[0]?.id
  const showingTool = activeCategory !== undefined && isToolCategory(activeCategory)

  if (!settingsOpen) return null

  return (
    <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
      <div className="modal-panel settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-dialog-head">
          <span className="settings-dialog-title">
            <SettingsIcon size={16} />
            Preferences
          </span>
          <input
            className="settings-dialog-search"
            type="search"
            placeholder="Search settings…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="modal-close" title="Close" onClick={() => setSettingsOpen(false)}>
            ×
          </button>
        </div>

        <div className="settings-dialog-body">
          <nav className="settings-dialog-rail" aria-label="Settings categories">
            {matches.map((c) => (
              <button
                key={c.id}
                className={c.id === activeCategory ? 'settings-rail-item settings-rail-item-active' : 'settings-rail-item'}
                onClick={() => setCategory(c.id)}
              >
                {(() => {
                  const Icon = CATEGORY_ICONS[c.icon]
                  return <Icon size={15} />
                })()}
                {c.label}
              </button>
            ))}
            {matches.length === 0 && <p className="settings-rail-empty">No settings match “{search}”.</p>}
          </nav>

          <div className="settings-dialog-content">
            {activeCategory &&
              (showingTool ? (
                <div className="settings-tool-panel">
                  <ToolPanel category={activeCategory} />
                </div>
              ) : (
                <SettingsPanel category={activeCategory} />
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}

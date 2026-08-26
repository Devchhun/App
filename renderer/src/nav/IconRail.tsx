import { useMedia } from '../media/MediaContext'
import { useUiState } from './UiStateContext'
import { PlusIcon, MediaIcon, TranscriptIcon, SparkleIcon, TemplatesIcon, SettingsIcon, HelpIcon } from './icons'

export function IconRail(): JSX.Element {
  const { importFromDialog } = useMedia()
  const { leftView, setLeftView, setRightTab } = useUiState()

  return (
    <nav className="icon-rail">
      <button className="icon-rail-button icon-rail-add" title="Import media" onClick={() => void importFromDialog()}>
        <PlusIcon size={20} />
      </button>

      <div className="icon-rail-group">
        <button
          className={leftView === 'media' ? 'icon-rail-button icon-rail-button-active' : 'icon-rail-button'}
          title="Media"
          onClick={() => setLeftView('media')}
        >
          <MediaIcon size={20} />
          <span className="icon-rail-button-label">Media</span>
        </button>
        <button
          className={leftView === 'transcript' ? 'icon-rail-button icon-rail-button-active' : 'icon-rail-button'}
          title="Transcript"
          onClick={() => setLeftView('transcript')}
        >
          <TranscriptIcon size={20} />
          <span className="icon-rail-button-label">Transcript</span>
        </button>
        <button className="icon-rail-button" title="AI Suggestions" onClick={() => setRightTab('ai')}>
          <SparkleIcon size={20} />
          <span className="icon-rail-button-label">AI</span>
        </button>
        <button
          className={leftView === 'templates' ? 'icon-rail-button icon-rail-button-active' : 'icon-rail-button'}
          title="Templates"
          onClick={() => setLeftView('templates')}
        >
          <TemplatesIcon size={20} />
          <span className="icon-rail-button-label">Templates</span>
        </button>
      </div>

      <div className="icon-rail-group icon-rail-group-bottom">
        <button className="icon-rail-button" title="Settings (coming soon)" disabled>
          <SettingsIcon size={20} />
        </button>
        <button className="icon-rail-button" title="Help (coming soon)" disabled>
          <HelpIcon size={20} />
        </button>
      </div>
    </nav>
  )
}

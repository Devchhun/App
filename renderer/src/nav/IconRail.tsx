import { useMedia } from '../media/MediaContext'
import { useUiState } from './UiStateContext'
import { useAiDubber } from '../dubbing/AiDubberContext'
import { PlusIcon, MediaIcon, TranscriptIcon, SparkleIcon, TemplatesIcon, SettingsIcon, HelpIcon, MicrophoneIcon } from './icons'

export function IconRail(): JSX.Element {
  const { importFromDialog } = useMedia()
  const { leftView, setLeftView, settingsOpen, setSettingsOpen } = useUiState()
  const aiDubber = useAiDubber()

  // Every OTHER rail button also exits AI Dubber (a no-op when it isn't
  // active) alongside its own normal left/right view change -- the user
  // explicitly asked for "click another sidebar item, get the normal panels
  // back" for this one entry point. Story Narration's own entry point (a
  // Timeline-toolbar button, not a rail button) has no such auto-exit today
  // and isn't changed here.
  const switchLeftView = (view: Parameters<typeof setLeftView>[0]): void => {
    aiDubber.exitAiDubber()
    setLeftView(view)
  }

  return (
    <nav className="icon-rail">
      <button
        className="icon-rail-button icon-rail-add"
        title="Import media"
        onClick={() => {
          aiDubber.exitAiDubber()
          void importFromDialog()
        }}
      >
        <PlusIcon size={20} />
      </button>

      <div className="icon-rail-group">
        <button
          className={!aiDubber.active && leftView === 'media' ? 'icon-rail-button icon-rail-button-active' : 'icon-rail-button'}
          title="Media"
          onClick={() => switchLeftView('media')}
        >
          <MediaIcon size={20} />
          <span className="icon-rail-button-label">Media</span>
        </button>
        <button
          className={!aiDubber.active && leftView === 'transcript' ? 'icon-rail-button icon-rail-button-active' : 'icon-rail-button'}
          title="Transcript"
          onClick={() => switchLeftView('transcript')}
        >
          <TranscriptIcon size={20} />
          <span className="icon-rail-button-label">Transcript</span>
        </button>
        <button
          className={!aiDubber.active && leftView === 'aiScript' ? 'icon-rail-button icon-rail-button-active' : 'icon-rail-button'}
          title="Recap Script / សរសេររឿង AI"
          onClick={() => switchLeftView('aiScript')}
        >
          <SparkleIcon size={20} />
          <span className="icon-rail-button-label">AI</span>
        </button>
        <button
          className={!aiDubber.active && leftView === 'templates' ? 'icon-rail-button icon-rail-button-active' : 'icon-rail-button'}
          title="Templates"
          onClick={() => switchLeftView('templates')}
        >
          <TemplatesIcon size={20} />
          <span className="icon-rail-button-label">Templates</span>
        </button>
        <button className={aiDubber.active ? 'icon-rail-button icon-rail-button-active' : 'icon-rail-button'} title="AI Dubber" onClick={() => aiDubber.enterAiDubber()}>
          <MicrophoneIcon size={20} />
          <span className="icon-rail-button-label">AI Dubber</span>
        </button>
      </div>

      <div className="icon-rail-group icon-rail-group-bottom">
        <button
          className={settingsOpen ? 'icon-rail-button icon-rail-button-active' : 'icon-rail-button'}
          title="Settings"
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <SettingsIcon size={20} />
        </button>
        <button className="icon-rail-button" title="Help (coming soon)" disabled>
          <HelpIcon size={20} />
        </button>
      </div>
    </nav>
  )
}

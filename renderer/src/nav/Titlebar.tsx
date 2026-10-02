import { useEffect, useState, useCallback } from 'react'
import type { UpdaterStatus } from '@shared/updater'
import { useProject } from '../project/ProjectContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { useHistory } from '../history/HistoryContext'
import { useChangeAspectRatio } from '../scenes/useAspectRatioChange'
import { useUiState } from './UiStateContext'
import { useExport } from '../export/ExportContext'
import type { BrandPreset } from '@shared/project'
import {
  UndoIcon,
  RedoIcon,
  ChatIcon,
  ExportIcon,
  SparkleIcon,
  MinimizeIcon,
  MaximizeIcon,
  CloseIcon,
  ShieldCheckIcon,
  UpdateIcon,
  SunIcon,
  MoonIcon
} from './icons'
import { useTheme } from './ThemeContext'

const ASPECT_RATIOS: BrandPreset['defaultAspectRatio'][] = ['16:9', '9:16', '1:1']

function SaveStatus(): JSX.Element {
  const { lastSavedAt } = useProject()
  if (!lastSavedAt) {
    return <span className="titlebar-save-status titlebar-save-status-pending">Not saved yet</span>
  }
  return <span className="titlebar-save-status">Autosave {new Date(lastSavedAt).toLocaleTimeString()}</span>
}

/** Whether a Whisper model is on disk -- a click opens Settings >
 * Transcription, which is also where the compute device (GPU / CUDA
 * / CPU) is shown; that badge used to sit here too. */
function DeviceBadges(): JSX.Element {
  const { models } = useTranscript()
  const { openSettings } = useUiState()
  const khmerReady = models.some((m) => m.downloaded)

  return (
    <button
      type="button"
      className={khmerReady ? 'titlebar-badge titlebar-badge-ready titlebar-badge-button' : 'titlebar-badge titlebar-badge-pending titlebar-badge-button'}
      title="Transcription model and compute device -- open Settings > Transcription"
      onClick={() => openSettings('transcription')}
    >
      <ShieldCheckIcon />
      {khmerReady ? 'Khmer Ready' : 'Model Needed'}
    </button>
  )
}

/** Quick light/dark flip. The icon shows what a click WILL do (sun while
 * dark, moon while light) -- the convention that stays unambiguous for a
 * lone unlabelled button. Reads the shared ThemeContext, so it can never
 * disagree with the Settings switch. */
function ThemeButton(): JSX.Element {
  const { theme, toggleTheme } = useTheme()
  return (
    <button className="titlebar-icon-button" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleTheme}>
      {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
    </button>
  )
}

/** The one place to trigger an update check on demand -- until now
 * electron-updater only ever checked automatically once at launch, silently,
 * with no click target and no feedback unless a download happened to finish
 * (see updater.ts). Also handles the 'downloaded' terminal state itself:
 * clicking then restarts and installs immediately instead of waiting for the
 * user to quit normally. */
function UpdateButton(): JSX.Element {
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' })
  const [appVersion, setAppVersion] = useState<string>('')

  useEffect(() => {
    void window.api.getAppVersion().then(setAppVersion)
    return window.api.updater.onStatus(setStatus)
  }, [])

  const busy = status.state === 'checking' || status.state === 'downloading'

  const handleClick = useCallback(() => {
    if (status.state === 'downloaded') {
      void window.api.updater.quitAndInstall()
      return
    }
    if (busy) return
    void window.api.updater.check()
  }, [status.state, busy])

  const title = ((): string => {
    switch (status.state) {
      case 'checking':
        return 'Checking for updates…'
      case 'available':
        return `Update ${status.version} found — downloading…`
      case 'downloading':
        return `Downloading update… ${status.percent}%`
      case 'downloaded':
        return `Update ${status.version} ready — click to restart and install`
      case 'not-available':
        return `You're up to date (v${appVersion})`
      case 'error':
        return `Update check failed: ${status.message}`
      case 'unsupported':
        return 'Auto-update is only available in the installed app, not in dev mode'
      default:
        return appVersion ? `Check for Updates (v${appVersion})` : 'Check for Updates'
    }
  })()

  return (
    <button
      className={status.state === 'downloaded' ? 'titlebar-icon-button titlebar-update-ready' : 'titlebar-icon-button'}
      title={title}
      disabled={busy}
      onClick={handleClick}
    >
      <UpdateIcon size={16} />
    </button>
  )
}

/** `onClose`: what the × does. The editor's titlebar passes "go Home"
 * -- the app is only ever closed from the Home screen's own ×, so a
 * stray click on the editor's × can never quit mid-edit; Home passes
 * nothing and really closes the window. */
export function WindowControls({ onClose }: { onClose?: () => void } = {}): JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    void window.api.windowControls.isMaximized().then(setIsMaximized)
    return window.api.windowControls.onMaximizedChanged(setIsMaximized)
  }, [])

  return (
    <div className="window-controls">
      <button className="window-control-button" title="Minimize" onClick={() => void window.api.windowControls.minimize()}>
        <MinimizeIcon />
      </button>
      <button
        className="window-control-button"
        title={isMaximized ? 'Restore' : 'Maximize'}
        onClick={() => void window.api.windowControls.maximizeToggle()}
      >
        <MaximizeIcon />
      </button>
      <button
        className="window-control-button window-control-close"
        title={onClose ? 'Back to Home' : 'Close'}
        onClick={() => {
          if (onClose) onClose()
          else void window.api.windowControls.close()
        }}
      >
        <CloseIcon />
      </button>
    </div>
  )
}

export function Titlebar(): JSX.Element {
  const { projectName, renameProject } = useProject()
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const commitName = (): void => {
    if (nameDraft !== null && nameDraft.trim()) renameProject(nameDraft)
    setNameDraft(null)
  }
  const { brandPreset } = useBrandPreset()
  const { openHome } = useUiState()
  const { canUndo, canRedo, undo, redo } = useHistory()
  const changeAspectRatio = useChangeAspectRatio()
  const { openDialog: openExportDialog } = useExport()

  return (
    <div className="titlebar-wrap">
      <header className="titlebar">
        <span className="titlebar-logo" aria-hidden="true">
          <SparkleIcon size={16} />
        </span>
        <span className="titlebar-name">Creative AI Editor</span>
        <button className="titlebar-home-button" title="Home -- all projects" onClick={openHome}>
          <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 9.5 10 3l7 6.5V17a1 1 0 0 1-1 1h-4v-5H8v5H4a1 1 0 0 1-1-1z" />
          </svg>
          Home
        </button>
        {projectName &&
          (nameDraft !== null ? (
            <input
              className="titlebar-project-input"
              autoFocus
              value={nameDraft}
              placeholder="Project name"
              onChange={(e) => setNameDraft(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName()
                else if (e.key === 'Escape') setNameDraft(null)
              }}
            />
          ) : (
            <button className="titlebar-project" title="Rename the project" onClick={() => setNameDraft(projectName)}>
              Project: {projectName}
            </button>
          ))}

        <div className="titlebar-history">
          <button
            className="titlebar-icon-button"
            title={canUndo ? 'Undo (Ctrl+Z)' : 'Nothing to undo'}
            disabled={!canUndo}
            onClick={undo}
          >
            <UndoIcon />
          </button>
          <button
            className="titlebar-icon-button"
            title={canRedo ? 'Redo (Ctrl+Shift+Z / Ctrl+Y)' : 'Nothing to redo'}
            disabled={!canRedo}
            onClick={redo}
          >
            <RedoIcon />
          </button>
        </div>

        <SaveStatus />

        <select
          className="titlebar-aspect-select"
          value={brandPreset.defaultAspectRatio}
          onChange={(e) => changeAspectRatio(e.target.value as BrandPreset['defaultAspectRatio'])}
          title="Default export aspect ratio"
        >
          {ASPECT_RATIOS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>


        <div className="titlebar-right">
          <DeviceBadges />
          <button className="titlebar-icon-button" title="Chat (coming soon)" disabled>
            <ChatIcon />
          </button>
          <UpdateButton />
          <ThemeButton />
          {/* Export sits right before the window controls, CapCut-style. */}
          <button className="header-export-button titlebar-export-button" title="Export" onClick={openExportDialog}>
            <ExportIcon /> Export
          </button>
          <WindowControls onClose={openHome} />
        </div>
      </header>
    </div>
  )
}

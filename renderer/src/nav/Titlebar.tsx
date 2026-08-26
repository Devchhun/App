import { useEffect, useState } from 'react'
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
  SettingsIcon,
  ExportIcon,
  SparkleIcon,
  MinimizeIcon,
  MaximizeIcon,
  CloseIcon,
  ShieldCheckIcon,
  ChipIcon
} from './icons'

const ASPECT_RATIOS: BrandPreset['defaultAspectRatio'][] = ['16:9', '9:16', '1:1']

function SaveStatus(): JSX.Element {
  const { lastSavedAt } = useProject()
  if (!lastSavedAt) {
    return <span className="titlebar-save-status titlebar-save-status-pending">Not saved yet</span>
  }
  return <span className="titlebar-save-status">Autosave {new Date(lastSavedAt).toLocaleTimeString()}</span>
}

function DeviceBadges(): JSX.Element {
  const { deviceInfo, models } = useTranscript()
  const khmerReady = models.some((m) => m.downloaded)

  return (
    <>
      <span className={khmerReady ? 'titlebar-badge titlebar-badge-ready' : 'titlebar-badge titlebar-badge-pending'}>
        <ShieldCheckIcon />
        {khmerReady ? 'Khmer Ready' : 'Model Needed'}
      </span>
      {deviceInfo && (
        <span className={deviceInfo.device === 'cuda' ? 'titlebar-badge titlebar-badge-gpu' : 'titlebar-badge titlebar-badge-cpu'}>
          <ChipIcon />
          {deviceInfo.device === 'cuda' ? `${deviceInfo.cudaDeviceName ?? 'GPU'} · CUDA` : 'CPU'}
        </span>
      )}
    </>
  )
}

function WindowControls(): JSX.Element {
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
      <button className="window-control-button window-control-close" title="Close" onClick={() => void window.api.windowControls.close()}>
        <CloseIcon />
      </button>
    </div>
  )
}

export function Titlebar(): JSX.Element {
  const { projectName } = useProject()
  const { brandPreset } = useBrandPreset()
  const { setRightTab } = useUiState()
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
        {projectName && <span className="titlebar-project">Project: {projectName}</span>}

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

        <div className="titlebar-actions">
          <button className="header-generate-button" onClick={() => setRightTab('ai')}>
            <SparkleIcon size={14} /> Generate AI Graphics
          </button>
          <button className="header-export-button" title="Export" onClick={openExportDialog}>
            <ExportIcon /> Export
          </button>
        </div>

        <div className="titlebar-right">
          <DeviceBadges />
          <button className="titlebar-icon-button" title="Chat (coming soon)" disabled>
            <ChatIcon />
          </button>
          <button className="titlebar-icon-button" title="Settings (coming soon)" disabled>
            <SettingsIcon size={16} />
          </button>
          <WindowControls />
        </div>
      </header>
    </div>
  )
}

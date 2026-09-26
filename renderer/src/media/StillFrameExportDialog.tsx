import { useEffect, useState } from 'react'
import { FolderIcon } from '../nav/icons'

/** "Export still frames": the frame under the playhead, saved where the
 * user says at the size and format they pick -- CapCut's dialog, item
 * for item. `dataUrl` is the captured frame (PNG, full source size). */

export type StillResolution = 'original' | '1080' | '720' | '480'
export type StillFormat = 'png' | 'jpeg'

const EXPORT_DIR_KEY = 'cae-still-export-dir-v1'

interface Props {
  dataUrl: string
  defaultName: string
  onClose: () => void
  /** Writes the encoded image; returns the saved path. */
  onExport: (args: { dirPath: string; fileName: string; bytes: Uint8Array; importIntoProject: boolean }) => Promise<void>
}

function readStoredDir(): string {
  try {
    return localStorage.getItem(EXPORT_DIR_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Re-encodes the captured frame at the chosen height/format. Pure DOM
 * work (an <img> into a <canvas>), so the dialog never blocks. */
async function encodeFrame(dataUrl: string, resolution: StillResolution, format: StillFormat): Promise<Uint8Array> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('Could not decode the captured frame.'))
    el.src = dataUrl
  })
  const targetHeight = resolution === 'original' ? img.naturalHeight : Math.min(img.naturalHeight, Number(resolution))
  const scale = targetHeight / img.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable.')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const encoded = format === 'jpeg' ? canvas.toDataURL('image/jpeg', 0.92) : canvas.toDataURL('image/png')
  const base64 = encoded.slice(encoded.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function StillFrameExportDialog({ dataUrl, defaultName, onClose, onExport }: Props): JSX.Element {
  const [name, setName] = useState(defaultName)
  const [dirPath, setDirPath] = useState(readStoredDir)
  const [resolution, setResolution] = useState<StillResolution>('1080')
  const [format, setFormat] = useState<StillFormat>('jpeg')
  const [importIntoProject, setImportIntoProject] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // No folder chosen yet on this machine: the system Videos folder, the
  // same default CapCut uses.
  useEffect(() => {
    if (dirPath) return
    void window.api.media.getDefaultStillDir().then((dir) => setDirPath((prev) => prev || dir))
  }, [dirPath])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const browse = async (): Promise<void> => {
    const result = await window.api.export.pickOutputDir()
    if (!result.canceled && result.path) {
      setDirPath(result.path)
      try {
        localStorage.setItem(EXPORT_DIR_KEY, result.path)
      } catch {
        // Per-machine convenience only.
      }
    }
  }

  const doExport = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const bytes = await encodeFrame(dataUrl, resolution, format)
      const safe = name.trim().replace(/[\\/:*?"<>|]+/g, '-') || defaultName
      await onExport({ dirPath, fileName: `${safe}.${format === 'jpeg' ? 'jpg' : 'png'}`, bytes, importIntoProject })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel still-export" onClick={(e) => e.stopPropagation()}>
        <div className="still-export-head">Export still frames</div>
        <div className="still-export-body">
          <div className="still-export-preview">
            <img src={dataUrl} alt="" draggable={false} />
          </div>
          <div className="still-export-form">
            <label className="still-export-row">
              <span>Name</span>
              <input className="still-export-input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="still-export-row">
              <span>Export to</span>
              <div className="still-export-path">
                <input className="still-export-input" value={dirPath} onChange={(e) => setDirPath(e.target.value)} title={dirPath} />
                <button type="button" className="still-export-browse" title="Choose folder" onClick={() => void browse()}>
                  <FolderIcon size={15} />
                </button>
              </div>
            </div>
            <label className="still-export-row">
              <span>Resolution</span>
              <select className="still-export-select" value={resolution} onChange={(e) => setResolution(e.target.value as StillResolution)}>
                <option value="original">Original</option>
                <option value="1080">1080P</option>
                <option value="720">720P</option>
                <option value="480">480P</option>
              </select>
            </label>
            <label className="still-export-row">
              <span>Format</span>
              <select className="still-export-select" value={format} onChange={(e) => setFormat(e.target.value as StillFormat)}>
                <option value="jpeg">JPEG</option>
                <option value="png">PNG</option>
              </select>
            </label>
            <div className="still-export-row">
              <span>Import project</span>
              <button
                type="button"
                role="switch"
                aria-checked={importIntoProject}
                aria-label="Import into project"
                className={importIntoProject ? 'cp-switch cp-switch-on' : 'cp-switch'}
                onClick={() => setImportIntoProject((v) => !v)}
              >
                <span className="cp-switch-knob" />
              </button>
            </div>
            {error && <div className="voiceover-recorder-error">{error}</div>}
          </div>
        </div>
        <div className="still-export-actions">
          <button type="button" className="still-export-primary" disabled={busy || !dirPath.trim()} onClick={() => void doExport()}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
          <button type="button" className="still-export-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

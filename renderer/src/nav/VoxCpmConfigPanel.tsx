import { useCallback, useEffect, useRef, useState } from 'react'
import type { ValidateVoxCpmInstallResult, VoxCpmDevice, DubbingEngine } from '@shared/dubbing'
import type { VoxCpmSettings } from '../dubbing/voxcpmSettings'
import { SettingsIcon, GlobeIcon, FolderIcon } from './icons'

interface Props {
  settings: VoxCpmSettings
  onChange: (next: Partial<VoxCpmSettings>) => void
}

/** Which of the three things a portable install must have is missing, keyed
 * by the tail of the path validateVoxCpmInstall reports. Labelled the way
 * the user thinks about them rather than by folder name. */
const REQUIREMENTS: { label: string; detail: string; match: string }[] = [
  { label: 'Python runtime', detail: 'voxcpm_runtime\\python.exe', match: 'python.exe' },
  { label: 'VoxCPM engine source', detail: 'VoxCPM-main\\src', match: 'src' },
  { label: 'Model weights (~11GB)', detail: 'models\\openbmb__VoxCPM2', match: 'openbmb__VoxCPM2' }
]

/** VoxCPM2's own settings card: which engine speaks, where the portable
 * install lives, and whether that folder actually has everything needed.
 *
 * Finds the install by itself. The path used to be a hardcoded default from
 * one machine, so on any other computer this opened "configured" with a
 * folder that wasn't there; now an unset (or invalid) path triggers a real
 * scan of the handful of places these get unzipped to, and the first valid
 * hit is adopted -- see app/main/media/voxcpmDiscovery.ts. */
export function VoxCpmConfigPanel({ settings, onChange }: Props): JSX.Element {
  const [validation, setValidation] = useState<ValidateVoxCpmInstallResult | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detectNote, setDetectNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const autoRanRef = useRef(false)

  /** Every call here crosses IPC, and a failure used to leave the card
   * sitting at "Not Configured / not checked" with no explanation at all --
   * which is exactly what a stale preload (the dev server not restarted
   * after a main-process change) looks like. Any throw is now shown. */
  const describe = (err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err)
    return /is not a function/.test(message)
      ? `${message} -- this build's main process is out of date. Restart the app (or "npm run dev") and try again.`
      : message
  }

  const validate = useCallback(async (dir: string) => {
    if (!dir.trim()) {
      setValidation(null)
      return null
    }
    try {
      const result = await window.api.dubbing.validateInstall(dir)
      setValidation(result)
      setError(null)
      return result
    } catch (err) {
      setValidation(null)
      setError(describe(err))
      return null
    }
  }, [])

  const detect = useCallback(
    async (silent: boolean) => {
      setDetecting(true)
      if (!silent) {
        setDetectNote(null)
        setError(null)
      }
      try {
        const found = await window.api.dubbing.detectInstalls(settings.installDir)
        if (found.length === 0) {
          setDetectNote('No VoxCPM2 install found in Downloads, Desktop, Documents or any drive root.')
          return
        }
        // Best guess first (search order) -- adopt it unless what's already
        // set is itself one of the valid hits.
        const keep = settings.installDir && found.some((p) => p.toLowerCase() === settings.installDir.toLowerCase())
        const chosen = keep ? settings.installDir : found[0]
        if (!keep) onChange({ installDir: chosen })
        await validate(chosen)
        setDetectNote(found.length > 1 ? `Found ${found.length} installs; using the first.` : null)
      } catch (err) {
        setError(describe(err))
      } finally {
        setDetecting(false)
      }
    },
    [settings.installDir, onChange, validate]
  )

  // One automatic attempt per mount, and only when there's nothing usable
  // configured -- so a machine that's already set up never pays for a scan,
  // and a fresh machine configures itself without being asked to.
  useEffect(() => {
    if (autoRanRef.current) return
    autoRanRef.current = true
    void (async () => {
      const result = await validate(settings.installDir)
      if (!result?.ok) await detect(true)
    })()
  }, [settings.installDir, validate, detect])

  const browse = useCallback(async () => {
    try {
      const picked = await window.api.dubbing.pickInstallFolder()
      if (!picked) return
      onChange({ installDir: picked })
      setDetectNote(null)
      setError(null)
      await validate(picked)
    } catch (err) {
      setError(describe(err))
    }
  }, [onChange, validate])

  const configured = validation?.ok === true
  const missing = validation?.missing ?? []

  return (
    <div className="voxcpm-config">
      <div className="voxcpm-config-head">
        <span className="voxcpm-config-title">
          <SettingsIcon size={15} />
          VoxCPM2 Config
        </span>
        <span className="voxcpm-config-head-note">System Config</span>
      </div>

      <div className="voxcpm-config-section">
        <div className="voxcpm-config-label">Execution Mode</div>
        <div className="voxcpm-mode-switch" role="group" aria-label="Execution mode">
          <button
            className={settings.engine === 'voxcpm2' ? 'voxcpm-mode-option voxcpm-mode-option-active' : 'voxcpm-mode-option'}
            onClick={() => onChange({ engine: 'voxcpm2' as DubbingEngine })}
            title="VoxCPM2 on this computer. Any voice, can clone a recording, no internet -- but needs the portable install below and a capable GPU."
          >
            <SettingsIcon size={14} />
            Local (Offline)
          </button>
          <button
            className={settings.engine === 'edge-tts' ? 'voxcpm-mode-option voxcpm-mode-option-active' : 'voxcpm-mode-option'}
            onClick={() => onChange({ engine: 'edge-tts' as DubbingEngine })}
            title="Microsoft Edge neural TTS over the internet. Built into this app -- nothing to install, about a second per line, but only its fixed Khmer male/female voices (no cloning)."
          >
            <GlobeIcon size={14} />
            Remote (Online)
          </button>
          <button
            className={settings.engine === 'kiritts' ? 'voxcpm-mode-option voxcpm-mode-option-active' : 'voxcpm-mode-option'}
            onClick={() => onChange({ engine: 'kiritts' as DubbingEngine })}
            title="KiriTTS in the cloud: Khmer voices and voice cloning with nothing running on this computer. Needs a KiriTTS API key (Settings > AI API Keys) on a plan with API access."
          >
            <GlobeIcon size={14} />
            KiriTTS (Cloud)
          </button>
        </div>
      </div>

      {/* Only Local runs out of the install folder -- Remote (Edge TTS) uses
          the runtime bundled with the app, so none of this applies to it. */}
      {settings.engine === 'voxcpm2' && (
        <>
          <div className="voxcpm-config-section">
            <div className="voxcpm-config-label-row">
              <span className="voxcpm-config-label">VoxCPM2 Installation Folder</span>
              {configured ? (
                <span className="voxcpm-status-ok">✓ Path Configured</span>
              ) : detecting ? (
                <span className="voxcpm-status-busy">Searching…</span>
              ) : (
                <span className="voxcpm-status-bad">✗ Not Configured</span>
              )}
            </div>
            <div className="voxcpm-path-row">
              <input
                type="text"
                className="voxcpm-path-input"
                placeholder="Not set -- click Detect or Browse"
                value={settings.installDir}
                onChange={(e) => {
                  onChange({ installDir: e.target.value })
                  setValidation(null)
                }}
                onBlur={(e) => void validate(e.target.value)}
                spellCheck={false}
              />
              <button className="voxcpm-browse-button" onClick={() => void browse()}>
                <FolderIcon size={14} />
                Browse…
              </button>
            </div>
            <div className="voxcpm-config-actions">
              <button className="voxcpm-detect-button" disabled={detecting} onClick={() => void detect(false)}>
                {detecting ? 'Searching…' : 'Detect Automatically'}
              </button>
              <label className="voxcpm-device-field">
                Device
                <select className="voxcpm-device-select" value={settings.device} onChange={(e) => onChange({ device: e.target.value as VoxCpmDevice })}>
                  <option value="auto">Auto</option>
                  <option value="cuda">CUDA (GPU)</option>
                  <option value="cpu">CPU</option>
                </select>
              </label>
            </div>
            {detectNote && <div className="voxcpm-config-note">{detectNote}</div>}
            {error && <div className="voxcpm-config-error">{error}</div>}
          </div>

          <div className="voxcpm-config-section">
            <div className="voxcpm-config-label">Voice tone</div>
            <div className="voxcpm-mode-switch voxcpm-tone-switch" role="group" aria-label="Voice tone">
              {(
                [
                  ['natural', 'Natural', 'Smoothest sound. Use this if the voice sounds processed or bubbly.'],
                  ['balanced', 'Balanced', 'The default: clean sound, still holds one speaker well.'],
                  ['locked', 'Locked', 'Holds one speaker hardest across many lines: emotions get less pitch room, so lines sound more alike. Can sound more processed.']
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  className={settings.tone === value ? 'voxcpm-mode-option voxcpm-mode-option-active' : 'voxcpm-mode-option'}
                  title={hint}
                  onClick={() => onChange({ tone: value })}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="voxcpm-config-note">
              {settings.tone === 'natural'
                ? 'Smoothest sound -- pick this first if a generated voice warbles.'
                : settings.tone === 'locked'
                  ? 'Strongest speaker lock: each emotion may move the voice less, so every line stays closest to the character. Can sound more processed.'
                  : 'Clean sound with a good speaker lock.'}
            </div>
          </div>

          <div className="voxcpm-config-section">
            <div className="voxcpm-config-label">Voice Consistency</div>
            <div className="voxcpm-toggle-row">
              <div className="voxcpm-toggle-text">
                <span className="voxcpm-toggle-title">Pitch match</span>
                <span className="voxcpm-toggle-hint">
                  Keeps every line on the reference voice's own pitch: a take that lands more than 2 semitones away is generated again, and what's left is nudged back with a
                  formant-preserving shift. Off leaves each take exactly as the model made it -- useful for comparing by ear.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.pitchMatch}
                aria-label="Pitch match"
                className={settings.pitchMatch ? 'cp-switch cp-switch-on' : 'cp-switch'}
                onClick={() => onChange({ pitchMatch: !settings.pitchMatch })}
              >
                <span className="cp-switch-knob" />
              </button>
            </div>
          </div>

          <div className="voxcpm-requirements">
            <div className="voxcpm-requirements-title">&gt;_ Requirements Verification</div>
            {REQUIREMENTS.map((req) => {
              const absent = !validation || missing.some((m) => m.endsWith(req.match))
              return (
                <div key={req.label} className="voxcpm-requirement-row" title={req.detail}>
                  <span className="voxcpm-requirement-label">{req.label}</span>
                  {validation === null ? (
                    <span className="voxcpm-requirement-unknown">— not checked</span>
                  ) : absent ? (
                    <span className="voxcpm-requirement-missing">✗ Missing</span>
                  ) : (
                    <span className="voxcpm-requirement-found">✓ Found</span>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

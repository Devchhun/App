// AI Dubber's VoxCPM2 voice-engine settings -- persisted to localStorage as
// a per-machine preference (mirrors renderer/src/timeline/timelineViewPrefs.ts
// exactly: versioned key, no migrator, per-field fallback to defaults on any
// parse error/missing/out-of-range value), deliberately NOT written into the
// project file. Where the portable VoxCPM2 install lives, and which device
// to run it on, are facts about THIS computer, not about the video project
// being edited -- a project opened on a different machine shouldn't carry a
// stale path from someone else's Downloads folder.

import { DEFAULT_VOICE_TONE, type VoxCpmDevice, type DubbingEngine, type VoiceTone } from '@shared/dubbing'

export type { VoiceTone }

export type { VoxCpmDevice, DubbingEngine }

export interface VoxCpmSettings {
  /** Which TTS engine "Generate Dubbing" uses -- see DubbingEngine. Stored
   * here with the install path because both engines run out of the SAME
   * portable Python runtime, so one folder setting serves both. */
  engine: DubbingEngine
  installDir: string
  device: VoxCpmDevice
  /** Pitch match: retry a take whose baseline pitch lands away from the
   * reference clip's, and nudge what's left onto it -- see
   * app/main/media/voxcpmTts.ts's VOICE_PITCH_TOLERANCE_SEMITONES. On by
   * default; off lets the takes come out exactly as the model made them,
   * for A/B listening. */
  pitchMatch: boolean
  /** How hard VoxCPM2 is pushed -- see shared/dubbing.ts's VoiceTone. */
  tone: VoiceTone
}

// installDir starts EMPTY on purpose. It used to be hardcoded to one
// machine's own Downloads path, which is wrong everywhere else -- on any
// other computer the app opened already "configured" with a path that
// doesn't exist, and nothing ever corrected it. Empty means "not known
// yet", which is what makes the Settings panel go and FIND the real install
// (see app/main/media/voxcpmDiscovery.ts).
export const DEFAULT_VOXCPM_SETTINGS: VoxCpmSettings = {
  engine: 'voxcpm2',
  installDir: '',
  device: 'auto',
  pitchMatch: true,
  tone: DEFAULT_VOICE_TONE
}

const DEVICES: VoxCpmDevice[] = ['auto', 'cuda', 'cpu']
const TONES: VoiceTone[] = ['natural', 'balanced', 'locked']
const ENGINES: DubbingEngine[] = ['voxcpm2', 'edge-tts']

const STORAGE_KEY = 'cae-voxcpm-settings-v1'

export function getVoxCpmSettingsStorageKey(): string {
  return STORAGE_KEY
}

/** Parses a raw localStorage value into a valid VoxCpmSettings. Any parse
 * error, missing field, or invalid value falls back to that field's default
 * individually -- a corrupt/old value never breaks the whole preference. */
export function parseStoredVoxCpmSettings(raw: string | null): VoxCpmSettings {
  if (!raw) return DEFAULT_VOXCPM_SETTINGS
  try {
    const parsed = JSON.parse(raw) as Partial<VoxCpmSettings>
    return {
      engine: ENGINES.includes(parsed.engine as DubbingEngine) ? (parsed.engine as DubbingEngine) : DEFAULT_VOXCPM_SETTINGS.engine,
      installDir: typeof parsed.installDir === 'string' && parsed.installDir.trim() ? parsed.installDir : DEFAULT_VOXCPM_SETTINGS.installDir,
      device: DEVICES.includes(parsed.device as VoxCpmDevice) ? (parsed.device as VoxCpmDevice) : DEFAULT_VOXCPM_SETTINGS.device,
      pitchMatch: typeof parsed.pitchMatch === 'boolean' ? parsed.pitchMatch : DEFAULT_VOXCPM_SETTINGS.pitchMatch,
      tone: TONES.includes(parsed.tone as VoiceTone) ? (parsed.tone as VoiceTone) : DEFAULT_VOXCPM_SETTINGS.tone
    }
  } catch {
    return DEFAULT_VOXCPM_SETTINGS
  }
}

export function serializeVoxCpmSettings(settings: VoxCpmSettings): string {
  return JSON.stringify(settings)
}

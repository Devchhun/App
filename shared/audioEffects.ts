/** Sound effects for audio clips (Clip Properties > Audio Effects): a preset
 * with an amount, plus bass/treble. Applied by rendering the clip's sound
 * through ffmpeg into a new file the clip then plays (renderer
 * AudioEffectsContext) -- so the Player and Export hear exactly the same
 * thing, and the original file is kept for re-adjusting or removing. */

export type AudioEffectPreset =
  | 'none'
  | 'echo'
  | 'reverb'
  | 'radio'
  | 'phone'
  | 'megaphone'
  | 'deep'
  | 'high'
  | 'robot'
  | 'clear'
  | 'denoise'
  | 'bass'

export interface AudioEffectSettings {
  preset: AudioEffectPreset
  /** 0-100: how strong the preset is. */
  amount: number
  /** -12..12 dB */
  bassDb: number
  trebleDb: number
}

export const AUDIO_EFFECT_PRESETS: { id: AudioEffectPreset; label: string; hint: string }[] = [
  { id: 'none', label: 'None', hint: 'No preset (bass/treble still apply)' },
  { id: 'echo', label: 'Echo', hint: 'Repeats that fade away' },
  { id: 'reverb', label: 'Reverb', hint: 'A room or hall around the voice' },
  { id: 'radio', label: 'Radio', hint: 'Thin, band-limited broadcast sound' },
  { id: 'phone', label: 'Phone', hint: 'A voice over the telephone' },
  { id: 'megaphone', label: 'Megaphone', hint: 'Loud, harsh and narrow' },
  { id: 'deep', label: 'Deep', hint: 'Lower pitch, same speed' },
  { id: 'high', label: 'High', hint: 'Higher pitch, same speed' },
  { id: 'robot', label: 'Robot', hint: 'Metallic robot voice' },
  { id: 'clear', label: 'Clear voice', hint: 'Brighter, more present speech' },
  { id: 'denoise', label: 'Denoise', hint: 'Less background hiss and noise' },
  { id: 'bass', label: 'Bass boost', hint: 'Heavier low end' }
]

export function createDefaultAudioEffectSettings(): AudioEffectSettings {
  return { preset: 'none', amount: 50, bassDb: 0, trebleDb: 0 }
}

export function sanitizeAudioEffectSettings(s: Partial<AudioEffectSettings> | undefined): AudioEffectSettings {
  const d = createDefaultAudioEffectSettings()
  const num = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback)
  return {
    preset: AUDIO_EFFECT_PRESETS.some((p) => p.id === s?.preset) ? (s!.preset as AudioEffectPreset) : d.preset,
    amount: num(s?.amount, 0, 100, d.amount),
    bassDb: num(s?.bassDb, -12, 12, d.bassDb),
    trebleDb: num(s?.trebleDb, -12, 12, d.trebleDb)
  }
}

/** True when the settings change nothing (the clip plays its original). */
export function isNeutralAudioEffect(s: AudioEffectSettings): boolean {
  return s.preset === 'none' && s.bassDb === 0 && s.trebleDb === 0
}

const r2 = (n: number): number => Math.round(n * 100) / 100

/** Pitch by `factor` keeping the length: play faster/slower, then stretch back. */
function pitch(factor: number, sampleRate: number): string {
  return `asetrate=${Math.round(sampleRate * factor)},aresample=${sampleRate},atempo=${Math.round((1 / factor) * 10000) / 10000}`
}

/** The ffmpeg audio filter chain for the settings ('' when neutral). Every
 * chain keeps the clip's length (pitch is compensated with atempo) and ends
 * in a limiter so a louder effect never clips. */
export function audioEffectFilter(settings: AudioEffectSettings, sampleRate = 48000): string {
  const s = sanitizeAudioEffectSettings(settings)
  if (isNeutralAudioEffect(s)) return ''
  const a = s.amount / 100
  const steps: string[] = []
  switch (s.preset) {
    case 'echo':
      steps.push(`aecho=0.8:0.85:${Math.round(180 + 320 * a)}|${Math.round(360 + 640 * a)}:${r2(0.25 + 0.35 * a)}|${r2(0.12 + 0.2 * a)}`)
      break
    case 'reverb':
      steps.push(`aecho=0.8:0.88:${[37, 59, 83, 109, 137].map((d) => Math.round(d * (1 + a))).join('|')}:${[0.4, 0.32, 0.25, 0.18, 0.12].map((g) => r2(g * (0.4 + 0.6 * a))).join('|')}`)
      break
    case 'radio':
      steps.push(`highpass=f=${Math.round(250 + 250 * a)}`, `lowpass=f=${Math.round(4500 - 1500 * a)}`, 'acompressor=threshold=-20dB:ratio=4:attack=5:release=60')
      break
    case 'phone':
      steps.push(`highpass=f=${Math.round(400 + 300 * a)}`, `lowpass=f=${Math.round(3400 - 800 * a)}`, `acrusher=bits=${Math.round(12 - 4 * a)}:mode=log:aa=1:mix=${r2(0.2 + 0.4 * a)}`)
      break
    case 'megaphone':
      steps.push('highpass=f=550', 'lowpass=f=4000', `acrusher=bits=8:mode=log:aa=1:mix=${r2(0.15 + 0.35 * a)}`, `volume=${r2(1 + a)}`)
      break
    case 'deep':
      steps.push(pitch(1 - 0.3 * a, sampleRate))
      break
    case 'high':
      steps.push(pitch(1 + 0.4 * a, sampleRate))
      break
    case 'robot':
      steps.push("afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75", `aecho=0.8:0.6:${Math.round(8 + 12 * a)}:${r2(0.3 + 0.4 * a)}`)
      break
    case 'clear':
      steps.push('highpass=f=80', `equalizer=f=3000:t=o:w=1.2:g=${r2(2 + 6 * a)}`, 'acompressor=threshold=-20dB:ratio=3:attack=5:release=80')
      break
    case 'denoise':
      steps.push(`afftdn=nr=${Math.round(8 + 22 * a)}:nf=-30`)
      break
    case 'bass':
      steps.push(`bass=g=${r2(4 + 10 * a)}:f=110`)
      break
    case 'none':
      break
  }
  if (s.bassDb !== 0) steps.push(`bass=g=${r2(s.bassDb)}:f=100`)
  if (s.trebleDb !== 0) steps.push(`treble=g=${r2(s.trebleDb)}:f=6000`)
  steps.push('alimiter=limit=0.95')
  return steps.join(',')
}

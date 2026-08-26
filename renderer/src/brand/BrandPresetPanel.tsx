import { useBrandPreset } from './BrandPresetContext'
import { useChangeAspectRatio } from '../scenes/useAspectRatioChange'
import type { BrandPreset } from '@shared/project'

const KHMER_FONTS = ['Noto Sans Khmer', 'Leelawadee UI', 'Khmer OS', 'Khmer OS Battambang']
const LATIN_FONTS = ['Segoe UI', 'Leelawadee UI', 'Arial', 'Georgia']
const ANIMATION_INTENSITIES: BrandPreset['animationIntensity'][] = ['minimal', 'balanced', 'energetic', 'cinematic', 'custom']
const ASPECT_RATIOS: BrandPreset['defaultAspectRatio'][] = ['16:9', '9:16', '1:1']

export function BrandPresetPanel(): JSX.Element {
  const { brandPreset, updateBrandPreset } = useBrandPreset()
  const changeAspectRatio = useChangeAspectRatio()

  return (
    <div className="brand-preset-panel editor-scroll">
      <label className="scene-properties-field">
        Project name
        <input type="text" value={brandPreset.projectName} onChange={(e) => updateBrandPreset({ projectName: e.target.value })} />
      </label>

      <div className="brand-color-row">
        <label className="brand-color-field">
          Primary
          <input type="color" value={brandPreset.primaryColor} onChange={(e) => updateBrandPreset({ primaryColor: e.target.value })} />
        </label>
        <label className="brand-color-field">
          Secondary
          <input type="color" value={brandPreset.secondaryColor} onChange={(e) => updateBrandPreset({ secondaryColor: e.target.value })} />
        </label>
        <label className="brand-color-field">
          Accent
          <input type="color" value={brandPreset.accentColor} onChange={(e) => updateBrandPreset({ accentColor: e.target.value })} />
        </label>
      </div>

      <label className="scene-properties-field">
        Khmer font
        <select value={brandPreset.khmerFont} onChange={(e) => updateBrandPreset({ khmerFont: e.target.value })}>
          {KHMER_FONTS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>

      <label className="scene-properties-field">
        Latin font
        <select value={brandPreset.latinFont} onChange={(e) => updateBrandPreset({ latinFont: e.target.value })}>
          {LATIN_FONTS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>

      <label className="scene-properties-field">
        Box style
        <select value={brandPreset.boxStyle} onChange={(e) => updateBrandPreset({ boxStyle: e.target.value })}>
          <option value="rounded">Rounded</option>
          <option value="square">Square</option>
          <option value="pill">Pill</option>
        </select>
      </label>

      <label className="scene-properties-field">
        Background style
        <select value={brandPreset.backgroundStyle} onChange={(e) => updateBrandPreset({ backgroundStyle: e.target.value })}>
          <option value="solid">Solid</option>
          <option value="translucent">Translucent</option>
          <option value="outline">Outline</option>
        </select>
      </label>

      <label className="scene-properties-field">
        Animation intensity
        <select
          value={brandPreset.animationIntensity}
          onChange={(e) => updateBrandPreset({ animationIntensity: e.target.value as BrandPreset['animationIntensity'] })}
        >
          {ANIMATION_INTENSITIES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>

      <label className="scene-properties-field">
        Aspect ratio
        <select
          value={brandPreset.defaultAspectRatio}
          onChange={(e) => changeAspectRatio(e.target.value as BrandPreset['defaultAspectRatio'])}
        >
          {ASPECT_RATIOS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

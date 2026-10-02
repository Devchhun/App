import type { Scene } from '@shared/project'
import type { TextAlign } from '@shared/templates'
import { plainTextLook, PLAIN_TEXT_DEFAULTS } from '@shared/plainText'
import { useHistoryFieldProps } from '../history/useHistoryFieldProps'

type Patch = Partial<Scene>

/** One-click looks: the words alone (with an outline so they read on any
 * picture), or on a box. */
const LOOKS: { name: string; patch: Patch; preview: { color: string; stroke?: string; box?: string } }[] = [
  { name: 'Classic', patch: { textColor: '#ffffff', textStrokeColor: '#000000', textStrokeWidth: 3, textShadow: true, textBackground: false }, preview: { color: '#ffffff', stroke: '#000000' } },
  { name: 'Yellow', patch: { textColor: '#ffd21f', textStrokeColor: '#000000', textStrokeWidth: 3, textShadow: true, textBackground: false }, preview: { color: '#ffd21f', stroke: '#000000' } },
  { name: 'Clean', patch: { textColor: '#ffffff', textStrokeWidth: 0, textShadow: true, textBackground: false }, preview: { color: '#ffffff' } },
  { name: 'Neon', patch: { textColor: '#38f3ff', textStrokeColor: '#00343a', textStrokeWidth: 2, textShadow: true, textBackground: false }, preview: { color: '#38f3ff', stroke: '#00343a' } },
  { name: 'Dark box', patch: { textColor: '#ffffff', textBackground: true, fillColor: '#000000', fillOpacity: 70, textShadow: false }, preview: { color: '#ffffff', box: 'rgba(0,0,0,0.7)' } },
  { name: 'Light box', patch: { textColor: '#111111', textBackground: true, fillColor: '#ffffff', fillOpacity: 92, textShadow: false }, preview: { color: '#111111', box: 'rgba(255,255,255,0.92)' } },
  { name: 'Red box', patch: { textColor: '#ffffff', textBackground: true, fillColor: '#e53935', fillOpacity: 100, textShadow: false }, preview: { color: '#ffffff', box: '#e53935' } }
]

/** Properties > Design for Add Text's plain text: the words, a look in one
 * click, then size, color, outline, shadow and an optional box -- what the
 * Player shows and Export burns in (shared/plainText.ts). */
export function PlainTextDesign({ scene, disabled, update }: { scene: Scene; disabled: boolean; update: (patch: Patch) => void }): JSX.Element {
  const history = useHistoryFieldProps()
  const look = plainTextLook(scene)
  const focusBlur = { onFocus: history.onFocus, onBlur: history.onBlur }

  return (
    <div className="plain-text-design">
      <label className="plain-text-field">
        <span>Text</span>
        <textarea lang="km" rows={2} value={scene.visualText} disabled={disabled} onChange={(e) => update({ visualText: e.target.value })} {...focusBlur} />
      </label>

      <div className="plain-text-looks" role="list">
        {LOOKS.map((option) => (
          <button key={option.name} role="listitem" className="plain-text-look" disabled={disabled} title={option.name} onClick={() => update(option.patch)}>
            <span
              className="plain-text-look-sample"
              style={{
                color: option.preview.color,
                background: option.preview.box ?? 'transparent',
                WebkitTextStroke: option.preview.stroke ? `2px ${option.preview.stroke}` : undefined,
                paintOrder: 'stroke fill'
              }}
            >
              Aa
            </span>
            <small>{option.name}</small>
          </button>
        ))}
      </div>

      <div className="plain-text-row">
        <span className="plain-text-label">Size</span>
        <input type="range" min={24} max={200} step={2} value={look.fontSizePx} disabled={disabled} onChange={(e) => update({ fontSizePx: Number(e.target.value) })} {...focusBlur} />
        <span className="plain-text-value">{look.fontSizePx}</span>
      </div>

      <div className="plain-text-row">
        <span className="plain-text-label">Color</span>
        <input className="plain-text-color" type="color" value={look.color} disabled={disabled} onChange={(e) => update({ textColor: e.target.value })} />
        <div className="plain-text-align" role="group" aria-label="Alignment">
          {(['left', 'center', 'right'] as TextAlign[]).map((align) => (
            <button key={align} className={look.align === align ? 'plain-text-align-button plain-text-align-button-active' : 'plain-text-align-button'} disabled={disabled} title={`Align ${align}`} onClick={() => update({ textAlign: align })}>
              <AlignIcon align={align} />
            </button>
          ))}
        </div>
      </div>

      <div className="plain-text-toggle-block">
        <label className="plain-text-toggle">
          <span>Outline</span>
          <input type="checkbox" className="subtitle-overlay-switch" checked={!look.background && look.strokeWidth > 0} disabled={disabled || look.background} onChange={(e) => update({ textStrokeWidth: e.target.checked ? PLAIN_TEXT_DEFAULTS.strokeWidth : 0 })} />
        </label>
        {!look.background && look.strokeWidth > 0 && (
          <div className="plain-text-row plain-text-sub">
            <input className="plain-text-color" type="color" value={look.strokeColor} disabled={disabled} onChange={(e) => update({ textStrokeColor: e.target.value })} />
            <input type="range" min={1} max={12} step={1} value={look.strokeWidth} disabled={disabled} onChange={(e) => update({ textStrokeWidth: Number(e.target.value) })} {...focusBlur} />
            <span className="plain-text-value">{look.strokeWidth}</span>
          </div>
        )}
        {look.background && <p className="plain-text-note">A box replaces the outline.</p>}
      </div>

      <div className="plain-text-toggle-block">
        <label className="plain-text-toggle">
          <span>Shadow</span>
          <input type="checkbox" className="subtitle-overlay-switch" checked={look.shadow} disabled={disabled} onChange={(e) => update({ textShadow: e.target.checked })} />
        </label>
      </div>

      <div className="plain-text-toggle-block">
        <label className="plain-text-toggle">
          <span>Background</span>
          <input type="checkbox" className="subtitle-overlay-switch" checked={look.background} disabled={disabled} onChange={(e) => update({ textBackground: e.target.checked })} />
        </label>
        {look.background && (
          <div className="plain-text-row plain-text-sub">
            <input className="plain-text-color" type="color" value={look.backgroundColor} disabled={disabled} onChange={(e) => update({ fillColor: e.target.value })} />
            <input type="range" min={10} max={100} step={5} value={look.backgroundOpacity} disabled={disabled} onChange={(e) => update({ fillOpacity: Number(e.target.value) })} {...focusBlur} />
            <span className="plain-text-value">{look.backgroundOpacity}%</span>
          </div>
        )}
      </div>

      <p className="plain-text-note">Drag the text on the Player to move it; drag its corners to change where it wraps. It is exported with the video.</p>
    </div>
  )
}

function AlignIcon({ align }: { align: TextAlign }): JSX.Element {
  const rows = align === 'left' ? ['M3 5h14', 'M3 9h9', 'M3 13h14', 'M3 17h9'] : align === 'right' ? ['M3 5h14', 'M8 9h9', 'M3 13h14', 'M8 17h9'] : ['M3 5h14', 'M5.5 9h9', 'M3 13h14', 'M5.5 17h9']
  return (
    <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
      {rows.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

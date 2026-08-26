import { useState } from 'react'
import { useMedia } from '../media/MediaContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { usePlayback } from '../playback/PlaybackContext'
import { useScenes } from './SceneContext'
import { useSequence } from '../sequence/SequenceContext'
import { useHistoryFieldProps } from '../history/useHistoryFieldProps'
import { IconPicker } from '../templates/IconPicker'
import { TemplateIcon, resolveTemplateIconId } from '../templates/templateIcons'
import { deriveChecklistItems } from '../templates/Checklist'
import { deriveStepItems } from '../templates/ThreeStepPresenterPlan'
import { deriveDeviceItems } from '../templates/DeviceCompatibilityLineup'
import { deriveSocialItems } from '../templates/SocialChannelCard'
import { deriveLoginRows } from '../templates/SecurityLoginFlow'
import { deriveBenefitItems } from '../templates/FeatureBenefitsPills'
import { deriveFlowNodes } from '../templates/CauseEffectFlow'
import { deriveIsometricNodes } from '../templates/IsometricSystemDiagram'
import { VAULT_DEFAULT_CONFIG } from '../templates/VaultBreakInAnimation'
import { ANIMATED_VAULT_DEFAULT_CONFIG } from '../templates/AnimatedBreakInVaultDiagram'
import { DATA_CENTER_DEFAULT_CONFIG } from '../templates/DataCenterCyberIntrusion'
import { HOSPITAL_RESPONSE_DEFAULT_CONFIG } from '../templates/HospitalEmergencyResponse'
import { buildTemplateSwitchPatch } from './templateSwitch'
import { getDefaultContentTransform } from './contentTransformReflow'
import {
  clampContentTransform,
  clampContentTransformUnconstrained,
  computeScalePercent,
  applyScalePercent,
  UNCONSTRAINED_SAFETY_LIMITS,
  MIN_SCALE_PERCENT,
  MAX_SCALE_PERCENT
} from './contentTransformMath'
import type {
  Scene,
  SceneContentItem,
  VaultBreakInConfig,
  AnimatedVaultDiagramConfig,
  DataCenterCyberIntrusionConfig,
  HospitalEmergencyResponseConfig
} from '@shared/project'
import {
  TEMPLATE_IDS,
  TEMPLATE_LABELS,
  TEMPLATE_RECOMMENDATIONS,
  TEMPLATE_ICON_SUPPORT,
  TEMPLATE_CONTENT_SLOTS,
  TEMPLATE_ITEM_COUNT,
  PRESENTATION_MODE_VALUES,
  PRESENTATION_MODE_LABELS,
  SCENE_BACKGROUND_MODE_VALUES,
  SCENE_BACKGROUND_MODE_LABELS,
  ANIMATION_PRESET_VALUES,
  ANIMATION_PRESET_LABELS,
  ANIMATION_EASING_VALUES,
  ANIMATION_EASING_LABELS,
  FONT_WEIGHT_VALUES,
  FONT_WEIGHT_LABELS,
  CANVAS_SIZE_BY_ASPECT,
  getEffectivePresentationMode,
  MOTION_PRESET_VALUES,
  MOTION_PRESET_LABELS
} from '@shared/templates'
import type {
  TemplateId,
  AnimationPreset,
  AnimationEasing,
  FontWeight,
  TextAlign,
  ScenePosition,
  TemplateIconId,
  PresentationMode,
  SceneBackgroundMode,
  MotionPreset
} from '@shared/templates'

type PropertiesTab = 'design' | 'animation' | 'timing'

const DEFAULT_POSITION: ScenePosition = { xPct: 30, yPct: 40, widthPct: 40, heightPct: 20 }
const KHMER_FONTS = ['Noto Sans Khmer', 'Leelawadee UI', 'Khmer OS', 'Khmer OS Battambang']
const LATIN_FONTS = ['Segoe UI', 'Leelawadee UI', 'Arial', 'Georgia']

interface StylePreset {
  id: string
  fillColor: string
  textColor: string
  borderColor: string
}

const BUILT_IN_PRESETS: StylePreset[] = [
  { id: 'preset-blue', fillColor: '#14213d', textColor: '#ffffff', borderColor: '#1687ff' },
  { id: 'preset-amber', fillColor: '#3a2a0d', textColor: '#ffffff', borderColor: '#f2ad18' },
  { id: 'preset-violet', fillColor: '#241533', textColor: '#ffffff', borderColor: '#8b42ff' },
  { id: 'preset-dark', fillColor: '#0c1219', textColor: '#ffffff', borderColor: '#2a3948' }
]

export function ScenePropertiesPanel(): JSX.Element {
  const { items, selectedId } = useMedia()
  const { brandPreset } = useBrandPreset()
  const {
    scenesByMedia,
    selectedSceneId,
    updateScene,
    retimeScene,
    moveSceneToTrack,
    toggleSceneLock,
    toggleSceneLinked,
    setSceneStatus,
    deleteScene,
    duplicateScene,
    bringSceneForward,
    sendSceneBackward,
    selectScene
  } = useScenes()
  const { sequence } = useSequence()
  const graphicTracks = sequence.tracks.filter((t) => t.kind === 'graphic' || t.kind === 'text')
  const [tab, setTab] = useState<PropertiesTab>('design')
  const [customPresets, setCustomPresets] = useState<StylePreset[]>([])
  const [iconPickerOpen, setIconPickerOpen] = useState<string | null>(null)
  const historyFieldProps = useHistoryFieldProps()
  const { seekTo } = usePlayback()

  const media = items.find((m) => m.id === selectedId)
  const scenes = media ? (scenesByMedia[media.id] ?? []) : []
  const scene = scenes.find((s) => s.id === selectedSceneId)

  if (!media) return <p className="placeholder">Select a media item to edit its graphics.</p>
  if (!scene) return <p className="placeholder">Select a graphics clip on the V2/V3 tracks to edit its properties.</p>

  const canvas = CANVAS_SIZE_BY_ASPECT[brandPreset.defaultAspectRatio]
  const disabled = scene.locked
  const iconSupport = TEMPLATE_ICON_SUPPORT[scene.templateId]
  const contentSlots = TEMPLATE_CONTENT_SLOTS[scene.templateId] ?? []
  const hasStructuredContent = contentSlots.length > 0
  const itemCount = TEMPLATE_ITEM_COUNT[scene.templateId]
  const effectivePresentationMode = getEffectivePresentationMode(scene.templateId, scene.presentationMode)
  const isFullFrame = effectivePresentationMode === 'full-frame'
  const checklistItems = iconSupport === 'per-item' && !contentSlots.includes('items') ? deriveChecklistItems(scene) : []

  const DERIVE_ITEMS_BY_TEMPLATE: Partial<Record<TemplateId, (s: Scene) => SceneContentItem[]>> = {
    'three-step-presenter-plan': deriveStepItems,
    'device-compatibility-lineup': deriveDeviceItems,
    'social-channel-card': deriveSocialItems,
    'security-login-flow': deriveLoginRows,
    'feature-benefits-pills': deriveBenefitItems,
    'cause-effect-flow': deriveFlowNodes,
    'isometric-system-diagram': deriveIsometricNodes
  }
  const STATUS_AWARE_TEMPLATES: TemplateId[] = ['security-login-flow', 'isometric-system-diagram']

  const structuredItems: SceneContentItem[] = contentSlots.includes('items')
    ? (scene.content?.items?.length ? scene.content.items.slice(0, itemCount) : (DERIVE_ITEMS_BY_TEMPLATE[scene.templateId]?.(scene) ?? []))
    : []

  const setItemIcon = (index: number, iconId: TemplateIconId | undefined): void => {
    const baseItems: SceneContentItem[] = scene.content?.items?.length ? scene.content.items : checklistItems
    const nextItems = baseItems.map((item, i) => (i === index ? { ...item, iconId } : item))
    updateScene(media.id, scene.id, { content: { ...scene.content, items: nextItems } })
  }

  const setStructuredItemField = (index: number, patch: Partial<SceneContentItem>): void => {
    const nextItems = structuredItems.map((item, i) => (i === index ? { ...item, ...patch } : item))
    updateScene(media.id, scene.id, { content: { ...scene.content, items: nextItems } })
  }

  const setContentField = (field: 'eyebrow' | 'title' | 'value' | 'cta', value: string): void => {
    updateScene(media.id, scene.id, { content: { ...scene.content, [field]: value || undefined } })
  }

  const switchTemplate = (toTemplateId: TemplateId): void => {
    if (toTemplateId === scene.templateId) return
    const patch = buildTemplateSwitchPatch(toTemplateId, scene.presentationMode)
    updateScene(media.id, scene.id, patch)
  }

  const setContentTransformField = (field: 'xPercent' | 'yPercent' | 'widthPercent' | 'heightPercent' | 'rotation', value: number): void => {
    if (!Number.isFinite(value) || !scene.contentTransform) return
    const next = { ...scene.contentTransform, [field]: value }
    // Rotation doesn't affect the box's own bounds, so clamping it would be
    // meaningless. Every other field is kept numerically sane the same way a
    // drag/resize would be -- strictly inside the safe area when "Constrain
    // to canvas" is on, otherwise just within the generous safety range (a
    // typed Width/X can legitimately put the box outside the canvas).
    const clamped =
      field === 'rotation' ? next : scene.constrainToCanvas ? clampContentTransform(next) : clampContentTransformUnconstrained(next)
    updateScene(media.id, scene.id, { contentTransform: clamped })
  }

  // The Scale control's "100%" baseline -- the template's own aspect-specific
  // default bounds, so scale is always relative to "this template's normal
  // size" rather than an arbitrary canvas fraction. Falls back to a generic
  // centered box for the (currently nonexistent) case of a full-frame
  // template with no default entry, matching Reset Transform's own fallback.
  const scaleBaseTransform = scene.contentTransform
    ? (getDefaultContentTransform(scene.templateId, brandPreset.defaultAspectRatio) ?? {
        xPercent: 50,
        yPercent: 50,
        widthPercent: 60,
        heightPercent: 50,
        rotation: 0,
        lockAspectRatio: scene.contentTransform.lockAspectRatio
      })
    : undefined

  const setScalePercentField = (value: number): void => {
    if (!Number.isFinite(value) || !scene.contentTransform || !scaleBaseTransform) return
    const next = applyScalePercent(scene.contentTransform, scaleBaseTransform, value)
    const clamped = scene.constrainToCanvas ? clampContentTransform(next) : clampContentTransformUnconstrained(next)
    updateScene(media.id, scene.id, { contentTransform: clamped })
  }

  const setVaultConfigField = <K extends keyof VaultBreakInConfig>(field: K, value: VaultBreakInConfig[K]): void => {
    updateScene(media.id, scene.id, { vaultConfig: { ...scene.vaultConfig, [field]: value } })
  }

  const setAnimatedVaultConfigField = <K extends keyof AnimatedVaultDiagramConfig>(field: K, value: AnimatedVaultDiagramConfig[K]): void => {
    updateScene(media.id, scene.id, { animatedVaultConfig: { ...scene.animatedVaultConfig, [field]: value } })
  }

  const setDataCenterConfigField = <K extends keyof DataCenterCyberIntrusionConfig>(field: K, value: DataCenterCyberIntrusionConfig[K]): void => {
    updateScene(media.id, scene.id, { dataCenterConfig: { ...scene.dataCenterConfig, [field]: value } })
  }

  const setHospitalResponseConfigField = <K extends keyof HospitalEmergencyResponseConfig>(field: K, value: HospitalEmergencyResponseConfig[K]): void => {
    updateScene(media.id, scene.id, { hospitalResponseConfig: { ...scene.hospitalResponseConfig, [field]: value } })
  }

  const handleStartChange = (value: number): void => {
    if (Number.isFinite(value) && value >= 0 && value < scene.endTime) {
      retimeScene(media.id, scene.id, value, scene.endTime)
    }
  }

  const handleEndChange = (value: number): void => {
    if (Number.isFinite(value) && value > scene.startTime) {
      retimeScene(media.id, scene.id, scene.startTime, value)
    }
  }

  const setPositionField = (field: 'xPct' | 'yPct' | 'widthPct' | 'heightPct', pxValue: number, axis: 'x' | 'y'): void => {
    if (!Number.isFinite(pxValue)) return
    const canvasSize = axis === 'x' ? canvas.width : canvas.height
    const pct = Math.min(100, Math.max(0, (pxValue / canvasSize) * 100))
    const base = scene.position ?? DEFAULT_POSITION
    const next: ScenePosition = { ...base, [field]: pct }

    if (scene.lockAspectRatio && (field === 'widthPct' || field === 'heightPct')) {
      const currentWidthPx = (base.widthPct / 100) * canvas.width
      const currentHeightPx = (base.heightPct / 100) * canvas.height
      const ratio = currentWidthPx / Math.max(1, currentHeightPx)
      if (field === 'widthPct') {
        next.heightPct = Math.min(100, Math.max(0, (pxValue / ratio / canvas.height) * 100))
      } else {
        next.widthPct = Math.min(100, Math.max(0, ((pxValue * ratio) / canvas.width) * 100))
      }
    }

    updateScene(media.id, scene.id, { position: next })
  }

  const applyPreset = (preset: StylePreset): void => {
    updateScene(media.id, scene.id, { fillColor: preset.fillColor, textColor: preset.textColor, borderColor: preset.borderColor })
  }

  const saveCurrentAsPreset = (): void => {
    const preset: StylePreset = {
      id: crypto.randomUUID(),
      fillColor: scene.fillColor ?? brandPreset.primaryColor,
      textColor: scene.textColor ?? '#ffffff',
      borderColor: scene.borderColor ?? brandPreset.accentColor
    }
    setCustomPresets((prev) => [...prev, preset])
  }

  const inDuration = scene.animationInDurationSeconds ?? scene.animationDurationSeconds
  const outDuration = scene.animationOutDurationSeconds ?? scene.animationDurationSeconds

  return (
    <div className="scene-properties">
      <div className="panel-fixed-head">
        <div className="scene-properties-header">
          <h3>Properties</h3>
          <button className="inline-link-button" onClick={() => selectScene(null)}>
            Close
          </button>
        </div>
        <p className="scene-properties-subtitle">{TEMPLATE_LABELS[scene.templateId]}</p>

        <div className="panel-tabs scene-properties-tabs">
          <button className={tab === 'design' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setTab('design')}>
            Design
          </button>
          <button className={tab === 'animation' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setTab('animation')}>
            Animation
          </button>
          <button className={tab === 'timing' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setTab('timing')}>
            Timing
          </button>
        </div>
      </div>

      <div className="panel-scroll-body editor-scroll scene-properties-scroll-body">
        {tab === 'design' && (
          <>
            <div className="scene-properties-group">
              <div className="scene-properties-group-title">Preset</div>
              <div className="scene-preset-row">
                {[...BUILT_IN_PRESETS, ...customPresets].map((preset) => (
                  <button
                    key={preset.id}
                    className="scene-preset-swatch"
                    style={{ background: preset.fillColor, borderColor: preset.borderColor }}
                    title="Apply preset"
                    disabled={disabled}
                    onClick={() => applyPreset(preset)}
                  />
                ))}
                <button className="scene-preset-add" title="Save current colors as a new preset (this session only)" disabled={disabled} onClick={saveCurrentAsPreset}>
                  +
                </button>
              </div>
            </div>

            {hasStructuredContent && (
              <div className="scene-properties-group">
                <div className="scene-properties-group-title">Content</div>

                {contentSlots.includes('eyebrow') && (
                  <label className="scene-properties-field">
                    Eyebrow label
                    <input
                      type="text"
                      lang="km"
                      disabled={disabled}
                      value={scene.content?.eyebrow ?? ''}
                      placeholder="e.g. TELEGRAM • SESSION THEFT • 2026"
                      onChange={(e) => setContentField('eyebrow', e.target.value)}
                      {...historyFieldProps}
                    />
                  </label>
                )}

                {contentSlots.includes('title') && (
                  <label className="scene-properties-field">
                    Title
                    <textarea
                      lang="km"
                      rows={2}
                      disabled={disabled}
                      value={scene.content?.title ?? ''}
                      placeholder={scene.visualText}
                      onChange={(e) => setContentField('title', e.target.value)}
                      {...historyFieldProps}
                    />
                  </label>
                )}

                {contentSlots.includes('value') && (
                  <label className="scene-properties-field">
                    Accent phrase
                    <input
                      type="text"
                      lang="km"
                      disabled={disabled}
                      value={scene.content?.value ?? ''}
                      placeholder="Optional highlighted phrase"
                      onChange={(e) => setContentField('value', e.target.value)}
                      {...historyFieldProps}
                    />
                  </label>
                )}

                {contentSlots.includes('cta') && (
                  <label className="scene-properties-field">
                    Question / CTA
                    <input
                      type="text"
                      lang="km"
                      disabled={disabled}
                      value={scene.content?.cta ?? ''}
                      placeholder="Optional closing line"
                      onChange={(e) => setContentField('cta', e.target.value)}
                      {...historyFieldProps}
                    />
                  </label>
                )}

                {contentSlots.includes('presentationMode') && (
                  <label className="scene-properties-field">
                    Presentation mode
                    <select
                      value={effectivePresentationMode}
                      disabled={disabled}
                      onChange={(e) => updateScene(media.id, scene.id, { presentationMode: e.target.value as PresentationMode })}
                    >
                      {PRESENTATION_MODE_VALUES.map((m) => (
                        <option key={m} value={m}>
                          {PRESENTATION_MODE_LABELS[m]}
                        </option>
                      ))}
                    </select>
                    {isFullFrame && (
                      <span className="scene-properties-hint">
                        Full frame is the available canvas, not an opaque background — the video stays visible unless you choose a
                        Dim/Gradient/Solid background below.
                      </span>
                    )}
                  </label>
                )}

                {contentSlots.includes('background') && (
                  <>
                    <div className="scene-properties-row">
                      <label className="scene-properties-field">
                        Background
                        <select
                          value={scene.background?.mode ?? 'transparent'}
                          disabled={disabled}
                          onChange={(e) =>
                            updateScene(media.id, scene.id, { background: { ...scene.background, mode: e.target.value as SceneBackgroundMode } })
                          }
                        >
                          {SCENE_BACKGROUND_MODE_VALUES.map((m) => (
                            <option key={m} value={m}>
                              {SCENE_BACKGROUND_MODE_LABELS[m]}
                            </option>
                          ))}
                        </select>
                      </label>
                      {(scene.background?.mode ?? 'transparent') !== 'transparent' && (
                        <label className="scene-properties-field">
                          Color
                          <input
                            className="scene-color-input"
                            type="color"
                            disabled={disabled}
                            value={scene.background?.glowColor ?? brandPreset.accentColor}
                            onChange={(e) => updateScene(media.id, scene.id, { background: { ...scene.background, glowColor: e.target.value } })}
                          />
                        </label>
                      )}
                    </div>
                    {(scene.background?.mode ?? 'transparent') !== 'transparent' && (
                      <label className="scene-properties-field">
                        Background opacity %
                        <input
                          type="number"
                          min={0}
                          max={100}
                          disabled={disabled}
                          placeholder="55"
                          value={scene.background?.intensity ?? ''}
                          onChange={(e) => {
                            const value = Number(e.target.value)
                            updateScene(media.id, scene.id, {
                              background: { ...scene.background, intensity: Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined }
                            })
                          }}
                          {...historyFieldProps}
                        />
                      </label>
                    )}
                  </>
                )}

                {contentSlots.includes('items') && (
                  <div className="scene-icon-item-list">
                    {structuredItems.map((item, i) => (
                      <div key={item.id} className="scene-structured-item">
                        <div className="scene-properties-row">
                          <input
                            type="text"
                            lang="km"
                            className="scene-structured-item-label"
                            disabled={disabled}
                            value={item.label}
                            placeholder={`Item ${i + 1}`}
                            onChange={(e) => setStructuredItemField(i, { label: e.target.value })}
                            {...historyFieldProps}
                          />
                          <input
                            className="scene-color-input"
                            type="color"
                            disabled={disabled}
                            title="Accent color"
                            value={item.color ?? '#1687ff'}
                            onChange={(e) => setStructuredItemField(i, { color: e.target.value })}
                          />
                          <button
                            className="scene-icon-trigger"
                            disabled={disabled}
                            title="Choose icon"
                            onClick={() => setIconPickerOpen(iconPickerOpen === item.id ? null : item.id)}
                          >
                            {resolveTemplateIconId(item.iconId) ? (
                              <TemplateIcon id={resolveTemplateIconId(item.iconId)!} size={14} />
                            ) : (
                              <span className="scene-icon-trigger-empty">+</span>
                            )}
                          </button>
                        </div>
                        <input
                          type="text"
                          lang="km"
                          className="scene-structured-item-description"
                          disabled={disabled}
                          value={item.description ?? ''}
                          placeholder="Optional subtitle"
                          onChange={(e) => setStructuredItemField(i, { description: e.target.value })}
                          {...historyFieldProps}
                        />
                        {STATUS_AWARE_TEMPLATES.includes(scene.templateId) && (
                          <select
                            className="scene-structured-item-status"
                            disabled={disabled}
                            value={item.status ?? 'default'}
                            onChange={(e) => setStructuredItemField(i, { status: e.target.value as SceneContentItem['status'] })}
                          >
                            <option value="default">Default</option>
                            <option value="complete">Complete</option>
                            <option value="warning">Warning</option>
                            <option value="blocked">Blocked</option>
                          </select>
                        )}
                        {iconPickerOpen === item.id && (
                          <IconPicker
                            value={item.iconId}
                            onSelect={(id) => setStructuredItemField(i, { iconId: id })}
                            onRemove={() => setStructuredItemField(i, { iconId: undefined })}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {scene.templateId === 'vault-break-in-animation' && (
              <div className="scene-properties-group">
                <div className="scene-properties-group-title">Vault Break-In Scene</div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Structure color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.vaultConfig?.structureColor ?? VAULT_DEFAULT_CONFIG.structureColor}
                      onChange={(e) => setVaultConfigField('structureColor', e.target.value)}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Grid opacity
                    <input
                      type="number"
                      min={0}
                      max={100}
                      disabled={disabled}
                      value={scene.vaultConfig?.gridOpacity ?? VAULT_DEFAULT_CONFIG.gridOpacity}
                      onChange={(e) => setVaultConfigField('gridOpacity', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Person color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.vaultConfig?.personColor ?? VAULT_DEFAULT_CONFIG.personColor}
                      onChange={(e) => setVaultConfigField('personColor', e.target.value)}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Laser count
                    <input
                      type="number"
                      min={1}
                      max={5}
                      disabled={disabled}
                      value={scene.vaultConfig?.laserCount ?? VAULT_DEFAULT_CONFIG.laserCount}
                      onChange={(e) => setVaultConfigField('laserCount', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Laser color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.vaultConfig?.laserColor ?? VAULT_DEFAULT_CONFIG.laserColor}
                      onChange={(e) => setVaultConfigField('laserColor', e.target.value)}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Laser glow
                    <input
                      type="number"
                      min={0}
                      max={100}
                      disabled={disabled}
                      value={scene.vaultConfig?.laserGlow ?? VAULT_DEFAULT_CONFIG.laserGlow}
                      onChange={(e) => setVaultConfigField('laserGlow', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Bypass style
                    <select
                      disabled={disabled}
                      value={scene.vaultConfig?.bypassStyle ?? VAULT_DEFAULT_CONFIG.bypassStyle}
                      onChange={(e) => setVaultConfigField('bypassStyle', e.target.value as VaultBreakInConfig['bypassStyle'])}
                    >
                      <option value="sequential">Sequential (left to right)</option>
                      <option value="gap">Center gap</option>
                    </select>
                  </label>
                  <label className="scene-properties-checkbox-field">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={scene.vaultConfig?.laserReactivation ?? VAULT_DEFAULT_CONFIG.laserReactivation}
                      onChange={(e) => setVaultConfigField('laserReactivation', e.target.checked)}
                    />
                    Lasers reactivate after crossing
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Vault metal color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.vaultConfig?.vaultMetalColor ?? VAULT_DEFAULT_CONFIG.vaultMetalColor}
                      onChange={(e) => setVaultConfigField('vaultMetalColor', e.target.value)}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Spoke count
                    <input
                      type="number"
                      min={4}
                      max={10}
                      disabled={disabled}
                      value={scene.vaultConfig?.vaultSpokeCount ?? VAULT_DEFAULT_CONFIG.vaultSpokeCount}
                      onChange={(e) => setVaultConfigField('vaultSpokeCount', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Locked color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.vaultConfig?.vaultLockedColor ?? VAULT_DEFAULT_CONFIG.vaultLockedColor}
                      onChange={(e) => setVaultConfigField('vaultLockedColor', e.target.value)}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Unlocked color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.vaultConfig?.vaultUnlockedColor ?? VAULT_DEFAULT_CONFIG.vaultUnlockedColor}
                      onChange={(e) => setVaultConfigField('vaultUnlockedColor', e.target.value)}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Wheel rotation °
                    <input
                      type="number"
                      min={90}
                      max={360}
                      step={10}
                      disabled={disabled}
                      value={scene.vaultConfig?.wheelRotationDegrees ?? VAULT_DEFAULT_CONFIG.wheelRotationDegrees}
                      onChange={(e) => setVaultConfigField('wheelRotationDegrees', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                  <label className="scene-properties-checkbox-field">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={scene.vaultConfig?.showFloorHatch ?? VAULT_DEFAULT_CONFIG.showFloorHatch}
                      onChange={(e) => setVaultConfigField('showFloorHatch', e.target.checked)}
                    />
                    Show floor hatch
                  </label>
                </div>
              </div>
            )}

            {scene.templateId === 'animated-break-in-vault-diagram' && (
              <div className="scene-properties-group">
                <div className="scene-properties-group-title">Animated Break-In Vault Diagram</div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Building outline color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.animatedVaultConfig?.outlineColor ?? ANIMATED_VAULT_DEFAULT_CONFIG.outlineColor}
                      onChange={(e) => setAnimatedVaultConfigField('outlineColor', e.target.value)}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Laser color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.animatedVaultConfig?.laserColor ?? ANIMATED_VAULT_DEFAULT_CONFIG.laserColor}
                      onChange={(e) => setAnimatedVaultConfigField('laserColor', e.target.value)}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Person color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.animatedVaultConfig?.personColor ?? ANIMATED_VAULT_DEFAULT_CONFIG.personColor}
                      onChange={(e) => setAnimatedVaultConfigField('personColor', e.target.value)}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Vault-wheel color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.animatedVaultConfig?.vaultWheelColor ?? ANIMATED_VAULT_DEFAULT_CONFIG.vaultWheelColor}
                      onChange={(e) => setAnimatedVaultConfigField('vaultWheelColor', e.target.value)}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Surface opacity
                    <input
                      type="number"
                      min={0}
                      max={100}
                      disabled={disabled}
                      value={scene.animatedVaultConfig?.surfaceOpacity ?? ANIMATED_VAULT_DEFAULT_CONFIG.surfaceOpacity}
                      onChange={(e) => setAnimatedVaultConfigField('surfaceOpacity', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Grid opacity
                    <input
                      type="number"
                      min={0}
                      max={100}
                      disabled={disabled}
                      value={scene.animatedVaultConfig?.gridOpacity ?? ANIMATED_VAULT_DEFAULT_CONFIG.gridOpacity}
                      onChange={(e) => setAnimatedVaultConfigField('gridOpacity', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Glow intensity
                    <input
                      type="number"
                      min={0}
                      max={100}
                      disabled={disabled}
                      value={scene.animatedVaultConfig?.glowIntensity ?? ANIMATED_VAULT_DEFAULT_CONFIG.glowIntensity}
                      onChange={(e) => setAnimatedVaultConfigField('glowIntensity', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Laser count
                    <input
                      type="number"
                      min={1}
                      max={5}
                      disabled={disabled}
                      value={scene.animatedVaultConfig?.laserCount ?? ANIMATED_VAULT_DEFAULT_CONFIG.laserCount}
                      onChange={(e) => setAnimatedVaultConfigField('laserCount', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-checkbox-field">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={scene.animatedVaultConfig?.showPerson ?? ANIMATED_VAULT_DEFAULT_CONFIG.showPerson}
                      onChange={(e) => setAnimatedVaultConfigField('showPerson', e.target.checked)}
                    />
                    Show person
                  </label>
                  <label className="scene-properties-checkbox-field">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={scene.animatedVaultConfig?.showVaultWheel ?? ANIMATED_VAULT_DEFAULT_CONFIG.showVaultWheel}
                      onChange={(e) => setAnimatedVaultConfigField('showVaultWheel', e.target.checked)}
                    />
                    Show vault wheel
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-checkbox-field">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={scene.animatedVaultConfig?.showFloorOpening ?? ANIMATED_VAULT_DEFAULT_CONFIG.showFloorOpening}
                      onChange={(e) => setAnimatedVaultConfigField('showFloorOpening', e.target.checked)}
                    />
                    Show floor opening
                  </label>
                </div>
                <p className="placeholder">
                  Animation speed, motion intensity, and looping are set in the Animation tab above (Loop speed / Motion intensity / Loop
                  animation). Background mode and opacity are set in the Design tab's Background section.
                </p>
              </div>
            )}

            {scene.templateId === 'data-center-cyber-intrusion' && (
              <div className="scene-properties-group">
                <div className="scene-properties-group-title">Data Center Cyber Intrusion</div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Attack color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.dataCenterConfig?.attackColor ?? DATA_CENTER_DEFAULT_CONFIG.attackColor}
                      onChange={(e) => setDataCenterConfigField('attackColor', e.target.value)}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Secure color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.dataCenterConfig?.secureColor ?? DATA_CENTER_DEFAULT_CONFIG.secureColor}
                      onChange={(e) => setDataCenterConfigField('secureColor', e.target.value)}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Firewall color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.dataCenterConfig?.firewallColor ?? DATA_CENTER_DEFAULT_CONFIG.firewallColor}
                      onChange={(e) => setDataCenterConfigField('firewallColor', e.target.value)}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Attack result
                    <select
                      disabled={disabled}
                      value={scene.dataCenterConfig?.attackResult ?? DATA_CENTER_DEFAULT_CONFIG.attackResult}
                      onChange={(e) => setDataCenterConfigField('attackResult', e.target.value as DataCenterCyberIntrusionConfig['attackResult'])}
                    >
                      <option value="blocked">Blocked</option>
                      <option value="breached">Breached</option>
                    </select>
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Server count
                    <input
                      type="number"
                      min={1}
                      max={8}
                      disabled={disabled}
                      value={scene.dataCenterConfig?.serverCount ?? DATA_CENTER_DEFAULT_CONFIG.serverCount}
                      onChange={(e) => setDataCenterConfigField('serverCount', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Packet count
                    <input
                      type="number"
                      min={1}
                      max={6}
                      disabled={disabled}
                      value={scene.dataCenterConfig?.packetCount ?? DATA_CENTER_DEFAULT_CONFIG.packetCount}
                      onChange={(e) => setDataCenterConfigField('packetCount', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Glow intensity
                    <input
                      type="number"
                      min={0}
                      max={100}
                      disabled={disabled}
                      value={scene.dataCenterConfig?.glowIntensity ?? DATA_CENTER_DEFAULT_CONFIG.glowIntensity}
                      onChange={(e) => setDataCenterConfigField('glowIntensity', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-checkbox-field">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={scene.dataCenterConfig?.showAttacker ?? DATA_CENTER_DEFAULT_CONFIG.showAttacker}
                      onChange={(e) => setDataCenterConfigField('showAttacker', e.target.checked)}
                    />
                    Show attacker
                  </label>
                  <label className="scene-properties-checkbox-field">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={scene.dataCenterConfig?.showShield ?? DATA_CENTER_DEFAULT_CONFIG.showShield}
                      onChange={(e) => setDataCenterConfigField('showShield', e.target.checked)}
                    />
                    Show shield
                  </label>
                </div>
                <p className="placeholder">
                  Animation speed, motion intensity, and looping are set in the Animation tab above. Background mode and opacity are set in the
                  Design tab's Background section.
                </p>
              </div>
            )}

            {scene.templateId === 'hospital-emergency-response' && (
              <div className="scene-properties-group">
                <div className="scene-properties-group-title">Hospital Emergency Response</div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Patient condition
                    <select
                      disabled={disabled}
                      value={scene.hospitalResponseConfig?.patientCondition ?? HOSPITAL_RESPONSE_DEFAULT_CONFIG.patientCondition}
                      onChange={(e) =>
                        setHospitalResponseConfigField('patientCondition', e.target.value as HospitalEmergencyResponseConfig['patientCondition'])
                      }
                    >
                      <option value="critical">Critical</option>
                      <option value="stable">Stable</option>
                      <option value="recovering">Recovering</option>
                    </select>
                  </label>
                  <label className="scene-properties-field">
                    Emergency severity
                    <input
                      type="number"
                      min={0}
                      max={100}
                      disabled={disabled}
                      value={scene.hospitalResponseConfig?.emergencySeverity ?? HOSPITAL_RESPONSE_DEFAULT_CONFIG.emergencySeverity}
                      onChange={(e) => setHospitalResponseConfigField('emergencySeverity', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Treatment stages
                    <input
                      type="number"
                      min={2}
                      max={4}
                      disabled={disabled}
                      value={scene.hospitalResponseConfig?.treatmentStageCount ?? HOSPITAL_RESPONSE_DEFAULT_CONFIG.treatmentStageCount}
                      onChange={(e) => setHospitalResponseConfigField('treatmentStageCount', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Scanner speed
                    <input
                      type="number"
                      min={0}
                      max={100}
                      disabled={disabled}
                      value={scene.hospitalResponseConfig?.scannerSpeed ?? HOSPITAL_RESPONSE_DEFAULT_CONFIG.scannerSpeed}
                      onChange={(e) => setHospitalResponseConfigField('scannerSpeed', Number(e.target.value))}
                      {...historyFieldProps}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Path color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.hospitalResponseConfig?.pathColor ?? HOSPITAL_RESPONSE_DEFAULT_CONFIG.pathColor}
                      onChange={(e) => setHospitalResponseConfigField('pathColor', e.target.value)}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Emergency color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.hospitalResponseConfig?.emergencyColor ?? HOSPITAL_RESPONSE_DEFAULT_CONFIG.emergencyColor}
                      onChange={(e) => setHospitalResponseConfigField('emergencyColor', e.target.value)}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Recovery color
                    <input
                      type="color"
                      disabled={disabled}
                      value={scene.hospitalResponseConfig?.recoveryColor ?? HOSPITAL_RESPONSE_DEFAULT_CONFIG.recoveryColor}
                      onChange={(e) => setHospitalResponseConfigField('recoveryColor', e.target.value)}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-checkbox-field">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={scene.hospitalResponseConfig?.showDoctor ?? HOSPITAL_RESPONSE_DEFAULT_CONFIG.showDoctor}
                      onChange={(e) => setHospitalResponseConfigField('showDoctor', e.target.checked)}
                    />
                    Show doctor
                  </label>
                  <label className="scene-properties-checkbox-field">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={scene.hospitalResponseConfig?.showNurse ?? HOSPITAL_RESPONSE_DEFAULT_CONFIG.showNurse}
                      onChange={(e) => setHospitalResponseConfigField('showNurse', e.target.checked)}
                    />
                    Show nurse
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Top floor label
                    <input
                      type="text"
                      lang="km"
                      disabled={disabled}
                      value={scene.hospitalResponseConfig?.topFloorLabel ?? HOSPITAL_RESPONSE_DEFAULT_CONFIG.topFloorLabel}
                      onChange={(e) => setHospitalResponseConfigField('topFloorLabel', e.target.value)}
                      {...historyFieldProps}
                    />
                  </label>
                  <label className="scene-properties-field">
                    Middle floor label
                    <input
                      type="text"
                      lang="km"
                      disabled={disabled}
                      value={scene.hospitalResponseConfig?.middleFloorLabel ?? HOSPITAL_RESPONSE_DEFAULT_CONFIG.middleFloorLabel}
                      onChange={(e) => setHospitalResponseConfigField('middleFloorLabel', e.target.value)}
                      {...historyFieldProps}
                    />
                  </label>
                </div>
                <div className="scene-properties-row">
                  <label className="scene-properties-field">
                    Bottom floor label
                    <input
                      type="text"
                      lang="km"
                      disabled={disabled}
                      value={scene.hospitalResponseConfig?.bottomFloorLabel ?? HOSPITAL_RESPONSE_DEFAULT_CONFIG.bottomFloorLabel}
                      onChange={(e) => setHospitalResponseConfigField('bottomFloorLabel', e.target.value)}
                      {...historyFieldProps}
                    />
                  </label>
                </div>
                <p className="placeholder">
                  Animation speed, motion intensity, and looping are set in the Animation tab above. Background mode and opacity are set in the
                  Design tab's Background section.
                </p>
              </div>
            )}

            <div className="scene-properties-group">
              <div className="scene-properties-group-title">Text</div>
              {!hasStructuredContent && (
                <label className="scene-properties-field">
                  Visual text
                  <textarea
                    lang="km"
                    rows={2}
                    value={scene.visualText}
                    disabled={disabled}
                    onChange={(e) => updateScene(media.id, scene.id, { visualText: e.target.value })}
                    {...historyFieldProps}
                  />
                </label>
              )}
              <div className="scene-properties-grid-2col">
                <label className="scene-properties-field">
                  Khmer Font
                  <select
                    value={scene.brandOverrides?.khmerFont ?? brandPreset.khmerFont}
                    disabled={disabled}
                    onChange={(e) =>
                      updateScene(media.id, scene.id, { brandOverrides: { ...scene.brandOverrides, khmerFont: e.target.value } })
                    }
                  >
                    {KHMER_FONTS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="scene-properties-field">
                  Latin Font
                  <select
                    value={scene.brandOverrides?.latinFont ?? brandPreset.latinFont}
                    disabled={disabled}
                    onChange={(e) =>
                      updateScene(media.id, scene.id, { brandOverrides: { ...scene.brandOverrides, latinFont: e.target.value } })
                    }
                  >
                    {LATIN_FONTS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="scene-properties-grid-2col">
                <label className="scene-properties-field">
                  Weight
                  <select
                    value={scene.fontWeight ?? 'semibold'}
                    disabled={disabled}
                    onChange={(e) => updateScene(media.id, scene.id, { fontWeight: e.target.value as FontWeight })}
                  >
                    {FONT_WEIGHT_VALUES.map((w) => (
                      <option key={w} value={w}>
                        {FONT_WEIGHT_LABELS[w]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="scene-properties-field">
                  Size (px)
                  <input
                    type="number"
                    min={10}
                    max={200}
                    disabled={disabled}
                    placeholder="Auto"
                    value={scene.fontSizePx ?? ''}
                    onChange={(e) => {
                      const value = Number(e.target.value)
                      updateScene(media.id, scene.id, { fontSizePx: Number.isFinite(value) && value > 0 ? value : undefined })
                    }}
                    {...historyFieldProps}
                  />
                </label>
              </div>
              <div className="scene-properties-field">
                Alignment
                <div className="scene-align-row">
                  {(['left', 'center', 'right'] as TextAlign[]).map((align) => (
                    <button
                      key={align}
                      className={scene.textAlign === align ? 'scene-align-button scene-align-button-active' : 'scene-align-button'}
                      disabled={disabled}
                      title={align}
                      onClick={() => updateScene(media.id, scene.id, { textAlign: align })}
                    >
                      {align === 'left' ? '≡←' : align === 'center' ? '≡' : '≡→'}
                    </button>
                  ))}
                  <input
                    className="scene-color-input"
                    type="color"
                    disabled={disabled}
                    value={scene.textColor ?? '#ffffff'}
                    onChange={(e) => updateScene(media.id, scene.id, { textColor: e.target.value })}
                    title="Text color"
                  />
                </div>
              </div>
            </div>

            <div className="scene-properties-group">
              <div className="scene-properties-group-title">Fill</div>
              <div className="scene-properties-row">
                <label className="scene-properties-field">
                  Color
                  <input
                    className="scene-color-input"
                    type="color"
                    disabled={disabled}
                    value={scene.fillColor ?? brandPreset.primaryColor}
                    onChange={(e) => updateScene(media.id, scene.id, { fillColor: e.target.value })}
                  />
                </label>
                <label className="scene-properties-field">
                  Opacity %
                  <input
                    type="number"
                    min={0}
                    max={100}
                    disabled={disabled}
                    placeholder="100"
                    value={scene.fillOpacity ?? ''}
                    onChange={(e) => {
                      const value = Number(e.target.value)
                      updateScene(media.id, scene.id, { fillOpacity: Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined })
                    }}
                    {...historyFieldProps}
                  />
                </label>
              </div>
            </div>

            <div className="scene-properties-group">
              <div className="scene-properties-group-title">Border</div>
              <div className="scene-properties-row">
                <label className="scene-properties-field">
                  Color
                  <input
                    className="scene-color-input"
                    type="color"
                    disabled={disabled}
                    value={scene.borderColor ?? brandPreset.accentColor}
                    onChange={(e) => updateScene(media.id, scene.id, { borderColor: e.target.value })}
                  />
                </label>
                <label className="scene-properties-field">
                  Width (px)
                  <input
                    type="number"
                    min={0}
                    max={20}
                    disabled={disabled}
                    placeholder="Auto"
                    value={scene.borderWidthPx ?? ''}
                    onChange={(e) => {
                      const value = Number(e.target.value)
                      updateScene(media.id, scene.id, { borderWidthPx: Number.isFinite(value) && value >= 0 ? value : undefined })
                    }}
                    {...historyFieldProps}
                  />
                </label>
                <label className="scene-properties-field">
                  Radius (px)
                  <input
                    type="number"
                    min={0}
                    max={100}
                    disabled={disabled}
                    placeholder="Auto"
                    value={scene.borderRadiusPx ?? ''}
                    onChange={(e) => {
                      const value = Number(e.target.value)
                      updateScene(media.id, scene.id, { borderRadiusPx: Number.isFinite(value) && value >= 0 ? value : undefined })
                    }}
                    {...historyFieldProps}
                  />
                </label>
              </div>
            </div>

            {iconSupport !== 'none' && !(iconSupport === 'per-item' && contentSlots.includes('items')) && (
              <div className="scene-properties-group">
                <div className="scene-properties-group-title">{iconSupport === 'avatar' ? 'Avatar Icon' : iconSupport === 'per-item' ? 'Item Icons' : 'Icon'}</div>

                {iconSupport === 'per-item' ? (
                  <div className="scene-icon-item-list">
                    {checklistItems.map((item, i) => (
                      <div key={item.id} className="scene-icon-item-row">
                        <span className="scene-icon-item-label" lang="km">
                          {item.label || `Item ${i + 1}`}
                        </span>
                        <button
                          className="scene-icon-trigger"
                          disabled={disabled}
                          title="Choose icon"
                          onClick={() => setIconPickerOpen(iconPickerOpen === item.id ? null : item.id)}
                        >
                          {resolveTemplateIconId(item.iconId) ? (
                            <TemplateIcon id={resolveTemplateIconId(item.iconId)!} size={16} />
                          ) : (
                            <span className="scene-icon-trigger-empty">+</span>
                          )}
                        </button>
                        {iconPickerOpen === item.id && (
                          <IconPicker value={item.iconId} onSelect={(id) => setItemIcon(i, id)} onRemove={() => setItemIcon(i, undefined)} />
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                    <div className="scene-properties-row">
                      <button
                        className="scene-icon-trigger"
                        disabled={disabled}
                        title="Choose icon"
                        onClick={() => setIconPickerOpen(iconPickerOpen === 'main' ? null : 'main')}
                      >
                        {resolveTemplateIconId(scene.icon?.iconId) ? (
                          <TemplateIcon id={resolveTemplateIconId(scene.icon?.iconId)!} size={18} color={scene.icon?.color} />
                        ) : (
                          <span className="scene-icon-trigger-empty">+ Choose icon</span>
                        )}
                      </button>
                    </div>
                    {iconPickerOpen === 'main' && (
                      <IconPicker
                        value={scene.icon?.iconId}
                        onSelect={(id) => updateScene(media.id, scene.id, { icon: { ...scene.icon, iconId: id } })}
                        onRemove={() => updateScene(media.id, scene.id, { icon: undefined })}
                      />
                    )}
                    {scene.icon?.iconId && (
                      <>
                        <div className="scene-properties-row">
                          <label className="scene-properties-field">
                            Color
                            <input
                              className="scene-color-input"
                              type="color"
                              disabled={disabled}
                              value={scene.icon.color ?? '#ffffff'}
                              onChange={(e) => updateScene(media.id, scene.id, { icon: { ...scene.icon, color: e.target.value } })}
                            />
                          </label>
                          <label className="scene-properties-field">
                            Size (px)
                            <input
                              type="number"
                              min={8}
                              max={80}
                              disabled={disabled}
                              placeholder="Auto"
                              value={scene.icon.size ?? ''}
                              onChange={(e) => {
                                const value = Number(e.target.value)
                                updateScene(media.id, scene.id, { icon: { ...scene.icon, size: Number.isFinite(value) && value > 0 ? value : undefined } })
                              }}
                              {...historyFieldProps}
                            />
                          </label>
                          <label className="scene-properties-field">
                            Opacity %
                            <input
                              type="number"
                              min={0}
                              max={100}
                              disabled={disabled}
                              placeholder="100"
                              value={scene.icon.opacity ?? ''}
                              onChange={(e) => {
                                const value = Number(e.target.value)
                                updateScene(media.id, scene.id, {
                                  icon: { ...scene.icon, opacity: Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined }
                                })
                              }}
                              {...historyFieldProps}
                            />
                          </label>
                        </div>
                        <div className="scene-properties-row">
                          <label className="scene-properties-field">
                            Horizontal
                            <select
                              value={scene.icon.hAlign ?? 'left'}
                              disabled={disabled}
                              onChange={(e) => updateScene(media.id, scene.id, { icon: { ...scene.icon, hAlign: e.target.value as 'left' | 'center' | 'right' } })}
                            >
                              <option value="left">Left</option>
                              <option value="center">Center</option>
                              <option value="right">Right</option>
                            </select>
                          </label>
                          <label className="scene-properties-field">
                            Vertical
                            <select
                              value={scene.icon.vAlign ?? 'center'}
                              disabled={disabled}
                              onChange={(e) => updateScene(media.id, scene.id, { icon: { ...scene.icon, vAlign: e.target.value as 'top' | 'center' | 'bottom' } })}
                            >
                              <option value="top">Top</option>
                              <option value="center">Center</option>
                              <option value="bottom">Bottom</option>
                            </select>
                          </label>
                          <label className="scene-properties-field">
                            Rotation
                            <input
                              type="number"
                              min={-180}
                              max={180}
                              disabled={disabled}
                              placeholder="0"
                              value={scene.icon.rotation ?? ''}
                              onChange={(e) => {
                                const value = Number(e.target.value)
                                updateScene(media.id, scene.id, { icon: { ...scene.icon, rotation: Number.isFinite(value) ? value : undefined } })
                              }}
                              {...historyFieldProps}
                            />
                          </label>
                        </div>
                        <div className="scene-properties-row">
                          <label className="scene-properties-field">
                            Background
                            <select
                              value={scene.icon.backgroundShape ?? 'none'}
                              disabled={disabled}
                              onChange={(e) =>
                                updateScene(media.id, scene.id, { icon: { ...scene.icon, backgroundShape: e.target.value as 'none' | 'circle' | 'square' } })
                              }
                            >
                              <option value="none">None</option>
                              <option value="circle">Circle</option>
                              <option value="square">Square</option>
                            </select>
                          </label>
                          {scene.icon.backgroundShape && scene.icon.backgroundShape !== 'none' && (
                            <label className="scene-properties-field">
                              Background color
                              <input
                                className="scene-color-input"
                                type="color"
                                disabled={disabled}
                                value={scene.icon.backgroundColor ?? '#1a2430'}
                                onChange={(e) => updateScene(media.id, scene.id, { icon: { ...scene.icon, backgroundColor: e.target.value } })}
                              />
                            </label>
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {isFullFrame && (
              <div className="scene-properties-group">
                <div className="scene-properties-position-header">
                  <span className="scene-properties-group-title">Content Position &amp; Size</span>
                  {scene.contentTransform ? (
                    <button
                      className="inline-link-button"
                      disabled={disabled}
                      onClick={() => updateScene(media.id, scene.id, { contentTransform: undefined })}
                    >
                      Reset to centered
                    </button>
                  ) : (
                    <button
                      className="inline-link-button"
                      disabled={disabled}
                      onClick={() =>
                        updateScene(media.id, scene.id, {
                          contentTransform: { xPercent: 20, yPercent: 25, widthPercent: 60, heightPercent: 50, rotation: 0, lockAspectRatio: true }
                        })
                      }
                    >
                      Set custom position
                    </button>
                  )}
                </div>
                {scene.contentTransform ? (
                  <>
                    <label className="scene-properties-checkbox-field">
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={scene.constrainToCanvas ?? false}
                        onChange={(e) => updateScene(media.id, scene.id, { constrainToCanvas: e.target.checked })}
                      />
                      Constrain to canvas
                    </label>
                    <p className="placeholder">
                      {scene.constrainToCanvas
                        ? 'On: dragging/resizing keeps the whole graphic inside the video safe area.'
                        : 'Off: the graphic can be dragged or resized partially or fully outside the canvas (clipped visually in Preview).'}
                    </p>
                    <div className="scene-properties-row">
                      <button
                        className="inline-link-button"
                        disabled={disabled}
                        onClick={() => {
                          const def = getDefaultContentTransform(scene.templateId, brandPreset.defaultAspectRatio)
                          updateScene(media.id, scene.id, {
                            contentTransform:
                              def ?? { xPercent: 50, yPercent: 50, widthPercent: 60, heightPercent: 50, rotation: 0, lockAspectRatio: scene.contentTransform!.lockAspectRatio }
                          })
                        }}
                      >
                        Reset Transform
                      </button>
                      <button
                        className="inline-link-button"
                        disabled={disabled}
                        onClick={() => updateScene(media.id, scene.id, { contentTransform: clampContentTransform(scene.contentTransform!) })}
                      >
                        Fit to Canvas
                      </button>
                    </div>
                    <div className="scene-properties-row">
                      <button
                        className="inline-link-button"
                        disabled={disabled}
                        onClick={() => updateScene(media.id, scene.id, { contentTransform: { ...scene.contentTransform!, xPercent: 50 } })}
                      >
                        Center Horizontally
                      </button>
                      <button
                        className="inline-link-button"
                        disabled={disabled}
                        onClick={() => updateScene(media.id, scene.id, { contentTransform: { ...scene.contentTransform!, yPercent: 50 } })}
                      >
                        Center Vertically
                      </button>
                    </div>
                    <div className="scene-properties-grid-2x2">
                      <label className="scene-properties-field">
                        X %
                        <input
                          type="number"
                          min={UNCONSTRAINED_SAFETY_LIMITS.minX}
                          max={UNCONSTRAINED_SAFETY_LIMITS.maxX}
                          disabled={disabled}
                          value={Math.round(scene.contentTransform.xPercent)}
                          onChange={(e) => setContentTransformField('xPercent', Number(e.target.value))}
                          {...historyFieldProps}
                        />
                      </label>
                      <label className="scene-properties-field">
                        Y %
                        <input
                          type="number"
                          min={UNCONSTRAINED_SAFETY_LIMITS.minY}
                          max={UNCONSTRAINED_SAFETY_LIMITS.maxY}
                          disabled={disabled}
                          value={Math.round(scene.contentTransform.yPercent)}
                          onChange={(e) => setContentTransformField('yPercent', Number(e.target.value))}
                          {...historyFieldProps}
                        />
                      </label>
                      <label className="scene-properties-field">
                        Width %
                        <input
                          type="number"
                          min={UNCONSTRAINED_SAFETY_LIMITS.minWidth}
                          max={UNCONSTRAINED_SAFETY_LIMITS.maxWidth}
                          disabled={disabled}
                          value={Math.round(scene.contentTransform.widthPercent)}
                          onChange={(e) => setContentTransformField('widthPercent', Number(e.target.value))}
                          {...historyFieldProps}
                        />
                      </label>
                      <label className="scene-properties-field">
                        Height %
                        <input
                          type="number"
                          min={UNCONSTRAINED_SAFETY_LIMITS.minHeight}
                          max={UNCONSTRAINED_SAFETY_LIMITS.maxHeight}
                          disabled={disabled}
                          value={Math.round(scene.contentTransform.heightPercent)}
                          onChange={(e) => setContentTransformField('heightPercent', Number(e.target.value))}
                          {...historyFieldProps}
                        />
                      </label>
                    </div>
                    <div className="scene-properties-row">
                      <label className="scene-properties-field">
                        Scale %
                        <input
                          type="number"
                          step={5}
                          min={MIN_SCALE_PERCENT}
                          max={MAX_SCALE_PERCENT}
                          disabled={disabled}
                          value={Math.round(computeScalePercent(scene.contentTransform, scaleBaseTransform!))}
                          onChange={(e) => setScalePercentField(Number(e.target.value))}
                          {...historyFieldProps}
                        />
                      </label>
                    </div>
                    <div className="scene-properties-row">
                      <label className="scene-properties-field">
                        Rotation °
                        <input
                          type="number"
                          step={1}
                          min={-180}
                          max={180}
                          disabled={disabled}
                          value={Math.round(scene.contentTransform.rotation)}
                          onChange={(e) => setContentTransformField('rotation', Number(e.target.value))}
                          {...historyFieldProps}
                        />
                      </label>
                      <label className="scene-properties-checkbox-field">
                        <input
                          type="checkbox"
                          disabled={disabled}
                          checked={scene.contentTransform.lockAspectRatio}
                          onChange={(e) =>
                            updateScene(media.id, scene.id, { contentTransform: { ...scene.contentTransform!, lockAspectRatio: e.target.checked } })
                          }
                        />
                        Lock aspect ratio
                      </label>
                    </div>
                  </>
                ) : (
                  <p className="placeholder">Drag the content on the canvas to position it, or set a custom box above.</p>
                )}
              </div>
            )}

            <div className="scene-properties-group">
              <div className="scene-properties-position-header">
                <span className="scene-properties-group-title">Position &amp; Size</span>
                {!isFullFrame &&
                  (scene.position ? (
                    <button
                      className="inline-link-button"
                      disabled={disabled}
                      onClick={() => updateScene(media.id, scene.id, { position: undefined })}
                    >
                      Reset to template default
                    </button>
                  ) : (
                    <button
                      className="inline-link-button"
                      disabled={disabled}
                      onClick={() => updateScene(media.id, scene.id, { position: DEFAULT_POSITION })}
                    >
                      Set custom position
                    </button>
                  ))}
              </div>

              {isFullFrame ? (
                <p className="placeholder">This is a full-frame template -- move and resize its content using Content Position &amp; Size above.</p>
              ) : scene.position ? (
                <>
                  <div className="scene-properties-grid-2x2">
                    <label className="scene-properties-field">
                      X
                      <input
                        type="number"
                        disabled={disabled}
                        value={Math.round((scene.position.xPct / 100) * canvas.width)}
                        onChange={(e) => setPositionField('xPct', Number(e.target.value), 'x')}
                        {...historyFieldProps}
                      />
                    </label>
                    <label className="scene-properties-field">
                      Y
                      <input
                        type="number"
                        disabled={disabled}
                        value={Math.round((scene.position.yPct / 100) * canvas.height)}
                        onChange={(e) => setPositionField('yPct', Number(e.target.value), 'y')}
                        {...historyFieldProps}
                      />
                    </label>
                    <label className="scene-properties-field">
                      W
                      <input
                        type="number"
                        disabled={disabled}
                        value={Math.round((scene.position.widthPct / 100) * canvas.width)}
                        onChange={(e) => setPositionField('widthPct', Number(e.target.value), 'x')}
                        {...historyFieldProps}
                      />
                    </label>
                    <label className="scene-properties-field">
                      H
                      <input
                        type="number"
                        disabled={disabled}
                        value={Math.round((scene.position.heightPct / 100) * canvas.height)}
                        onChange={(e) => setPositionField('heightPct', Number(e.target.value), 'y')}
                        {...historyFieldProps}
                      />
                    </label>
                  </div>
                  <label className="scene-properties-checkbox-field">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={scene.lockAspectRatio ?? false}
                      onChange={(e) => updateScene(media.id, scene.id, { lockAspectRatio: e.target.checked })}
                    />
                    Lock aspect ratio
                  </label>
                </>
              ) : (
                <p className="placeholder">Using this template's default layout. Set a custom position to enable X/Y/W/H.</p>
              )}
            </div>

            <div className="scene-properties-field">
              Recommended for {scene.purpose.replace(/_/g, ' ')}
              <div className="scene-template-recommend-row">
                {TEMPLATE_RECOMMENDATIONS[scene.purpose].map((id) => (
                  <button
                    key={id}
                    className={id === scene.templateId ? 'scene-template-recommend-chip scene-template-recommend-chip-active' : 'scene-template-recommend-chip'}
                    disabled={disabled}
                    title={TEMPLATE_LABELS[id]}
                    onClick={() => switchTemplate(id)}
                  >
                    {TEMPLATE_LABELS[id]}
                  </button>
                ))}
              </div>
            </div>

            <div className="scene-properties-grid-2col">
              <label className="scene-properties-field">
                Template
                <select
                  value={scene.templateId}
                  disabled={disabled}
                  onChange={(e) => switchTemplate(e.target.value as TemplateId)}
                >
                  {TEMPLATE_IDS.map((id) => (
                    <option key={id} value={id}>
                      {TEMPLATE_LABELS[id]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="scene-properties-field">
                Track
                <select
                  value={scene.track}
                  disabled={disabled}
                  onChange={(e) => moveSceneToTrack(media.id, scene.id, e.target.value)}
                >
                  {graphicTracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.id} {t.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </>
        )}

        {tab === 'animation' && (
          <>
            <label className="scene-properties-field">
              Animation preset
              <select
                value={scene.animationPreset ?? ''}
                disabled={disabled}
                onChange={(e) => updateScene(media.id, scene.id, { animationPreset: (e.target.value || undefined) as AnimationPreset | undefined })}
              >
                <option value="">Template default</option>
                {ANIMATION_PRESET_VALUES.map((p) => (
                  <option key={p} value={p}>
                    {ANIMATION_PRESET_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
            <div className="scene-properties-row">
              <label className="scene-properties-field">
                Duration (s)
                <input
                  type="number"
                  step={0.1}
                  min={0.1}
                  max={2}
                  disabled={disabled}
                  placeholder="Brand default"
                  value={scene.animationDurationSeconds ?? ''}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    updateScene(media.id, scene.id, { animationDurationSeconds: Number.isFinite(value) && value > 0 ? value : undefined })
                  }}
                  {...historyFieldProps}
                />
              </label>
              <label className="scene-properties-field">
                Easing
                <select
                  value={scene.animationEasing ?? 'ease-out'}
                  disabled={disabled}
                  onChange={(e) => updateScene(media.id, scene.id, { animationEasing: e.target.value as AnimationEasing })}
                >
                  {ANIMATION_EASING_VALUES.map((easing) => (
                    <option key={easing} value={easing}>
                      {ANIMATION_EASING_LABELS[easing]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="scene-properties-field">
              Internal motion
              <p className="placeholder">Coordinated per-element choreography (enter / hold-loop / exit) for this template's internal parts, separate from the whole-graphic fade above.</p>
            </div>
            <label className="scene-properties-field">
              Motion preset
              <select
                value={scene.motionPreset ?? ''}
                disabled={disabled}
                onChange={(e) => updateScene(media.id, scene.id, { motionPreset: (e.target.value || undefined) as MotionPreset | undefined })}
              >
                <option value="">Template default</option>
                {MOTION_PRESET_VALUES.map((p) => (
                  <option key={p} value={p}>
                    {MOTION_PRESET_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
            <div className="scene-properties-row">
              <label className="scene-properties-field">
                Enter duration (s)
                <input
                  type="number"
                  step={0.05}
                  min={0.05}
                  max={3}
                  disabled={disabled}
                  placeholder="Preset default"
                  value={scene.enterDuration ?? ''}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    updateScene(media.id, scene.id, { enterDuration: Number.isFinite(value) && value > 0 ? value : undefined })
                  }}
                  {...historyFieldProps}
                />
              </label>
              <label className="scene-properties-field">
                Exit duration (s)
                <input
                  type="number"
                  step={0.05}
                  min={0.05}
                  max={3}
                  disabled={disabled}
                  placeholder="Preset default"
                  value={scene.exitDuration ?? ''}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    updateScene(media.id, scene.id, { exitDuration: Number.isFinite(value) && value > 0 ? value : undefined })
                  }}
                  {...historyFieldProps}
                />
              </label>
            </div>
            <div className="scene-properties-row">
              <label className="scene-properties-field">
                Stagger delay (seconds between items)
                <input
                  type="number"
                  step={0.05}
                  min={0}
                  max={1}
                  disabled={disabled || scene.motionPreset === 'none'}
                  placeholder="Preset default"
                  value={scene.staggerDelay ?? ''}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    updateScene(media.id, scene.id, { staggerDelay: Number.isFinite(value) && value >= 0 ? value : undefined })
                  }}
                  {...historyFieldProps}
                />
              </label>
              <label className="scene-properties-field">
                Motion intensity (0-100)
                <input
                  type="number"
                  step={5}
                  min={0}
                  max={100}
                  disabled={disabled}
                  placeholder="Preset default"
                  value={scene.motionIntensity ?? ''}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    updateScene(media.id, scene.id, { motionIntensity: Number.isFinite(value) && value >= 0 ? Math.min(100, value) : undefined })
                  }}
                  {...historyFieldProps}
                />
              </label>
            </div>
            <div className="scene-properties-row">
              <label className="scene-properties-checkbox-field">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={scene.loopEnabled ?? false}
                  onChange={(e) => updateScene(media.id, scene.id, { loopEnabled: e.target.checked })}
                />
                Loop animation (hold phase)
              </label>
              <label className="scene-properties-field">
                Loop speed
                <input
                  type="number"
                  step={0.1}
                  min={0.1}
                  max={4}
                  disabled={disabled || !scene.loopEnabled}
                  placeholder="Preset default"
                  value={scene.loopSpeed ?? ''}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    updateScene(media.id, scene.id, { loopSpeed: Number.isFinite(value) && value > 0 ? value : undefined })
                  }}
                  {...historyFieldProps}
                />
              </label>
            </div>
            <div className="scene-properties-actions">
              <button type="button" disabled={disabled} onClick={() => seekTo(scene.startTime)}>
                Restart preview
              </button>
            </div>
          </>
        )}

        {tab === 'timing' && (
          <>
            <div className="scene-properties-row">
              <label className="scene-properties-field">
                Start (s)
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={scene.startTime.toFixed(2)}
                  disabled={disabled}
                  onChange={(e) => handleStartChange(Number(e.target.value))}
                  {...historyFieldProps}
                />
              </label>
              <label className="scene-properties-field">
                End (s)
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={scene.endTime.toFixed(2)}
                  disabled={disabled}
                  onChange={(e) => handleEndChange(Number(e.target.value))}
                  {...historyFieldProps}
                />
              </label>
              <label className="scene-properties-field">
                Duration (s)
                <input type="number" value={(scene.endTime - scene.startTime).toFixed(2)} disabled readOnly />
              </label>
            </div>
            <div className="scene-properties-row">
              <label className="scene-properties-field">
                In animation (s)
                <input
                  type="number"
                  step={0.1}
                  min={0.05}
                  max={2}
                  disabled={disabled}
                  placeholder="Brand default"
                  value={scene.animationInDurationSeconds ?? ''}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    updateScene(media.id, scene.id, { animationInDurationSeconds: Number.isFinite(value) && value > 0 ? value : undefined })
                  }}
                  {...historyFieldProps}
                />
              </label>
              <label className="scene-properties-field">
                Out animation (s)
                <input
                  type="number"
                  step={0.1}
                  min={0.05}
                  max={2}
                  disabled={disabled}
                  placeholder="Brand default"
                  value={scene.animationOutDurationSeconds ?? ''}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    updateScene(media.id, scene.id, { animationOutDurationSeconds: Number.isFinite(value) && value > 0 ? value : undefined })
                  }}
                  {...historyFieldProps}
                />
              </label>
            </div>
            <p className="placeholder">Effective in/out durations right now: {(inDuration ?? 0.4).toFixed(2)}s / {(outDuration ?? 0.4).toFixed(2)}s.</p>
          </>
        )}

        <p className="scene-properties-reason">{scene.reason}</p>

        <div className="scene-properties-actions">
          <button onClick={() => toggleSceneLock(media.id, scene.id)}>{scene.locked ? 'Unlock' : 'Lock'}</button>
          {scene.status !== 'rejected' ? (
            <button onClick={() => setSceneStatus(media.id, scene.id, 'rejected')}>Hide graphic</button>
          ) : (
            <button onClick={() => setSceneStatus(media.id, scene.id, 'accepted')}>Show graphic</button>
          )}
        </div>
      </div>

      <div className="panel-fixed-foot scene-layer-controls">
        <button title="Bring forward" disabled={disabled} onClick={() => bringSceneForward(media.id, scene.id)}>
          ↑ Forward
        </button>
        <button title="Send backward" disabled={disabled} onClick={() => sendSceneBackward(media.id, scene.id)}>
          ↓ Backward
        </button>
        <button title="Duplicate" onClick={() => duplicateScene(media.id, scene.id)}>
          ⧉ Duplicate
        </button>
        <button
          title={(scene.linked ?? true) ? 'Unlink from its AI suggestion' : 'Re-link to its AI suggestion'}
          onClick={() => toggleSceneLinked(media.id, scene.id)}
        >
          {(scene.linked ?? true) ? '🔗 Unlink' : '⛓️‍💥 Link'}
        </button>
        <button className="scene-layer-delete" title="Delete" onClick={() => deleteScene(media.id, scene.id)}>
          🗑 Delete
        </button>
      </div>
    </div>
  )
}

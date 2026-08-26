// Shared project-file data model, used by both the Electron main process
// and the renderer UI. See plan section "Data model (project file)".
import type { Transcript, ScriptAlignment } from './transcription'
import type { CommunicationPurpose, AiSuggestion } from './suggestions'
import type {
  TemplateId,
  ScenePosition,
  AnimationPreset,
  AnimationEasing,
  FontWeight,
  TextAlign,
  TemplateIconId,
  SceneIcon,
  PresentationMode,
  SceneBackground,
  SceneContentTransform,
  MotionPreset
} from './templates'
import type { TimelineTrack } from './timelineTracks'
import { createDefaultTracks } from './timelineTracks'
import type { StoryAnalysis, EntityBible, VisualPlan, StorySceneGroup, StoryVisualTheme } from './story'

export type { CommunicationPurpose }

export type SceneStatus = 'accepted' | 'rejected' | 'needsReview'

export interface SceneContentItem {
  id: string
  label: string
  description?: string
  value?: string
  /** Per-item icon choice for 'per-item' templates (Checklist, Three-Step
   * Presenter Plan, Device Compatibility Lineup). Unknown/invalid ids are
   * validated away on load rather than crashing the renderer. */
  iconId?: TemplateIconId
  /** Per-item accent color (step number circle, device glow/icon). Undefined
   * falls back to the template's own default palette. */
  color?: string
  /** Row/node state for templates with per-item progress or diagram
   * semantics (Security Login Flow's rows, Isometric System Diagram's
   * highlighted node). 'default' (or undefined) is a plain, unmarked item. */
  status?: 'default' | 'complete' | 'blocked' | 'warning'
}

/** Per-instance styling/behavior for the 'vault-break-in-animation' template
 * only -- kept as its own optional field (not squeezed into SceneContent)
 * since none of these are free text/eyebrow/title style content, they're
 * structural/behavioral parameters (colors, counts, a bypass strategy, a
 * reactivation toggle) specific to this one heist-scene composition.
 * Every field is optional; the template supplies its own defaults for any
 * unset field so scenes created before a given field existed keep rendering
 * unchanged. */
export interface VaultBreakInConfig {
  /** Floor outline / grid line color. */
  structureColor?: string
  /** 0-100. Perspective grid line opacity within each floor. */
  gridOpacity?: number
  personColor?: string
  /** 1-5 -- how many laser lines span the middle floor. */
  laserCount?: number
  laserColor?: string
  /** 0-100. Glow/bloom strength around each active laser line. */
  laserGlow?: number
  /** 'sequential': lasers switch off left-to-right one at a time.
   * 'gap': a single center gap opens between two lasers, the rest stay lit. */
  bypassStyle?: 'sequential' | 'gap'
  /** Whether lasers switch back on after the person has fully crossed. */
  laserReactivation?: boolean
  vaultMetalColor?: string
  vaultLockedColor?: string
  vaultUnlockedColor?: string
  /** 4-10 radial spokes on the vault wheel. */
  vaultSpokeCount?: number
  /** Degrees the wheel rotates through while unlocking (120-180 suggested). */
  wheelRotationDegrees?: number
  showFloorHatch?: boolean
}

/** Per-instance styling/behavior for the 'animated-break-in-vault-diagram'
 * template only -- structural/behavioral parameters specific to this one
 * SVG composition, kept separate from SceneContent for the same reason as
 * VaultBreakInConfig. Every field optional; the template supplies its own
 * defaults for any unset field. Eyebrow/title live in `scene.content`
 * (standard content slots); animation speed/intensity/loop live in the
 * existing generic motion fields (`motionIntensity`/`loopEnabled`/
 * `loopSpeed`, see motion.ts) rather than being duplicated here; background
 * mode/opacity live in the existing `scene.background` field -- all three
 * are shared, already-editable systems, not template-specific state. */
export interface AnimatedVaultDiagramConfig {
  outlineColor?: string
  laserColor?: string
  personColor?: string
  vaultWheelColor?: string
  /** 0-100. Floor surface fill opacity. */
  surfaceOpacity?: number
  /** 0-100. Technical grid line opacity. */
  gridOpacity?: number
  /** 0-100. Outer cyan glow strength. */
  glowIntensity?: number
  /** 1-5 -- how many laser lines span the middle floor. */
  laserCount?: number
  showPerson?: boolean
  showVaultWheel?: boolean
  showFloorOpening?: boolean
}

/** Per-instance styling/behavior for the 'data-center-cyber-intrusion'
 * template only -- kept separate from SceneContent for the same reason as
 * VaultBreakInConfig. Eyebrow/title live in `scene.content`; animation
 * speed/intensity/loop live in the existing generic motion fields;
 * background mode/opacity live in `scene.background`. */
export interface DataCenterCyberIntrusionConfig {
  /** 1-8 server racks on the top floor. */
  serverCount?: number
  /** 1-6 malicious packets entering from the left. */
  packetCount?: number
  attackColor?: string
  secureColor?: string
  firewallColor?: string
  showAttacker?: boolean
  showShield?: boolean
  /** Whether the attack ultimately gets stopped at the firewall or reaches the database core. */
  attackResult?: 'blocked' | 'breached'
  /** 0-100. Outer structural glow strength. */
  glowIntensity?: number
}

/** Per-instance styling/behavior for the 'hospital-emergency-response'
 * template only -- kept separate from SceneContent for the same reason as
 * VaultBreakInConfig. Eyebrow/title live in `scene.content`; animation
 * speed/intensity/loop live in the existing generic motion fields;
 * background mode/opacity live in `scene.background`. */
export interface HospitalEmergencyResponseConfig {
  patientCondition?: 'critical' | 'stable' | 'recovering'
  /** 0-100. Drives how intense the entrance emergency pulse/flash reads. */
  emergencySeverity?: number
  /** 2-4 treatment stages/floors highlighted along the path. */
  treatmentStageCount?: number
  showDoctor?: boolean
  showNurse?: boolean
  pathColor?: string
  emergencyColor?: string
  recoveryColor?: string
  /** 0-100. Hold-phase scanner rotation speed. */
  scannerSpeed?: number
  topFloorLabel?: string
  middleFloorLabel?: string
  bottomFloorLabel?: string
}

export interface SceneContent {
  /** Small label above the title (Tech Title Scene's category tag, Three-Step
   * Presenter Plan's section label -- e.g. "PLAN • ៣ ជំហាន"). */
  eyebrow?: string
  title?: string
  subtitle?: string
  body?: string
  /** Single scalar value -- percentage for Percentage Card, or the
   * accent-colored highlight phrase for Tech Title Scene. */
  value?: string
  items?: SceneContentItem[]
  /** Optional closing question/CTA line (Device Compatibility Lineup). */
  cta?: string
}

export interface Scene {
  id: string
  mediaId: string
  /** Transcript segment this scene was generated from -- lets scene sync find
   * and update/remove the right scene as the originating suggestion changes. */
  segmentId: string
  suggestionId: string
  /** References a TimelineTrack.id in ProjectSequence.tracks (kind 'graphic'
   * or, in principle, 'text' -- see shared/timelineTracks.ts). Was a fixed
   * 'V2'|'V3' literal union before dynamic tracks; now any track id. */
  track: string
  templateId: TemplateId
  startTime: number
  endTime: number
  purpose: CommunicationPurpose
  originalText: string
  visualText: string
  reason: string
  confidence: number
  brandOverrides?: Partial<BrandPreset>

  /** Richer structured content for templates that need more than one text
   * slot (Checklist items, Person Card name/role, Percentage Card value,
   * etc). Undefined for older/simple scenes -- those templates fall back to
   * deriving reasonable defaults from `visualText` so nothing needs a data
   * migration to keep rendering. */
  content?: SceneContent

  /** Explicit on-canvas placement; undefined uses the template's own default anchored layout. */
  position?: ScenePosition
  /** When true, Position & Size edits scale width/height together from a single dimension. Display-only (not persisted geometry). */
  lockAspectRatio?: boolean

  // Text styling -- undefined falls back to the brand preset / template default.
  fontSizePx?: number
  fontWeight?: FontWeight
  textAlign?: TextAlign
  textColor?: string

  // Fill (background) -- undefined falls back to brandOverrides.primaryColor / brand.primaryColor.
  fillColor?: string
  /** 0-100. */
  fillOpacity?: number

  // Border -- undefined means no explicit border override (template default).
  borderColor?: string
  borderWidthPx?: number
  borderRadiusPx?: number

  /** Undefined uses the template's own default motion direction and the brand's animationIntensity timing. */
  animationPreset?: AnimationPreset
  animationEasing?: AnimationEasing
  /** Legacy single duration, still honored if the split in/out fields below are unset. */
  animationDurationSeconds?: number
  animationInDurationSeconds?: number
  animationOutDurationSeconds?: number

  /** Icon configuration for templates with a 'single' or 'avatar' icon slot
   * (see TEMPLATE_ICON_SUPPORT). Undefined uses the template's own default
   * icon and styling. Per-item icons for 'per-item' templates live on
   * `content.items[].iconId` instead. */
  icon?: SceneIcon

  /** How the scene occupies the frame -- an overlay on top of source video, a
   * bottom glass panel that keeps the presenter visible, or a full-frame
   * cinematic composition. Undefined uses the template's own default. */
  presentationMode?: PresentationMode
  /** Cinematic background treatment for templates that declare the
   * 'background' content slot. Undefined uses the template's own default. */
  background?: SceneBackground
  /** Foreground content group transform for full-frame templates -- see
   * SceneContentTransform. Undefined uses DEFAULT_CONTENT_TRANSFORM
   * (centered, unscaled) without writing it into the saved scene until the
   * user actually moves/resizes the content. */
  contentTransform?: SceneContentTransform
  /** Properties panel "Constrain to canvas" toggle. Default (undefined/false)
   * is OFF: ordinary dragging/resizing of `contentTransform`/`position` only
   * keeps values numerically sane (see contentTransformMath.ts's
   * clampContentTransformUnconstrained) and may sit partially or fully
   * outside the video canvas, clipped only visually by the stage's own
   * `overflow: hidden`. When true, dragging/resizing instead keeps the full
   * box inside the safe area (clampContentTransform) -- the previous,
   * always-on behavior. Reset Transform/Fit to Canvas/Center actions work
   * regardless of this toggle. */
  constrainToCanvas?: boolean

  /** Per-instance styling/behavior for the 'vault-break-in-animation'
   * template only -- see VaultBreakInConfig. Undefined for every other
   * template, and for a vault scene that hasn't customized anything yet
   * (the template supplies its own defaults). */
  vaultConfig?: VaultBreakInConfig

  /** Per-instance styling/behavior for the 'animated-break-in-vault-diagram'
   * template only -- see AnimatedVaultDiagramConfig. */
  animatedVaultConfig?: AnimatedVaultDiagramConfig

  /** Per-instance styling/behavior for the 'data-center-cyber-intrusion'
   * template only -- see DataCenterCyberIntrusionConfig. */
  dataCenterConfig?: DataCenterCyberIntrusionConfig

  /** Per-instance styling/behavior for the 'hospital-emergency-response'
   * template only -- see HospitalEmergencyResponseConfig. */
  hospitalResponseConfig?: HospitalEmergencyResponseConfig

  /** Coordinated internal-element motion preset (see renderer/src/templates/motion.ts).
   * Undefined uses each template's own default preset. Distinct from the
   * older `animationPreset` above, which only ever moved the whole
   * container -- these drive per-element enter/hold/exit choreography. */
  motionPreset?: MotionPreset
  /** 0-100. Undefined uses the preset's own default strength. */
  motionIntensity?: number
  /** Whether hold-phase looping motion (packets, pulses, breathing glows) is
   * active. Undefined uses the preset's own default. */
  loopEnabled?: boolean
  /** Multiplier applied to all loop timings (1 = preset's natural speed). */
  loopSpeed?: number
  /** Seconds between each staggered internal element's start. */
  staggerDelay?: number
  /** Seconds. Overall entrance choreography duration (distinct from the
   * legacy animationInDurationSeconds, which only timed the whole container). */
  enterDuration?: number
  /** Seconds. Overall exit choreography duration. */
  exitDuration?: number

  /** Stacking order among scenes on the same media (higher renders on top). Undefined == 0. */
  zIndex?: number
  /** False means this scene is intentionally detached from its originating AI
   * suggestion -- it survives regeneration/rejection of that suggestion even
   * without being locked or hand-edited. Undefined/true == normally linked. */
  linked?: boolean

  locked: boolean
  /** True once the user has hand-edited this scene (text, timing, template,
   * or track); preserved when the originating suggestion is regenerated. */
  edited: boolean
  status: SceneStatus
  createdAt: string
}

export interface BrandPreset {
  id: string
  projectName: string
  logoPath?: string
  primaryColor: string
  secondaryColor: string
  accentColor: string
  khmerFont: string
  latinFont: string
  textStyle: string
  boxStyle: string
  iconStyle: string
  backgroundStyle: string
  animationIntensity: 'minimal' | 'balanced' | 'energetic' | 'cinematic' | 'custom'
  defaultAspectRatio: '16:9' | '9:16' | '1:1'
}

export interface MediaSource {
  id: string
  kind: 'video' | 'audio'
  /** Which real-world asset kind this came from -- distinct from `kind`
   * because a still image is imported by synthesizing a short silent video
   * from it (see app/main/media/stillImage.ts), so `kind` stays 'video' for
   * an image-sourced asset while `assetType` records that it's really an
   * image (unbounded/re-timeable duration, no source-duration trim limit).
   * Undefined for media imported before this field existed -- treated as
   * 'video'/'audio' per `kind` (see migrateToSequence). */
  assetType?: 'video' | 'image' | 'audio'
  fileName: string
  originalPath: string
  proxyPath?: string
  thumbnailPath?: string
  durationSeconds: number
  hasAudio: boolean
  addedAt: string
}

/** A marker on a single clip, offset-relative so it travels with the clip
 * for free on move/trim (see sequenceOps.ts's clip-marker helpers, which
 * clamp `offsetSeconds` into `[0, duration)` on trim rather than deleting a
 * marker a trim would otherwise push out of range). */
export interface ClipMarker {
  id: string
  offsetSeconds: number
  color: string
  name: string
  note?: string
}

/** One piece of media placed on the Timeline -- distinct from `MediaSource`
 * (the imported asset itself, which can be placed as zero, one, or many
 * clips). `startTime`/`duration` are project-sequence-absolute seconds;
 * `sourceIn`/`sourceOut` are offsets into the underlying media asset's own
 * timeline. Image clips are not source-bounded: `sourceOut` stays undefined
 * and `duration` can be set arbitrarily long (see sequenceOps.ts). */
export interface TimelineClip {
  id: string
  /** -> MediaSource.id */
  mediaId: string
  type: 'video' | 'image' | 'audio'
  /** References a TimelineTrack.id in ProjectSequence.tracks (kind 'video'
   * or 'audio'). Was a fixed 'V1'|'A1'|'A2' literal union before dynamic
   * tracks; now any track id of a compatible kind. */
  trackId: string
  startTime: number
  duration: number
  sourceIn: number
  /** Undefined for image clips (they're not bounded by a source duration). */
  sourceOut?: number
  /** A video clip's own extracted audio clip on A1, and vice versa -- kept
   * in sync by SequenceContext so moving/splitting one moves/splits both
   * (unless the user explicitly opts out via Alt+Split). Cascading is gated
   * behind the Linkage toggle (see TimelineViewContext) -- this field itself
   * is never cleared by toggling Linkage off, only by an explicit Unlink. */
  linkedClipId?: string
  /** Arbitrary multi-clip "move together" set, independent of `linkedClipId`
   * (a 1:1 video<->audio pairing with its own split/move cascade). Clips
   * sharing a `groupId` always move together regardless of the Linkage
   * toggle. Undefined/no group is the common case. */
  groupId?: string
  locked: boolean
  muted?: boolean
  /** False = Disabled (Enable/Disable clip-context-menu command): excluded
   * from findActiveClips/playback and rendered dimmed, but stays in the
   * clip array and undo history. Undefined/true = enabled (the common case). */
  enabled?: boolean
  markers?: ClipMarker[]

  /** All fields below are additive (schemaVersion 6) and optional -- a
   * missing value always means "the un-adjusted default" (1x speed, full
   * opacity/volume, no fade, identity transform), so old projects need no
   * data migration, only the schemaVersion bump (see projectMigration.ts). */
  /** Video only. 1 = normal speed. */
  playbackRate?: number
  /** 0-1. Undefined = fully opaque (1). */
  opacity?: number
  /** 0-1 (independent of the boolean `muted`. Undefined = full volume (1). */
  volume?: number
  /** Seconds, from this clip's own start. Undefined/0 = no fade. */
  fadeIn?: number
  /** Seconds, from this clip's own end. Undefined/0 = no fade. */
  fadeOut?: number
  /** Video/image only. Undefined = identity (centered, unscaled, unrotated,
   * uncropped) -- matches how the clip renders today without this field. */
  transform?: ClipTransform
}

export interface ClipTransform {
  /** Position offset in pixels from center, at the project's native resolution. */
  x: number
  y: number
  scaleX: number
  scaleY: number
  /** Degrees. */
  rotation: number
  /** Each 0-1, fraction of the source frame cropped from that edge. */
  cropTop: number
  cropRight: number
  cropBottom: number
  cropLeft: number
}

/** A sequence-level marker (Timeline ruler), distinct from ClipMarker (which
 * lives on and travels with one clip). `time` is sequence-absolute seconds. */
export interface Marker {
  id: string
  time: number
  color: string
  name: string
  note?: string
}

export interface ProjectSequence {
  /** The dynamic track registry -- every TimelineClip.trackId and Scene.track
   * value references an id here. See shared/timelineTracks.ts. */
  tracks: TimelineTrack[]
  clips: TimelineClip[]
  markers: Marker[]
  /** Project-sequence-absolute seconds -- always
   * `max(clip.startTime + clip.duration) + 5` (see
   * sequenceOps.ts's computeSequenceDuration), recomputed after every
   * insert/move/trim/duplicate so the Timeline always has headroom past the
   * last clip instead of ending exactly at it. 0 for an empty sequence. */
  duration: number
}

export function createEmptySequence(): ProjectSequence {
  return { tracks: createDefaultTracks(), clips: [], markers: [], duration: 0 }
}

/** The single source of truth for `ProjectSequence.duration`: always headroom
 * past the last clip's end, never exactly at it, so the Timeline never ends
 * flush against the final clip. 0 for an empty sequence (never negative). */
export function computeSequenceDuration(clips: TimelineClip[]): number {
  if (clips.length === 0) return 0
  return Math.max(...clips.map((clip) => clip.startTime + clip.duration)) + 5
}

export interface ProjectFile {
  /** 1: original schema. 2: SceneContentTransform's xPercent/yPercent became
   * the box's normalized CENTER instead of its top-left corner. 3: added
   * `sequence` (ProjectSequence) -- the real multi-clip V1/A1/A2 timeline;
   * older files have no `sequence` at all and are migrated by turning their
   * one implicit "selected" media item into a single V1 clip (see
   * shared/projectMigration.ts's migrateToSequence). 4: added
   * `sequence.tracks` -- the dynamic track registry; older files get the
   * fixed V1/V2/V3/A1/A2/C1 tracks synthesized under the same ids their
   * clips/scenes already used (see migrateToTrackRegistry). 5: added
   * `sequence.markers` (real, persisted Markers) and `TimelineTrack.isMain`
   * (the primary video track for magnetic/gapless editing) -- older files
   * get `markers: []` and `isMain` set on whichever video track has the
   * lowest `order` (see migrateToMainTrackAndMarkers). 6: added the optional
   * `playbackRate`/`opacity`/`volume`/`fadeIn`/`fadeOut`/`transform` fields
   * on `TimelineClip` -- purely additive, no data to backfill, older files
   * just need the version bump (see migrateToClipProperties). 7: added the
   * optional `narrativeGraph`/`entityBible`/`visualPlan`/`sceneGroups` fields
   * for AI Connected Story Visualization (see shared/story.ts) -- purely
   * additive, no data to backfill, older files just need the version bump
   * (see migrateToStoryVisualization). Always written as the current version
   * on save; loadProject migrates older files forward. */
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7
  id: string
  name: string
  createdAt: string
  updatedAt: string
  media: MediaSource[]
  /** Keyed by mediaId. */
  transcripts: Record<string, Transcript>
  /** Keyed by mediaId. */
  scriptAlignments: Record<string, ScriptAlignment>
  /** Keyed by mediaId. Phase E output -- classification only, not yet renderable (see shared/suggestions.ts). */
  aiSuggestions: Record<string, AiSuggestion[]>
  scenes: Scene[]
  /** The project's real Timeline: placed, trimmable, splittable clips on
   * V1/A1/A2. See ProjectSequence/TimelineClip. */
  sequence: ProjectSequence
  brandPreset: BrandPreset
  captionsTrackEnabled: boolean
  privacyMode: 'fully-local' | 'cloud-assisted'

  /** All five fields below are additive (schemaVersion 7) and optional --
   * AI Connected Story Visualization (see shared/story.ts). A missing value
   * always means "the user has never run story analysis for this project,"
   * so old projects need no data migration, only the schemaVersion bump
   * (see migrateToStoryVisualization). Keyed by mediaId, matching
   * `transcripts`/`aiSuggestions`'s own convention -- one story analysis per
   * transcript. `sceneGroups` stays a flat array (like `scenes`) since each
   * group already carries its own `narrativeGraphId`/`entityBibleId`
   * back-references. `theme` is the LIVE, still-editable theme for a media
   * item (edited in the Story Visuals panel's Continuity section before any
   * scenes exist yet); `Generate Accepted Graphics` snapshots its current
   * value into the new StorySceneGroup.theme it creates, so a group's own
   * theme is a frozen-at-generation-time copy, not a live reference back here. */
  narrativeGraph?: Record<string, StoryAnalysis>
  entityBible?: Record<string, EntityBible>
  visualPlan?: Record<string, VisualPlan>
  sceneGroups?: StorySceneGroup[]
  theme?: Record<string, StoryVisualTheme>
}

export function createDefaultBrandPreset(): BrandPreset {
  return {
    id: 'default',
    projectName: 'Untitled Project',
    primaryColor: '#5b8cff',
    secondaryColor: '#0b0d10',
    accentColor: '#ffb84d',
    khmerFont: 'Noto Sans Khmer',
    latinFont: 'Segoe UI',
    textStyle: 'bold',
    boxStyle: 'rounded',
    iconStyle: 'outline',
    backgroundStyle: 'solid',
    animationIntensity: 'balanced',
    defaultAspectRatio: '16:9'
  }
}

export const PROJECT_IPC = {
  getOrCreateStartup: 'project:getOrCreateStartup',
  save: 'project:save'
} as const

export function createNewProjectFile(name: string): ProjectFile {
  const now = new Date().toISOString()
  return {
    schemaVersion: 7,
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    media: [],
    transcripts: {},
    scriptAlignments: {},
    aiSuggestions: {},
    scenes: [],
    sequence: createEmptySequence(),
    brandPreset: createDefaultBrandPreset(),
    captionsTrackEnabled: false,
    privacyMode: 'fully-local',
    narrativeGraph: {},
    entityBible: {},
    visualPlan: {},
    sceneGroups: [],
    theme: {}
  }
}

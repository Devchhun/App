// Phase F: the five MVP motion-graphics templates (spec §22 item 6) and the
// default purpose->template mapping used when a scene is first created from
// an accepted AI suggestion. The mapping is a starting point only -- every
// scene's template can be overridden per-instance in the Properties editor.
import type { CommunicationPurpose } from './suggestions'

export type TemplateId =
  | 'lower-third'
  | 'statistic-callout'
  | 'numbered-steps'
  | 'comparison'
  | 'warning-alert'
  | 'title-card'
  | 'keyword-highlight'
  | 'percentage-card'
  | 'person-card'
  | 'checklist'
  | 'tech-title-scene'
  | 'three-step-presenter-plan'
  | 'device-compatibility-lineup'
  | 'social-channel-card'
  | 'security-login-flow'
  | 'feature-benefits-pills'
  | 'cause-effect-flow'
  | 'isometric-system-diagram'
  | 'vault-break-in-animation'
  | 'animated-break-in-vault-diagram'
  | 'data-center-cyber-intrusion'
  | 'hospital-emergency-response'
  | 'central-identity'
  | 'reality-vs-dream'
  | 'body-vs-avatar'
  | 'source-branch'
  | 'chapter-evidence'
  | 'final-summary'

export const TEMPLATE_IDS: TemplateId[] = [
  'lower-third',
  'statistic-callout',
  'numbered-steps',
  'comparison',
  'warning-alert',
  'title-card',
  'keyword-highlight',
  'percentage-card',
  'person-card',
  'checklist',
  'tech-title-scene',
  'three-step-presenter-plan',
  'device-compatibility-lineup',
  'social-channel-card',
  'security-login-flow',
  'feature-benefits-pills',
  'cause-effect-flow',
  'isometric-system-diagram',
  'vault-break-in-animation',
  'animated-break-in-vault-diagram',
  'data-center-cyber-intrusion',
  'hospital-emergency-response',
  'central-identity',
  'reality-vs-dream',
  'body-vs-avatar',
  'source-branch',
  'chapter-evidence',
  'final-summary'
]

export const TEMPLATE_LABELS: Record<TemplateId, string> = {
  'lower-third': 'Lower Third',
  'statistic-callout': 'Statistic Callout',
  'numbered-steps': 'Numbered Steps',
  comparison: 'Comparison',
  'warning-alert': 'Warning / Alert',
  'title-card': 'Animated Title Card',
  'keyword-highlight': 'Large Keyword Highlight',
  'percentage-card': 'Percentage Card',
  'person-card': 'Person / Profile Card',
  checklist: 'Checklist',
  'tech-title-scene': 'Technology Title Scene',
  'three-step-presenter-plan': 'Three-Step Presenter Plan',
  'device-compatibility-lineup': 'Device Compatibility Lineup',
  'social-channel-card': 'Social Channel / Profile Card',
  'security-login-flow': 'Security Login Flow',
  'feature-benefits-pills': 'Feature Benefits Pills',
  'cause-effect-flow': 'Cause and Effect Flow',
  'isometric-system-diagram': 'Isometric System Diagram',
  'vault-break-in-animation': 'Vault Break-In Animation',
  'animated-break-in-vault-diagram': 'Animated Break-In Vault Diagram',
  'data-center-cyber-intrusion': 'Data Center Cyber Intrusion',
  'hospital-emergency-response': 'Hospital Emergency Response',
  'central-identity': 'Central Character Identity',
  'reality-vs-dream': 'Reality vs. Simulation Split',
  'body-vs-avatar': 'Two Bodies, One Identity',
  'source-branch': 'Source and Branch Diagram',
  'chapter-evidence': 'Chapter Evidence Card',
  'final-summary': 'Final Three-Point Summary'
}

export const TEMPLATE_DESCRIPTIONS: Record<TemplateId, string> = {
  'lower-third': 'A bottom-left name/title bar. Used for introductions, causes/effects, and generic captions.',
  'statistic-callout': 'A bold centered callout. Used for key numbers, dates, money, and main claims.',
  'numbered-steps': 'A numbered badge with text. Used for sequences of steps.',
  comparison: 'A split two-sided card (or single card). Used for comparisons.',
  'warning-alert': 'A full-width alert banner. Used for warnings, problems, and security events.',
  'title-card': 'A large centered title, held on screen. Used for introductions and section openers.',
  'keyword-highlight': 'One short phrase blown up to fill the frame. Used for a main claim or conclusion.',
  'percentage-card': 'A radial percentage ring with a label. Used for statistics expressed as a percentage.',
  'person-card': 'A framed name/role card. Used for introducing a person or organization.',
  checklist: 'A vertical list with checkmarks. Used for list-type content.',
  'tech-title-scene':
    'A full-frame cinematic chapter title with glow background, eyebrow label, masked title reveal, and accent phrase. Used for cybersecurity, technology, and product-introduction openers.',
  'three-step-presenter-plan':
    'A glass lower-third panel with three sequential step cards over the presenter video. Used for plans, workflows, and setup instructions.',
  'device-compatibility-lineup':
    'A full-frame lineup of four CSS-built device frames with per-device color, icon, and label. Used for supported-platform and availability scenes.',
  'social-channel-card':
    'A presenter-overlay profile card with up to four social/channel rows (icon, name, action pill). Used for introductions, organizations, and calls to action.',
  'security-login-flow':
    'An editable login-device frame beside a sequence of security rows (password, code, verification), each with its own complete/blocked/warning state. Used for cybersecurity, authentication, and login-process scenes.',
  'feature-benefits-pills':
    'A title with an accent phrase above three or four rounded benefit pills. Used for feature lists, benefits, and main-claim/conclusion scenes.',
  'cause-effect-flow':
    'Two connected cause/effect nodes with a drawing connector, plus optional supporting nodes. Used for cause, effect, problem/solution, and comparison scenes.',
  'isometric-system-diagram':
    'Three isometric platform layers with configurable nodes and animated connectors/packets between them. Used for system-architecture and network/technology explainer scenes.',
  'vault-break-in-animation':
    'A three-floor isometric heist scene: an animated human figure walks down through the floors, bypasses a configurable red laser barrier, and unlocks a rotating steel bank-vault wheel. Used for cybersecurity events, security breaches, and step-by-step technical process explainers.',
  'animated-break-in-vault-diagram':
    'A tall transparent three-floor isometric security-breach diagram (doorway, U-shaped barrier, laser bypass, and a large bank-vault wheel), rendered as one editable SVG composition with a deterministic playhead-driven entrance/hold/exit sequence. Used for cybersecurity events, security warnings, and step-by-step breach explainers.',
  'data-center-cyber-intrusion':
    'A three-floor isometric server-room diagram: an attacker sends red malicious packets from the left toward a dividing firewall wall, one packet probes a crack while a security scan and detection ring respond, and a shielded database core on the bottom floor resolves the attack as blocked or breached. Used for cybersecurity events, intrusion/breach explainers, and network-defense sequences.',
  'hospital-emergency-response':
    'A three-floor isometric hospital diagram: a patient arrives on the emergency floor, is scanned on a rotating medical-scanner floor, and moves to a recovery floor as a luminous path and heartbeat line track their status from red emergency to green recovery. Used for healthcare, emergency-response, and step-by-step process explainers.',
  'central-identity':
    'A consistent character avatar centered on screen with name, origin, and an identity badge (e.g. "The same Wang Lin"), plus a small forward-extending timeline. Used to (re)establish one recurring character\'s identity in a connected story sequence.',
  'reality-vs-dream':
    'A split composition: one side shows a real timeline/events, the other shows a simulated/calculated branch, divided by a labeled connector. Used to visually separate real story events from a simulation, dream, or calculation.',
  'body-vs-avatar':
    'A two-sided comparison card with a shared center connector marking the same underlying identity behind both sides. Used to show two different bodies, forms, or roles that belong to one character -- never implying one side is more "real" than the other.',
  'source-branch':
    'A source node with a branch line leading to a second, related-but-distinct node, carrying a relationship label along the connector. Used for created-from/split-from/sent-to-past relationships between two connected entities.',
  'chapter-evidence':
    'A compact evidence callout: a chapter/source marker, a short paraphrased claim, and a connector toward the conclusion it supports. Used when a script cites a specific chapter or source as evidence for a claim.',
  'final-summary':
    'Three connected conclusion nodes converging on one central identity. Used to close a connected story sequence with a short, multi-point summary.'
}

export type TemplateCategory =
  | 'titles'
  | 'information'
  | 'statistics'
  | 'steps'
  | 'comparisons'
  | 'warnings'
  | 'people'
  | 'social'
  | 'technology'
  | 'location'
  | 'money'
  | 'diagrams'
  | 'cybersecurity'

export const TEMPLATE_CATEGORY_LABELS: Record<TemplateCategory, string> = {
  titles: 'Titles',
  information: 'Information',
  statistics: 'Statistics',
  steps: 'Steps',
  comparisons: 'Comparisons',
  warnings: 'Warnings',
  people: 'People',
  social: 'Social',
  technology: 'Technology',
  location: 'Location',
  money: 'Money',
  diagrams: 'Diagrams',
  cybersecurity: 'Cybersecurity'
}

export const TEMPLATE_CATEGORY: Record<TemplateId, TemplateCategory> = {
  'lower-third': 'information',
  'statistic-callout': 'statistics',
  'numbered-steps': 'steps',
  comparison: 'comparisons',
  'warning-alert': 'warnings',
  'title-card': 'titles',
  'keyword-highlight': 'titles',
  'percentage-card': 'statistics',
  'person-card': 'people',
  checklist: 'information',
  'tech-title-scene': 'technology',
  'three-step-presenter-plan': 'steps',
  'device-compatibility-lineup': 'technology',
  'social-channel-card': 'social',
  'security-login-flow': 'warnings',
  'feature-benefits-pills': 'information',
  'cause-effect-flow': 'comparisons',
  'isometric-system-diagram': 'diagrams',
  'vault-break-in-animation': 'diagrams',
  'animated-break-in-vault-diagram': 'cybersecurity',
  'data-center-cyber-intrusion': 'cybersecurity',
  'hospital-emergency-response': 'diagrams',
  'central-identity': 'people',
  'reality-vs-dream': 'diagrams',
  'body-vs-avatar': 'comparisons',
  'source-branch': 'diagrams',
  'chapter-evidence': 'information',
  'final-summary': 'diagrams'
}

/** Declared per template so the Properties panel shows only the icon
 * controls a given template actually renders (spec: "the panel must show
 * only controls the selected template supports"). */
export const TEMPLATE_ICON_SUPPORT: Record<TemplateId, IconSupportLevel> = {
  'lower-third': 'single',
  'statistic-callout': 'single',
  'numbered-steps': 'single',
  comparison: 'single',
  'warning-alert': 'single',
  'title-card': 'none',
  'keyword-highlight': 'none',
  'percentage-card': 'single',
  'person-card': 'avatar',
  checklist: 'per-item',
  'tech-title-scene': 'single',
  'three-step-presenter-plan': 'per-item',
  'device-compatibility-lineup': 'per-item',
  'social-channel-card': 'per-item',
  'security-login-flow': 'per-item',
  'feature-benefits-pills': 'per-item',
  'cause-effect-flow': 'per-item',
  'isometric-system-diagram': 'per-item',
  'vault-break-in-animation': 'none',
  'animated-break-in-vault-diagram': 'none',
  'data-center-cyber-intrusion': 'none',
  'hospital-emergency-response': 'none',
  'central-identity': 'avatar',
  'reality-vs-dream': 'per-item',
  'body-vs-avatar': 'per-item',
  'source-branch': 'per-item',
  'chapter-evidence': 'single',
  'final-summary': 'per-item'
}

/** Which structured content fields a template's Properties panel should
 * expose (Properties > Design > Content). Templates absent from this map
 * (the original 10) keep their existing free-text-only editing -- purely
 * additive, no behavior change for scenes/templates that predate this. */
export type ContentSlot = 'eyebrow' | 'title' | 'value' | 'body' | 'items' | 'cta' | 'background' | 'presentationMode'

export const TEMPLATE_CONTENT_SLOTS: Partial<Record<TemplateId, ContentSlot[]>> = {
  'tech-title-scene': ['eyebrow', 'title', 'value', 'background', 'presentationMode'],
  'three-step-presenter-plan': ['eyebrow', 'items', 'presentationMode'],
  'device-compatibility-lineup': ['title', 'items', 'cta', 'background', 'presentationMode'],
  'social-channel-card': ['title', 'value', 'items', 'presentationMode'],
  'security-login-flow': ['eyebrow', 'items', 'cta'],
  'feature-benefits-pills': ['eyebrow', 'title', 'value', 'items'],
  'cause-effect-flow': ['items'],
  'isometric-system-diagram': ['eyebrow', 'title', 'items', 'background'],
  'vault-break-in-animation': ['eyebrow', 'title', 'background'],
  'animated-break-in-vault-diagram': ['eyebrow', 'title', 'background'],
  'data-center-cyber-intrusion': ['eyebrow', 'title', 'background'],
  'hospital-emergency-response': ['eyebrow', 'title', 'background'],
  'central-identity': ['eyebrow', 'title', 'value', 'background', 'presentationMode'],
  'reality-vs-dream': ['eyebrow', 'title', 'items', 'background', 'presentationMode'],
  'body-vs-avatar': ['title', 'items', 'background', 'presentationMode'],
  'source-branch': ['eyebrow', 'title', 'items', 'background', 'presentationMode'],
  'chapter-evidence': ['eyebrow', 'title', 'body', 'value', 'background'],
  'final-summary': ['title', 'items', 'background', 'presentationMode']
}

/** How many structured items a per-item template expects -- fixed by design
 * (a "Three-Step" plan has three steps, a "4 Devices" lineup has four), so
 * the Properties panel edits exactly this many item slots rather than
 * offering add/remove. */
export const TEMPLATE_ITEM_COUNT: Partial<Record<TemplateId, number>> = {
  'three-step-presenter-plan': 3,
  'device-compatibility-lineup': 4,
  'social-channel-card': 4,
  'security-login-flow': 3,
  'feature-benefits-pills': 4,
  'cause-effect-flow': 4,
  'isometric-system-diagram': 3,
  'reality-vs-dream': 2,
  'body-vs-avatar': 2,
  'source-branch': 2,
  'final-summary': 3
}

export type PresentationMode = 'overlay' | 'presenter-overlay' | 'full-frame'
export const PRESENTATION_MODE_VALUES: PresentationMode[] = ['overlay', 'presenter-overlay', 'full-frame']
export const PRESENTATION_MODE_LABELS: Record<PresentationMode, string> = {
  overlay: 'Overlay',
  'presenter-overlay': 'Presenter Overlay',
  'full-frame': 'Full Frame'
}

/** Each cinematic template's mode when the scene hasn't explicitly overridden
 * it. Templates absent from this map default to plain 'overlay' (the
 * original 10 templates' historical behavior). */
export const TEMPLATE_DEFAULT_PRESENTATION_MODE: Partial<Record<TemplateId, PresentationMode>> = {
  'tech-title-scene': 'full-frame',
  'device-compatibility-lineup': 'full-frame',
  'three-step-presenter-plan': 'presenter-overlay',
  'social-channel-card': 'presenter-overlay',
  'cause-effect-flow': 'full-frame',
  'security-login-flow': 'full-frame',
  'vault-break-in-animation': 'full-frame',
  'animated-break-in-vault-diagram': 'full-frame',
  'data-center-cyber-intrusion': 'full-frame',
  'hospital-emergency-response': 'full-frame',
  // Central Character Identity and Chapter Evidence default to a compact
  // overlay -- the spec explicitly warns against making every connected
  // scene full-screen ("use a rhythm of full diagrams, compact overlays,
  // character cards... evidence callouts"). The four true diagram families
  // default full-frame since they need the whole canvas to show a
  // split/branch/comparison composition clearly.
  'central-identity': 'overlay',
  'reality-vs-dream': 'full-frame',
  'body-vs-avatar': 'full-frame',
  'source-branch': 'full-frame',
  'chapter-evidence': 'overlay',
  'final-summary': 'full-frame'
}

/** The mode that actually governs rendering/selection for a scene: its own
 * explicit override if set, else the template's default, else plain overlay. */
export function getEffectivePresentationMode(templateId: TemplateId, presentationMode?: PresentationMode): PresentationMode {
  return presentationMode ?? TEMPLATE_DEFAULT_PRESENTATION_MODE[templateId] ?? 'overlay'
}

/** Which presentation modes a template can meaningfully render in. Used when
 * switching a scene's template: an explicit mode override only survives the
 * switch if the destination template actually supports it (see
 * renderer/src/scenes/templateSwitch.ts) -- otherwise the destination's own
 * default takes over, which is what fixes "replacing Device Compatibility
 * Lineup (full-frame) with Three-Step Presenter Plan kept Full Frame". */
export const TEMPLATE_SUPPORTED_PRESENTATION_MODES: Partial<Record<TemplateId, PresentationMode[]>> = {
  'tech-title-scene': ['full-frame', 'overlay'],
  'device-compatibility-lineup': ['full-frame', 'overlay'],
  'three-step-presenter-plan': ['presenter-overlay', 'overlay'],
  'social-channel-card': ['presenter-overlay', 'overlay'],
  'cause-effect-flow': ['full-frame', 'overlay'],
  'security-login-flow': ['full-frame', 'overlay'],
  'vault-break-in-animation': ['full-frame', 'overlay'],
  'animated-break-in-vault-diagram': ['full-frame', 'overlay'],
  'data-center-cyber-intrusion': ['full-frame', 'overlay'],
  'hospital-emergency-response': ['full-frame', 'overlay'],
  'central-identity': ['overlay', 'full-frame'],
  'reality-vs-dream': ['full-frame', 'overlay'],
  'body-vs-avatar': ['full-frame', 'overlay'],
  'source-branch': ['full-frame', 'overlay'],
  'chapter-evidence': ['overlay', 'full-frame'],
  'final-summary': ['full-frame', 'overlay']
}

export function getSupportedPresentationModes(templateId: TemplateId): PresentationMode[] {
  return TEMPLATE_SUPPORTED_PRESENTATION_MODES[templateId] ?? ['overlay']
}

/** Independent transform for a full-frame template's EDITABLE FOREGROUND
 * content group (title text, device lineup, cards -- whatever the template
 * composes), kept separate from the background layer. Lets a full-frame
 * scene's background still cover the whole canvas while its foreground stays
 * selectable/movable/resizable with 8 handles, same as an overlay scene's
 * `ScenePosition`. All percentages are normalized against the logical design
 * canvas (see CANVAS_SIZE_BY_ASPECT), never Preview window pixels.
 *
 * xPercent/yPercent are the box's normalized CENTER, not its top-left corner
 * -- this is the one coordinate contract used everywhere a content box is
 * rendered, dragged, resized, reflowed, or persisted (see
 * renderer/src/scenes/contentTransformMath.ts's contentTransformToBounds /
 * boundsToContentTransform / clampContentTransform). Projects saved before
 * this contract was center-based are migrated on load (schemaVersion 1 -> 2,
 * see app/main/project/projectStore.ts) -- never silently reinterpreted. */
export interface SceneContentTransform {
  /** Normalized center X, 0-100. */
  xPercent: number
  /** Normalized center Y, 0-100. */
  yPercent: number
  widthPercent: number
  heightPercent: number
  /** Degrees. Optional -- most compositions never rotate. */
  rotation: number
  /** When true, corner-handle resizes preserve the box's current aspect
   * ratio; edge handles always resize a single axis regardless. */
  lockAspectRatio: boolean
}

/** Background paint behind a scene's foreground content. Defaults to
 * `transparent` -- "Full Frame" describes the available coordinate canvas a
 * template's foreground can be positioned within, not an instruction to
 * paint over the source video. The underlying `<video>` stays visible unless
 * the user deliberately picks Dim Video / Gradient Overlay / Solid. */
export type SceneBackgroundMode = 'transparent' | 'dim-video' | 'gradient-overlay' | 'solid'
export const SCENE_BACKGROUND_MODE_VALUES: SceneBackgroundMode[] = ['transparent', 'dim-video', 'gradient-overlay', 'solid']
export const SCENE_BACKGROUND_MODE_LABELS: Record<SceneBackgroundMode, string> = {
  transparent: 'Transparent',
  'dim-video': 'Dim Video',
  'gradient-overlay': 'Gradient Overlay',
  solid: 'Solid'
}

/** Background treatment for scenes that declare the 'background' content
 * slot. Undefined uses the template's own default (transparent for most
 * cinematic templates; Tech Title Scene defaults to a gradient overlay so
 * its title stays readable, but transparent remains selectable there too). */
export interface SceneBackground {
  mode?: SceneBackgroundMode
  /** Fill/glow color for gradient-overlay and solid modes. */
  glowColor?: string
  /** 0-100. Opacity of the chosen mode's paint -- 0 always shows the video
   * untouched regardless of mode; 100 is the mode's full strength (opaque
   * for Solid). */
  intensity?: number
}

/** Up to 3 templates per purpose, most-recommended first. A newly-created
 * scene uses index 0 as its default template; the Properties panel offers
 * all 3 as one-click alternatives (the user can still pick any template). */
export const TEMPLATE_RECOMMENDATIONS: Record<CommunicationPurpose, TemplateId[]> = {
  introduction: ['title-card', 'tech-title-scene', 'person-card', 'central-identity'],
  person: ['person-card', 'lower-third', 'social-channel-card', 'central-identity'],
  organization: ['person-card', 'social-channel-card', 'lower-third'],
  place: ['lower-third', 'title-card', 'keyword-highlight'],
  question: ['lower-third', 'keyword-highlight', 'title-card'],
  answer: ['lower-third', 'keyword-highlight', 'statistic-callout'],
  cause: ['cause-effect-flow', 'animated-break-in-vault-diagram', 'lower-third', 'statistic-callout', 'source-branch'],
  effect: ['cause-effect-flow', 'animated-break-in-vault-diagram', 'lower-third', 'statistic-callout', 'source-branch'],
  device: ['device-compatibility-lineup', 'isometric-system-diagram', 'lower-third'],
  product: ['device-compatibility-lineup', 'feature-benefits-pills', 'lower-third'],

  main_claim: ['keyword-highlight', 'feature-benefits-pills', 'statistic-callout'],
  conclusion: ['keyword-highlight', 'feature-benefits-pills', 'statistic-callout', 'final-summary', 'chapter-evidence'],
  call_to_action: ['social-channel-card', 'keyword-highlight', 'statistic-callout'],
  solution: ['cause-effect-flow', 'vault-break-in-animation', 'hospital-emergency-response', 'statistic-callout', 'checklist'],
  date: ['statistic-callout', 'lower-third', 'title-card'],
  money: ['statistic-callout', 'percentage-card', 'keyword-highlight'],
  statistics: ['statistic-callout', 'percentage-card', 'keyword-highlight'],

  sequence_of_steps: [
    'three-step-presenter-plan',
    'vault-break-in-animation',
    'animated-break-in-vault-diagram',
    'security-login-flow',
    'numbered-steps',
    'hospital-emergency-response'
  ],
  list: ['feature-benefits-pills', 'checklist', 'numbered-steps'],

  comparison: ['comparison', 'cause-effect-flow', 'checklist', 'body-vs-avatar', 'reality-vs-dream'],

  warning: ['warning-alert', 'vault-break-in-animation', 'animated-break-in-vault-diagram', 'security-login-flow', 'tech-title-scene', 'data-center-cyber-intrusion'],
  problem: ['warning-alert', 'vault-break-in-animation', 'cause-effect-flow', 'tech-title-scene', 'data-center-cyber-intrusion'],
  cybersecurity_event: [
    'security-login-flow',
    'vault-break-in-animation',
    'animated-break-in-vault-diagram',
    'warning-alert',
    'tech-title-scene',
    'data-center-cyber-intrusion'
  ]
}

export const DEFAULT_TEMPLATE_FOR_PURPOSE: Record<CommunicationPurpose, TemplateId> = Object.fromEntries(
  Object.entries(TEMPLATE_RECOMMENDATIONS).map(([purpose, ids]) => [purpose, ids[0]])
) as Record<CommunicationPurpose, TemplateId>

/** Coordinated internal-element motion presets (see renderer/src/templates/motion.ts)
 * -- distinct from the older per-scene `animationPreset` (which only ever
 * moved the whole template container). Undefined uses each template's own
 * default preset. */
export type MotionPreset = 'none' | 'gentle' | 'dynamic' | 'technical' | 'cinematic'
export const MOTION_PRESET_VALUES: MotionPreset[] = ['none', 'gentle', 'dynamic', 'technical', 'cinematic']
export const MOTION_PRESET_LABELS: Record<MotionPreset, string> = {
  none: 'None',
  gentle: 'Gentle',
  dynamic: 'Dynamic',
  technical: 'Technical',
  cinematic: 'Cinematic'
}

/** Explicit on-canvas placement, in percent of the preview canvas. Undefined
 * means "use the template's own default anchored layout" -- so existing
 * scenes created before this field existed keep rendering exactly as before. */
export interface ScenePosition {
  xPct: number
  yPct: number
  widthPct: number
  heightPct: number
}

/** Reference canvas size used only to show human-friendly pixel numbers in
 * the Properties panel (e.g. "1260 x 360"); actual rendering always uses the
 * percentages above, so it stays correct regardless of preview window size. */
export const CANVAS_SIZE_BY_ASPECT: Record<'16:9' | '9:16' | '1:1', { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 }
}

export type AnimationPreset = 'fade' | 'slide-up' | 'slide-down' | 'scale-in' | 'pop'

export const ANIMATION_PRESET_VALUES: AnimationPreset[] = ['fade', 'slide-up', 'slide-down', 'scale-in', 'pop']

export const ANIMATION_PRESET_LABELS: Record<AnimationPreset, string> = {
  fade: 'Fade',
  'slide-up': 'Slide Up',
  'slide-down': 'Slide Down',
  'scale-in': 'Scale In',
  pop: 'Pop'
}

export type AnimationEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

export const ANIMATION_EASING_VALUES: AnimationEasing[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out']

export const ANIMATION_EASING_LABELS: Record<AnimationEasing, string> = {
  linear: 'Linear',
  'ease-in': 'Ease In',
  'ease-out': 'Ease Out',
  'ease-in-out': 'Ease In Out'
}

export type FontWeight = 'normal' | 'semibold' | 'bold'
export const FONT_WEIGHT_VALUES: FontWeight[] = ['normal', 'semibold', 'bold']
export const FONT_WEIGHT_LABELS: Record<FontWeight, string> = { normal: 'Regular', semibold: 'Semi Bold', bold: 'Bold' }

export type TextAlign = 'left' | 'center' | 'right'

/** Icon id type lives here (not in the renderer icon file) so the shared
 * `Scene`/`SceneContentItem` types can reference it without the shared
 * package importing from renderer. `renderer/src/templates/templateIcons.tsx`
 * owns the actual SVG components and imports this type back. */
export type TemplateIconId =
  | 'warning'
  | 'security'
  | 'bank'
  | 'money'
  | 'device'
  | 'location'
  | 'person'
  | 'statistics'
  | 'check'
  | 'question'
  | 'arrow'
  | 'social'
  | 'message'
  | 'calendar'
  | 'briefcase'
  | 'chip'

export const TEMPLATE_ICON_IDS: TemplateIconId[] = [
  'warning',
  'security',
  'bank',
  'money',
  'device',
  'location',
  'person',
  'statistics',
  'check',
  'question',
  'arrow',
  'social',
  'message',
  'calendar',
  'briefcase',
  'chip'
]

export type TemplateIconCategory =
  | 'warning'
  | 'security'
  | 'bank'
  | 'money'
  | 'device'
  | 'location'
  | 'person'
  | 'statistics'
  | 'check'
  | 'question'
  | 'arrow'
  | 'social'
  | 'communication'
  | 'date-time'
  | 'business'
  | 'technology'

export const TEMPLATE_ICON_CATEGORY_LABELS: Record<TemplateIconCategory, string> = {
  warning: 'Warning',
  security: 'Security',
  bank: 'Bank',
  money: 'Money',
  device: 'Device',
  location: 'Location',
  person: 'Person',
  statistics: 'Statistics',
  check: 'Check',
  question: 'Question',
  arrow: 'Arrow',
  social: 'Social',
  communication: 'Communication',
  'date-time': 'Date / Time',
  business: 'Business',
  technology: 'Technology'
}

/** Every icon belongs to exactly one category; category == icon id for the
 * original 12 (each was already its own category), and the 4 new icons each
 * introduce a new category. */
export const TEMPLATE_ICON_CATEGORY: Record<TemplateIconId, TemplateIconCategory> = {
  warning: 'warning',
  security: 'security',
  bank: 'bank',
  money: 'money',
  device: 'device',
  location: 'location',
  person: 'person',
  statistics: 'statistics',
  check: 'check',
  question: 'question',
  arrow: 'arrow',
  social: 'social',
  message: 'communication',
  calendar: 'date-time',
  briefcase: 'business',
  chip: 'technology'
}

/** How (if at all) a template accepts icon configuration. The Properties
 * panel uses this to show only the icon controls a template actually
 * supports instead of a generic icon editor on every template. */
export type IconSupportLevel = 'none' | 'single' | 'per-item' | 'avatar'

/** Editable per-instance icon styling, attached to a Scene (single/avatar
 * slot) or reused by SceneContentItem (per-item, id only -- kept lightweight
 * since a full per-item style override wasn't requested). */
export interface SceneIcon {
  iconId?: TemplateIconId
  color?: string
  /** Icon glyph size in px at the reference canvas resolution. */
  size?: number
  /** 0-100. */
  opacity?: number
  hAlign?: 'left' | 'center' | 'right'
  vAlign?: 'top' | 'center' | 'bottom'
  backgroundShape?: 'none' | 'circle' | 'square'
  backgroundColor?: string
  backgroundRadius?: number
  /** Degrees. */
  rotation?: number
}

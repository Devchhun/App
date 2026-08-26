// Central template registry -- the single place every built-in template is
// registered. GraphicsOverlay, the Template Library, thumbnails, and the
// Properties panel's template picker all read from this instead of each
// keeping their own switch/list, so adding a template means editing one file.
import {
  TEMPLATE_IDS,
  TEMPLATE_LABELS,
  TEMPLATE_DESCRIPTIONS,
  TEMPLATE_CATEGORY,
  TEMPLATE_CATEGORY_LABELS,
  TEMPLATE_RECOMMENDATIONS
} from '@shared/templates'
import type { TemplateId, TemplateCategory } from '@shared/templates'
import type { CommunicationPurpose } from '@shared/suggestions'
import type { TemplateProps } from './templateShared'
import { LowerThird } from './LowerThird'
import { StatisticCallout } from './StatisticCallout'
import { NumberedSteps } from './NumberedSteps'
import { Comparison } from './Comparison'
import { WarningAlert } from './WarningAlert'
import { TitleCard } from './TitleCard'
import { KeywordHighlight } from './KeywordHighlight'
import { PercentageCard } from './PercentageCard'
import { PersonCard } from './PersonCard'
import { Checklist } from './Checklist'
import { TechTitleScene } from './TechTitleScene'
import { ThreeStepPresenterPlan } from './ThreeStepPresenterPlan'
import { DeviceCompatibilityLineup } from './DeviceCompatibilityLineup'
import { SocialChannelCard } from './SocialChannelCard'
import { SecurityLoginFlow } from './SecurityLoginFlow'
import { FeatureBenefitsPills } from './FeatureBenefitsPills'
import { CauseEffectFlow } from './CauseEffectFlow'
import { IsometricSystemDiagram } from './IsometricSystemDiagram'
import { VaultBreakInAnimation } from './VaultBreakInAnimation'
import { AnimatedBreakInVaultDiagram } from './AnimatedBreakInVaultDiagram'
import { DataCenterCyberIntrusion } from './DataCenterCyberIntrusion'
import { HospitalEmergencyResponse } from './HospitalEmergencyResponse'
import { CentralCharacterIdentity } from './CentralCharacterIdentity'
import { RealityVsDaoDream } from './RealityVsDaoDream'
import { BodyVsAvatar } from './BodyVsAvatar'
import { SourceBranchDiagram } from './SourceBranchDiagram'
import { ChapterEvidenceCard } from './ChapterEvidenceCard'
import { FinalSummaryNodes } from './FinalSummaryNodes'

export interface TemplateDefinition {
  id: TemplateId
  name: string
  description: string
  category: TemplateCategory
  supportedPurposes: CommunicationPurpose[]
  component: (props: TemplateProps) => JSX.Element
  tags: string[]
}

function purposesFor(id: TemplateId): CommunicationPurpose[] {
  return (Object.keys(TEMPLATE_RECOMMENDATIONS) as CommunicationPurpose[]).filter((purpose) => TEMPLATE_RECOMMENDATIONS[purpose].includes(id))
}

const COMPONENTS: Record<TemplateId, (props: TemplateProps) => JSX.Element> = {
  'lower-third': LowerThird,
  'statistic-callout': StatisticCallout,
  'numbered-steps': NumberedSteps,
  comparison: Comparison,
  'warning-alert': WarningAlert,
  'title-card': TitleCard,
  'keyword-highlight': KeywordHighlight,
  'percentage-card': PercentageCard,
  'person-card': PersonCard,
  checklist: Checklist,
  'tech-title-scene': TechTitleScene,
  'three-step-presenter-plan': ThreeStepPresenterPlan,
  'device-compatibility-lineup': DeviceCompatibilityLineup,
  'social-channel-card': SocialChannelCard,
  'security-login-flow': SecurityLoginFlow,
  'feature-benefits-pills': FeatureBenefitsPills,
  'cause-effect-flow': CauseEffectFlow,
  'isometric-system-diagram': IsometricSystemDiagram,
  'vault-break-in-animation': VaultBreakInAnimation,
  'animated-break-in-vault-diagram': AnimatedBreakInVaultDiagram,
  'data-center-cyber-intrusion': DataCenterCyberIntrusion,
  'hospital-emergency-response': HospitalEmergencyResponse,
  'central-identity': CentralCharacterIdentity,
  'reality-vs-dream': RealityVsDaoDream,
  'body-vs-avatar': BodyVsAvatar,
  'source-branch': SourceBranchDiagram,
  'chapter-evidence': ChapterEvidenceCard,
  'final-summary': FinalSummaryNodes
}

const TAGS: Record<TemplateId, string[]> = {
  'lower-third': ['name', 'title', 'caption', 'intro'],
  'statistic-callout': ['number', 'stat', 'claim', 'callout'],
  'numbered-steps': ['steps', 'sequence', 'process', 'numbered'],
  comparison: ['vs', 'compare', 'split'],
  'warning-alert': ['warning', 'alert', 'danger', 'security'],
  'title-card': ['title', 'intro', 'opener', 'section'],
  'keyword-highlight': ['keyword', 'claim', 'big text', 'emphasis'],
  'percentage-card': ['percent', 'stat', 'ring', 'progress'],
  'person-card': ['person', 'profile', 'name', 'role', 'organization'],
  checklist: ['list', 'checklist', 'items', 'checkmarks'],
  'tech-title-scene': ['title', 'tech', 'cyber', 'security', 'telegram', 'hacking', 'chapter', 'intro', 'cinematic'],
  'three-step-presenter-plan': ['steps', 'plan', 'presenter', 'workflow', 'instructions', 'panel', 'overlay'],
  'device-compatibility-lineup': ['devices', 'platforms', 'compatibility', 'ios', 'mac', 'windows', 'android'],
  'social-channel-card': ['social', 'profile', 'channel', 'follow', 'subscribe', 'creator', 'call to action'],
  'security-login-flow': ['security', 'login', 'auth', 'password', 'verification', 'cybersecurity', 'blocked'],
  'feature-benefits-pills': ['benefits', 'features', 'pills', 'claim', 'list'],
  'cause-effect-flow': ['cause', 'effect', 'problem', 'solution', 'flow', 'connector'],
  'isometric-system-diagram': ['isometric', 'diagram', 'system', 'network', 'architecture', 'server'],
  'vault-break-in-animation': ['vault', 'heist', 'break-in', 'security', 'breach', 'laser', 'lock', 'unlock', 'animation', 'story'],
  'animated-break-in-vault-diagram': ['break-in', 'vault', 'security', 'hacker', 'laser', 'isometric', 'bank'],
  'data-center-cyber-intrusion': ['data center', 'server', 'firewall', 'intrusion', 'attack', 'packet', 'cybersecurity', 'isometric', 'breach'],
  'hospital-emergency-response': ['hospital', 'emergency', 'patient', 'doctor', 'nurse', 'scanner', 'treatment', 'recovery', 'medical', 'isometric'],
  'central-identity': ['story', 'narrative', 'character', 'identity', 'avatar', 'central', 'wang lin'],
  'reality-vs-dream': ['story', 'narrative', 'split', 'reality', 'simulation', 'dream', 'compare'],
  'body-vs-avatar': ['story', 'narrative', 'body', 'avatar', 'identity', 'compare', 'connector'],
  'source-branch': ['story', 'narrative', 'source', 'branch', 'relationship', 'connector', 'created from'],
  'chapter-evidence': ['story', 'narrative', 'chapter', 'evidence', 'quote', 'claim', 'citation'],
  'final-summary': ['story', 'narrative', 'summary', 'conclusion', 'nodes', 'connected']
}

export const TEMPLATE_REGISTRY: Record<TemplateId, TemplateDefinition> = Object.fromEntries(
  TEMPLATE_IDS.map((id) => [
    id,
    {
      id,
      name: TEMPLATE_LABELS[id],
      description: TEMPLATE_DESCRIPTIONS[id],
      category: TEMPLATE_CATEGORY[id],
      supportedPurposes: purposesFor(id),
      component: COMPONENTS[id],
      tags: TAGS[id]
    }
  ])
) as Record<TemplateId, TemplateDefinition>

export function getTemplate(id: TemplateId): TemplateDefinition {
  return TEMPLATE_REGISTRY[id]
}

export function listAllTemplates(): TemplateDefinition[] {
  return TEMPLATE_IDS.map((id) => TEMPLATE_REGISTRY[id])
}

export function listTemplatesByCategory(category: TemplateCategory | 'all'): TemplateDefinition[] {
  const all = listAllTemplates()
  return category === 'all' ? all : all.filter((t) => t.category === category)
}

export function listTemplatesByPurpose(purpose: CommunicationPurpose): TemplateDefinition[] {
  return listAllTemplates().filter((t) => t.supportedPurposes.includes(purpose))
}

export function searchTemplates(query: string): TemplateDefinition[] {
  const term = query.trim().toLowerCase()
  if (!term) return listAllTemplates()
  return listAllTemplates().filter(
    (t) => t.name.toLowerCase().includes(term) || t.description.toLowerCase().includes(term) || t.tags.some((tag) => tag.includes(term))
  )
}

export { TEMPLATE_CATEGORY_LABELS }

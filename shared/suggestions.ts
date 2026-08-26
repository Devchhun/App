// Phase E: AI meaning-classification suggestions. Deliberately lighter than
// the full `Scene` type in project.ts (no templateId/brandOverrides) --
// Phase F (rendering/templates) is explicitly out of scope; a suggestion is
// just "here's what this segment means and a shortened visual phrase for
// it," not yet a renderable graphic.

export type CommunicationPurpose =
  | 'introduction'
  | 'main_claim'
  | 'question'
  | 'answer'
  | 'warning'
  | 'problem'
  | 'solution'
  | 'cause'
  | 'effect'
  | 'comparison'
  | 'sequence_of_steps'
  | 'list'
  | 'person'
  | 'organization'
  | 'place'
  | 'date'
  | 'money'
  | 'statistics'
  | 'device'
  | 'product'
  | 'cybersecurity_event'
  | 'call_to_action'
  | 'conclusion'

export const PURPOSE_VALUES: CommunicationPurpose[] = [
  'introduction',
  'main_claim',
  'question',
  'answer',
  'warning',
  'problem',
  'solution',
  'cause',
  'effect',
  'comparison',
  'sequence_of_steps',
  'list',
  'person',
  'organization',
  'place',
  'date',
  'money',
  'statistics',
  'device',
  'product',
  'cybersecurity_event',
  'call_to_action',
  'conclusion'
]

export const PURPOSE_LABELS: Record<CommunicationPurpose, string> = {
  introduction: 'Introduction',
  main_claim: 'Main Claim',
  question: 'Question',
  answer: 'Answer',
  warning: 'Warning',
  problem: 'Problem',
  solution: 'Solution',
  cause: 'Cause',
  effect: 'Effect',
  comparison: 'Comparison',
  sequence_of_steps: 'Steps',
  list: 'List',
  person: 'Person',
  organization: 'Organization',
  place: 'Place',
  date: 'Date',
  money: 'Money',
  statistics: 'Statistics',
  device: 'Device',
  product: 'Product',
  cybersecurity_event: 'Security Event',
  call_to_action: 'Call to Action',
  conclusion: 'Conclusion'
}

export type SuggestionStatus = 'suggested' | 'accepted' | 'rejected'

export interface AiSuggestion {
  id: string
  mediaId: string
  segmentId: string
  startTime: number
  endTime: number
  purpose: CommunicationPurpose
  originalText: string
  visualText: string
  reason: string
  confidence: number
  status: SuggestionStatus
  locked: boolean
  /** True once the user has hand-edited visualText or reason; preserved during bulk regeneration. */
  edited: boolean
  createdAt: string
}

/** Bumped whenever the classification prompt's wording changes meaningfully
 * enough that old cached results should no longer be considered valid. */
export const PROMPT_VERSION = 1
/** Bumped whenever the AiSuggestion shape changes in a way that makes old
 * cached raw results unsafe to reuse without re-validating. */
export const SCHEMA_VERSION = 1

export interface CloudRequestPreview {
  segmentCount: number
  characterCount: number
  textPreview: string
  model: string
}

export type GenerationState = 'idle' | 'generating' | 'success' | 'canceled' | 'rate-limited' | 'error'

export type ClaudeErrorKind = 'auth' | 'rate-limit' | 'network' | 'timeout' | 'malformed' | 'schema' | 'canceled' | 'unknown'

export interface GenerateSuggestionsResult {
  suggestions: AiSuggestion[]
  model: string
  fromCache: boolean
  /** Segment ids the provider was asked about but returned no valid result for. */
  missingSegmentIds: string[]
}

export interface GenerateSuggestionsError {
  kind: ClaudeErrorKind
  message: string
  retryAfterSeconds?: number
}

export const AI_IPC = {
  hasApiKey: 'ai:hasApiKey',
  setApiKey: 'ai:setApiKey',
  clearApiKey: 'ai:clearApiKey',
  previewCloudRequest: 'ai:previewCloudRequest',
  generateSuggestions: 'ai:generateSuggestions',
  cancelRequest: 'ai:cancelRequest',
  regenerateSuggestion: 'ai:regenerateSuggestion',
  simplifySuggestion: 'ai:simplifySuggestion'
} as const

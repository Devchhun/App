// "Translate SRT" -- AI Dubber's own cloud translation step (see this
// feature's own plan). Reuses the SAME Anthropic API key
// (app/main/ai/apiKeyStore.ts's getApiKey/AI_IPC.hasApiKey/setApiKey) and the
// SAME cloud-consent flow (renderer/src/suggestions/CloudConsentModal.tsx,
// shared/suggestions.ts's CloudRequestPreview) every other cloud AI feature
// in this app already uses -- this file only adds the two calls specific to
// translation itself.
import type { ClaudeErrorKind } from './suggestions'

export const TRANSLATION_IPC = {
  previewTranslation: 'translation:preview',
  translateSubtitles: 'translation:translateSubtitles',
  cancelTranslation: 'translation:cancel'
} as const

export interface TranslationResult {
  segmentId: string
  translated: string
}

export interface TranslateSubtitlesResult {
  translations: TranslationResult[]
  /** Segment ids the model's response didn't include a result for -- dropped,
   * never guessed at, same "never trust a stale/missing id" discipline
   * suggestionsService.ts's own buildSuggestions already follows. */
  missingSegmentIds: string[]
}

export interface TranslationError {
  kind: ClaudeErrorKind
  message: string
  retryAfterSeconds?: number
}

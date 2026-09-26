import type { CommunicationPurpose, ClaudeErrorKind, ScriptTransformMode } from '@shared/suggestions'
import type { TranslationResult } from '@shared/translation'

export interface SegmentInput {
  segmentId: string
  text: string
}

export interface ClassificationResult {
  segmentId: string
  purpose: CommunicationPurpose
  visualText: string
  reason: string
  confidence: number
}

export class ProviderError extends Error {
  readonly kind: ClaudeErrorKind
  readonly retryAfterSeconds?: number

  constructor(kind: ClaudeErrorKind, message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Provider-agnostic interface for the classification step. Anthropic is the
 * only concrete implementation for now (see AnthropicProvider.ts); this
 * exists so a second provider could be added later without touching
 * suggestionsService.ts or the IPC layer. */
export interface AiProvider {
  readonly name: string
  readonly model: string
  classifySegments(apiKey: string, segments: SegmentInput[], signal: AbortSignal): Promise<ClassificationResult[]>
  /** Rewrites a single visual phrase to be shorter/simpler while preserving meaning. */
  simplifyText(apiKey: string, text: string, signal: AbortSignal): Promise<string>
  /** Translates every segment's text into `targetLanguage` (a plain English
   * language name, e.g. "Khmer") -- see app/main/ai/translationService.ts. */
  translateSegments(apiKey: string, segments: SegmentInput[], targetLanguage: string, signal: AbortSignal): Promise<TranslationResult[]>
  /** Rewrites or summarizes a whole recap script, in its own language. */
  transformScript(apiKey: string, text: string, mode: ScriptTransformMode, signal: AbortSignal): Promise<string>
}

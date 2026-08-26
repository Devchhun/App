import type { LocalAiHealth, LocalModelInfo, ModelPullProgress, LocalAiErrorKind } from '@shared/localAi'

export class LocalAiProviderError extends Error {
  readonly kind: LocalAiErrorKind

  constructor(kind: LocalAiErrorKind, message: string) {
    super(message)
    this.name = 'LocalAiProviderError'
    this.kind = kind
  }
}

export interface ScenePlanGenerationRequest {
  mediaId: string
  model: string
  systemPrompt: string
  userPrompt: string
  /** JSON Schema object passed as Ollama's grammar-constrained `format`
   * field -- structurally guarantees valid JSON shape at the provider
   * level, on top of (never instead of) shared/localAi.ts's own strict
   * validation once the response comes back. */
  jsonSchema: Record<string, unknown>
  /** Sampling temperature (the "creativity" quality control), 0-1+.
   * Provider-defined default (Ollama: 0, fully deterministic) when omitted. */
  temperature?: number
}

/** Provider-agnostic interface for the local model backend -- Ollama is the
 * only concrete implementation today (see OllamaProvider.ts). This exists so
 * a bundled llama.cpp sidecar can replace it in a later production build
 * without touching localAiService.ts or the IPC layer, mirroring
 * AiProvider.ts's identical role for the cloud (Anthropic) path. The
 * renderer never imports this or knows Ollama exists -- it only ever talks
 * to shared/localAi.ts's LOCAL_AI_IPC surface. */
export interface LocalAiProvider {
  readonly name: string
  checkHealth(): Promise<LocalAiHealth>
  listModels(): Promise<LocalModelInfo[]>
  pullModel(model: string, onProgress: (p: ModelPullProgress) => void, signal: AbortSignal): Promise<void>
  /** Unloads a model from memory without generating anything (Ollama:
   * `keep_alive: 0` with no prompt). Best-effort -- a concurrent generation
   * on the same model can keep it resident regardless. */
  unloadModel(model: string): Promise<void>
  /** Returns the raw, UNVALIDATED JSON the model produced. localAiService.ts
   * is the only caller, and it always runs the result through
   * shared/localAi.ts's validateScenePlan before any of it is trusted --
   * this layer's job is only to get bytes out of the local model, never to
   * decide whether they're safe to act on. */
  generateJson(request: ScenePlanGenerationRequest, signal: AbortSignal): Promise<unknown>
}

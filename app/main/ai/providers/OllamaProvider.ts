import { existsSync } from 'fs'
import { join } from 'path'
import { SCENE_PLAN_LIMITS } from '@shared/localAi'
import type { LocalAiHealth, LocalModelInfo, ModelPullProgress } from '@shared/localAi'
import { LocalAiProviderError, type LocalAiProvider, type ScenePlanGenerationRequest } from './LocalAiProvider'

// 127.0.0.1, never 'localhost' -- on Windows, 'localhost' can resolve IPv6
// first (Ollama binds IPv4 only by default), which is an established source
// of flaky ECONNREFUSED / added latency. Overridable for a user who's moved
// Ollama's OLLAMA_HOST, though the app never prompts for this.
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'
const HEALTH_TIMEOUT_MS = 2_000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/** Ollama silently truncates the prompt to whatever context window is
 * currently loaded (4096 tokens by default) if the request doesn't ask for
 * more -- there is no error, no warning, just quietly dropped transcript
 * content, and past a certain point a model reasoning over a truncated,
 * schema-less-looking tail of its own instructions can degrade into
 * incoherent or runaway generation. Every request must size num_ctx itself
 * rather than trust whatever the model happened to load with.
 *
 * Token count is estimated conservatively from character count: Khmer (and
 * other non-Latin, multi-byte) script tokenizes far worse than English BPE
 * text (measured ~1.1-1.2 tokens/char for real Khmer narration against this
 * app's own prompts, well above the ~0.25 tokens/char a mostly-ASCII prompt
 * would need) -- 1.5 tokens/char stays a safe overestimate rather than risk
 * under-provisioning. `outputHeadroomTokens` covers the structured JSON
 * response itself (up to SCENE_PLAN_LIMITS.maxScenesInPlan scenes). Clamped
 * to a floor (small requests don't need to pay for a huge context) and a
 * ceiling (matches qwen2.5's own advertised max; a request that would need
 * more than this is already rejected upstream by the app's own transcript
 * character-count hard limit before it ever reaches here). */
function estimateContextTokens(systemPrompt: string, userPrompt: string): number {
  const estimatedInputTokens = Math.ceil((systemPrompt.length + userPrompt.length) * 1.5)
  const outputHeadroomTokens = 6_000
  const estimated = estimatedInputTokens + outputHeadroomTokens
  return Math.max(4_096, Math.min(32_768, Math.ceil(estimated / 1024) * 1024))
}

/** Combines the caller's signal with an internal request timeout, and
 * reports which one actually fired -- same pattern as AnthropicProvider.ts's
 * withTimeout, needed to tell "user canceled" apart from "timed out" after
 * the fact (both surface as an aborted fetch). */
function withTimeout(signal: AbortSignal, timeoutMs: number): { combined: AbortSignal; timedOut: () => boolean } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, timeoutSignal])
  return { combined, timedOut: () => timeoutSignal.aborted && !signal.aborted }
}

function mapFetchError(err: unknown, signal: AbortSignal, timedOut: () => boolean): never {
  if (err instanceof Error && err.name === 'AbortError') {
    if (signal.aborted) throw new LocalAiProviderError('canceled', 'Request canceled')
    if (timedOut()) throw new LocalAiProviderError('timeout', 'Request timed out')
    throw new LocalAiProviderError('canceled', 'Request canceled')
  }
  const cause = (err as { cause?: { code?: string } })?.cause
  if (cause?.code === 'ECONNREFUSED') {
    throw new LocalAiProviderError('not-running', 'Ollama is not running on 127.0.0.1:11434.')
  }
  throw new LocalAiProviderError('network', `Could not reach Ollama: ${err instanceof Error ? err.message : String(err)}`)
}

/** %LOCALAPPDATA%\Programs\Ollama\ollama.exe -- the default per-user install
 * path the official Windows installer uses (no admin required). Existence
 * here is the "installed but not currently running" signal; its absence
 * plus a connection refusal means "not installed at all". Purely
 * corroborating evidence for the health check UI, never load-bearing for
 * anything that actually talks to the server. */
function looksInstalledOnWindows(): boolean {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return false
  return existsSync(join(localAppData, 'Programs', 'Ollama', 'ollama.exe'))
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string; size?: number }>
}

interface OllamaPsResponse {
  models?: Array<{ name?: string; model?: string }>
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string }
  done?: boolean
}

export class OllamaProvider implements LocalAiProvider {
  readonly name = 'ollama'
  private readonly baseUrl: string
  private readonly requestTimeoutMs: number

  constructor(baseUrl: string = DEFAULT_BASE_URL, requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.baseUrl = baseUrl
    this.requestTimeoutMs = requestTimeoutMs
  }

  async checkHealth(): Promise<LocalAiHealth> {
    try {
      const response = await fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      if (!response.ok) return { status: 'unknown', providerName: this.name }
      const data = (await response.json().catch(() => null)) as { version?: string } | null
      return { status: 'running', version: data?.version, providerName: this.name }
    } catch {
      const installed = process.platform === 'win32' ? looksInstalledOnWindows() : false
      return { status: installed ? 'installed-not-running' : 'not-installed', providerName: this.name }
    }
  }

  async listModels(): Promise<LocalModelInfo[]> {
    const neverAborted = new AbortController().signal
    let tagsRes: Response
    try {
      tagsRes = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    } catch (err) {
      mapFetchError(err, neverAborted, () => true)
    }
    if (!tagsRes.ok) throw new LocalAiProviderError('unknown', `Ollama /api/tags failed: ${tagsRes.status}`)
    const tags = (await tagsRes.json().catch(() => ({}))) as OllamaTagsResponse

    let loadedNames = new Set<string>()
    try {
      const psRes = await fetch(`${this.baseUrl}/api/ps`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      if (psRes.ok) {
        const ps = (await psRes.json().catch(() => ({}))) as OllamaPsResponse
        loadedNames = new Set((ps.models ?? []).map((m) => m.model ?? m.name ?? '').filter(Boolean))
      }
    } catch {
      // /api/ps is a nice-to-have (loaded state) -- absence of it never blocks listing installed models.
    }

    return (tags.models ?? [])
      .map((m) => m.model ?? m.name)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((id) => ({ id, installed: true, loaded: loadedNames.has(id) }))
  }

  async pullModel(model: string, onProgress: (p: ModelPullProgress) => void, signal: AbortSignal): Promise<void> {
    const { combined, timedOut } = withTimeout(signal, this.requestTimeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
        signal: combined
      })
    } catch (err) {
      mapFetchError(err, signal, timedOut)
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new LocalAiProviderError('unknown', `Ollama pull request failed: ${response.status} ${text.slice(0, 300)}`)
    }

    // Progress is per-digest (a model download has several layers -- weights,
    // template, params, license); summing each digest's own latest
    // completed/total avoids the progress bar visibly resetting partway
    // through, which naive "just use the last line's numbers" would do.
    const perDigest = new Map<string, { completed: number; total: number }>()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const sumProgress = (): { completed: number; total: number } => {
      let completed = 0
      let total = 0
      for (const d of perDigest.values()) {
        completed += d.completed
        total += d.total
      }
      return { completed, total }
    }

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let obj: Record<string, unknown>
          try {
            obj = JSON.parse(line)
          } catch {
            continue // a stray non-JSON line shouldn't abort an otherwise-healthy stream
          }
          if (typeof obj.error === 'string') {
            throw new LocalAiProviderError('unknown', obj.error)
          }
          const digest = typeof obj.digest === 'string' ? obj.digest : null
          if (digest && typeof obj.total === 'number') {
            perDigest.set(digest, { completed: typeof obj.completed === 'number' ? obj.completed : 0, total: obj.total })
          }
          const { completed, total } = sumProgress()
          const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0
          const status = obj.status === 'success' ? 'success' : typeof obj.status === 'string' && obj.status.includes('verify') ? 'verifying' : 'pulling'
          onProgress({ requestId: '', model, percent, completedBytes: completed, totalBytes: total, status, message: typeof obj.status === 'string' ? obj.status : undefined })
        }
      }
    } catch (err) {
      if (err instanceof LocalAiProviderError) throw err
      mapFetchError(err, signal, timedOut)
    }
  }

  async unloadModel(model: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      })
    } catch {
      // Best-effort -- unload is not safety-critical, a failed unload just
      // leaves the model resident until its own keep_alive expires.
    }
  }

  async generateJson(request: ScenePlanGenerationRequest, signal: AbortSignal): Promise<unknown> {
    const { combined, timedOut } = withTimeout(signal, this.requestTimeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          stream: false,
          format: request.jsonSchema,
          options: { temperature: request.temperature ?? 0, num_ctx: estimateContextTokens(request.systemPrompt, request.userPrompt) },
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt }
          ]
        }),
        signal: combined
      })
    } catch (err) {
      mapFetchError(err, signal, timedOut)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 404) throw new LocalAiProviderError('model-not-found', `Model "${request.model}" is not installed.`)
      throw new LocalAiProviderError('unknown', `Ollama chat request failed: ${response.status} ${text.slice(0, 300)}`)
    }

    let data: OllamaChatResponse
    try {
      data = (await response.json()) as OllamaChatResponse
    } catch {
      throw new LocalAiProviderError('malformed', 'Ollama returned a response that was not valid JSON.')
    }

    const content = data.message?.content
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new LocalAiProviderError('malformed', 'Ollama response had no message content.')
    }
    // Bounds worst-case memory for a runaway/looping local model regardless
    // of its own num_predict cap -- rejected before JSON.parse ever sees it.
    if (content.length > SCENE_PLAN_LIMITS.maxOutputChars) {
      throw new LocalAiProviderError('malformed', `Ollama response was too large (${content.length} characters, max ${SCENE_PLAN_LIMITS.maxOutputChars}).`)
    }

    try {
      return JSON.parse(content)
    } catch {
      throw new LocalAiProviderError('malformed', 'Ollama response content was not valid JSON.')
    }
  }
}

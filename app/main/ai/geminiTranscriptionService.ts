import { GoogleGenAI, FileState } from '@google/genai'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ffmpegPath } from '../media/ffmpeg'
import { spawn } from 'child_process'
import { createGemini } from './geminiClient'
import { getGeminiApiKey } from './geminiApiKeyStore'
import type { NarrationSegment } from '@shared/aiEditing'

const MODEL = process.env.GEMINI_TRANSCRIBE_MODEL?.trim() || 'gemini-2.5-flash'

const schema = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', description: 'start time in seconds' },
          end: { type: 'number', description: 'end time in seconds' },
          text: { type: 'string', description: 'the Khmer text spoken in this segment' },
        },
        required: ['start', 'end', 'text'],
      },
    },
  },
  required: ['segments'],
}

const PROMPT = `You are transcribing a Khmer voice-over narration for a video.
Transcribe ONLY the spoken Khmer narration. Ignore background music and sound effects.
Split it into natural sentence- or phrase-sized segments. For each segment give its
start and end time in SECONDS from the beginning of the audio, and the exact Khmer text.
Keep the segments in time order and do not overlap them. Return JSON matching the schema.`

/** Compress the audio to a small mono m4a first — a long WAV is slow to upload
 * and Gemini only needs to hear it. */
async function toUploadableAudio(sourcePath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-tx-'))
  const out = join(dir, 'audio.m4a')
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-y', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k', out], { windowsHide: true })
    let err = ''
    proc.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-1500)))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-2).join('\n') || `ffmpeg exited ${code}`))))
  })
  return out
}

async function waitForFile(ai: GoogleGenAI, name: string, signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new Error('Canceled')
    const file = await ai.files.get({ name })
    if (file.state === FileState.ACTIVE && file.uri) return
    if (file.state === FileState.FAILED) throw new Error(file.error?.message || 'Gemini could not process the audio.')
    await new Promise((r) => setTimeout(r, 1500))
  }
}

/**
 * Transcribe Khmer narration with Gemini (far better on Khmer than the local
 * Whisper models, and no multi-GB model download). Returns timed segments.
 * Throws if no Gemini API key is set.
 */
export async function transcribeKhmerWithGemini(
  sourcePath: string,
  onProgress: (percent: number, message?: string) => void,
  signal?: AbortSignal,
): Promise<NarrationSegment[]> {
  const key = await getGeminiApiKey()
  if (!key) throw new Error('Gemini transcription needs a Gemini API key — add one in Settings → AI API Keys.')
  const ai = createGemini(key)

  onProgress(5, 'Preparing the audio…')
  const audioPath = await toUploadableAudio(sourcePath)
  let remoteName: string | undefined
  try {
    onProgress(20, 'Uploading to Gemini…')
    const uploaded = await ai.files.upload({ file: audioPath, config: { mimeType: 'audio/mp4', abortSignal: signal } })
    remoteName = uploaded.name
    await waitForFile(ai, uploaded.name as string, signal)

    onProgress(55, 'Transcribing the Khmer narration…')
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: uploaded.uri as string, mimeType: uploaded.mimeType || 'audio/mp4' } }, { text: PROMPT }] }],
      config: { temperature: 0.1, responseMimeType: 'application/json', responseJsonSchema: schema, abortSignal: signal },
    })

    const parsed = JSON.parse(response.text ?? '{"segments":[]}') as { segments?: Array<{ start?: number; end?: number; text?: string }> }
    const segments: NarrationSegment[] = (parsed.segments ?? [])
      .map((s, i) => ({
        id: `g${i}`,
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        text: String(s.text ?? '').trim(),
        reviewed: false as const,
      }))
      .filter((n) => n.text.length > 0 && n.end > n.start)
      .sort((a, b) => a.start - b.start)
    onProgress(95)
    return segments
  } finally {
    if (remoteName) await ai.files.delete({ name: remoteName }).catch(() => undefined)
    await rm(join(audioPath, '..'), { recursive: true, force: true }).catch(() => undefined)
  }
}

import { GoogleGenAI, FileState } from '@google/genai'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { ffmpegPath } from '../media/ffmpeg'
import { createGemini } from './geminiClient'
import { getGeminiApiKey } from './geminiApiKeyStore'
import type { NarrationSegment, Seconds } from '@shared/aiEditing'
import type { AutoEditClip, AutoEditPlan } from '@shared/autoEdit'

const MODEL = process.env.GEMINI_EDIT_MODEL?.trim() || 'gemini-2.5-flash'

const schema = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'the narration line id this is for' },
          sourceStart: { type: 'number', description: 'start time in the SOURCE video, seconds' },
          sourceEnd: { type: 'number', description: 'end time in the SOURCE video, seconds' },
        },
        required: ['id', 'sourceStart', 'sourceEnd'],
      },
    },
  },
  required: ['picks'],
}

/** A small, low-fps copy of the source — Gemini only needs to recognise what is
 * on screen, not watch it in HD, and a huge upload is slow and costly. */
async function toUploadableVideo(sourcePath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-plan-'))
  const out = join(dir, 'source.mp4')
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      ['-y', '-i', sourcePath, '-vf', 'scale=426:-2,fps=2', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', out],
      { windowsHide: true },
    )
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
    if (file.state === FileState.FAILED) throw new Error(file.error?.message || 'Gemini could not process the video.')
    await new Promise((r) => setTimeout(r, 1500))
  }
}

/**
 * Semantic auto-edit: Gemini watches the source footage and reads the Khmer
 * narration, then chooses, for each narration line, the SOURCE segment that
 * best matches what the line is talking about. The video then shows the scene
 * the narration is describing, not just whatever came next. Each line keeps its
 * own time on the final timeline (so the cut still follows the narration), and
 * its source window is what Gemini picked, trimmed to the line's length.
 */
export async function planEditWithGemini(
  sourceVideoPath: string,
  narration: NarrationSegment[],
  sourceDuration: Seconds,
  onProgress: (percent: number, message?: string) => void,
  signal?: AbortSignal,
): Promise<AutoEditPlan> {
  const key = await getGeminiApiKey()
  if (!key) throw new Error('Gemini scene matching needs a Gemini API key — add one in Settings → AI API Keys.')
  const ai = createGemini(key)

  onProgress(2, 'Preparing the footage…')
  const videoPath = await toUploadableVideo(sourceVideoPath)
  let remoteName: string | undefined
  try {
    onProgress(25, 'Uploading the footage to Gemini…')
    const uploaded = await ai.files.upload({ file: videoPath, config: { mimeType: 'video/mp4', abortSignal: signal } })
    remoteName = uploaded.name
    await waitForFile(ai, uploaded.name as string, signal)

    onProgress(60, 'Gemini is matching scenes to the narration…')
    const lines = narration.map((n) => `[${n.id}] ${n.text}`).join('\n')
    const prompt = `You are editing a recap video. The attached SOURCE video is the original footage (0 to ${sourceDuration.toFixed(0)} seconds). Below are the Khmer narration lines, each with an id.
For EACH narration line, pick the SOURCE video time range (sourceStart, sourceEnd in seconds, within 0..${sourceDuration.toFixed(0)}) whose picture best matches WHAT THE LINE IS TALKING ABOUT — show the moment the narration describes. Prefer different parts of the footage for different lines; do not return the same range for everything. Keep ranges in increasing source order where the story allows. Return JSON matching the schema, one pick per line id.

NARRATION LINES:
${lines}`

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: uploaded.uri as string, mimeType: uploaded.mimeType || 'video/mp4' } }, { text: prompt }] }],
      config: { temperature: 0.2, responseMimeType: 'application/json', responseJsonSchema: schema, abortSignal: signal },
    })

    const parsed = JSON.parse(response.text ?? '{"picks":[]}') as { picks?: Array<{ id?: string; sourceStart?: number; sourceEnd?: number }> }
    const pickById = new Map<string, { start: number; end: number }>()
    for (const p of parsed.picks ?? []) {
      const start = Math.max(0, Math.min(sourceDuration, Number(p.sourceStart) || 0))
      const end = Math.max(start, Math.min(sourceDuration, Number(p.sourceEnd) || start))
      if (p.id) pickById.set(String(p.id), { start, end })
    }

    // One clip per narration line, placed at the line's time, showing Gemini's
    // chosen source segment (trimmed to the line's length).
    const clips: AutoEditClip[] = []
    for (const line of narration) {
      const pick = pickById.get(line.id)
      if (!pick) continue
      const lineDur = line.end - line.start
      const sourceOut = Math.min(pick.end, pick.start + lineDur) > pick.start ? Math.min(pick.end, pick.start + lineDur) : Math.min(sourceDuration, pick.start + lineDur)
      clips.push({
        sourceScene: 0,
        sourceIn: round(pick.start),
        sourceOut: round(sourceOut),
        timelineStart: round(line.start),
        duration: round(lineDur),
        narrationId: line.id,
      })
    }
    onProgress(95)
    const duration = narration.length ? round(Math.max(...narration.map((n) => n.end))) : 0
    return { clips, duration, usedHold: 0 }
  } finally {
    if (remoteName) await ai.files.delete({ name: remoteName }).catch(() => undefined)
    await rm(join(videoPath, '..'), { recursive: true, force: true }).catch(() => undefined)
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

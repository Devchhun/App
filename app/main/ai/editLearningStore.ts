import { app } from 'electron'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { EditPair, TrainingProject, TrainingProjectSummary } from '@shared/aiEditing'

/**
 * Where the "Learn My Editing Style" projects live: one JSON file per project
 * in userData/ai-editing/, plus a per-project folder for bulky bits
 * (thumbnails, embedding side-files) that must never bloat the JSON. The
 * source and edited videos are referenced by path and never copied.
 */

const DIR_NAME = 'ai-editing'
const MAX_PAIRS = 100

function rootDir(): string {
  return join(app.getPath('userData'), DIR_NAME)
}
function projectPath(id: string): string {
  return join(rootDir(), `${id}.json`)
}
/** A folder for a project's thumbnails / embedding side-files. */
export function projectAssetsDir(id: string): string {
  return join(rootDir(), id)
}

const text = (value: unknown, max = 200): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** Keeps only well-formed data — the file may be old or half-written. Pure. */
export function sanitizeProject(raw: unknown): TrainingProject | null {
  const p = (raw ?? {}) as Record<string, unknown>
  const id = text(p.id, 80)
  if (!id) return null
  const pairs: EditPair[] = (Array.isArray(p.pairs) ? p.pairs : []).slice(0, MAX_PAIRS).flatMap((item) => {
    const pair = (item ?? {}) as Record<string, unknown>
    const pairId = text(pair.id, 80)
    const original = text(pair.originalMediaPath, 1000)
    const edited = text(pair.editedMediaPath, 1000)
    if (!pairId || !original || !edited) return []
    const status = ['new', 'analyzing', 'analyzed', 'needs-review', 'ready', 'error'].includes(pair.status as string)
      ? (pair.status as EditPair['status'])
      : 'new'
    // The heavy analysis arrays are trusted as-is when present (written by us).
    return [{
      id: pairId,
      name: text(pair.name, 200) || 'Pair',
      originalMediaPath: original,
      editedMediaPath: edited,
      narrationAudioPath: text(pair.narrationAudioPath, 1000) || undefined,
      scriptPath: text(pair.scriptPath, 1000) || undefined,
      addedAt: num(pair.addedAt) || Date.now(),
      status: status === 'analyzing' ? 'new' : status, // never resume "analyzing" across restarts
      error: text(pair.error, 500) || undefined,
      sourceShots: Array.isArray(pair.sourceShots) ? (pair.sourceShots as EditPair['sourceShots']) : undefined,
      editedShots: Array.isArray(pair.editedShots) ? (pair.editedShots as EditPair['editedShots']) : undefined,
      matches: Array.isArray(pair.matches) ? (pair.matches as EditPair['matches']) : undefined,
      narration: Array.isArray(pair.narration) ? (pair.narration as EditPair['narration']) : undefined,
      samples: Array.isArray(pair.samples) ? (pair.samples as EditPair['samples']) : undefined,
      originalDuration: num(pair.originalDuration) || undefined,
      editedDuration: num(pair.editedDuration) || undefined,
    }]
  })
  return {
    id,
    name: text(p.name, 200) || 'Untitled',
    createdAt: num(p.createdAt) || Date.now(),
    updatedAt: num(p.updatedAt) || Date.now(),
    pairs,
    modelIds: (Array.isArray(p.modelIds) ? p.modelIds : []).map((m) => text(m, 80)).filter(Boolean),
    notes: text(p.notes, 2000) || undefined,
  }
}

export async function loadProject(id: string): Promise<TrainingProject | null> {
  try {
    return sanitizeProject(JSON.parse(await readFile(projectPath(id), 'utf8')))
  } catch {
    return null
  }
}

/** Written to a temp file then renamed, so a crash mid-write never corrupts it. */
export async function saveProject(project: TrainingProject): Promise<TrainingProject> {
  const clean = sanitizeProject(project)
  if (!clean) throw new Error('A training project needs an id.')
  clean.updatedAt = Date.now()
  await mkdir(rootDir(), { recursive: true })
  const tmp = `${projectPath(clean.id)}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(clean), 'utf8')
  await rename(tmp, projectPath(clean.id))
  return clean
}

export async function listProjects(): Promise<TrainingProjectSummary[]> {
  if (!existsSync(rootDir())) return []
  const files = (await readdir(rootDir())).filter((f) => f.endsWith('.json'))
  const out: TrainingProjectSummary[] = []
  for (const file of files) {
    const project = await loadProject(file.replace(/\.json$/, ''))
    if (!project) continue
    out.push({
      id: project.id,
      name: project.name,
      pairCount: project.pairs.length,
      analyzedCount: project.pairs.filter((p) => p.status === 'analyzed' || p.status === 'ready' || p.status === 'needs-review').length,
      sampleCount: project.pairs.reduce((sum, p) => sum + (p.samples?.length ?? 0), 0),
      updatedAt: project.updatedAt,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteProject(id: string): Promise<void> {
  await rm(projectPath(id), { force: true }).catch(() => undefined)
  await rm(projectAssetsDir(id), { recursive: true, force: true }).catch(() => undefined)
}

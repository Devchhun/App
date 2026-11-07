import { app, safeStorage } from 'electron'
import { join } from 'path'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { geminiKeyPool, isRefusedKeyError, maskGeminiKey, mergeGeminiKeys, parseGeminiKeys, probeGeminiKeys, type GeminiRouterSnapshot } from '@shared/geminiKeyPool'

function keyFilePath(): string {
  return join(app.getPath('userData'), 'gemini-key.enc')
}

export async function hasGeminiApiKey(): Promise<boolean> {
  if (process.env.GEMINI_API_KEY?.trim()) return true
  try {
    await readFile(keyFilePath())
    return true
  } catch {
    return false
  }
}

/** Every saved key, one per line in the encrypted file (a file from before
 * there could be several is a list of one). GEMINI_API_KEY replaces them. */
async function readKeys(): Promise<string[]> {
  const environment = process.env.GEMINI_API_KEY?.trim()
  if (environment) return parseGeminiKeys(environment)
  try {
    if (!safeStorage.isEncryptionAvailable()) return []
    return parseGeminiKeys(safeStorage.decryptString(await readFile(keyFilePath())))
  } catch {
    return []
  }
}

/** The key to start with. Every service gets its key here, so this also tells
 * the client (geminiClient.ts) about the others it can move on to. */
export async function getGeminiApiKey(): Promise<string | null> {
  const keys = await readKeys()
  geminiKeyPool.setKeys(keys)
  return keys[0] ?? null
}

/** Adds the keys in `text` to those already saved; returns how many there are now. */
export async function setGeminiApiKey(text: string): Promise<number> {
  const added = parseGeminiKeys(text)
  if (added.length === 0) throw new Error('Enter a valid Gemini API key.')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS-level secure storage is not available on this machine.')
  const keys = mergeGeminiKeys(added, await readSavedKeys())
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(keyFilePath(), safeStorage.encryptString(keys.join('\n')))
  geminiKeyPool.setKeys(keys)
  return keys.length
}

/** Only the file: a key from the environment is not saved along with them. */
async function readSavedKeys(): Promise<string[]> {
  try {
    return parseGeminiKeys(safeStorage.decryptString(await readFile(keyFilePath())))
  } catch {
    return []
  }
}

export async function clearGeminiApiKey(): Promise<void> {
  await unlink(keyFilePath()).catch(() => undefined)
  geminiKeyPool.setKeys(await readKeys())
}

/** For the Router screen: holds no key. */
export async function geminiRouterStatus(): Promise<GeminiRouterSnapshot> {
  if (geminiKeyPool.size === 0) await getGeminiApiKey()
  return geminiKeyPool.snapshot()
}

/** Asks every key for one word: the only way to see a project with no free tier. */
export async function testGeminiRouterKeys(): Promise<GeminiRouterSnapshot> {
  await getGeminiApiKey()
  await probeGeminiKeys(geminiKeyPool, 'https://generativelanguage.googleapis.com')
  return geminiKeyPool.snapshot()
}

export interface GeminiKeyCheck {
  /** Never the whole key. */
  mask: string
  state: 'ok' | 'refused' | 'unknown'
  note: string
}

/** Asks Google about each key: lists one model, which costs no quota. This
 * shows a wrong or expired key; a key whose project has no free tier passes
 * here and is only refused when it is asked to generate. */
export async function checkGeminiApiKeys(): Promise<GeminiKeyCheck[]> {
  const keys = await readKeys()
  return Promise.all(
    keys.map(async (key): Promise<GeminiKeyCheck> => {
      const mask = maskGeminiKey(key)
      try {
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10_000) })
        if (response.ok) return { mask, state: 'ok', note: 'Accepted' }
        const body = await response.text().catch(() => '')
        return isRefusedKeyError(body) || response.status === 401 || response.status === 403 ? { mask, state: 'refused', note: 'Refused by Google' } : { mask, state: 'unknown', note: `Google answered ${response.status}` }
      } catch {
        return { mask, state: 'unknown', note: 'No answer' }
      }
    })
  )
}

import { app, safeStorage } from 'electron'
import { join } from 'path'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'

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

export async function getGeminiApiKey(): Promise<string | null> {
  const environmentKey = process.env.GEMINI_API_KEY?.trim()
  if (environmentKey) return environmentKey
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(await readFile(keyFilePath()))
  } catch {
    return null
  }
}

export async function setGeminiApiKey(key: string): Promise<void> {
  const clean = key.trim()
  if (clean.length < 10) throw new Error('Enter a valid Gemini API key.')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS-level secure storage is not available on this machine.')
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(keyFilePath(), safeStorage.encryptString(clean))
}

export async function clearGeminiApiKey(): Promise<void> {
  await unlink(keyFilePath()).catch(() => undefined)
}

import { app, safeStorage } from 'electron'
import { join } from 'path'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'

/** The KiriTTS API key, encrypted with the OS's secure storage exactly like
 * the Gemini key (geminiApiKeyStore.ts) -- never returned to the UI, never
 * in a project file or a log. KIRI_API_KEY in the environment wins. */
function keyFilePath(): string {
  return join(app.getPath('userData'), 'kiri-key.enc')
}

export async function hasKiriApiKey(): Promise<boolean> {
  if (process.env.KIRI_API_KEY?.trim()) return true
  try {
    await readFile(keyFilePath())
    return true
  } catch {
    return false
  }
}

export async function getKiriApiKey(): Promise<string | null> {
  const environmentKey = process.env.KIRI_API_KEY?.trim()
  if (environmentKey) return environmentKey
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(await readFile(keyFilePath()))
  } catch {
    return null
  }
}

export async function setKiriApiKey(key: string): Promise<void> {
  const clean = key.trim()
  if (clean.length < 10) throw new Error('Enter a valid KiriTTS API key.')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS-level secure storage is not available on this machine.')
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(keyFilePath(), safeStorage.encryptString(clean))
}

export async function clearKiriApiKey(): Promise<void> {
  await unlink(keyFilePath()).catch(() => undefined)
}

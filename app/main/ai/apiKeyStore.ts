import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFile, writeFile, unlink, mkdir } from 'fs/promises'

// The key never touches the project file or any autosave payload -- it's a
// separate, OS-encrypted-at-rest file at the user-install level (safeStorage
// uses the OS keychain/DPAPI, not our own crypto).
function keyFilePath(): string {
  return join(app.getPath('userData'), 'anthropic-key.enc')
}

export async function hasApiKey(): Promise<boolean> {
  try {
    await readFile(keyFilePath())
    return true
  } catch {
    return false
  }
}

export async function getApiKey(): Promise<string | null> {
  try {
    const encrypted = await readFile(keyFilePath())
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}

export async function setApiKey(key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level secure storage is not available on this machine')
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  const encrypted = safeStorage.encryptString(key)
  await writeFile(keyFilePath(), encrypted)
}

export async function clearApiKey(): Promise<void> {
  try {
    await unlink(keyFilePath())
  } catch {
    // already absent
  }
}

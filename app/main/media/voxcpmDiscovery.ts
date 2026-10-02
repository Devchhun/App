import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { join, parse } from 'path'
import { validateVoxCpmInstall } from './voxcpmTts'

/** Finding the portable VoxCPM2 install on its own, so the app works on a
 * new computer without anyone typing a path.
 *
 * The install is ~11.5GB of someone's Downloads folder, and its name varies
 * (VoxCPM2, VoxCPM-main, voxcpm_portable...). Rather than walking the whole
 * disk -- minutes of IO for a folder that is almost always in one of half a
 * dozen places -- this checks a bounded set of likely locations and only
 * descends where the folder NAME says it might be a VoxCPM install. */

/** Anything worth opening: the install itself, or a wrapper folder someone
 * dropped it into (the user's own copy has VoxCPM2 nested inside VoxCPM2). */
export function looksLikeVoxCpmFolder(name: string): boolean {
  return /voxcpm/i.test(name)
}

/** Every path worth validating for one directory and its immediate
 * children: the directory itself (the user may have pointed us straight at
 * the install), plus each VoxCPM-looking child. Pure, so the name-matching
 * and shape rules are testable without touching a disk. */
export function candidateInstallPaths(dir: string, childNames: string[]): string[] {
  return [dir, ...childNames.filter(looksLikeVoxCpmFolder).map((name) => join(dir, name))]
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return [] // missing/denied -- just not a place we can look
  }
}

/** The places a portable install realistically lives, most likely first.
 * Drive roots are included because "unzip it to D:\" is as common as
 * leaving it in Downloads. */
export function searchRoots(): string[] {
  const home = homedir()
  const roots = [
    join(home, 'Downloads'),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    home,
    join(home, 'Downloads', 'Compressed')
  ]
  // Every fixed drive root, derived from the home path's own drive letter
  // upward -- C:\ through H:\ covers essentially every consumer machine
  // without enumerating volumes through a native API.
  const homeDrive = parse(home).root
  const firstLetter = homeDrive.charCodeAt(0)
  for (let code = firstLetter; code <= 'H'.charCodeAt(0); code++) {
    roots.push(`${String.fromCharCode(code)}:\\`)
  }
  return roots
}

/** Every valid install found, in search order (so the first entry is the
 * best guess). A path already known to be good is returned first and
 * without scanning -- the common case on a machine that's already set up.
 *
 * Two levels deep at most: a root's VoxCPM-looking children, and THEIR
 * VoxCPM-looking children. That is what finds `Downloads\VoxCPM2\VoxCPM2`
 * (a real shape on this user's machine) while still never walking an
 * unrelated tree. */
export async function detectVoxCpmInstalls(knownPath?: string): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()

  const consider = (path: string): void => {
    const key = path.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    if (validateVoxCpmInstall(path).ok) found.push(path)
  }

  if (knownPath?.trim()) consider(knownPath.trim())

  const searchUnder = async (root: string): Promise<void> => {
    const children = await listDirectories(root)
    for (const candidate of candidateInstallPaths(root, children)) {
      consider(candidate)
      // One level further, but only under a VoxCPM-looking folder.
      if (candidate !== root) {
        const grandchildren = await listDirectories(candidate)
        for (const nested of candidateInstallPaths(candidate, grandchildren)) consider(nested)
      }
    }
  }

  for (const root of searchRoots()) await searchUnder(root)

  // On a drive root, also one ordinary folder down: installs live in
  // `E:\Donwload\VoxCPM2`, `D:\AI\VoxCPM2`... -- a folder whose own name
  // says nothing about VoxCPM. Only directory listings, and system folders
  // are skipped, so this stays a quick look rather than a disk walk.
  for (const root of searchRoots().filter(isDriveRoot)) {
    for (const child of await listDirectories(root)) {
      if (looksLikeVoxCpmFolder(child) || isSystemFolder(child)) continue // VoxCPM ones were searched above
      await searchUnder(join(root, child))
    }
  }

  return found
}

function isDriveRoot(path: string): boolean {
  return /^[A-Za-z]:\\?$/.test(path)
}

/** Folders on a drive root that never hold a user's portable install. */
export function isSystemFolder(name: string): boolean {
  return /^(\$|windows$|program files|programdata$|system volume information$|recovery$|perflogs$|msocache$|intel$|amd$|nvidia$|drivers$|boot$|config\.msi$|documents and settings$|users$|onedrivetemp$|\.)/i.test(name)
}

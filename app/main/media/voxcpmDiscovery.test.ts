import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() } }))

import { looksLikeVoxCpmFolder, candidateInstallPaths, searchRoots, isSystemFolder } from './voxcpmDiscovery'

describe('looksLikeVoxCpmFolder', () => {
  it('matches the names a portable install actually ships under', () => {
    for (const name of ['VoxCPM2', 'VoxCPM-main', 'voxcpm', 'voxcpm_portable', 'My VoxCPM2 copy']) {
      expect(looksLikeVoxCpmFolder(name)).toBe(true)
    }
  })

  it('ignores everything else, so an unrelated tree is never descended', () => {
    for (const name of ['Downloads', 'Program Files', 'node_modules', 'Videos', 'vox']) {
      expect(looksLikeVoxCpmFolder(name)).toBe(false)
    }
  })
})

describe('candidateInstallPaths', () => {
  it('always includes the directory itself -- the user may have named the install exactly', () => {
    expect(candidateInstallPaths('D:\rigs', [])).toEqual(['D:\rigs'])
  })

  it('adds only the VoxCPM-looking children', () => {
    const paths = candidateInstallPaths('C:\dl', ['VoxCPM2', 'Movies', 'voxcpm-old', 'Games'])
    expect(paths).toEqual(['C:\dl', join('C:\dl', 'VoxCPM2'), join('C:\dl', 'voxcpm-old')])
  })

  it('never returns duplicates for one child', () => {
    const paths = candidateInstallPaths('C:\dl', ['VoxCPM2'])
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('searchRoots', () => {
  const roots = searchRoots()

  it('looks in Downloads before anything else -- where these are nearly always unzipped', () => {
    expect(roots[0].toLowerCase()).toContain('downloads')
  })

  it('covers Desktop and Documents too', () => {
    const joined = roots.join('|').toLowerCase()
    expect(joined).toContain('desktop')
    expect(joined).toContain('documents')
  })

  it('includes drive roots, for an install unzipped straight to a drive', () => {
    expect(roots.some((r) => /^[A-H]:\\$/.test(r))).toBe(true)
  })

  it('stays a short, bounded list rather than a disk walk', () => {
    expect(roots.length).toBeLessThan(20)
  })
})

describe('drive-root search one folder down', () => {
  it('skips system folders but not ordinary ones like a misspelled Downloads', () => {
    for (const name of ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin', 'System Volume Information', 'Recovery', 'Users']) expect(isSystemFolder(name), name).toBe(true)
    for (const name of ['Donwload', 'Downloads', 'AI', 'Tools', 'APP']) expect(isSystemFolder(name), name).toBe(false)
  })
})

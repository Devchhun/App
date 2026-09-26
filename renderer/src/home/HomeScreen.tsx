import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectSummary } from '@shared/project'
import { useProject } from '../project/ProjectContext'
import { useConfirm } from '../ui/ConfirmDialog'
import { useTheme } from '../nav/ThemeContext'
import { WindowControls } from '../nav/Titlebar'
import { SparkleIcon, PlusIcon, TrashIcon, GridViewIcon, ListViewIcon, MenuDotsIcon, SunIcon, MoonIcon, SettingsIcon, VideoTrackIcon } from '../nav/icons'
import { useUiState } from '../nav/UiStateContext'
import { markHomeSeen } from './homeSession'

/** The screen the app opens on: a big "Create project" and every project
 * on this machine, newest edit first -- the CapCut home, in this app's
 * own chrome. Opening a project other than the one already loaded writes
 * it as the project to reopen and reloads the window: every provider
 * hydrates from the startup project at mount (see ProjectContext.tsx),
 * so a reload is the one path that loads a different project completely
 * and cleanly. A pending autosave is flushed first, so the edit that was
 * being made never loses its last three seconds. */

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatEdited(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const minutes = Math.round((Date.now() - then) / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} d ago`
  return new Date(iso).toLocaleDateString()
}

type View = 'projects' | 'trash'
type Layout = 'grid' | 'list'

export function HomeScreen(): JSX.Element {
  const { projectId, switchProject } = useProject()
  const { closeHome, openSettings } = useUiState()
  const { theme, toggleTheme } = useTheme()
  const confirm = useConfirm()
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [trashed, setTrashed] = useState<ProjectSummary[]>([])
  const [view, setView] = useState<View>('projects')
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return localStorage.getItem('cae-home-layout') === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const [search, setSearch] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    const [list, bin] = await Promise.all([window.api.project.list(), window.api.project.listTrash()])
    setProjects(list)
    setTrashed(bin)
  }, [])

  // Also re-read once the startup project has loaded: on a first launch
  // that project is created by ProjectContext a moment after this mounts,
  // and the list fetched before then would not include it.
  useEffect(() => {
    void refresh()
  }, [refresh, projectId])

  useEffect(() => {
    if (renaming) renameInputRef.current?.select()
  }, [renaming])

  // Any click outside a card menu closes it.
  useEffect(() => {
    if (!menuFor) return
    const close = (): void => setMenuFor(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menuFor])

  const chooseLayout = (next: Layout): void => {
    setLayout(next)
    try {
      localStorage.setItem('cae-home-layout', next)
    } catch {
      // Per-viewer convenience only.
    }
  }

  const shown = useMemo(() => {
    const source = view === 'trash' ? trashed : (projects ?? [])
    const q = search.trim().toLowerCase()
    return q ? source.filter((p) => p.name.toLowerCase().includes(q)) : source
  }, [view, projects, trashed, search])

  const openProject = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (id === projectId) {
        markHomeSeen()
        closeHome()
        return
      }
      await switchProject(id)
    } finally {
      setBusy(false)
    }
  }

  const createProject = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await switchProject('new')
    } finally {
      setBusy(false)
    }
  }

  const commitRename = async (): Promise<void> => {
    if (!renaming) return
    const name = renaming.name.trim()
    setRenaming(null)
    if (!name) return
    await window.api.project.rename(renaming.id, name)
    await refresh()
  }

  const trashProject = async (p: ProjectSummary): Promise<void> => {
    const ok = await confirm({
      title: `Move "${p.name}" to Trash?`,
      message: 'The project stays in Trash until you delete it forever, so this can be undone.',
      confirmLabel: 'Move to Trash',
      danger: true
    })
    if (!ok) return
    await window.api.project.trash(p.id)
    await refresh()
  }

  const deleteForever = async (p: ProjectSummary): Promise<void> => {
    const ok = await confirm({
      title: `Delete "${p.name}" forever?`,
      message: 'The project file is removed. Media files on disk are never touched.',
      confirmLabel: 'Delete forever',
      danger: true
    })
    if (!ok) return
    await window.api.project.deleteForever(p.id)
    await refresh()
  }

  const restore = async (p: ProjectSummary): Promise<void> => {
    await window.api.project.restore(p.id)
    await refresh()
  }

  return (
    <div className="home">
      <header className="home-titlebar">
        <span className="titlebar-logo" aria-hidden="true">
          <SparkleIcon size={16} />
        </span>
        <span className="titlebar-name">Creative AI Editor</span>
        <span className="home-titlebar-spacer" />
        <button className="titlebar-icon-button" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleTheme}>
          {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </button>
        <button className="titlebar-icon-button" title="Settings" onClick={() => openSettings()}>
          <SettingsIcon size={16} />
        </button>
        <WindowControls />
      </header>

      <div className="home-body">
        <nav className="home-sidebar">
          <button className={view === 'projects' ? 'home-nav-item home-nav-item-active' : 'home-nav-item'} onClick={() => setView('projects')}>
            <HomeGlyph />
            Home
          </button>
          <button className={view === 'trash' ? 'home-nav-item home-nav-item-active' : 'home-nav-item'} onClick={() => setView('trash')}>
            <TrashIcon size={16} />
            Trash
            {trashed.length > 0 && <span className="home-nav-count">{trashed.length}</span>}
          </button>
          {projectId && (
            <button
              className="home-nav-item home-nav-continue"
              title="Back to the project that is open"
              onClick={() => {
                markHomeSeen()
                closeHome()
              }}
            >
              <VideoTrackIcon size={16} />
              Continue editing
            </button>
          )}
        </nav>

        <main className="home-main editor-scroll">
          {view === 'projects' && (
            <button className="home-create" onClick={() => void createProject()} disabled={busy}>
              <span className="home-create-plus">
                <PlusIcon size={18} />
              </span>
              Create project
            </button>
          )}

          <div className="home-list-head">
            <h2 className="home-list-title">
              {view === 'trash' ? 'Trash' : 'Projects'} <span className="home-list-count">({shown.length})</span>
            </h2>
            <div className="home-list-tools">
              <input className="home-search" type="search" placeholder="Search projects…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <div className="home-layout-switch" role="group" aria-label="Layout">
                <button className={layout === 'grid' ? 'home-layout-button home-layout-button-active' : 'home-layout-button'} title="Grid" onClick={() => chooseLayout('grid')}>
                  <GridViewIcon size={15} />
                </button>
                <button className={layout === 'list' ? 'home-layout-button home-layout-button-active' : 'home-layout-button'} title="List" onClick={() => chooseLayout('list')}>
                  <ListViewIcon size={15} />
                </button>
              </div>
              {view === 'projects' ? (
                <button className="home-tool-button" onClick={() => setView('trash')}>
                  <TrashIcon size={15} />
                  Trash
                </button>
              ) : (
                <button className="home-tool-button" onClick={() => setView('projects')}>
                  Back to projects
                </button>
              )}
            </div>
          </div>

          {projects === null ? (
            <div className="home-empty">Loading projects…</div>
          ) : shown.length === 0 ? (
            <div className="home-empty">
              {view === 'trash' ? 'Trash is empty.' : search ? 'No project matches that search.' : 'No projects yet -- create your first one above.'}
            </div>
          ) : (
            <div className={layout === 'grid' ? 'home-grid' : 'home-rows'}>
              {shown.map((p) => {
                const current = p.id === projectId && view === 'projects'
                const isRenaming = renaming?.id === p.id
                return (
                  <div
                    key={p.id}
                    className={['home-card', current ? 'home-card-current' : '', view === 'trash' ? 'home-card-trashed' : ''].filter(Boolean).join(' ')}
                    role="button"
                    tabIndex={0}
                    title={view === 'trash' ? p.name : `Open ${p.name}`}
                    onClick={() => {
                      if (view === 'projects' && !isRenaming) void openProject(p.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && view === 'projects' && !isRenaming) void openProject(p.id)
                    }}
                  >
                    <div className="home-card-thumb">
                      {p.thumbnailUrl ? <img src={p.thumbnailUrl} alt="" draggable={false} /> : <span className="home-card-thumb-empty" aria-hidden />}
                      {p.durationSeconds > 0 && <span className="home-card-duration">{formatDuration(p.durationSeconds)}</span>}
                      {current && <span className="home-card-open-badge">Open</span>}
                    </div>
                    <div className="home-card-body">
                      {isRenaming ? (
                        <input
                          ref={renameInputRef}
                          className="home-card-rename"
                          value={renaming.name}
                          onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitRename()
                            if (e.key === 'Escape') setRenaming(null)
                          }}
                          onBlur={() => void commitRename()}
                        />
                      ) : (
                        <div className="home-card-name" title={p.name}>
                          {p.name}
                        </div>
                      )}
                      <div className="home-card-meta">
                        {p.clipCount} {p.clipCount === 1 ? 'clip' : 'clips'} · {formatEdited(p.updatedAt)}
                      </div>
                    </div>
                    {view === 'projects' ? (
                      <div className="home-card-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
                        <button
                          className="home-card-menu-button"
                          title="More"
                          onClick={(e) => {
                            e.stopPropagation()
                            setMenuFor(menuFor === p.id ? null : p.id)
                          }}
                        >
                          <MenuDotsIcon size={15} />
                        </button>
                        {menuFor === p.id && (
                          <div className="home-card-menu" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => {
                                setMenuFor(null)
                                setRenaming({ id: p.id, name: p.name })
                              }}
                            >
                              Rename
                            </button>
                            <button
                              className="home-card-menu-danger"
                              onClick={() => {
                                setMenuFor(null)
                                void trashProject(p)
                              }}
                            >
                              Move to Trash
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="home-card-trash-actions" onClick={(e) => e.stopPropagation()}>
                        <button className="home-tool-button" onClick={() => void restore(p)}>
                          Restore
                        </button>
                        <button className="home-tool-button home-tool-button-danger" onClick={() => void deleteForever(p)}>
                          Delete forever
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function HomeGlyph(): JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5 10 3l7 6.5V17a1 1 0 0 1-1 1h-4v-5H8v5H4a1 1 0 0 1-1-1z" />
    </svg>
  )
}

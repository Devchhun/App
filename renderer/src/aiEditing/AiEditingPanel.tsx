import { useCallback, useEffect, useMemo, useState } from 'react'
import { AUTO_EDIT_JOB, type AiEditProgress, type EditPair, type TrainingProject, type TrainingProjectSummary } from '@shared/aiEditing'
import type { AutoEditPlan } from '@shared/autoEdit'
import { learnStyle } from '@shared/editSamples'
import { pairByEpisode } from '@shared/pairMatch'
import { useMedia } from '../media/MediaContext'
import { useSequence } from '../sequence/SequenceContext'
import { buildAutoEditSequence } from './autoEditPlacement'

/** Last path segment, for showing a chosen file's name. */
function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/**
 * AI Editing — "Learn My Editing Style" (right sidebar tab). The user adds
 * pairs of (original video, their finished edit); the app reverse-analyses
 * each pair into matched segments and training samples, so a later phase can
 * imitate the style. This tab is the training workspace: projects, pairs,
 * analysis progress, and what was learned. Auto-editing lives in its own tab
 * (Phase 3). Everything heavy runs in the main process.
 */
export function AiEditingPanel(): JSX.Element {
  const [projects, setProjects] = useState<TrainingProjectSummary[]>([])
  const [current, setCurrent] = useState<TrainingProject | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<Record<string, AiEditProgress>>({})
  // Electron's renderer blocks window.prompt(), so the name is typed inline.
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('My editing style')
  // Auto-edit: the chosen new footage + narration, and the plan we're waiting
  // to drop onto the timeline once their media finishes importing.
  const { items, importPaths } = useMedia()
  const { sequence, restoreSequence } = useSequence()
  // Khmer transcription model — 'small' misses a lot of Khmer, so default to
  // 'medium'. Used for both "Add narration" and auto-edit.
  const [model, setModel] = useState<'small' | 'medium' | 'large-v3' | 'gemini'>('gemini')
  const [autoSource, setAutoSource] = useState('')
  const [autoNarration, setAutoNarration] = useState('')
  const [autoBusy, setAutoBusy] = useState(false)
  const [autoMsg, setAutoMsg] = useState('')
  const [autoPercent, setAutoPercent] = useState(0)
  const [autoResult, setAutoResult] = useState<{ lines: number; scenes: number; clips: number; planDur: number } | null>(null)
  const [pendingPlan, setPendingPlan] = useState<{ plan: AutoEditPlan; source: string; narration: string } | null>(null)

  const refreshList = useCallback(async () => {
    const res = await window.api.aiEditing.listProjects()
    if (res.ok) setProjects(res.data)
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  useEffect(() => {
    return window.api.aiEditing.onProgress((p) => {
      if (p.pairId === AUTO_EDIT_JOB) {
        setAutoPercent(p.percent)
        if (p.message) setAutoMsg(p.message)
      } else setProgress((prev) => ({ ...prev, [p.pairId]: p }))
    })
  }, [])

  const openProject = useCallback(async (id: string) => {
    setError('')
    const res = await window.api.aiEditing.getProject(id)
    if (res.ok) setCurrent(res.data)
    else setError(res.error)
  }, [])

  const createProject = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    const res = await window.api.aiEditing.createProject(name)
    if (res.ok) {
      setCreating(false)
      setNewName('My editing style')
      await refreshList()
      setCurrent(res.data)
    } else setError(res.error)
  }, [newName, refreshList])

  const deleteProject = useCallback(async (id: string) => {
    if (!window.confirm('Delete this training project? The analysis is removed; your video files are untouched.')) return
    await window.api.aiEditing.deleteProject(id)
    if (current?.id === id) setCurrent(null)
    await refreshList()
  }, [current, refreshList])

  const addPair = useCallback(async () => {
    if (!current) return
    setError('')
    const original = await window.api.aiEditing.pickVideo('Choose the ORIGINAL (un-edited) video')
    if (!original) return
    const edited = await window.api.aiEditing.pickVideo('Choose YOUR edited (final) video')
    if (!edited) return
    const res = await window.api.aiEditing.addPair(current.id, original, edited)
    if (res.ok) {
      setCurrent(res.data)
      await refreshList()
    } else setError(res.error)
  }, [current, refreshList])

  const addManyPairs = useCallback(async () => {
    if (!current) return
    setError('')
    const originals = await window.api.aiEditing.pickVideos('Choose the ORIGINAL videos (in order)')
    if (originals.length === 0) return
    const editeds = await window.api.aiEditing.pickVideos('Choose YOUR edited videos — SAME order')
    if (editeds.length === 0) return
    const res = await window.api.aiEditing.addPairs(current.id, originals, editeds)
    if (res.ok) {
      setCurrent(res.data)
      await refreshList()
      if (originals.length !== editeds.length) {
        setError(`You picked ${originals.length} originals and ${editeds.length} edits — only ${Math.min(originals.length, editeds.length)} pairs were made. Pick equal numbers in matching order.`)
      }
    } else setError(res.error)
  }, [current, refreshList])

  const addFolders = useCallback(async () => {
    if (!current) return
    setError('')
    const originals = await window.api.aiEditing.pickVideoFolder('Choose the folder of ORIGINAL videos')
    if (originals.length === 0) return
    const editeds = await window.api.aiEditing.pickVideoFolder('Choose the folder of your EDITED videos')
    if (editeds.length === 0) return
    // Pair by EPISODE number, not file order — the two folders often number
    // things differently (source by episode, recaps by upload order).
    const matched = pairByEpisode(originals, editeds)
    const res = await window.api.aiEditing.addPairs(current.id, matched.originals, matched.editeds)
    if (res.ok) {
      setCurrent(res.data)
      await refreshList()
      setError(
        matched.method === 'episode'
          ? matched.unmatched.length
            ? `Matched ${matched.originals.length} pairs by episode number. ${matched.unmatched.length} original(s) had no matching edit.`
            : ''
          : 'Could not read episode numbers from the names, so pairs were matched in file order — CHECK the pairs below are the same episode.',
      )
    } else setError(res.error)
  }, [current, refreshList])

  const removePair = useCallback(async (pairId: string) => {
    if (!current) return
    const res = await window.api.aiEditing.removePair(current.id, pairId)
    if (res.ok) setCurrent(res.data)
  }, [current])

  const transcribe = useCallback(async (pairId: string) => {
    if (!current) return
    setBusy(true)
    setError('')
    setProgress((prev) => ({ ...prev, [pairId]: { pairId, phase: 'narration', percent: 0, message: 'Listening to the narration…' } }))
    const res = await window.api.aiEditing.transcribeNarration(current.id, pairId, model)
    setBusy(false)
    setProgress((prev) => {
      const next = { ...prev }
      delete next[pairId]
      return next
    })
    if (res.ok) {
      setCurrent(res.data)
      await refreshList()
    } else if (!res.canceled) setError(res.error)
  }, [current, refreshList, model])

  const analyzePair = useCallback(async (pairId: string) => {
    if (!current) return
    setBusy(true)
    setError('')
    setProgress((prev) => ({ ...prev, [pairId]: { pairId, phase: 'decoding', percent: 0 } }))
    const res = await window.api.aiEditing.analyzePair(current.id, pairId)
    setBusy(false)
    setProgress((prev) => {
      const next = { ...prev }
      delete next[pairId]
      return next
    })
    if (res.ok) {
      setCurrent(res.data)
      await refreshList()
    } else if (!res.canceled) setError(res.error)
  }, [current, refreshList])

  const pickAutoSource = useCallback(async () => {
    const p = await window.api.aiEditing.pickVideo('Choose the NEW footage to edit')
    if (p) setAutoSource(p)
  }, [])
  const pickAutoNarration = useCallback(async () => {
    const p = await window.api.aiEditing.pickVideo('Choose the Khmer narration audio')
    if (p) setAutoNarration(p)
  }, [])

  const generateAutoEdit = useCallback(async () => {
    if (!current || !autoSource || !autoNarration) return
    setAutoBusy(true)
    setError('')
    setAutoMsg('Analysing the footage and narration…')
    const res = await window.api.aiEditing.autoEdit(current.id, autoSource, autoNarration, model)
    if (!res.ok) {
      setAutoBusy(false)
      if (!res.canceled) setError(res.error)
      return
    }
    setAutoResult({ lines: res.data.narration.length, scenes: res.data.scenes.length, clips: res.data.plan.clips.length, planDur: res.data.plan.duration })
    if (res.data.plan.clips.length === 0) {
      setAutoBusy(false)
      setError('No timeline could be built — the footage had no scenes, or the narration had no speech.')
      return
    }
    // Bring the media in; the effect below drops the plan on the timeline once
    // both files have finished importing.
    setAutoMsg('Importing the media…')
    setPendingPlan({ plan: res.data.plan, source: autoSource, narration: autoNarration })
    await importPaths([autoSource, autoNarration])
  }, [current, autoSource, autoNarration, importPaths, model])

  // Once the source + narration media are ready, build the editable timeline.
  useEffect(() => {
    if (!pendingPlan) return
    const find = (path: string): typeof items[number] | undefined => items.find((it) => it.originalPath === path)
    const source = find(pendingPlan.source)
    const narration = find(pendingPlan.narration)
    if (!source || !narration) return
    const settled = (s?: { stage: string }): boolean => s?.stage === 'ready' || s?.stage === 'error'
    if (!settled(source) || !settled(narration)) return
    if (source.stage === 'error') {
      setError('The footage could not be imported.')
      setPendingPlan(null)
      setAutoBusy(false)
      return
    }
    const next = buildAutoEditSequence(
      sequence,
      pendingPlan.plan,
      { mediaId: source.id, durationSeconds: source.metadata?.durationSeconds ?? 0 },
      narration.stage === 'error' ? undefined : { mediaId: narration.id, durationSeconds: narration.metadata?.durationSeconds ?? 0 },
    )
    restoreSequence(next)
    setPendingPlan(null)
    setAutoBusy(false)
    setAutoMsg(`✓ Added ${pendingPlan.plan.clips.length} clips to the timeline. Close Settings to see it.`)
  }, [items, pendingPlan, sequence, restoreSequence])

  // Train everything: analyse each un-done pair, then give it Khmer narration.
  const trainAll = useCallback(async () => {
    if (!current) return
    for (const pair of current.pairs) {
      if (pair.status === 'new' || pair.status === 'error') await analyzePair(pair.id)
    }
    // Re-read so we transcribe pairs that just became analysed.
    const fresh = await window.api.aiEditing.getProject(current.id)
    if (fresh.ok && fresh.data) {
      for (const pair of fresh.data.pairs) {
        if (!pair.narration && (pair.status === 'analyzed' || pair.status === 'needs-review' || pair.status === 'ready')) {
          await transcribe(pair.id)
        }
      }
    }
  }, [current, analyzePair, transcribe])

  if (!current) {
    return (
      <div className="ai-editing-panel" style={PANEL}>
        <Header title="Learn My Editing Style" />
        <p style={NOTE}>
          Teach the app how you edit: add a few pairs of an original video and your finished edit of it. It studies which parts of the
          footage you kept, how long you held each scene, and how you paced the cuts — then (next phase) edits new footage the same way.
        </p>
        {creating ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              autoFocus
              style={INPUT}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createProject()
                else if (e.key === 'Escape') setCreating(false)
              }}
              placeholder="Name this editing style"
            />
            <button style={PRIMARY} disabled={!newName.trim()} onClick={() => void createProject()}>Create</button>
            <button style={GHOST} onClick={() => setCreating(false)}>Cancel</button>
          </div>
        ) : (
          <button style={PRIMARY} onClick={() => setCreating(true)}>+ New training project</button>
        )}
        {error && <p style={ERROR}>{error}</p>}
        <div style={{ marginTop: 14 }}>
          {projects.length === 0 && <p style={NOTE}>No training projects yet.</p>}
          {projects.map((p) => (
            <div key={p.id} style={ROW}>
              <button style={LINK} onClick={() => openProject(p.id)}>{p.name}</button>
              <span style={DIM}>{p.pairCount} pairs · {p.sampleCount} samples</span>
              <button style={GHOST} title="Delete" onClick={() => deleteProject(p.id)}>✕</button>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="ai-editing-panel" style={PANEL}>
      <Header title={current.name} onBack={() => setCurrent(null)} />
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <button style={GHOST} onClick={addPair}>+ Add one pair</button>
        <button style={GHOST} onClick={addManyPairs}>+ Add many pairs</button>
        <button style={GHOST} onClick={addFolders}>+ Add 2 folders</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={{ ...PRIMARY, flex: 1 }} disabled={busy || current.pairs.length === 0} onClick={trainAll}>
          {busy ? 'Training…' : '▶ Train all pairs'}
        </button>
        <label style={{ ...DIM, display: 'flex', alignItems: 'center', gap: 6 }}>
          Khmer:
          <select value={model} onChange={(e) => setModel(e.target.value as typeof model)} style={{ ...INPUT, flex: 'unset', padding: '4px 8px' }}>
            <option value="gemini">Gemini (best)</option>
            <option value="medium">Medium</option>
            <option value="small">Small</option>
            <option value="large-v3">Large</option>
          </select>
        </label>
      </div>
      {error && <p style={ERROR}>{error}</p>}

      {current.pairs.some((p) => (p.samples?.length ?? 0) > 0) && (
        <div style={{ ...CARD, borderColor: 'var(--ai)', background: 'var(--ai-soft, rgba(139,66,255,0.06))' }}>
          <strong>Auto-edit new footage with this style</strong>
          <p style={NOTE}>Pick new footage and its Khmer narration; the app arranges an editable timeline in the pacing it learned here.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            <button style={GHOST} onClick={pickAutoSource}>{autoSource ? `▶ ${basename(autoSource)}` : 'Choose new footage'}</button>
            <button style={GHOST} onClick={pickAutoNarration}>{autoNarration ? `🎙 ${basename(autoNarration)}` : 'Choose Khmer narration audio'}</button>
            <label style={{ ...DIM, display: 'flex', alignItems: 'center', gap: 6 }}>
              Khmer accuracy:
              <select value={model} onChange={(e) => setModel(e.target.value as typeof model)} style={{ ...INPUT, flex: 'unset', padding: '4px 8px' }}>
                <option value="gemini">Gemini (cloud — best Khmer)</option>
                <option value="medium">Medium (local, offline)</option>
                <option value="small">Small (local, fast)</option>
                <option value="large-v3">Large (local, best, slow)</option>
              </select>
            </label>
            <button style={PRIMARY} disabled={autoBusy || !autoSource || !autoNarration} onClick={() => void generateAutoEdit()}>
              {autoBusy ? 'Working…' : 'Generate editable timeline'}
            </button>
            {autoBusy && (
              <div>
                <div style={BAR_WRAP}><div style={{ ...BAR, width: `${autoPercent}%` }} /></div>
                <div style={{ ...DIM, marginTop: 4 }}>{autoMsg || 'Working…'} ({autoPercent}%)</div>
              </div>
            )}
            {autoMsg.startsWith('✓') && !autoBusy && <div style={{ color: '#22a06b', fontSize: 12, marginTop: 4 }}>{autoMsg}</div>}
            {autoResult && !autoBusy && (
              <div style={{ ...DIM, fontSize: 12, marginTop: 2 }}>
                Narration lines: <b>{autoResult.lines}</b> · Source scenes: <b>{autoResult.scenes}</b> · Clips placed: <b>{autoResult.clips}</b> · Timeline: <b>{autoResult.planDur.toFixed(0)}s</b>
                {autoResult.lines <= 5 && <div style={{ color: 'var(--warn, #e0a33a)', marginTop: 4 }}>Very few narration lines were heard — the timing may be off. Tell me this number.</div>}
              </div>
            )}
          </div>
        </div>
      )}

      {current.pairs.length === 0 && <p style={NOTE}>Add a pair to begin. The two videos are read in place — nothing is copied.</p>}
      {current.pairs.map((pair) => (
        <PairCard
          key={pair.id}
          pair={pair}
          progress={progress[pair.id]}
          busy={busy}
          onCancel={() => window.api.aiEditing.cancelAnalyze(pair.id)}
          onRemove={() => removePair(pair.id)}
        />
      ))}
    </div>
  )
}

function PairCard({
  pair,
  progress,
  busy,
  onCancel,
  onRemove,
}: {
  pair: EditPair
  progress?: AiEditProgress
  busy: boolean
  onCancel: () => void
  onRemove: () => void
}): JSX.Element {
  const style = useMemo(() => (pair.samples ? learnStyle(pair.samples) : null), [pair.samples])
  const avgConfidence = useMemo(() => {
    if (!pair.matches || pair.matches.length === 0) return 0
    return pair.matches.reduce((s, m) => s + m.confidence, 0) / pair.matches.length
  }, [pair.matches])
  const analyzing = progress && progress.phase !== 'done'

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pair.name}</strong>
        <StatusBadge status={pair.status} />
        <button style={GHOST} title="Remove pair" onClick={onRemove}>✕</button>
      </div>
      <div style={DIM}>▶ {basename(pair.originalMediaPath)}</div>
      <div style={DIM}>✓ {basename(pair.editedMediaPath)}</div>

      {analyzing ? (
        <div style={{ marginTop: 8 }}>
          <div style={BAR_WRAP}><div style={{ ...BAR, width: `${progress?.percent ?? 0}%` }} /></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={DIM}>{progress?.message ?? 'Working…'}</span>
            <button style={LINK} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      ) : !pair.matches ? (
        <div style={{ ...DIM, marginTop: 8 }}>Not trained yet — use “Train all pairs” above.</div>
      ) : null}

      {pair.error && <p style={ERROR}>{pair.error}</p>}

      {pair.matches && !analyzing && (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <div style={STAT}><span style={DIM}>Source shots</span><span>{pair.sourceShots?.length ?? 0}</span></div>
          <div style={STAT}><span style={DIM}>Edited shots</span><span>{pair.editedShots?.length ?? 0}</span></div>
          <div style={STAT}><span style={DIM}>Matched segments</span><span>{pair.matches.length}</span></div>
          <div style={STAT}><span style={DIM}>Match confidence</span><span>{Math.round(avgConfidence * 100)}%</span></div>
          <div style={STAT}><span style={DIM}>Training samples</span><span>{pair.samples?.length ?? 0}</span></div>
          <div style={STAT}><span style={DIM}>Khmer narration lines</span><span>{pair.narration?.length ?? '—'}</span></div>
          {style && (
            <>
              <div style={{ ...DIM, marginTop: 6 }}>Learned style</div>
              <div style={STAT}><span style={DIM}>Typical scene hold</span><span>{style.medianHold.toFixed(1)}s</span></div>
              <div style={STAT}><span style={DIM}>Cuts per minute</span><span>{style.cutsPerMinute.toFixed(0)}</span></div>
              {style.commonSpeeds.length > 0 && (
                <div style={STAT}><span style={DIM}>Speeds used</span><span>{style.commonSpeeds.map((s) => `${s}×`).join(', ')}</span></div>
              )}
            </>
          )}
          {pair.status === 'needs-review' && (
            <p style={{ ...NOTE, color: 'var(--warn, #e0a33a)' }}>Some matches are uncertain — a review/fix step for these comes in the next phase.</p>
          )}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: EditPair['status'] }): JSX.Element {
  const label: Record<EditPair['status'], string> = {
    new: 'Not analyzed',
    analyzing: 'Analyzing…',
    analyzed: 'Analyzed',
    'needs-review': 'Needs review',
    ready: 'Ready',
    error: 'Error',
  }
  const color: Record<EditPair['status'], string> = {
    new: '#8a8f99',
    analyzing: '#3b82f6',
    analyzed: '#22a06b',
    'needs-review': '#c9922b',
    ready: '#22a06b',
    error: '#d13a55',
  }
  return <span style={{ fontSize: 11, color: color[status], border: `1px solid ${color[status]}55`, borderRadius: 6, padding: '1px 6px' }}>{label[status]}</span>
}

function Header({ title, onBack }: { title: string; onBack?: () => void }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
      {onBack && (
        <button style={{ ...GHOST, padding: '6px 10px' }} onClick={onBack} title="All projects">←</button>
      )}
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg, var(--ai), var(--accent))', boxShadow: '0 2px 8px rgba(139,66,255,0.3)', fontSize: 15 }}>✨</span>
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h3>
    </div>
  )
}

const PANEL: React.CSSProperties = { padding: 16, overflowY: 'auto', height: '100%', color: 'var(--text)' }
const NOTE: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }
const DIM: React.CSSProperties = { fontSize: 12, color: 'var(--text-dim)' }
const ERROR: React.CSSProperties = { fontSize: 12.5, color: '#ff6b81', marginTop: 8, background: 'rgba(255,107,129,0.08)', border: '1px solid rgba(255,107,129,0.25)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5 }
const PRIMARY: React.CSSProperties = { background: 'linear-gradient(135deg, var(--ai), var(--accent))', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, boxShadow: '0 2px 10px rgba(139,66,255,0.25)' }
const GHOST: React.CSSProperties = { background: 'var(--surface-elevated)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 9, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }
const LINK: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent-hover)', cursor: 'pointer', fontSize: 13, padding: 0, textAlign: 'left' }
const INPUT: React.CSSProperties = { flex: 1, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }
const ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 8 }
const CARD: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 14, marginBottom: 12 }
const STAT: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid var(--border)' }
const BAR_WRAP: React.CSSProperties = { height: 7, background: 'var(--surface-elevated)', borderRadius: 5, overflow: 'hidden', border: '1px solid var(--border)' }
const BAR: React.CSSProperties = { height: '100%', background: 'linear-gradient(90deg, var(--ai), var(--accent))', transition: 'width .25s', borderRadius: 5 }

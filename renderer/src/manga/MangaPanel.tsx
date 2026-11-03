import { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon, GridViewIcon, MicrophoneIcon, PlusIcon, SparkleIcon, TextToolIcon } from '../nav/icons'
import type { Scene } from '@shared/project'
import { kiriVoiceOf, type KiriVoice } from '@shared/kiriTts'
import { PLAIN_TEXT_POSITION } from '@shared/plainText'
import { MANGA_TRIO_SIZE, sortPanelPaths, type MangaLanguage, type MangaLayout, type MangaProgress, type MangaRequest, type MangaResult } from '@shared/mangaRecap'
import type { MangaEpisode } from '@shared/mangaStrip'
import { useMedia } from '../media/MediaContext'
import { useSequence } from '../sequence/SequenceContext'
import { useScenes } from '../scenes/SceneContext'
import { useBrandPreset } from '../brand/BrandPresetContext'
import { useUiState } from '../nav/UiStateContext'
import { defaultContentForTemplate } from '../templates/defaultContent'
import { ensureTrack, findOrCreateTrack, type OccupiedRange } from '../timeline/trackModel'
import { placeMangaGroups, type PlacedGroup } from './mangaPlacement'
import { useChangeAspectRatio } from '../scenes/useAspectRatioChange'
import { keepChosenAspectRatio } from '../scenes/useAutoAspectRatio'
import { loadStoryNarratorVoiceId } from '../dubbing/savedVoices'
import { useProject } from '../project/ProjectContext'
import { storeRecapScript } from '../aiScript/useRecapNarration'
import { MANGA_SUBTITLE_REASON, mangaScriptFromPassages } from './mangaScript'

/** The AI Manga tab (right sidebar): already-cut manga panels in, and one
 * click puts a narrated story recap on the Timeline -- the panels three side
 * by side (or one at a time), each group on screen for exactly as long as
 * its passage of the recap. The writing and the voice happen in the main
 * process (app/main/manga/mangaRecapService.ts); the placing in
 * mangaPlacement.ts. */

const FORM_KEY = 'cae-ai-manga-form-v1'

interface FormState { voice: string; language: MangaLanguage; notes: string; subtitles: boolean; layout: MangaLayout; layoutPicked?: boolean; grid: 'small' | 'large'; compact: boolean }
const DEFAULT_FORM: FormState = { voice: '', language: 'km', notes: '', subtitles: true, layout: 'single', grid: 'small', compact: false }

/** Subtitles low on the frame and subtitle-sized, like a recap channel's
 * (Add Text's own 72 px wrapped one Khmer sentence over four lines in a
 * 9:16 frame). Sizes are pixels of a 1080-tall frame (shared/plainText.ts). */
const SUBTITLE_POSITION = { ...PLAIN_TEXT_POSITION, xPct: 6, yPct: 72, widthPct: 88, heightPct: 22 }
const SUBTITLE_FONT_PX: Record<'16:9' | '9:16' | '1:1', number> = { '16:9': 52, '9:16': 40, '1:1': 46 }

const PHASE_LABEL: Record<MangaProgress['phase'], string> = { downloading: 'Downloading the chapter', cutting: 'Cutting into scenes', characters: 'Cutting out the characters', reading: 'Looking at the panels', writing: 'Writing the narration', voicing: 'Recording the voice' }

/** The remembered form, field by field: anything else stored there is
 * ignored rather than spread into the form. */
function readForm(): FormState {
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_KEY) ?? '{}') as Partial<Record<keyof FormState, unknown>>
    return {
      voice: typeof saved.voice === 'string' ? saved.voice : DEFAULT_FORM.voice,
      language: saved.language === 'en' ? 'en' : 'km',
      notes: typeof saved.notes === 'string' ? saved.notes : DEFAULT_FORM.notes,
      subtitles: typeof saved.subtitles === 'boolean' ? saved.subtitles : DEFAULT_FORM.subtitles,
      // Big, one at a time, unless 3 side by side was picked by hand (it was
      // the default once, and a remembered default is not a choice).
      layout: saved.layout === 'trio' && saved.layoutPicked === true ? 'trio' : 'single',
      layoutPicked: saved.layoutPicked === true,
      grid: saved.grid === 'large' ? 'large' : 'small',
      compact: saved.compact === true
    }
  } catch {
    return DEFAULT_FORM
  }
}

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Two links to the same chapter page (host and path; not ?query or #hash). */
function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a.trim())
    const y = new URL(b.trim())
    return x.hostname.replace(/^www\./, '') === y.hostname.replace(/^www\./, '') && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '')
  } catch {
    return false
  }
}

/** Everything a finished job brings into Media: its pictures, its voice
 * (one narration, or a file per passage) and its backdrops. */
function jobFiles(job: MangaResult & { backdrops: string[] }): string[] {
  const pictures = job.groups.flatMap((g) => [...g.imagePaths, ...(g.cutouts ?? []).filter((c): c is string => !!c)])
  const voices = job.narrationPath ? [job.narrationPath] : job.groups.flatMap((g) => (g.audioPath ? [g.audioPath] : []))
  return [...new Set([...pictures, ...voices, ...job.backdrops])]
}

/** The narrator to start with: the AI Story recap's narrator when it is a
 * KiriTTS voice, else one named like a narrator, else the first. An
 * account's list starts with its character clones, which suit dubbing, not
 * a recap. */
function defaultNarrator(voices: KiriVoice[]): string {
  const recap = kiriVoiceOf(loadStoryNarratorVoiceId() ?? undefined)
  if (recap && voices.some((v) => v.id === recap)) return recap
  return (voices.find((v) => /novel|narrat|recap|និទាន|អ្នកនិទាន|សម្រាយ/i.test(v.name)) ?? voices.find((v) => !v.cloned) ?? voices[0])?.id ?? ''
}

export function MangaPanel(): JSX.Element {
  const { items, importPaths } = useMedia()
  const { sequence, restoreSequence } = useSequence()
  const { projectId } = useProject()
  const { scenesByMedia, insertScenes } = useScenes()
  const { brandPreset } = useBrandPreset()
  const { openSettings } = useUiState()
  const changeAspectRatio = useChangeAspectRatio()
  const [form, setForm] = useState<FormState>(readForm)
  const [panels, setPanels] = useState<string[]>([])
  const [voices, setVoices] = useState<KiriVoice[] | null>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [progress, setProgress] = useState<MangaProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** A finished job waiting for its files to come through Media. */
  const pending = useRef<(MangaResult & { backdrops: string[] }) | null>(null)
  const [placing, setPlacing] = useState(false)
  const [chapterUrl, setChapterUrl] = useState('')
  const [chapterTitle, setChapterTitle] = useState('')
  // Several chapters in one long video (MangaToon): its chapter list, the
  // range picked, the chapter whose panels are loaded, and the run.
  const [episodes, setEpisodes] = useState<MangaEpisode[] | null>(null)
  const [comicTitle, setComicTitle] = useState('')
  const [range, setRange] = useState<{ from: number; to: number } | null>(null)
  const [loadedUrl, setLoadedUrl] = useState('')
  const [run, setRun] = useState<{ index: number; total: number; title: string } | null>(null)
  const stopRunRef = useRef(false)
  /** Resolved when a chapter's job is on the Timeline (true) or failed. */
  const placedRef = useRef<((ok: boolean) => void) | null>(null)
  // The panels' pictures for the grid (app-media:// links from the main process).
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  useEffect(() => {
    const missing = panels.filter((path) => !thumbs[path])
    if (missing.length === 0) return
    let stale = false
    void window.api.manga.thumbs(missing).then((urls) => {
      if (stale) return
      setThumbs((current) => {
        const next = { ...current }
        missing.forEach((path, i) => { if (urls[i]) next[path] = urls[i] })
        return next
      })
    })
    return () => { stale = true }
  }, [panels, thumbs])

  useEffect(() => {
    try { localStorage.setItem(FORM_KEY, JSON.stringify(form)) } catch { /* only the remembered form is lost */ }
  }, [form])
  useEffect(() => window.api.manga.onProgress((event) => { if (event.jobId === jobId) setProgress(event) }), [jobId])

  // The account's KiriTTS voices, once.
  useEffect(() => {
    let stale = false
    void (async () => {
      if (!(await window.api.kiri.hasKey())) {
        if (!stale) setVoiceError('Add your KiriTTS key in Settings first.')
        return
      }
      const result = await window.api.kiri.listVoices()
      if (stale) return
      if (!result.ok) return setVoiceError(result.error)
      setVoices(result.voices)
      setForm((f) => (f.voice && result.voices.some((v) => v.id === f.voice) ? f : { ...f, voice: defaultNarrator(result.voices) }))
    })()
    return () => { stale = true }
  }, [])

  const patch = (next: Partial<FormState>): void => setForm((f) => ({ ...f, ...next }))

  const addPanels = async (): Promise<void> => {
    const picked = await window.api.manga.pickImages()
    if (picked.length) setPanels((current) => [...current, ...picked.filter((p) => !current.includes(p))])
  }

  /** Downloading a chapter or cutting a strip: the panel list is replaced by
   * the scenes. Runs under `jobId` like the narration, so Cancel stops it. */
  const loadScenes = async (run: (id: string) => Promise<import('@shared/mangaRecap').MangaScenesResult>, first: MangaProgress['phase']): Promise<boolean> => {
    const id = `manga-${Date.now()}`
    setJobId(id)
    setError(null)
    setNote(null)
    setProgress({ jobId: id, phase: first, percent: 0, message: 'Starting…' })
    const answer = await run(id)
    setJobId(null)
    setProgress(null)
    if (!answer.ok) {
      if (!answer.canceled) setError(answer.error)
      return false
    }
    if (answer.paths.length === 0) {
      setError('No scenes were found in these pictures.')
      return false
    }
    setPanels(answer.paths)
    if (answer.title) setChapterTitle(answer.title)
    if (answer.title && !form.notes.trim()) patch({ notes: `Title: ${answer.title}` })
    setNote(`${answer.paths.length} scenes ready${answer.title ? ` from "${answer.title}"` : ''}. Check the list, then Make Manga Video.`)
    return true
  }

  const getChapter = (): void => {
    const link = chapterUrl.trim()
    if (!link) return
    void loadScenes((id) => window.api.manga.getChapter(id, link), 'downloading').then((ok) => { if (ok) setLoadedUrl(link) })
    // A MangaToon link also brings its comic's chapter list, for from..to.
    setEpisodes(null)
    setRange(null)
    if (/mangatoon\.mobi/i.test(link)) {
      void window.api.manga.episodes(link).then((answer) => {
        if (!answer.ok || answer.episodes.length < 2) return
        const here = answer.episodes.find((e) => samePage(e.url, link)) ?? answer.episodes[0]
        setEpisodes(answer.episodes)
        setComicTitle(answer.title)
        setRange({ from: here.number, to: here.number })
      })
    }
  }
  const chosenChapters = episodes && range ? episodes.filter((e) => e.number >= range.from && e.number <= range.to) : []

  const cutPanels = (): void => {
    if (panels.length) void loadScenes((id) => window.api.manga.cutScenes(id, panels), 'cutting')
  }

  const generate = async (): Promise<void> => {
    if (chosenChapters.length > 1) return void makeChapters(chosenChapters)
    await makeChapter(panels, {})
  }

  /** One chapter: written, voiced and placed after what is on the Timeline.
   * Resolves with the story so far once it is there (null: it failed). */
  const makeChapter = async (paths: string[], extra: Pick<MangaRequest, 'storySoFar' | 'continues' | 'more'>): Promise<string | null> => {
    if (!paths.length || !form.voice) return null
    const id = `manga-${Date.now()}`
    setJobId(id)
    setError(null)
    setNote(null)
    setProgress({ jobId: id, phase: 'reading', percent: 0, message: 'Starting…' })
    const trio = form.layout === 'trio' && trioFits()
    // An empty project becomes 16:9 (see the placing below), the shape of a
    // YouTube recap; otherwise the project's own.
    const empty = !sequence.clips.some((c) => c.type === 'video' || c.type === 'image')
    const answer = await window.api.manga.generate({ jobId: id, imagePaths: paths, voice: form.voice, language: form.language, notes: form.notes, groupSize: trio ? MANGA_TRIO_SIZE : 1, aspect: empty ? '16:9' : brandPreset.defaultAspectRatio, ...extra })
    setJobId(null)
    setProgress(null)
    if (!answer.ok) {
      if (!answer.canceled) setError(answer.error)
      return null
    }
    // 3 side by side: a blurred backdrop from each group's first panel.
    const backdrops = trio ? await window.api.manga.backdrops(id, answer.data.groups.map((g) => g.imagePaths[0])) : []
    pending.current = { ...answer.data, backdrops }
    const placedOk = new Promise<boolean>((resolve) => { placedRef.current = resolve })
    setPlacing(true)
    void importPaths(jobFiles(pending.current))
    return (await placedOk) ? (answer.data.storySoFar ?? '') : null
  }

  /** Several chapters, one after another, into one long video: each one
   * downloaded and cut (the one already loaded is used as it is), told on
   * from the story so far, and placed after the one before. */
  const makeChapters = async (chapters: MangaEpisode[]): Promise<void> => {
    stopRunRef.current = false
    let story = ''
    let made = 0
    for (const [k, chapter] of chapters.entries()) {
      if (stopRunRef.current) break
      setRun({ index: k, total: chapters.length, title: chapter.title })
      let paths = samePage(chapter.url, loadedUrl) && panels.length > 0 ? panels : null
      if (!paths) {
        const id = `manga-${Date.now()}`
        setJobId(id)
        setError(null)
        setProgress({ jobId: id, phase: 'downloading', percent: 0, message: `${chapter.title}: starting…` })
        const answer = await window.api.manga.getChapter(id, chapter.url)
        setJobId(null)
        setProgress(null)
        if (!answer.ok || answer.paths.length === 0) {
          if (!answer.ok && answer.canceled) break
          setError(`${chapter.title}: ${answer.ok ? 'no scenes were found' : answer.error}. ${made} chapter(s) are on the Timeline.`)
          break
        }
        paths = answer.paths
        setPanels(paths)
        setLoadedUrl(chapter.url)
      }
      if (stopRunRef.current) break
      const next = await makeChapter(paths, { storySoFar: story, continues: k > 0, more: k < chapters.length - 1 })
      if (next === null) {
        if (stopRunRef.current) break
        setError((current) => `${chapter.title}: ${current ?? 'it could not be made'} ${made} chapter(s) are on the Timeline.`)
        break
      }
      story = next
      made++
    }
    setRun(null)
    if (made > 0) setNote(`${made} of ${chapters.length} chapters on the Timeline, one after another${comicTitle ? ` ("${comicTitle}")` : ''}.`)
  }
  const stopRun = (): void => {
    stopRunRef.current = true
    if (jobId) void window.api.manga.cancel(jobId)
  }

  // Once every panel and voice is in Media: onto the Timeline in one go.
  useEffect(() => {
    const job = pending.current
    if (!job || !placing) return
    const find = (path: string) => items.find((item) => item.originalPath === path)
    const files = jobFiles(job)
    if (files.some((path) => { const item = find(path); return !item || (item.stage !== 'ready' && item.stage !== 'error') })) return
    pending.current = null
    setPlacing(false)
    const placed: PlacedGroup[] = []
    for (const g of job.groups) {
      const pictures = g.imagePaths.flatMap((path, k) => {
        const image = find(path)
        const cut = g.cutouts?.[k] ? find(g.cutouts[k] as string) : undefined
        return image && image.stage !== 'error' ? [{ imageMediaId: image.id, imageSize: { width: image.metadata?.width, height: image.metadata?.height }, focusX: g.focus[k]?.x ?? 0.5, focusY: g.focus[k]?.y ?? 0.5, cutoutMediaId: cut && cut.stage !== 'error' ? cut.id : null, motion: g.motions?.[k] }] : []
      })
      const voice = g.audioPath && !job.narrationPath ? find(g.audioPath) : undefined
      const voiced = job.narrationPath ? g.audioSeconds > 0 : !!voice && voice.stage !== 'error'
      // A group whose pictures all failed to load still keeps its time: the
      // joined narration has its passage in it.
      placed.push({ pictures, audioMediaId: voice && voiced ? voice.id : null, audioSeconds: voiced ? g.audioSeconds : 0, pauseAfter: g.pauseAfter, lines: g.lines })
    }
    const counted = placed.reduce((n, g) => n + g.pictures.length, 0)
    if (counted === 0) {
      setError('None of the panels could be read into Media.')
      placedRef.current?.(false)
      placedRef.current = null
      return
    }
    // An empty project becomes 16:9, a YouTube recap's shape, before
    // anything is placed (useAutoAspectRatio would otherwise give it the
    // first picture's shape a moment later: a tall webtoon scene, 9:16). A
    // tall scene scrolls in it instead.
    let aspect = brandPreset.defaultAspectRatio
    const empty = !sequence.clips.some((c) => c.type === 'video' || c.type === 'image')
    const trio = job.backdrops.length > 0 && (empty || aspect === '16:9')
    if (empty) {
      aspect = '16:9'
      changeAspectRatio(aspect)
      keepChosenAspectRatio()
    }
    const narration = job.narrationPath ? find(job.narrationPath) : undefined
    const backdrops = job.backdrops.map((path) => { const item = find(path); return item && item.stage !== 'error' ? item.id : null })
    const result = placeMangaGroups(sequence, placed, aspect, undefined, narration && narration.stage !== 'error' ? { mediaId: narration.id, seconds: narration.metadata?.durationSeconds ?? 0 } : undefined, trio ? backdrops : undefined)
    let next = result.sequence
    if (form.subtitles && result.subtitles.length) {
      const sceneRanges: OccupiedRange[] = Object.values(scenesByMedia).flat().map((s) => ({ trackId: s.track, startTime: s.startTime, endTime: s.endTime }))
      const routing = findOrCreateTrack(next.tracks, sceneRanges, result.start, result.end - result.start, 'text')
      if (routing.newTrack) next = { ...next, tracks: ensureTrack(next.tracks, { ...routing.newTrack, name: 'Manga Subtitles' }) }
      const owner = placed.find((g) => g.pictures.length)?.pictures[0].imageMediaId as string
      const scenes: Scene[] = result.subtitles.map((line) => {
        const id = crypto.randomUUID()
        const defaults = defaultContentForTemplate('plain-text', id)
        return {
          id, mediaId: owner, segmentId: '', suggestionId: `manga-${id}`, track: routing.trackId, templateId: 'plain-text',
          startTime: line.start, endTime: line.end, purpose: 'main_claim', originalText: line.text, visualText: line.text,
          reason: MANGA_SUBTITLE_REASON, confidence: 1, locked: false, edited: true, status: 'accepted', createdAt: new Date().toISOString(),
          ...(defaults?.content ? { content: defaults.content } : {}),
          position: { ...SUBTITLE_POSITION }, textAlign: 'center', lockAspectRatio: false, fontSizePx: SUBTITLE_FONT_PX[aspect]
        }
      })
      restoreSequence(next)
      insertScenes(owner, scenes)
    } else {
      restoreSequence(next)
    }
    // The recap's text in the Recap Script box too, to read or edit.
    storeRecapScript(projectId, mangaScriptFromPassages(placed.map((g) => g.lines.map((l) => l.text))))
    const minutes = (result.end - result.start) / 60
    setNote(`"${job.title}": ${counted} panels, ${minutes >= 1 ? `${minutes.toFixed(1)} min` : `${Math.round(result.end - result.start)} s`}, placed at ${Math.round(result.start)} s on the Timeline.${job.skipped ? ` ${job.skipped} passage(s) got no voice and show silently.` : ''}${job.leftOut ? ` ${job.leftOut} picture(s) with only words left out.` : ''}`)
    placedRef.current?.(true)
    placedRef.current = null
  }, [items, placing, sequence, scenesByMedia, brandPreset.defaultAspectRatio, form.subtitles, restoreSequence, insertScenes, changeAspectRatio, projectId])

  const busy = !!jobId || placing || !!run
  /** 3 side by side needs a 16:9 frame: an empty project becomes one. */
  function trioFits(): boolean {
    return brandPreset.defaultAspectRatio === '16:9' || !sequence.clips.some((c) => c.type === 'video' || c.type === 'image')
  }

  const statusLine = progress && jobId ? null : error ? { kind: 'error', text: error } : voiceError ? { kind: 'error', text: voiceError } : note ? { kind: 'done', text: note } : form.layout === 'trio' && !trioFits() ? { kind: 'warn', text: 'This project is not 16:9: panels will go one at a time.' } : null

  return (
    <section className="manga-studio">
      <div className="manga-studio-top">
        <div className="manga-studio-crumb">
          <span className="manga-studio-crumb-dot" aria-hidden />
          <strong>AI Manga</strong>
          <span className="manga-studio-crumb-sep">/</span>
          <span className="manga-studio-crumb-title" title={chapterTitle || undefined}>{chapterTitle || 'New chapter'}</span>
        </div>
        <div className="manga-studio-link">
          <input value={chapterUrl} disabled={busy} placeholder="Paste a chapter link (MangaToon or another site)" onChange={(event) => setChapterUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') getChapter() }} />
          <button type="button" disabled={busy || !chapterUrl.trim()} title="Download the chapter's pictures and cut the strip into scenes" onClick={getChapter}>Get</button>
        </div>
        {episodes && range && (
          <div className="manga-studio-range">
            <span className="manga-studio-range-label">Chapters</span>
            <select value={range.from} disabled={busy} onChange={(event) => { const from = Number(event.target.value); setRange((r) => (r ? { from, to: Math.max(from, r.to) } : r)) }}>
              {episodes.map((e) => <option key={e.url} value={e.number}>EP{e.number}</option>)}
            </select>
            <span className="manga-studio-range-sep">→</span>
            <select value={range.to} disabled={busy} onChange={(event) => { const to = Number(event.target.value); setRange((r) => (r ? { from: Math.min(r.from, to), to } : r)) }}>
              {episodes.map((e) => <option key={e.url} value={e.number}>EP{e.number}</option>)}
            </select>
            <span className="manga-studio-range-note" title="Each chapter is written by Gemini (about one request; the free key has 20 a day) and voiced by KiriTTS (credits).">
              {chosenChapters.length === 1 ? '1 chapter' : `${chosenChapters.length} chapters · one long video`}
            </span>
          </div>
        )}
        <div className="manga-studio-tools">
          <span className="manga-studio-count">{panels.length > 0 ? `${panels.length} panels` : 'Panels'}</span>
          {panels.length > 0 && <button type="button" className="manga-studio-tool" disabled={busy} title="Order by the numbers in the file names" onClick={() => setPanels(sortPanelPaths(panels))}>Sort</button>}
          {panels.length > 0 && <button type="button" className="manga-studio-tool" disabled={busy} title="Join these pictures into one strip and cut it into scenes at the gaps between pictures (for webtoon strips and long pages)" onClick={cutPanels}>Cut into scenes</button>}
          {panels.length > 0 && <button type="button" className="manga-studio-tool manga-studio-tool-danger" disabled={busy} title="Remove all panels" onClick={() => setPanels([])}>Clear</button>}
          <span className="manga-studio-spacer" />
          <div className="manga-studio-toggle" role="group" aria-label="Picture size">
            <button type="button" className={form.grid === 'small' ? 'active' : ''} title="Small pictures" onClick={() => patch({ grid: 'small' })}>
              <GridViewIcon size={13} />
            </button>
            <button type="button" className={form.grid === 'large' ? 'active' : ''} title="Large pictures" onClick={() => patch({ grid: 'large' })}>
              <LargeGridIcon />
            </button>
          </div>
        </div>
      </div>

      <div className="manga-studio-gallery editor-scroll">
        {panels.length === 0 ? (
          <div className="manga-studio-empty">
            <strong>No panels yet</strong>
            <span>Paste a chapter link above, or add your own panels with +</span>
          </div>
        ) : (
          <ol className={form.grid === 'large' ? 'manga-studio-grid manga-studio-grid-large' : 'manga-studio-grid'}>
            {panels.map((path, i) => (
              <li key={path} title={fileName(path)}>
                {thumbs[path] ? <img src={thumbs[path]} alt="" loading="lazy" draggable={false} /> : <span className="manga-studio-thumb-wait" />}
                <span className="manga-studio-num">{i + 1}</span>
                <span className="manga-studio-item-tools">
                  <button type="button" disabled={busy || i === 0} title="Earlier" onClick={() => setPanels((list) => { const next = [...list]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; return next })}>↑</button>
                  <button type="button" disabled={busy} title="Remove" onClick={() => setPanels((list) => list.filter((_, j) => j !== i))}>✕</button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="manga-studio-composer">
        <div className="manga-studio-row">
          <button type="button" className="manga-studio-round" disabled={busy} title="Add panels (pictures)" onClick={() => void addPanels()}>
            <PlusIcon size={15} />
          </button>
          <button type="button" className={form.subtitles ? 'manga-studio-icon active' : 'manga-studio-icon'} disabled={busy} aria-pressed={form.subtitles} title={form.subtitles ? 'Subtitles on: the narration as text on the video (Add Text, editable, exported)' : 'Subtitles off'} onClick={() => patch({ subtitles: !form.subtitles })}>
            <TextToolIcon size={15} />
          </button>
          <span className="manga-studio-spacer" />
          <div className="manga-studio-toggle" role="group" aria-label="Layout">
            <button type="button" disabled={busy} className={form.layout === 'single' ? 'active' : ''} title="1 at a time: each scene big, on its own" onClick={() => patch({ layout: 'single', layoutPicked: true })}>
              <SingleLayoutIcon />
            </button>
            <button type="button" disabled={busy} className={form.layout === 'trio' ? 'active' : ''} title="3 side by side, on a blurred backdrop (16:9)" onClick={() => patch({ layout: 'trio', layoutPicked: true })}>
              <TrioLayoutIcon />
            </button>
          </div>
          <button type="button" className={form.compact ? 'manga-studio-icon manga-studio-chevron manga-studio-chevron-up' : 'manga-studio-icon manga-studio-chevron'} title={form.compact ? 'Show the voice and the notes' : 'Hide the voice and the notes'} onClick={() => patch({ compact: !form.compact })}>
            <ChevronDownIcon size={12} />
          </button>
        </div>

        {!form.compact && (
          <>
            <div className="manga-studio-chips">
              <label className="manga-studio-chip manga-studio-voice" title="Narrator voice (KiriTTS)">
                <MicrophoneIcon size={13} />
                <select value={form.voice} disabled={busy || !voices} onChange={(event) => patch({ voice: event.target.value })}>
                  {!voices && <option value="">{voiceError ? 'No voices' : 'Loading voices…'}</option>}
                  {voices?.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}{voice.cloned ? ' (my clone)' : ''}{voice.gender !== 'unknown' ? ` · ${voice.gender}` : ''}</option>)}
                </select>
              </label>
              <div className="manga-studio-chip manga-studio-lang" role="group" aria-label="Narration language">
                {(['km', 'en'] as const).map((language) => (
                  <button key={language} type="button" disabled={busy} className={form.language === language ? 'active' : ''} onClick={() => patch({ language })}>{language === 'km' ? 'ខ្មែរ' : 'EN'}</button>
                ))}
              </div>
            </div>
            <textarea className="manga-studio-notes" rows={2} value={form.notes} disabled={busy} placeholder="Tell the AI about the story (optional): the title, names (Lin Feng = តួឯក), what came before…" onChange={(event) => patch({ notes: event.target.value })} />
          </>
        )}

        {run && (
          <p className="manga-studio-status manga-studio-status-info">
            Chapter {run.index + 1} of {run.total}: {run.title}
          </p>
        )}
        {jobId && progress && (
          <div className="manga-studio-progress">
            <div><strong>{PHASE_LABEL[progress.phase]}</strong><span>{progress.percent}%</span></div>
            <progress max={100} value={progress.percent} />
            <small>{progress.message}</small>
          </div>
        )}
        {placing && <p className="manga-studio-status manga-studio-status-info">Putting the panels and voice on the Timeline…</p>}
        {statusLine && (
          <p className={`manga-studio-status manga-studio-status-${statusLine.kind}`}>
            {statusLine.text}
            {statusLine.text === voiceError && (
              <>
                {' '}
                <button type="button" className="inline-link-button" onClick={() => openSettings('voice')}>Settings</button>
              </>
            )}
          </p>
        )}

        <div className="manga-studio-row">
          <span className="manga-studio-spacer" />
          {(jobId || run) && <button type="button" className="manga-studio-cancel" onClick={stopRun}>{run ? 'Stop' : 'Cancel'}</button>}
          <button type="button" className="manga-studio-generate" disabled={busy || (panels.length === 0 && chosenChapters.length < 2) || !form.voice} title="Gemini reads the panels and writes the narration; KiriTTS speaks it (uses KiriTTS credits). Each panel stays on screen as long as its voice." onClick={() => void generate()}>
            <SparkleIcon size={14} />
            {busy ? 'Working…' : chosenChapters.length > 1 ? `Make ${chosenChapters.length} chapters` : 'Make Manga Video'}
          </button>
        </div>
      </div>
    </section>
  )
}

function LargeGridIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" />
    </svg>
  )
}

function SingleLayoutIcon(): JSX.Element {
  return (
    <svg width="15" height="13" viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="1" y="1" width="16" height="12" rx="2" />
      <rect x="6.5" y="3" width="5" height="8" rx="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

function TrioLayoutIcon(): JSX.Element {
  return (
    <svg width="15" height="13" viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="1" y="1" width="16" height="12" rx="2" />
      <rect x="3" y="3" width="3.4" height="8" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="7.3" y="3" width="3.4" height="8" rx="0.6" fill="currentColor" stroke="none" />
      <rect x="11.6" y="3" width="3.4" height="8" rx="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}


import { useEffect, useMemo, useRef, useState } from 'react'
import { useProject } from '../project/ProjectContext'
import { useMedia } from '../media/MediaContext'
import { useSequence } from '../sequence/SequenceContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { parseSrtToSegments } from '@shared/srt'
import type { Transcript } from '@shared/transcription'
import type { StoryBeat, StoryCharacter, StoryLibrary, StoryLibraryEntry, StoryOutline, StoryReferenceCharacter, VideoStoryNarrationProgress, VideoStoryNarrationScene } from '@shared/videoStoryNarration'
import { usePlaybackControls } from '../playback/PlaybackContext'
import { AUTO_GENERATE_RECAP_VOICE_EVENT } from './videoStoryEvents'
import { SCRIPT_CHANGED_EVENT } from './useRecapNarration'
import { clipSourceRange, outlineToTimeline, sceneToSource, sceneToTimeline, segmentsToSource, sourceSegmentsToTimeline } from './recapClipTime'
import { CameraIcon, CloseIcon, ExportIcon, FolderIcon, PlusIcon, TrashIcon, UpdateIcon } from '../nav/icons'

const STORY_STORAGE_PREFIX = 'cae-video-story-v1:'
const AUTO_VOICE_KEY = 'cae-video-story-auto-voice-v1'
/** Which library story this project's videos belong to. */
const STORY_SELECTION_PREFIX = 'cae-video-story-library-selection-v1:'
const newId = (prefix: string): string => `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}`

interface StoredStoryState {
  videoMediaId?: string
  srtFileName?: string
  characterContext: string
  scenes: VideoStoryNarrationScene[]
  /** Step 1's result, kept so the user can review/edit it and re-write the
   * script without watching the video again. */
  outline?: StoryOutline
  /** Faces the user named -- older builds kept them per video; they now
   * live in the app-wide story library and are migrated there on load. */
  references?: StoryReferenceCharacter[]
}

/** Scales a captured frame or picked picture down to a small JPEG: enough
 * for a face, small enough to keep in the project and send with every
 * video part. */
function shrinkImage(dataUrl: string, maxSide = 384): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * scale))
      canvas.height = Math.max(1, Math.round(image.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('No canvas'))
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    image.onerror = () => reject(new Error('Could not read that image.'))
    image.src = dataUrl
  })
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read that file.'))
    reader.readAsDataURL(file)
  })
}

function readStored(projectId: string | null): StoredStoryState {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${STORY_STORAGE_PREFIX}${projectId ?? 'draft'}`) ?? '{}') as Partial<StoredStoryState>
    const outline = parsed.outline && Array.isArray(parsed.outline.beats) && Array.isArray(parsed.outline.characters) ? parsed.outline : undefined
    const references = Array.isArray(parsed.references) ? parsed.references.filter((r) => r && typeof r.id === 'string') : []
    return { videoMediaId: parsed.videoMediaId, srtFileName: parsed.srtFileName, characterContext: parsed.characterContext ?? '', scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [], outline, references }
  } catch {
    return { characterContext: '', scenes: [] }
  }
}

const formatClock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

const BEAT_KIND_LABEL: Record<StoryBeat['kind'], string> = { story: '', flashback: 'Flashback', teaser: 'Teaser', credits: 'Credits' }

function scenesToScript(scenes: VideoStoryNarrationScene[]): string {
  return scenes.map((scene) => scene.khmerNarration.trim()).filter(Boolean).join('\n\n')
}

export function VideoStoryRecapControls(): JSX.Element {
  const { projectId } = useProject()
  const { items } = useMedia()
  const { sequence, selectedTimelineClipIds } = useSequence()
  const { transcripts, setImportedTranscript } = useTranscript()
  const selectedClip = sequence.clips.find((clip) => selectedTimelineClipIds.includes(clip.id))
  const selectedVideo = items.find((item) => item.id === selectedClip?.mediaId && item.kind === 'video')
  const [story, setStory] = useState<StoredStoryState>(() => readStored(projectId))
  const [jobId, setJobId] = useState<string | null>(null)
  const [progress, setProgress] = useState<VideoStoryNarrationProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null)
  const [regenerating, setRegenerating] = useState(false)
  const [autoVoice, setAutoVoice] = useState(() => localStorage.getItem(AUTO_VOICE_KEY) === 'true')
  const [library, setLibrary] = useState<StoryLibrary | null>(null)
  const [storyId, setStoryId] = useState<string>(() => localStorage.getItem(`${STORY_SELECTION_PREFIX}${projectId ?? 'draft'}`) ?? '')
  const libraryDirty = useRef(false)
  const storyTitleInput = useRef<HTMLInputElement>(null)
  const [librarySaveState, setLibrarySaveState] = useState<'idle' | 'pending' | 'saved' | 'error'>('idle')

  useEffect(() => {
    let alive = true
    void window.api.videoStoryNarration.libraryGet().then((loaded) => {
      if (!alive) return
      // Leftover nameless, photo-less stories (except the one in use) are noise.
      const selected = localStorage.getItem(`${STORY_SELECTION_PREFIX}${projectId ?? 'draft'}`)
      setLibrary({ stories: loaded.stories.filter((entry) => entry.id === selected || entry.title.trim() || entry.characters.length) })
    }).catch(() => { if (alive) setLibrary({ stories: [] }) })
    return () => { alive = false }
  }, [])

  const saveLibraryNow = (current: StoryLibrary): void => {
    libraryDirty.current = false
    window.api.videoStoryNarration.librarySave(current)
      .then(() => { if (!libraryDirty.current) setLibrarySaveState('saved') })
      .catch(() => setLibrarySaveState('error'))
  }

  // Saved a moment after the last edit, so typing a name is not a disk
  // write per keystroke. The Save button just does it right away.
  useEffect(() => {
    if (!library || !libraryDirty.current) return
    const timer = window.setTimeout(() => saveLibraryNow(library), 400)
    return () => window.clearTimeout(timer)
  }, [library])

  useEffect(() => {
    setStoryId(localStorage.getItem(`${STORY_SELECTION_PREFIX}${projectId ?? 'draft'}`) ?? '')
  }, [projectId])

  const selectStory = (id: string): void => {
    setStoryId(id)
    localStorage.setItem(`${STORY_SELECTION_PREFIX}${projectId ?? 'draft'}`, id)
  }
  const updateLibrary = (update: (stories: StoryLibraryEntry[]) => StoryLibraryEntry[]): void => {
    libraryDirty.current = true
    setLibrarySaveState('pending')
    setLibrary((current) => ({ stories: update(current?.stories ?? []) }))
  }
  /** A story with no name and no characters is an abandoned "+ New
   * story" -- dropped whenever another is started, so they don't pile up. */
  const isBlankStory = (entry: StoryLibraryEntry): boolean => !entry.title.trim() && entry.characters.length === 0
  const createStory = (title = '', characters: StoryReferenceCharacter[] = []): string => {
    const id = newId('story')
    updateLibrary((stories) => [...stories.filter((entry) => !isBlankStory(entry)), { id, title, characters, updatedAt: new Date().toISOString() }])
    selectStory(id)
    return id
  }
  /** "+ New story": start one and put the cursor in its name box. */
  const startNewStory = (): void => {
    createStory()
    window.setTimeout(() => storyTitleInput.current?.focus(), 0)
  }
  const patchStory = (id: string, patch: (entry: StoryLibraryEntry) => StoryLibraryEntry): void =>
    updateLibrary((stories) => stories.map((entry) => (entry.id === id ? { ...patch(entry), updatedAt: new Date().toISOString() } : entry)))
  const deleteStory = (id: string): void => {
    const entry = library?.stories.find((s) => s.id === id)
    if (!window.confirm(`Delete the story "${entry?.title || 'Untitled story'}" and its ${entry?.characters.length ?? 0} character photos?`)) return
    updateLibrary((stories) => stories.filter((s) => s.id !== id))
    selectStory('')
  }

  // Photos the previous build kept per video move into a library story.
  useEffect(() => {
    if (!library || !story.references?.length) return
    const legacy = story.references
    setStory((current) => ({ ...current, references: undefined }))
    if (storyId && library.stories.some((s) => s.id === storyId)) patchStory(storyId, (entry) => ({ ...entry, characters: [...entry.characters, ...legacy] }))
    else createStory('', legacy)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library === null, story.references])

  useEffect(() => {
    setStory(readStored(projectId))
    setSelectedSceneId(null)
  }, [projectId])

  useEffect(() => {
    localStorage.setItem(`${STORY_STORAGE_PREFIX}${projectId ?? 'draft'}`, JSON.stringify(story))
  }, [story, projectId])

  useEffect(() => window.api.videoStoryNarration.onProgress((event) => {
    if (event.jobId === jobId) setProgress(event)
  }), [jobId])

  const activeVideoId = selectedVideo?.id ?? story.videoMediaId
  const video = items.find((item) => item.id === activeVideoId && item.kind === 'video')
  // The clip this video plays through on the Timeline: its trim decides which
  // part of the file the recap covers (see recapClipTime.ts).
  const storyClip = selectedClip?.mediaId === activeVideoId ? selectedClip : sequence.clips.find((clip) => clip.mediaId === activeVideoId && clip.type === 'video')
  const isStoredStoryVideo = Boolean(activeVideoId && story.videoMediaId === activeVideoId)
  // Story context belongs to one source video. Selecting a different video
  // must never silently feed the previous story's names/relationships into
  // a new analysis, even when both videos live in the same project.
  const activeCharacterContext = isStoredStoryVideo ? story.characterContext : ''
  const activeSrtFileName = isStoredStoryVideo ? story.srtFileName : undefined
  const segments = activeVideoId ? (transcripts[activeVideoId]?.segments ?? []) : []
  const scenes = isStoredStoryVideo ? story.scenes : []
  const outline = isStoredStoryVideo ? story.outline : undefined
  const selectedStory = library?.stories.find((entry) => entry.id === storyId)
  const references = selectedStory?.characters ?? []
  // A just-started story with nothing in it has nothing worth calling saved.
  const storyShownSaved = librarySaveState === 'saved' && Boolean(selectedStory && (selectedStory.title.trim() || selectedStory.characters.length))
  const { captureFrame } = usePlaybackControls()

  /** Edits the selected story's characters, starting a story first when
   * none is selected. */
  const updateReferences = (update: (characters: StoryReferenceCharacter[]) => StoryReferenceCharacter[]): void => {
    if (selectedStory) patchStory(selectedStory.id, (entry) => ({ ...entry, characters: update(entry.characters) }))
    else createStory('', update([]))
  }
  const patchReference = (id: string, patch: Partial<StoryReferenceCharacter>): void => updateReferences((characters) => characters.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const addReference = (): void => updateReferences((characters) => [...characters, { id: newId('ref'), name: '', image: '' }])
  /** The frame on screen right now -- pause on a close-up of the person. */
  const photoFromVideo = async (id: string): Promise<void> => {
    const frame = captureFrame()
    if (!frame) {
      setError('No video frame to capture -- play the video to a close-up of this character first.')
      return
    }
    patchReference(id, { image: await shrinkImage(frame) })
  }
  const photoFromFile = async (id: string, file: File | undefined): Promise<void> => {
    if (!file) return
    try {
      patchReference(id, { image: await shrinkImage(await readFileAsDataUrl(file)) })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read that image.')
    }
  }
  /** From the outline: give an analysed character a photo (it becomes a
   * reference for the next Analyze, under that character's name). */
  const photoForOutlineCharacter = async (character: StoryCharacter): Promise<void> => {
    const frame = captureFrame()
    if (!frame) {
      setError('No video frame to capture -- play the video to a close-up of this character first.')
      return
    }
    const image = await shrinkImage(frame)
    updateReferences((characters) => {
      const existing = characters.find((r) => r.name.trim() === character.name.trim())
      return existing
        ? characters.map((r) => (r.id === existing.id ? { ...r, image } : r))
        : [...characters, { id: newId('ref'), name: character.name, image }]
    })
    setStory((current) => (current.outline ? { ...current, outline: { ...current.outline, characters: current.outline.characters.map((c) => (c.id === character.id ? { ...c, faceImage: image } : c)) } } : current))
  }
  const selectedIndex = scenes.findIndex((scene) => scene.id === selectedSceneId)
  const hasSrt = segments.length > 0

  const videoLabel = useMemo(() => video?.fileName ?? 'Select a video clip on the Timeline', [video])

  const writeRecapScript = (script: string): void => {
    const key = `cae-ai-script-v1:${projectId ?? 'draft'}`
    if (script) localStorage.setItem(key, script)
    else localStorage.removeItem(key)
    window.dispatchEvent(new Event(SCRIPT_CHANGED_EVENT))
  }

  const addSrt = async (): Promise<void> => {
    if (!video?.id || !video.metadata?.durationSeconds) {
      setError('Select a ready video clip on the Timeline first.')
      return
    }
    const result = await window.api.transcription.importSrtFile()
    if (result.canceled || !result.srtText) return
    const parsed = parseSrtToSegments(result.srtText)
    const duration = video.metadata.durationSeconds
    const valid = parsed.segments
      .filter((segment) => segment.startTime < duration && segment.endTime > 0)
      .map((segment) => ({ ...segment, endTime: Math.min(segment.endTime, duration) }))
    // An SRT is timed to the whole file; a clip trimmed past its opening
    // shows it later, so line the captions up with the clip right away.
    const onTimeline = sourceSegmentsToTimeline(valid, storyClip, duration)
    if (onTimeline.length === 0) {
      setError('No valid subtitle segments were found in this SRT file.')
      return
    }
    const transcript: Transcript = {
      mediaId: video.id,
      segments: onTimeline,
      requestedLanguage: 'auto',
      generatedAt: new Date().toISOString(),
      audioSourcePath: '',
      source: 'srt'
    }
    setImportedTranscript(video.id, transcript)
    setStory((current) => current.videoMediaId === video.id
      ? { ...current, srtFileName: result.fileName ?? 'subtitles.srt' }
      : { videoMediaId: video.id, srtFileName: result.fileName ?? 'subtitles.srt', characterContext: '', scenes: [] })
    setError(null)
  }

  const analyze = async (): Promise<void> => {
    if (!video?.originalPath || !video.metadata?.durationSeconds) {
      setError('Select a ready video clip on the Timeline first.')
      return
    }
    if (segments.length === 0) {
      setError('Add an SRT file for the selected video first.')
      return
    }
    // Step 1 of the story-first recap: watch the whole video, write down who
    // is who and what happens. The user checks that before any script is
    // written (see storyRecapService.ts).
    const id = `video-story-outline-${Date.now()}`
    setJobId(id)
    setError(null)
    setProgress({ jobId: id, phase: 'preparing', percent: 0, message: 'Starting…' })
    const duration = video.metadata.durationSeconds
    const range = clipSourceRange(storyClip, duration)
    const result = await window.api.videoStoryNarration.buildOutline({
      jobId: id,
      videoPath: video.originalPath,
      videoDurationSeconds: duration,
      // Gemini watches the file: captions go in its clock, and only the part
      // of the file the clip shows is outlined.
      segments: segmentsToSource(segments, storyClip, duration),
      rangeStart: range.start,
      rangeEnd: range.end,
      characterContext: activeCharacterContext,
      // Only people with both a name and a photo help recognition.
      referenceCharacters: references.filter((r) => r.name.trim() && r.image),
      storyTitle: selectedStory?.title.trim() || undefined
    })
    setJobId(null)
    if (!result.ok) {
      if (!result.canceled) setError(result.error)
      return
    }
    setStory({ videoMediaId: video.id, srtFileName: activeSrtFileName, characterContext: activeCharacterContext, scenes: [], outline: outlineToTimeline(result.data, storyClip) })
    setSelectedSceneId(null)
  }

  /** Step 2: the approved outline -> the Khmer script. */
  const writeScript = async (): Promise<void> => {
    if (!outline || !video) return
    const id = `video-story-script-${Date.now()}`
    setJobId(id)
    setError(null)
    setProgress({ jobId: id, phase: 'analyzing', percent: 0, message: 'Writing the Khmer script…' })
    const result = await window.api.videoStoryNarration.writeScript({ jobId: id, outline, segments, sourceSrtFileName: activeSrtFileName })
    setJobId(null)
    if (!result.ok) {
      if (!result.canceled) setError(result.error)
      return
    }
    setStory((current) => ({ ...current, videoMediaId: video.id, scenes: result.data.scenes }))
    setSelectedSceneId(result.data.scenes[0]?.id ?? null)
    writeRecapScript(scenesToScript(result.data.scenes))
    if (autoVoice) window.dispatchEvent(new Event(AUTO_GENERATE_RECAP_VOICE_EVENT))
  }

  const patchOutline = (patch: (current: StoryOutline) => StoryOutline): void => {
    setStory((current) => (current.outline ? { ...current, outline: patch(current.outline) } : current))
  }
  const patchCharacter = (id: string, patch: Partial<StoryCharacter>): void =>
    patchOutline((current) => ({ ...current, characters: current.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
  const patchBeat = (id: string, patch: Partial<StoryBeat>): void =>
    patchOutline((current) => ({ ...current, beats: current.beats.map((b) => (b.id === id ? { ...b, ...patch } : b)) }))

  const updateScenes = (nextScenes: VideoStoryNarrationScene[]): void => {
    setStory((current) => ({ ...current, videoMediaId: activeVideoId, scenes: nextScenes }))
    writeRecapScript(scenesToScript(nextScenes))
  }

  const patchScene = (scene: VideoStoryNarrationScene, patch: Partial<VideoStoryNarrationScene>): void => {
    updateScenes(scenes.map((item) => item.id === scene.id ? { ...item, ...patch } : item))
  }

  const regenerate = async (): Promise<void> => {
    if (selectedIndex < 0 || !video?.originalPath || !video.metadata?.durationSeconds) return
    setRegenerating(true)
    setError(null)
    const result = await window.api.videoStoryNarration.regenerateScene({
      jobId: `video-story-scene-${Date.now()}`,
      videoPath: video.originalPath,
      videoDurationSeconds: video.metadata.durationSeconds,
      scene: sceneToSource(scenes[selectedIndex], storyClip),
      segments: segmentsToSource(segments, storyClip, video.metadata.durationSeconds),
      characterContext: activeCharacterContext,
      previousNarration: scenes[selectedIndex - 1]?.khmerNarration,
      nextNarration: scenes[selectedIndex + 1]?.khmerNarration
    })
    setRegenerating(false)
    if (result.ok) updateScenes(scenes.map((scene, index) => index === selectedIndex ? sceneToTimeline(result.data, storyClip) : scene))
    else setError(result.error)
  }

  return (
    <section className="video-story-recap video-story-recap-open">
      <div className="video-story-panel-title">
        <span className="video-story-title-icon">✦</span>
        <span><strong>AI Video Story Narration</strong><small>Turn video and subtitles into a Khmer recap</small></span>
      </div>
      <div className="video-story-controls">
        <div className="video-story-sources">
          <div className={`video-story-source-card${video ? ' ready' : ''}`}>
            <span className="video-story-source-step">1</span>
            <span className="video-story-source-copy"><strong>Video</strong><small title={videoLabel}>{videoLabel}</small></span>
            <span className="video-story-source-status">{video ? '✓' : '—'}</span>
          </div>
          <div className={`video-story-source-card${hasSrt ? ' ready' : ''}`}>
            <span className="video-story-source-step">2</span>
            <span className="video-story-source-copy"><strong>SRT subtitles</strong><small title={activeSrtFileName}>{hasSrt ? activeSrtFileName ?? 'Subtitle transcript ready' : 'Required for dialogue'}</small></span>
            <button className="video-story-srt-button" type="button" disabled={!video || !!jobId} onClick={() => void addSrt()}>{hasSrt ? 'Replace' : 'Add'}</button>
          </div>
        </div>
        <label className="video-story-context-label"><span>Character Name Lock / Story Context <em>Recommended</em></span><textarea value={activeCharacterContext} disabled={!!jobId} placeholder={'One character per line, for example:\nCanonical name = exact name; aliases: alternate names; identifying detail\nSecond character = exact name; confirmed relationship to first character'} onChange={(event) => setStory((current) => current.videoMediaId === activeVideoId
          ? { ...current, characterContext: event.target.value }
          : { videoMediaId: activeVideoId, characterContext: event.target.value, scenes: [] })} /></label>
        <div className="story-photos">
          <div className="story-photos-head">
            <strong>Story &amp; Characters</strong>
            <em>Optional</em>
          </div>
          <p className="story-photos-hint">The story name and character faces help Gemini tell who is who. Saved for every episode.</p>
          <div className="story-library-row">
            <select className="story-library-select" value={selectedStory ? selectedStory.id : ''} disabled={!!jobId || !library} onChange={(event) => selectStory(event.target.value)}>
              <option value="">{library?.stories.length ? 'Choose a story…' : 'No stories yet'}</option>
              {library?.stories.map((entry) => <option key={entry.id} value={entry.id}>{entry.title.trim() || 'Untitled story'} · {entry.characters.length}</option>)}
            </select>
            <button type="button" className="story-icon-button story-library-new" title="New story" disabled={!!jobId || !library} onClick={startNewStory}><PlusIcon size={14} /></button>
            {selectedStory && <button type="button" className="story-icon-button story-icon-danger" title="Delete this story and its photos" disabled={!!jobId} onClick={() => deleteStory(selectedStory.id)}><TrashIcon size={14} /></button>}
          </div>
          <div className="story-library-row">
            <input ref={storyTitleInput} className={`story-library-title${selectedStory && !selectedStory.title.trim() ? ' needs-name' : ''}`} value={selectedStory?.title ?? ''} disabled={!!jobId || !library} placeholder="Type the story name" onChange={(event) => { if (selectedStory) patchStory(selectedStory.id, (entry) => ({ ...entry, title: event.target.value })); else createStory(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter' && library) { event.preventDefault(); saveLibraryNow(library) } }} />
            <button type="button" className={`story-library-save${storyShownSaved ? ' saved' : ''}`} disabled={!!jobId || !library || !selectedStory} onClick={() => { if (library) saveLibraryNow(library) }}>{storyShownSaved ? '✓ Saved' : librarySaveState === 'error' ? 'Retry' : 'Save'}</button>
          </div>
          {librarySaveState === 'error' && <small className="story-library-status story-library-status-error">Could not save — press Retry.</small>}
          <div className="story-cast-head">
            <span>Characters <em>{references.length}</em>{references.length > 0 && librarySaveState !== 'idle' && <small className={`story-cast-status story-cast-status-${librarySaveState}`}>{librarySaveState === 'saved' ? '✓ Saved' : librarySaveState === 'error' ? 'Not saved' : 'Saving…'}</small>}</span>
            <button type="button" className="story-photo-add" disabled={!!jobId || !library} onClick={() => addReference()}><PlusIcon size={12} /> Add</button>
          </div>
          {references.length === 0 && <p className="story-cast-empty">Pause the video on a close-up, press Add, type the name, then take the photo with <CameraIcon size={11} />.</p>}
          {references.map((reference) => (
            <div key={reference.id} className="story-photo-row">
              <span className="story-photo-thumb">{reference.image ? <img src={reference.image} alt={reference.name || 'Character'} /> : <CameraIcon size={14} />}</span>
              <input className="story-photo-name" value={reference.name} disabled={!!jobId} placeholder="Name, e.g. គូ អាន" onChange={(event) => patchReference(reference.id, { name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && library) { event.preventDefault(); saveLibraryNow(library); event.currentTarget.blur() } }} onBlur={() => { if (library && libraryDirty.current) saveLibraryNow(library) }} />
              <button type="button" className="story-icon-button story-photo-button" title="Use the video frame on screen now" disabled={!!jobId} onClick={() => void photoFromVideo(reference.id)}><CameraIcon size={14} /></button>
              <label className="story-icon-button story-photo-button" title="Choose a picture file">
                <FolderIcon size={14} />
                <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={!!jobId} onChange={(event) => { void photoFromFile(reference.id, event.target.files?.[0]); event.target.value = '' }} />
              </label>
              <button type="button" className="story-icon-button story-icon-danger" title="Remove" disabled={!!jobId} onClick={() => updateReferences((characters) => characters.filter((r) => r.id !== reference.id))}><CloseIcon size={12} /></button>
            </div>
          ))}
        </div>
        <label className="video-story-auto">
          <input type="checkbox" checked={autoVoice} onChange={(event) => { setAutoVoice(event.target.checked); localStorage.setItem(AUTO_VOICE_KEY, String(event.target.checked)) }} />
          <span className="video-story-switch" aria-hidden><span /></span>
          <span className="video-story-auto-copy"><strong>Auto-generate voice</strong><small>Start narration after the script is ready</small></span>
        </label>
        {jobId && progress && <div className="video-story-progress video-story-progress-visible">
          <div className="video-story-progress-head"><strong>{progress.phase === 'analyzing' ? 'Gemini is analyzing' : progress.phase === 'uploading' ? 'Uploading video' : 'Preparing video'}</strong><span>{progress.percent}%</span></div>
          <progress max={100} value={progress.percent} />
          <span>{progress.message}</span>
          {progress.currentChunk && progress.totalChunks && <small>Chunk {progress.currentChunk} of {progress.totalChunks}</small>}
        </div>}
        {error && <div className="voiceover-recorder-error">{error}</div>}
        <div className="video-story-actions">
          <button className="video-story-analyze-button" disabled={!video || !hasSrt || !!jobId} onClick={() => void analyze()}><span>✦</span>{jobId ? 'Working…' : outline ? 'Analyze Again' : 'Analyze Story'}</button>
          {jobId && <button className="video-story-cancel-button" onClick={() => void window.api.videoStoryNarration.cancel(jobId)}>Cancel</button>}
          {scenes.length > 0 && <div className="video-story-result-actions">
            <button className="video-story-regenerate-button" disabled={selectedIndex < 0 || regenerating} onClick={() => void regenerate()}>
              <UpdateIcon size={14} />
              <span>{regenerating ? 'Regenerating…' : 'Regenerate Selected Scene'}</span>
            </button>
            <button className="video-story-export-button" onClick={() => void window.api.videoStoryNarration.exportTxt(scenes)}>
              <ExportIcon size={14} />
              <span>Export TXT</span>
            </button>
            <button className="video-story-export-button" onClick={() => void window.api.videoStoryNarration.exportSrt(scenes)}>
              <ExportIcon size={14} />
              <span>Export SRT</span>
            </button>
          </div>}
        </div>
        {outline && (
          <div className="story-outline">
            <div className="story-outline-head">
              <strong>Story outline</strong>
              <small>Check names and events, untick anything to leave out, then write the script.</small>
            </div>
            <div className="story-outline-section-title">Characters ({outline.characters.length})</div>
            <div className="story-outline-characters">
              {outline.characters.map((character) => (
                <div key={character.id} className="story-outline-character">
                  <button type="button" className="story-outline-face" title={character.faceImage ? 'Replace photo with the video frame on screen now' : 'Add a photo: the video frame on screen now'} disabled={!!jobId} onClick={() => void photoForOutlineCharacter(character)}>
                    {character.faceImage ? <img src={character.faceImage} alt={character.name} /> : <CameraIcon size={13} />}
                  </button>
                  <input className="story-outline-name" value={character.name} disabled={!!jobId} onChange={(event) => patchCharacter(character.id, { name: event.target.value })} title="The Khmer name the script uses" />
                  <input className="story-outline-role" value={character.role} disabled={!!jobId} onChange={(event) => patchCharacter(character.id, { role: event.target.value })} title="Who they are" />
                  {character.sourceNames.length > 0 && <small className="story-outline-aliases" title="How the subtitles name them">{character.sourceNames.join(' · ')}</small>}
                </div>
              ))}
            </div>
            <div className="story-outline-section-title">Events ({outline.beats.filter((beat) => beat.include).length} of {outline.beats.length} in the script)</div>
            <div className="story-outline-beats">
              {outline.beats.map((beat) => (
                <div key={beat.id} className={`story-outline-beat${beat.include ? '' : ' excluded'}`}>
                  <label className="story-outline-beat-head">
                    <input type="checkbox" checked={beat.include} disabled={!!jobId} onChange={(event) => patchBeat(beat.id, { include: event.target.checked })} />
                    <span className="story-outline-time">{formatClock(beat.startTime)}–{formatClock(beat.endTime)}</span>
                    {BEAT_KIND_LABEL[beat.kind] && <span className={`story-outline-kind story-outline-kind-${beat.kind}`}>{BEAT_KIND_LABEL[beat.kind]}</span>}
                  </label>
                  <textarea value={beat.summary} disabled={!!jobId} onChange={(event) => patchBeat(beat.id, { summary: event.target.value })} />
                </div>
              ))}
            </div>
            <button className="video-story-analyze-button story-outline-write" disabled={!!jobId || !outline.beats.some((beat) => beat.include)} onClick={() => void writeScript()}>
              <span>✦</span>{jobId ? 'Working…' : scenes.length > 0 ? 'Write Script Again' : 'Write Script'}
            </button>
          </div>
        )}
        {scenes.length > 0 && <details className="video-story-scene-details"><summary>Scene details ({scenes.length})</summary><div className="video-story-results">
          {scenes.map((scene, index) => <article key={scene.id} className={`video-story-scene${selectedSceneId === scene.id ? ' selected' : ''}`} onClick={() => setSelectedSceneId(scene.id)}>
            <header><strong>Scene {index + 1}</strong><span>{Math.round(scene.confidence * 100)}%</span></header>
            <div className="video-story-times"><label>Start<input type="number" step="0.01" value={scene.startTime} onChange={(event) => patchScene(scene, { startTime: Number(event.target.value) })} /></label><label>End<input type="number" step="0.01" value={scene.endTime} onChange={(event) => patchScene(scene, { endTime: Number(event.target.value) })} /></label></div>
            <label>សន្ទនាសង្ខេប<textarea value={scene.dialogueSummary} onChange={(event) => patchScene(scene, { dialogueSummary: event.target.value })} /></label>
            <label>សកម្មភាពដែលមើលឃើញ<textarea value={scene.visibleAction} onChange={(event) => patchScene(scene, { visibleAction: event.target.value })} /></label>
            <label>ស្គ្រីបសម្រាយខ្មែរ<textarea value={scene.khmerNarration} onChange={(event) => patchScene(scene, { khmerNarration: event.target.value })} /></label>
          </article>)}
        </div></details>}
      </div>
    </section>
  )
}

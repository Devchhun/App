import { useCallback, useEffect, useState } from 'react'
import { LicenseProvider } from './license/LicenseContext'
import { LicenseGate } from './license/LicenseGate'
import { MediaProvider, useMedia } from './media/MediaContext'
import { ImportPanel } from './media/ImportPanel'
import { PreviewPlayer } from './media/PreviewPlayer'
import { PlaybackProvider } from './playback/PlaybackContext'
import { TranscriptProvider } from './transcript/TranscriptContext'
import { TranscriptPanel } from './transcript/TranscriptPanel'
import { ProjectProvider } from './project/ProjectContext'
import { CorrectionDictionaryProvider } from './dictionary/CorrectionDictionaryContext'
import { Timeline } from './timeline/Timeline'
import { TimelineViewProvider, useTimelineView } from './timeline/TimelineViewContext'
import { AiSuggestionsProvider } from './suggestions/AiSuggestionsContext'
import { LocalAiProvider } from './localAi/LocalAiContext'
import { ExportProvider } from './export/ExportContext'
import { ExportPanel } from './export/ExportPanel'
import { SceneProvider, useScenes } from './scenes/SceneContext'
import { SequenceProvider, useSequence } from './sequence/SequenceContext'
import { ScenePropertiesPanel } from './scenes/ScenePropertiesPanel'
import { ProjectDetailsPanel } from './project/ProjectDetailsPanel'
import { AiScriptPanel } from './aiScript/AiScriptPanel'
import { useRecapNarration } from './aiScript/useRecapNarration'
import { ClipPropertiesPanel } from './sequence/ClipPropertiesPanel'
import { HistoryProvider } from './history/HistoryContext'
import { StoryProvider } from './story/StoryContext'
import { BrandPresetProvider } from './brand/BrandPresetContext'
import { BrandPresetPanel } from './brand/BrandPresetPanel'
import { UiStateProvider, useUiState } from './nav/UiStateContext'
import { NarrationProvider, useNarration } from './narration/NarrationContext'
import { NarrationScriptPanel } from './narration/NarrationScriptPanel'
import { RecordingAssistantPanel } from './narration/RecordingAssistantPanel'
import { AiDubberProvider, useAiDubber } from './dubbing/AiDubberContext'
import { AiDubberScriptPanel } from './dubbing/AiDubberScriptPanel'
import { VoiceModelPanel } from './dubbing/VoiceModelPanel'
import { Titlebar } from './nav/Titlebar'
import { IconRail } from './nav/IconRail'
import { TemplateBrowserPanel } from './templates/TemplateBrowserPanel'
import { SettingsDialog } from './nav/SettingsDialog'
import { TranscriptPreviewList } from './transcript/TranscriptPreviewList'
import { AiSuggestionsPreviewList } from './suggestions/AiSuggestionsPreviewList'
import { useWorkspaceLayout, ICON_RAIL_WIDTH } from './nav/useWorkspaceLayout'
import { Splitter } from './nav/Splitter'
import { clampLeftSplitHeight, LEFT_SPLIT_DEFAULT, persistLeftSplitHeight, readStoredLeftSplitHeight } from './nav/leftSplitPrefs'
import { buildWorkspaceGridColumns, computeSplitterOffsets, SPLITTER_HIT_WIDTH } from './nav/workspaceLayout'
import { DEFAULT_TIMELINE_VIEW_PREFS } from './timeline/timelineViewPrefs'
import { ConfirmDialogProvider } from './ui/ConfirmDialog'
import { ThemeProvider } from './nav/ThemeContext'
import { SparkleIcon } from './nav/icons'
import { HomeScreen } from './home/HomeScreen'
import { AUTO_GENERATE_RECAP_VOICE_EVENT } from './aiScript/videoStoryEvents'
import { EarthGlobe } from './recap/EarthGlobe'
import { AiAnimationPanel } from './aiAnimation/AiAnimationPanel'
import { VideoStoryRecapControls } from './aiScript/VideoStoryRecapControls'

function RightSidebar(): JSX.Element {
  const { rightTab, setRightTab, setLeftView, openSettings, requestVideoStory } = useUiState()
  const recap = useRecapNarration()
  const { selectedSceneId } = useScenes()
  const { selectedTimelineClipIds, sequence } = useSequence()
  const { items } = useMedia()
  const narration = useNarration()
  const aiDubber = useAiDubber()
  const [autoVoicePending, setAutoVoicePending] = useState(false)
  const selectedClip = sequence.clips.find((clip) => selectedTimelineClipIds.includes(clip.id))
  const selectedVideo = items.find((item) => item.id === selectedClip?.mediaId && item.kind === 'video')

  useEffect(() => {
    const queue = (): void => setAutoVoicePending(true)
    window.addEventListener(AUTO_GENERATE_RECAP_VOICE_EVENT, queue)
    return () => window.removeEventListener(AUTO_GENERATE_RECAP_VOICE_EVENT, queue)
  }, [])

  useEffect(() => {
    if (!autoVoicePending || recap.progress || recap.blocker) return
    setAutoVoicePending(false)
    void recap.generate(true)
  }, [autoVoicePending, recap.progress, recap.blocker, recap.generate])

  // Jump to the Properties tab whenever a graphics clip or a Timeline clip
  // is selected -- suppressed while Story Narration or AI Dubber is active
  // so selecting a clip on the Timeline (e.g. to inspect a generated DUB1
  // clip) can never fight either special-mode panel for the right sidebar.
  useEffect(() => {
    if (narration.active || aiDubber.active) return
    if (selectedSceneId || selectedTimelineClipIds.length > 0) setRightTab('graphics')
  }, [selectedSceneId, selectedTimelineClipIds, setRightTab, narration.active, aiDubber.active])

  if (narration.active) return <RecordingAssistantPanel />
  if (aiDubber.active) return <VoiceModelPanel />

  return (
    <div className="right-column">
    <aside className="panel panel-brand">
      {/* AI Suggestions / Local AI Planner / Story Visuals live in the
          Settings dialog now (SettingsDialog.tsx's tool categories). */}
      <div className="panel-tabs">
        <button className={rightTab === 'graphics' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setRightTab('graphics')}>
          Properties
        </button>
        <button className={rightTab === 'brand' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setRightTab('brand')}>
          Brand Preset
        </button>
        <button className={rightTab === 'videoStory' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setRightTab('videoStory')} title="AI Video Story Narration">
          AI Story
        </button>
        <button className={rightTab === 'aiAnimation' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setRightTab('aiAnimation')} title="AI Animation">
          AI Animation
        </button>
      </div>
      {/* Nothing selected on the Timeline -> the project's own Details
          sheet, rather than a "select something" placeholder. */}
      {rightTab === 'graphics' &&
        (selectedTimelineClipIds.length > 0 ? <ClipPropertiesPanel /> : selectedSceneId ? <ScenePropertiesPanel /> : <ProjectDetailsPanel />)}
      {rightTab === 'brand' && <BrandPresetPanel />}
      {rightTab === 'videoStory' && <VideoStoryRecapControls />}
      {rightTab === 'aiAnimation' && <AiAnimationPanel />}
    </aside>
    {/* Its own strip under the panel, not part of it: one-click route to
        the Recap Script workspace (the same view the rail's AI button
        opens), with breathing room on every side. */}
    {/* Recap: with a script and a narrator voice in place this generates
        the narration outright (useRecapNarration); otherwise it opens the
        Recap Script panel so the missing piece can be added. */}
    <div className="recap-dock">
      {/* The Earth sits in a bite taken out of the button's left end. */}
      <div className={recap.blocker || recap.progress ? 'recap-launch' : 'recap-launch recap-launch-ready'}>
      <EarthGlobe className="recap-globe" size={40} />
      <button
        className={recap.blocker || recap.progress ? 'header-generate-button recap-button' : 'header-generate-button recap-button recap-button-ready'}
        title={
          recap.progress
            ? recap.progress.stage === 'generating'
              ? `Generating part ${recap.progress.completed} / ${recap.progress.total} -- click to stop`
              : recap.progress.stage === 'stitching'
                ? 'Joining the parts into one continuous narration…'
                : 'Placing the narration on the Timeline…'
            : recap.blocker === 'no-script'
              ? selectedVideo ? `Generate a Khmer story script from ${selectedVideo.fileName} with Gemini` : 'Select a video clip to generate its story script'
              : recap.blocker === 'no-narrator'
                ? 'Pick a narrator voice (My Voice) first'
                : recap.blocker === 'no-engine'
                  ? 'Set the VoxCPM2 install folder in Settings > Voice Engine first'
                  : `Generate the narration in ${recap.narratorName}'s voice -- one continuous clip`
        }
        onClick={() => {
          if (recap.progress) recap.cancel()
          else if (recap.blocker === 'no-engine') openSettings('voice')
          else if (recap.blocker === 'no-script') requestVideoStory()
          else if (recap.blocker) setLeftView('aiScript')
          else void recap.generate()
        }}
      >
        <SparkleIcon size={14} />{' '}
        {recap.progress
          ? recap.progress.stage === 'generating'
            ? `Generating ${recap.progress.completed}/${recap.progress.total}…`
            : recap.progress.stage === 'stitching'
              ? 'Joining audio…'
              : 'Placing…'
          : recap.blocker === 'no-script'
            ? selectedVideo ? 'AI · Generate Story Script' : 'Recap Script'
            : recap.blocker === 'no-narrator'
              ? 'Select Narrator Voice'
              : recap.blocker === 'no-engine'
                ? 'Set Up Voice Engine'
                : 'Recap · Generate Voice'}
      </button>
      </div>
    </div>
    </div>
  )
}

function LeftColumn(): JSX.Element {
  const { leftView } = useUiState()
  const narration = useNarration()
  const aiDubber = useAiDubber()
  // The Transcript / AI Suggestions strip under the Media grid is
  // user-resizable (drag its top edge), so a long transcript never
  // squeezes the media grid down to one row. Persisted per machine.
  const [splitHeight, setSplitHeightState] = useState(() => readStoredLeftSplitHeight())
  const setSplitHeight = useCallback((px: number) => {
    const next = clampLeftSplitHeight(px)
    setSplitHeightState(next)
    persistLeftSplitHeight(next)
  }, [])

  if (narration.active) {
    return (
      <aside className="panel panel-import">
        <h2>
          Narration Script <span className="narration-info-icon" title="Import a video and SRT, then record each subtitle segment into the Timeline">ⓘ</span>
        </h2>
        <NarrationScriptPanel />
      </aside>
    )
  }

  if (aiDubber.active) {
    return (
      <aside className="panel panel-import">
        <AiDubberScriptPanel />
      </aside>
    )
  }

  if (leftView === 'templates') {
    return (
      <aside className="panel panel-import">
        <TemplateBrowserPanel />
      </aside>
    )
  }

  if (leftView === 'aiScript') {
    return (
      <aside className="panel panel-import panel-ai-script">
        <AiScriptPanel />
      </aside>
    )
  }

  if (leftView === 'transcript') {
    return (
      <aside className="panel panel-import">
        <h2>Transcript</h2>
        <TranscriptPanel />
      </aside>
    )
  }

  return (
    <aside className="panel panel-import">
      {/* "Media" heading now rendered inside ImportPanel itself, below its
          own search/filter row -- see ImportPanel.tsx. */}
      <ImportPanel />
      <div className="left-column-split" style={{ height: splitHeight }}>
        <Splitter width={splitHeight} onChange={setSplitHeight} onReset={() => setSplitHeight(LEFT_SPLIT_DEFAULT)} side="bottom" axis="y" style={{ top: -3 }} />
        <div className="left-column-split-col">
          <h2>Transcript</h2>
          <TranscriptPreviewList />
        </div>
        <div className="left-column-split-col">
          <h2>AI Suggestions</h2>
          <AiSuggestionsPreviewList />
        </div>
      </div>
    </aside>
  )
}

/** While a take is being counted in or recorded, everything except the
 * Preview and the Timeline dims and stops accepting clicks: the two panels
 * you actually watch while narrating stay live, and a stray click on an
 * unrelated panel can't disturb the recording. Both recorders feed the same
 * flag -- the Timeline's own voiceover popover through UiState, and Story
 * Narration through its own phase. */
function AppShell(): JSX.Element {
  const { recordingFocus, homeOpen } = useUiState()

  // Home is a small centred launcher window; the editor takes the screen.
  useEffect(() => {
    void window.api.windowControls.setMode(homeOpen ? 'home' : 'editor')
  }, [homeOpen])
  const narration = useNarration()
  const narrationRecording = narration.phase === 'countdown' || narration.phase === 'recording'
  const recording = recordingFocus || narrationRecording

  // The panel that OWNS the active recorder must never be dimmed out --
  // Story Narration's Stop button lives in the right panel, so dimming it
  // would leave a recording running with no way to end it.
  const className = [
    'app-shell',
    recording ? 'app-shell-recording' : '',
    narrationRecording ? 'app-shell-recording-narration' : ''
  ]
    .filter(Boolean)
    .join(' ')

  // Any click that lands outside a text field takes keyboard focus away
  // from whichever text field had it. Normally the browser does this on its
  // own -- but several Timeline pointerdown handlers call preventDefault()
  // (to stop text selection during a drag), and that also cancels the
  // default focus change. So: click a subtitle's text box, then click a
  // clip, press S/Space/Delete -- and the keys still went to the text box,
  // where every Timeline shortcut is (correctly) ignored as typing. Capture
  // phase, so it runs before any child handler gets to preventDefault.
  const releaseTextFocus = (e: React.PointerEvent): void => {
    const target = e.target as HTMLElement | null
    if (isTextField(target)) return
    const active = document.activeElement as HTMLElement | null
    if (active && isTextField(active)) active.blur()
  }

  if (homeOpen) {
    return (
      <div className="app-shell">
        <HomeScreen />
        <SettingsDialog />
      </div>
    )
  }

  return (
    <div className={className} onPointerDownCapture={releaseTextFocus}>
      <Titlebar />
      <Workspace />
      <TimelineFooter />
      <ExportPanel />
      <SettingsDialog />
    </div>
  )
}

function isTextField(el: HTMLElement | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

function Workspace(): JSX.Element {
  const { widths, setLeftWidth, setRightWidth, resetLeftWidth, resetRightWidth } = useWorkspaceLayout()
  const { leftSplitterLeft, rightSplitterRight } = computeSplitterOffsets(widths, ICON_RAIL_WIDTH)

  return (
    <div className="workspace" style={{ gridTemplateColumns: buildWorkspaceGridColumns(widths, ICON_RAIL_WIDTH) }}>
      <IconRail />
      <LeftColumn />
      <main className="panel panel-preview">
        <PreviewPlayer />
      </main>
      <RightSidebar />
      <Splitter width={widths.leftWidth} onChange={setLeftWidth} onReset={resetLeftWidth} side="left" style={{ left: leftSplitterLeft - SPLITTER_HIT_WIDTH / 2 }} />
      <Splitter width={widths.rightWidth} onChange={setRightWidth} onReset={resetRightWidth} side="right" style={{ right: rightSplitterRight - SPLITTER_HIT_WIDTH / 2 }} />
    </div>
  )
}

/** Owns the Timeline panel's user-resizable height (see TimelineViewContext's
 * timelinePanelHeightPx) -- a thin wrapper so `useTimelineView()` can be
 * called from inside the provider tree while App() itself renders the
 * provider. The resize handle sits on the panel's own top edge; the panel is
 * the "bottom" side of that handle (dragging up grows it, down shrinks it). */
function TimelineFooter(): JSX.Element {
  const { timelinePanelHeightPx, setTimelinePanelHeightPx } = useTimelineView()
  return (
    <footer className="panel panel-timeline editor-scroll" style={{ height: timelinePanelHeightPx }}>
      <Splitter
        width={timelinePanelHeightPx}
        onChange={setTimelinePanelHeightPx}
        onReset={() => setTimelinePanelHeightPx(DEFAULT_TIMELINE_VIEW_PREFS.timelinePanelHeightPx)}
        side="bottom"
        axis="y"
        style={{ top: 0 }}
      />
      <Timeline />
    </footer>
  )
}

function App(): JSX.Element {
  return (
    <LicenseProvider>
      <LicenseGate>
        <MediaProvider>
      <PlaybackProvider>
        <TranscriptProvider>
          <CorrectionDictionaryProvider>
            <AiSuggestionsProvider>
              <LocalAiProvider>
                <SceneProvider>
                  <SequenceProvider>
                    <BrandPresetProvider>
                      <StoryProvider>
                        <HistoryProvider>
                          {/* UiStateProvider moved above ProjectProvider (was
                              nested inside it) so NarrationProvider/
                              AiDubberProvider -- which need both
                              useHistory() and useUiState() to capture/
                              restore the pre-entry left/right panel on
                              Story Narration/AI Dubber enter/exit -- can sit
                              between them while ProjectProvider (which needs
                              useNarration()/useAiDubber() for Save/Reopen)
                              stays an ancestor of both providers' own state.
                              No other provider here reads useUiState(), so
                              this reordering is otherwise inert. */}
                          <UiStateProvider>
                            <NarrationProvider>
                              <AiDubberProvider>
                                <ProjectProvider>
                                  <TimelineViewProvider>
                                    <ExportProvider>
                                      <ConfirmDialogProvider>
                                        <ThemeProvider>
                                          <AppShell />
                                        </ThemeProvider>
                                      </ConfirmDialogProvider>
                                    </ExportProvider>
                                  </TimelineViewProvider>
                                </ProjectProvider>
                              </AiDubberProvider>
                            </NarrationProvider>
                          </UiStateProvider>
                        </HistoryProvider>
                      </StoryProvider>
                    </BrandPresetProvider>
                  </SequenceProvider>
                </SceneProvider>
              </LocalAiProvider>
            </AiSuggestionsProvider>
          </CorrectionDictionaryProvider>
        </TranscriptProvider>
      </PlaybackProvider>
        </MediaProvider>
      </LicenseGate>
    </LicenseProvider>
  )
}

export default App

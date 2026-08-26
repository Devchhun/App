import { useEffect } from 'react'
import { MediaProvider } from './media/MediaContext'
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
import { AiSuggestionsPanel } from './suggestions/AiSuggestionsPanel'
import { LocalAiProvider } from './localAi/LocalAiContext'
import { ExportProvider } from './export/ExportContext'
import { ExportPanel } from './export/ExportPanel'
import { LocalAiPanel } from './localAi/LocalAiPanel'
import { StoryVisualsPanel } from './story/StoryVisualsPanel'
import { SceneProvider, useScenes } from './scenes/SceneContext'
import { SequenceProvider, useSequence } from './sequence/SequenceContext'
import { ScenePropertiesPanel } from './scenes/ScenePropertiesPanel'
import { ClipPropertiesPanel } from './sequence/ClipPropertiesPanel'
import { HistoryProvider } from './history/HistoryContext'
import { StoryProvider } from './story/StoryContext'
import { BrandPresetProvider } from './brand/BrandPresetContext'
import { BrandPresetPanel } from './brand/BrandPresetPanel'
import { UiStateProvider, useUiState } from './nav/UiStateContext'
import { Titlebar } from './nav/Titlebar'
import { IconRail } from './nav/IconRail'
import { TemplateBrowserPanel } from './templates/TemplateBrowserPanel'
import { TranscriptPreviewList } from './transcript/TranscriptPreviewList'
import { AiSuggestionsPreviewList } from './suggestions/AiSuggestionsPreviewList'
import { useWorkspaceLayout, ICON_RAIL_WIDTH } from './nav/useWorkspaceLayout'
import { Splitter } from './nav/Splitter'
import { buildWorkspaceGridColumns, computeSplitterOffsets, SPLITTER_HIT_WIDTH } from './nav/workspaceLayout'
import { DEFAULT_TIMELINE_VIEW_PREFS } from './timeline/timelineViewPrefs'

function RightSidebar(): JSX.Element {
  const { rightTab, setRightTab } = useUiState()
  const { selectedSceneId } = useScenes()
  const { selectedTimelineClipIds } = useSequence()

  // Jump to the Properties tab whenever a graphics clip or a Timeline clip
  // is selected.
  useEffect(() => {
    if (selectedSceneId || selectedTimelineClipIds.length > 0) setRightTab('graphics')
  }, [selectedSceneId, selectedTimelineClipIds, setRightTab])

  return (
    <aside className="panel panel-brand">
      <div className="panel-tabs">
        <button className={rightTab === 'ai' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setRightTab('ai')}>
          AI Suggestions
        </button>
        <button className={rightTab === 'localAi' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setRightTab('localAi')}>
          Local AI Planner
        </button>
        <button className={rightTab === 'story' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setRightTab('story')}>
          Story Visuals
        </button>
        <button className={rightTab === 'graphics' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setRightTab('graphics')}>
          Properties
        </button>
        <button className={rightTab === 'brand' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setRightTab('brand')}>
          Brand Preset
        </button>
      </div>
      {rightTab === 'ai' && <AiSuggestionsPanel />}
      {rightTab === 'localAi' && <LocalAiPanel />}
      {rightTab === 'story' && <StoryVisualsPanel />}
      {rightTab === 'graphics' && (selectedTimelineClipIds.length > 0 ? <ClipPropertiesPanel /> : <ScenePropertiesPanel />)}
      {rightTab === 'brand' && <BrandPresetPanel />}
    </aside>
  )
}

function LeftColumn(): JSX.Element {
  const { leftView } = useUiState()

  if (leftView === 'templates') {
    return (
      <aside className="panel panel-import">
        <h2>Templates</h2>
        <TemplateBrowserPanel />
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
      <h2>Media</h2>
      <ImportPanel />
      <div className="left-column-split">
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
                          <ProjectProvider>
                            <UiStateProvider>
                              <TimelineViewProvider>
                                <ExportProvider>
                                  <div className="app-shell">
                                    <Titlebar />
                                    <Workspace />
                                    <TimelineFooter />
                                    <ExportPanel />
                                  </div>
                                </ExportProvider>
                              </TimelineViewProvider>
                            </UiStateProvider>
                          </ProjectProvider>
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
  )
}

export default App

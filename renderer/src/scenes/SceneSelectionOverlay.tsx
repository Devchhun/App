import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useScenes } from './SceneContext'
import { useHistory } from '../history/HistoryContext'
import { getEffectivePresentationMode } from '@shared/templates'
import type { ScenePosition, SceneContentTransform } from '@shared/templates'
import type { BrandPreset } from '@shared/project'
import { computeDesignFit, type DesignFit } from '../templates/designScale'
import {
  applyContentDrag,
  applyScenePositionDrag,
  applyContentRotate,
  angleFromCenter,
  contentTransformToStageRect,
  positionToStageRect,
  canTransformScene,
  type ContentHandle,
  type PixelRect
} from './contentTransformMath'
import { resolveEffectiveContentTransform } from './contentTransformReflow'

interface Props {
  stageRef: RefObject<HTMLDivElement>
  currentTime: number
  brand: BrandPreset
}

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

interface DragState {
  handle: HandleId
  startX: number
  startY: number
  startPosition: ScenePosition
  stageWidth: number
  stageHeight: number
}

interface ContentDragState {
  kind: 'move' | 'resize' | 'rotate'
  handle: HandleId
  startClientX: number
  startClientY: number
  startTransform: SceneContentTransform
  fit: DesignFit
  centerClientX: number
  centerClientY: number
  startAngle: number
}

const HANDLES: Exclude<HandleId, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** Derives a starting `ScenePosition` from a measured pixel rect -- only
 * used the first time an overlay-mode scene with no explicit position is
 * dragged (there is no formula for "where is a template's own CSS-centered
 * default box," so that one case has to read it off the DOM once). */
function rectToPositionPct(rect: PixelRect, stageWidth: number, stageHeight: number): ScenePosition {
  return {
    xPct: (rect.left / stageWidth) * 100,
    yPct: (rect.top / stageHeight) * 100,
    widthPct: (rect.width / stageWidth) * 100,
    heightPct: (rect.height / stageHeight) * 100
  }
}

/** Selection outline + drag/resize handles for the selected graphics scene.
 *
 * The rect this component draws around and hit-tests against is resolved
 * the SAME way for every scene kind, and (for full-frame and explicit-
 * position scenes) is computed DIRECTLY from the scene's own transform --
 * never measured off the rendered DOM, and never the video stage's own
 * bounds:
 * - Full-frame scenes (Tech Title Scene / Device Compatibility Lineup /
 *   Cause and Effect Flow by default): `resolveEffectiveContentTransform`
 *   (the SAME function the template's own render calls) resolves the
 *   scene's `contentTransform` (explicit, or the template's aspect-specific
 *   default), then `contentTransformToStageRect` converts it to stage
 *   pixels via the same `computeDesignFit` the template's DesignCanvas
 *   uses -- so the rendered foreground and this overlay can never drift
 *   apart, and full-frame presentation never expands selection to the
 *   whole stage (that's the background's coordinate canvas, not the
 *   foreground's selection target).
 * - Overlay-mode scenes with an explicit Position & Size override: computed
 *   directly from `scene.position` (percent of the raw stage).
 * - Overlay-mode scenes with NO explicit position (the template's own
 *   unpositioned default CSS layout, e.g. a centered pill): there is no
 *   formula for this, so it's the one remaining case measured off the
 *   actual rendered DOM node (via `data-scene-id`). */
export function SceneSelectionOverlay({ stageRef, currentTime, brand }: Props): JSX.Element | null {
  const { scenesByMedia, selectedSceneId, updateScene } = useScenes()
  const { beginTransaction, endTransaction } = useHistory()
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null)
  const [domRect, setDomRect] = useState<PixelRect | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const contentDragRef = useRef<ContentDragState | null>(null)

  // Scenes are project-global (their startTime/endTime are already absolute
  // seconds) but SceneContext still buckets them internally by mediaId --
  // find whichever bucket the selected scene actually lives in instead of
  // requiring an external mediaId prop, so this overlay works regardless of
  // which Media asset (if any) is currently selected for inspection.
  const scene = selectedSceneId
    ? Object.values(scenesByMedia)
        .flat()
        .find((s) => s.id === selectedSceneId)
    : undefined
  const mediaId = scene?.mediaId ?? ''
  const isFullFrame = scene ? getEffectivePresentationMode(scene.templateId, scene.presentationMode) === 'full-frame' : false
  const needsDomMeasurement = Boolean(scene) && !isFullFrame && !scene?.position

  // Track the stage's own pixel size -- every computed-bounds path needs it,
  // and the DOM-measurement fallback needs to re-measure on layout resize.
  useEffect(() => {
    const stageEl = stageRef.current
    if (!stageEl) return
    const update = (): void => setStageSize({ width: stageEl.clientWidth, height: stageEl.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(stageEl)
    return () => observer.disconnect()
  }, [stageRef])

  const measureDom = useCallback(() => {
    if (!scene || !stageRef.current) {
      setDomRect(null)
      return
    }
    const stageRect = stageRef.current.getBoundingClientRect()
    const el = stageRef.current.querySelector<HTMLElement>(`[data-scene-id="${scene.id}"]`)
    if (!el) {
      setDomRect(null)
      return
    }
    const elRect = el.getBoundingClientRect()
    setDomRect({ left: elRect.left - stageRect.left, top: elRect.top - stageRect.top, width: elRect.width, height: elRect.height })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene?.id, scene?.templateId, scene?.presentationMode, stageRef])

  useEffect(() => {
    if (needsDomMeasurement) measureDom()
  }, [measureDom, currentTime, needsDomMeasurement])

  useEffect(() => {
    if (!needsDomMeasurement) return
    const stageEl = stageRef.current
    if (!stageEl) return
    const observer = new ResizeObserver(() => measureDom())
    observer.observe(stageEl)
    return () => observer.disconnect()
  }, [measureDom, stageRef, needsDomMeasurement])

  const rect: PixelRect | null = useMemo(() => {
    if (!scene || !stageSize) return null
    if (isFullFrame) {
      const fit = computeDesignFit(stageSize.width, stageSize.height, brand.defaultAspectRatio)
      const transform = resolveEffectiveContentTransform(scene, scene.templateId, brand.defaultAspectRatio)
      return contentTransformToStageRect(transform, fit)
    }
    if (scene.position) {
      return positionToStageRect(scene.position, stageSize.width, stageSize.height)
    }
    return domRect
  }, [scene, stageSize, isFullFrame, brand.defaultAspectRatio, domRect])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, handle: HandleId) => {
      if (!scene || !canTransformScene(scene) || !rect || !stageSize) return
      e.stopPropagation()
      e.preventDefault()
      const startPosition = scene.position ?? rectToPositionPct(rect, stageSize.width, stageSize.height)
      dragRef.current = { handle, startX: e.clientX, startY: e.clientY, startPosition, stageWidth: stageSize.width, stageHeight: stageSize.height }
      beginTransaction()
      if (!scene.position) updateScene(mediaId, scene.id, { position: startPosition })
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    },
    [scene, rect, stageSize, mediaId, updateScene, beginTransaction]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag || !scene) return
      const deltaXPct = ((e.clientX - drag.startX) / drag.stageWidth) * 100
      const deltaYPct = ((e.clientY - drag.startY) / drag.stageHeight) * 100
      // Delegates to the same shared drag/resize math SceneContentTransform
      // uses (see applyScenePositionDrag's doc comment). "Constrain to
      // canvas" defaults to off -- an off-canvas box is also always
      // recoverable, since the FULL resulting box is (re-)evaluated on every
      // pointer move rather than accumulating unclamped deltas.
      const nextPosition = applyScenePositionDrag(drag.startPosition, drag.handle, deltaXPct, deltaYPct, scene.lockAspectRatio ?? false, scene.constrainToCanvas ?? false)
      updateScene(mediaId, scene.id, { position: nextPosition })
    },
    [scene, mediaId, updateScene]
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (dragRef.current) {
        dragRef.current = null
        endTransaction()
      }
      if ((e.currentTarget as Element).hasPointerCapture?.(e.pointerId)) {
        ;(e.currentTarget as Element).releasePointerCapture(e.pointerId)
      }
    },
    [endTransaction]
  )

  const handleContentPointerDown = useCallback(
    (e: React.PointerEvent, handle: HandleId, kind: 'move' | 'resize' | 'rotate') => {
      if (!scene || !canTransformScene(scene) || !rect || !stageRef.current || !stageSize) return
      e.stopPropagation()
      e.preventDefault()
      const stageRect = stageRef.current.getBoundingClientRect()
      const fit = computeDesignFit(stageSize.width, stageSize.height, brand.defaultAspectRatio)
      const startTransform = resolveEffectiveContentTransform(scene, scene.templateId, brand.defaultAspectRatio)
      const centerClientX = stageRect.left + rect.left + rect.width / 2
      const centerClientY = stageRect.top + rect.top + rect.height / 2
      const startAngle = angleFromCenter(centerClientX, centerClientY, e.clientX, e.clientY)
      contentDragRef.current = { kind, handle, startClientX: e.clientX, startClientY: e.clientY, startTransform, fit, centerClientX, centerClientY, startAngle }
      beginTransaction()
      if (!scene.contentTransform) updateScene(mediaId, scene.id, { contentTransform: startTransform })
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    },
    [scene, rect, stageRef, stageSize, brand.defaultAspectRatio, mediaId, updateScene, beginTransaction]
  )

  const handleContentPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = contentDragRef.current
      if (!drag || !scene) return
      let next: SceneContentTransform
      if (drag.kind === 'rotate') {
        const currentAngle = angleFromCenter(drag.centerClientX, drag.centerClientY, e.clientX, e.clientY)
        next = applyContentRotate(drag.startTransform, drag.startAngle, currentAngle)
      } else {
        const deltaXPercent = ((e.clientX - drag.startClientX) / drag.fit.scale / drag.fit.designWidth) * 100
        const deltaYPercent = ((e.clientY - drag.startClientY) / drag.fit.scale / drag.fit.designHeight) * 100
        const dragHandle: ContentHandle = drag.kind === 'move' ? 'move' : (drag.handle as ContentHandle)
        next = applyContentDrag(drag.startTransform, dragHandle, deltaXPercent, deltaYPercent, scene.constrainToCanvas ?? false)
      }
      updateScene(mediaId, scene.id, { contentTransform: next })
    },
    [scene, mediaId, updateScene]
  )

  const handleContentPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (contentDragRef.current) {
        contentDragRef.current = null
        endTransaction()
      }
      if ((e.currentTarget as Element).hasPointerCapture?.(e.pointerId)) {
        ;(e.currentTarget as Element).releasePointerCapture(e.pointerId)
      }
    },
    [endTransaction]
  )

  if (!scene || !rect || scene.status === 'rejected') return null

  if (isFullFrame) {
    return (
      <div
        className="scene-selection-overlay scene-selection-overlay-content-group"
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      >
        {!scene.locked && (
          <div
            className="scene-selection-rotate-handle"
            onPointerDown={(e) => handleContentPointerDown(e, 'n', 'rotate')}
            onPointerMove={handleContentPointerMove}
            onPointerUp={handleContentPointerUp}
            onPointerCancel={handleContentPointerUp}
          />
        )}
        <div
          className={`scene-selection-box${scene.locked ? ' scene-selection-box-locked' : ''}`}
          onPointerDown={(e) => handleContentPointerDown(e, 'move', 'move')}
          onPointerMove={handleContentPointerMove}
          onPointerUp={handleContentPointerUp}
          onPointerCancel={handleContentPointerUp}
        />
        {!scene.locked &&
          HANDLES.map((h) => (
            <div
              key={h}
              className={`scene-selection-handle scene-selection-handle-${h}`}
              onPointerDown={(e) => handleContentPointerDown(e, h, 'resize')}
              onPointerMove={handleContentPointerMove}
              onPointerUp={handleContentPointerUp}
              onPointerCancel={handleContentPointerUp}
            />
          ))}
      </div>
    )
  }

  return (
    <div className="scene-selection-overlay" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
      <div
        className={`scene-selection-box${scene.locked ? ' scene-selection-box-locked' : ''}`}
        onPointerDown={(e) => handlePointerDown(e, 'move')}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      {!scene.locked &&
        HANDLES.map((h) => (
          <div
            key={h}
            className={`scene-selection-handle scene-selection-handle-${h}`}
            onPointerDown={(e) => handlePointerDown(e, h)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          />
        ))}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, type PointerEvent } from 'react'
import type { PreparedGlyph } from '@lib/animation/timeline'
import { canvasSize } from '@lib/project/coords'
import { layoutTextBox, type FontMetrics, type TextBoxLayout } from '@lib/project/layout'
import { buildRenderContext, renderTextBox } from '@lib/project/render'
import type { TextBox } from '@lib/project/schema'
import { slideTimeWindows } from '@lib/project/timing'
import { useVideoStore } from '../../state/videoStore'
import { BACKING_W, boxOriginPx, clientToNorm, drawSelection, hitTest, type NormPoint } from './layoutCanvas'
import { SlideOrderView } from './SlideOrderView'
import { ProjectPlayer } from './ProjectPlayer'
import { SlideVttExtract } from './SlideVttExtract'

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export function SlideCanvas({
  glyphs,
  metrics,
}: {
  glyphs: Map<string, PreparedGlyph>
  metrics: FontMetrics
}) {
  const project = useVideoStore((s) => s.project)
  const selectedSlideId = useVideoStore((s) => s.selectedSlideId)
  const selectedTextBoxId = useVideoStore((s) => s.selectedTextBoxId)
  const slideView = useVideoStore((s) => s.slideView)
  const selectTextBox = useVideoStore((s) => s.selectTextBox)
  const addTextBox = useVideoStore((s) => s.addTextBox)
  const updateTextBoxFrame = useVideoStore((s) => s.updateTextBoxFrame)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Live drag: the grabbed box's id, the pointer→origin offset, and the box's
  // current transient position (normalized). Written to the store only on release.
  const dragRef = useRef<{ boxId: string; offX: number; offY: number; x: number; y: number } | null>(null)
  const movedRef = useRef(false)
  const downNormRef = useRef<NormPoint | null>(null)
  const downHitRef = useRef<string | null>(null)

  const slide = project ? project.slides.find((s) => s.id === selectedSlideId) ?? project.slides[0] : undefined
  const baseEmFraction = project?.baseEmFraction ?? 0.085

  // Per-box layouts for the selected slide — memoized on the slide content,
  // available glyphs, size and canvas width.
  const layouts = useMemo(() => {
    const m = new Map<string, TextBoxLayout>()
    if (!slide) return m
    for (const box of slide.textBoxes) {
      m.set(box.id, layoutTextBox(box, glyphs, metrics, baseEmFraction, BACKING_W))
    }
    return m
  }, [slide, glyphs, metrics, baseEmFraction])

  // The selected slide's project-time window, for the read-only voiceover extract.
  const slideWindow = useMemo(() => {
    if (!project || !slide || slideView !== 'layout') return null
    const rc = buildRenderContext(project, glyphs, BACKING_W, metrics, project.playbackRate ?? 1)
    return slideTimeWindows(rc.timing).find((x) => x.slideId === slide.id) ?? null
  }, [project, slide, glyphs, metrics, slideView])

  // Paint the slide. `drag`, when set, overrides one box's origin with its live
  // transient position so a drag-in-progress repaints without writing the model
  // (and thus without re-deriving the `layouts` memo). Used by both the static
  // draw effect (drag=null) and pointermove (drag=the grabbed box).
  const drawScene = useCallback(
    (drag?: { boxId: string; x: number; y: number } | null) => {
      const canvas = canvasRef.current
      if (!canvas || !project || !slide) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const { w, h } = canvasSize(project.aspect, BACKING_W)
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = slide.background
      ctx.fillRect(0, 0, w, h)
      const minHalfWidth = metrics.unitsPerEm * 0.004
      const originFor = (box: TextBox) =>
        drag && drag.boxId === box.id ? { x: drag.x * w, y: drag.y * w } : boxOriginPx(box, w)
      for (const box of slide.textBoxes) {
        const layout = layouts.get(box.id)
        if (!layout) continue
        renderTextBox(ctx, layout, originFor(box), box.brush ?? project.brush, Infinity, minHalfWidth)
      }
      const selBox = slide.textBoxes.find((b) => b.id === selectedTextBoxId)
      if (selBox) {
        const l = layouts.get(selBox.id)
        if (l) drawSelection(ctx, selBox, l, w, undefined, originFor(selBox))
      }
    },
    [project, slide, layouts, selectedTextBoxId, metrics],
  )

  // Static draw whenever the slide, its layouts, or the selection change.
  useEffect(() => {
    if (slideView !== 'layout') return
    drawScene(null)
  }, [drawScene, slideView])

  if (!project || !slide) return <div className="stage video-stage">No slide.</div>

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const p = clientToNorm(canvas, e.clientX, e.clientY)
    downNormRef.current = p
    movedRef.current = false
    const hit = hitTest(slide, layouts, p.nx, p.ny, BACKING_W)
    downHitRef.current = hit
    if (hit) {
      const box = slide.textBoxes.find((b) => b.id === hit)
      if (!box) return
      selectTextBox(hit)
      // Deferred write (mirrors the timeline leader lines): we hold the grabbed
      // box's live position locally and commit it to the store exactly once on
      // release — so there's no zundo pause/resume to strand (it's a plain flag),
      // and dragging never re-derives layouts or churns history every frame.
      dragRef.current = { boxId: hit, offX: p.nx - box.frame.x, offY: p.ny - box.frame.y, x: box.frame.x, y: box.frame.y }
      canvas.setPointerCapture(e.pointerId)
    }
  }

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    const canvas = canvasRef.current
    if (!d || !canvas) return
    const p = clientToNorm(canvas, e.clientX, e.clientY)
    if (!movedRef.current) {
      const dn = downNormRef.current
      if (dn && Math.hypot((p.nx - dn.nx) * BACKING_W, (p.ny - dn.ny) * BACKING_W) < 3) return
      movedRef.current = true
    }
    // Local move only: update the transient position and repaint this canvas —
    // no store write (the model and the layouts memo stay untouched).
    d.x = clamp01(p.nx - d.offX)
    d.y = clamp01(p.ny - d.offY)
    drawScene({ boxId: d.boxId, x: d.x, y: d.y })
  }

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const d = dragRef.current
    if (d) {
      dragRef.current = null
      try {
        canvas?.releasePointerCapture(e.pointerId)
      } catch {
        /* never captured, or already lost (e.g. pointercancel) */
      }
      // Commit the whole gesture as one store write ≡ one undo step. The store
      // update re-renders and the effect repaints at the committed position. A
      // bare click (no movement past the threshold) only (re)selected the box —
      // nothing to write.
      if (movedRef.current) updateTextBoxFrame(slide.id, d.boxId, { x: d.x, y: d.y })
      return
    }
    if (!downHitRef.current && !movedRef.current) {
      const p = downNormRef.current
      if (selectedTextBoxId) selectTextBox(null)
      else if (p) addTextBox(slide.id, clamp01(p.nx), clamp01(p.ny))
    }
  }

  // Interrupted gesture (pointercancel) → abandon the move and snap the box back
  // to its model position; nothing is written (matches the leader-line drag).
  const onPointerCancel = () => {
    if (dragRef.current) {
      dragRef.current = null
      drawScene(null)
    }
  }

  return (
    <div className="slidecanvas">
      {slideView === 'order' ? (
        <SlideOrderView glyphs={glyphs} metrics={metrics} />
      ) : slideView === 'play' ? (
        <ProjectPlayer glyphs={glyphs} metrics={metrics} />
      ) : (
        <>
          <div className="stage stage-overlay video-stage">
            <canvas
              ref={canvasRef}
              className="slide-canvas-el"
              width={canvasSize(project.aspect, BACKING_W).w}
              height={canvasSize(project.aspect, BACKING_W).h}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
            />
          </div>
          {slideWindow && (
            <SlideVttExtract cues={project.voiceover ?? []} startMs={slideWindow.startMs} endMs={slideWindow.endMs} />
          )}
        </>
      )}
    </div>
  )
}

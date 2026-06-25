import { useEffect, useMemo, useRef, type PointerEvent } from 'react'
import type { PreparedGlyph } from '@lib/animation/timeline'
import { canvasSize } from '@lib/project/coords'
import { layoutTextBox, type FontMetrics, type TextBoxLayout } from '@lib/project/layout'
import { buildRenderContext, renderTextBox } from '@lib/project/render'
import { slideTimeWindows } from '@lib/project/timing'
import { useVideoStore, videoHistory } from '../../state/videoStore'
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
  const dragRef = useRef<{ boxId: string; offX: number; offY: number } | null>(null)
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

  // Static draw whenever the slide, its layouts, or the selection change.
  useEffect(() => {
    if (slideView !== 'layout') return
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
    for (const box of slide.textBoxes) {
      const layout = layouts.get(box.id)
      if (!layout) continue
      renderTextBox(ctx, layout, boxOriginPx(box, w), box.brush ?? project.brush, Infinity, minHalfWidth)
    }
    const selBox = slide.textBoxes.find((b) => b.id === selectedTextBoxId)
    if (selBox) {
      const l = layouts.get(selBox.id)
      if (l) drawSelection(ctx, selBox, l, w)
    }
  }, [project, slide, layouts, selectedTextBoxId, slideView, metrics])

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
      dragRef.current = { boxId: hit, offX: p.nx - box.frame.x, offY: p.ny - box.frame.y }
      videoHistory.pause()
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
    updateTextBoxFrame(slide.id, d.boxId, { x: clamp01(p.nx - d.offX), y: clamp01(p.ny - d.offY) })
  }

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (dragRef.current) {
      // resume + commit a single undo entry for the whole drag gesture
      videoHistory.resume()
      dragRef.current = null
      canvas?.releasePointerCapture(e.pointerId)
      return
    }
    if (!downHitRef.current && !movedRef.current) {
      const p = downNormRef.current
      if (selectedTextBoxId) selectTextBox(null)
      else if (p) addTextBox(slide.id, clamp01(p.nx), clamp01(p.ny))
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

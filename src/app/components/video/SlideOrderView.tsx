import { useCallback, useMemo } from 'react'
import type { PreparedGlyph } from '@lib/animation/timeline'
import type { FontMetrics } from '@lib/project/layout'
import { buildRenderContext, renderSlide } from '@lib/project/render'
import { useVideoStore } from '../../state/videoStore'
import { BACKING_W } from './layoutCanvas'
import { AnimationOrderList } from './AnimationOrderList'
import { PlaybackCanvas } from './PlaybackCanvas'

/**
 * Animation-order view: plays the selected slide's writing-on (boxes in order,
 * with per-box delays) followed by its closing transition, via `renderSlide` on
 * a shared PlaybackCanvas. Below the canvas, the order list reorders boxes /
 * tunes delays.
 */
export function SlideOrderView({ glyphs, metrics }: { glyphs: Map<string, PreparedGlyph>; metrics: FontMetrics }) {
  const project = useVideoStore((s) => s.project)
  const selectedSlideId = useVideoStore((s) => s.selectedSlideId)

  const slideIndex = project ? Math.max(0, project.slides.findIndex((s) => s.id === selectedSlideId)) : -1
  const slide = project && slideIndex >= 0 ? project.slides[slideIndex] : undefined

  const rc = useMemo(
    () => (project ? buildRenderContext(project, glyphs, BACKING_W, metrics) : null),
    [project, glyphs, metrics],
  )
  const totalMs = rc && slideIndex >= 0 ? rc.timing.slides[slideIndex]?.timing.totalMs ?? 0 : 0

  const ready = useMemo(() => {
    if (!slide) return false
    for (const box of slide.textBoxes)
      for (const run of box.runs)
        for (const ch of run.text) if (ch.trim().length && !glyphs.has(ch)) return false
    return true
  }, [slide, glyphs])

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, t: number, w: number, h: number) => {
      if (rc && project && slideIndex >= 0) renderSlide(ctx, project, rc, slideIndex, t, w, h)
    },
    [rc, project, slideIndex],
  )

  if (!project || !slide) return <div className="stage video-stage">No slide.</div>

  return (
    <div className="orderview">
      <PlaybackCanvas aspect={project.aspect} totalMs={totalMs} ready={ready} resetKey={selectedSlideId ?? ''} draw={draw} autoPlay />
      <div className="order-head">
        Animation order — drag to reorder; “+ms” delays each box after the previous one finishes.
      </div>
      <AnimationOrderList slideId={slide.id} boxes={slide.textBoxes} />
    </div>
  )
}

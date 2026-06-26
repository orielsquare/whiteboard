import { useEffect, useMemo, useRef } from 'react'
import { aspectHeightUnits } from '@lib/project/coords'
import { boxForAspect } from '@lib/project/aspect'
import { layoutTextBox, type FontSet } from '@lib/project/layout'
import { renderTextBox } from '@lib/project/render'
import type { Slide } from '@lib/project/schema'
import { useVideoStore } from '../../state/videoStore'
import { boxOriginPx } from './layoutCanvas'

/** Backing height of a thumbnail in px (2× the ~40px display height, for crispness). */
const THUMB_BACK_H = 80

/**
 * A small static preview of one slide. Renders **once per content signature**
 * (effect-gated), reusing the same pure render path as the main canvas — so the
 * thumbnail always matches the layout view.
 */
export function SlideThumbnail({
  slide,
  fonts,
}: {
  slide: Slide
  fonts: FontSet
}) {
  const aspect = useVideoStore((s) => s.activeAspect)
  const baseEmFraction = useVideoStore((s) => s.project?.baseEmFraction ?? 0.085)
  const brush = useVideoStore((s) => s.project?.brush)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // A cheap signature of everything that affects the rendered pixels.
  const sig = useMemo(
    () =>
      JSON.stringify({
        a: aspect,
        e: baseEmFraction,
        bg: slide.background,
        br: brush && [brush.style, brush.color, brush.sizeScale, brush.opacity, brush.jitter],
        boxes: slide.textBoxes.map((b) => ({
          f: [b.frame[aspect].x, b.frame[aspect].y, b.frame[aspect].w],
          al: b.align,
          lh: b.lineHeightScale,
          d: b.interCharDelayMs,
          bx: b.brush && [b.brush.style, b.brush.color, b.brush.sizeScale, b.brush.opacity, b.brush.jitter],
          r: b.runs.map((r) => [r.text, r.sizeScale ?? 1, r.color ?? '', !!r.underline, r.letterSpacing ?? 0, r.fontId ?? '']),
        })),
      }),
    [aspect, baseEmFraction, brush, slide],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const aspectH = aspectHeightUnits(aspect)
    const w = Math.max(1, Math.round(THUMB_BACK_H / aspectH))
    const h = Math.round(w * aspectH)
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = slide.background
    ctx.fillRect(0, 0, w, h)
    if (!brush) return
    for (const box of slide.textBoxes) {
      const fb = boxForAspect(box, aspect)
      const layout = layoutTextBox(fb, fonts, baseEmFraction, w)
      renderTextBox(ctx, layout, boxOriginPx(fb, w), fb.brush ?? brush, Infinity)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, fonts])

  return (
    <span className="slide-thumb">
      <canvas ref={canvasRef} className="slide-thumb-canvas" />
    </span>
  )
}

import { samplePart, type PreparedDrawing } from './timeline'
import { paintStroke } from '@lib/render/brush'
import type { Transform } from '@lib/render/ribbon'
import type { Bbox, BrushSettings } from '@lib/manifest/schema'

/** A prepared drawing plus the viewBox its geometry lives in (for placement). */
export interface PreparedDrawingEntry {
  prepared: PreparedDrawing
  viewBox: Bbox
}

/** All drawings a project may render with, keyed by drawingId (mirrors FontSet). */
export type DrawingSet = Map<string, PreparedDrawingEntry>

/**
 * Shared pure renderer for a prepared drawing — used by the Drawing tool, the
 * Video editor/preview, and the headless MP4 exporter, so all three match.
 * A drawing is painted into a viewBox→px transform; each part draws with its own
 * colour/alpha over the base brush (the brush supplies texture: chalk/ink/marker).
 */

/** A drawing's viewBox → canvas-px transform: the drawing's width fills `wPx` at
 *  top-left `(xPx,yPx)`, height follows the viewBox aspect (no distortion). */
export function drawingTransform(viewBox: Bbox, xPx: number, yPx: number, wPx: number): Transform {
  const scale = wPx / Math.max(viewBox.w, 1)
  return { scale, ox: xPx - viewBox.x * scale, oy: yPx - viewBox.y * scale }
}

/** The px height a drawing occupies when its width is `wPx`. */
export function drawingHeightPx(viewBox: Bbox, wPx: number): number {
  return (wPx / Math.max(viewBox.w, 1)) * viewBox.h
}

/** A minimum stroke half-width sized to the drawing's viewBox units. */
export function drawingMinHalfWidth(viewBox: Bbox): number {
  return Math.max(0.4, viewBox.w * 0.0015)
}

/**
 * Paint a prepared drawing at time `t` (ms since it began drawing) through `tr`.
 * Parts are already z-ordered (prepareDrawing sorts them), so painting in array
 * order respects the stacking order. `ruboutFrac` (0..1) retracts the last
 * fraction of every revealed stroke — used by the slide closing-transition rubout
 * (sample fully drawn at t=Infinity, then erase the tail). Pure — only draws on ctx.
 */
export function renderPreparedDrawing(
  ctx: CanvasRenderingContext2D,
  prepared: PreparedDrawing,
  tr: Transform,
  brush: BrushSettings,
  minHalfWidth: number,
  t: number,
  ruboutFrac = 0,
): void {
  const keep = ruboutFrac > 0 ? 1 - ruboutFrac : 1
  if (keep <= 0) return
  for (const p of prepared.parts) {
    const rv = samplePart(p, t)
    const b =
      p.color != null || p.opacity != null
        ? { ...brush, color: p.color ?? brush.color, opacity: p.opacity ?? brush.opacity }
        : brush
    rv.segs.forEach((s, j) => {
      const len = s.revealedLen * keep
      if (len > 0) paintStroke(ctx, s.lut, len, tr, b, minHalfWidth, `${p.id}:${j}`)
    })
  }
}

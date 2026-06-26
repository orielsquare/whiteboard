import { aspectWidthFraction } from '@lib/project/coords'
import type { Aspect } from '@lib/project/schema'
import type { FlatBox, FlatSlide } from '@lib/project/aspect'
import type { TextBoxLayout } from '@lib/project/layout'

/**
 * Coordinate + hit-test helpers for the slide layout canvas. They operate on
 * flattened (single-aspect) boxes whose `frame` is width-units (x,w fractions of
 * width; y in width-units), so a single conversion pair maps pointer events ↔
 * normalized coords through the canvas backing size + getBoundingClientRect.
 */

/** Backing width (px) of the 16:9 (landscape) editor preview; CSS scales the
 *  canvas to fit. The font basis for both cuts (the 16:9-equivalent width). */
export const BACKING_W = 960

/** The per-aspect preview backing width: 16:9 = BACKING_W, 9:16 = 9/16·BACKING_W
 *  (so the portrait preview is genuinely 9/16 as wide, same area). All editor
 *  geometry (canvas size, hit-test, origins) runs at this width; the font basis
 *  stays BACKING_W via `buildRenderContext`. */
export function previewCanvasW(aspect: Aspect): number {
  return BACKING_W * aspectWidthFraction(aspect)
}

export interface NormPoint {
  nx: number
  ny: number
}

/** Client (CSS px) → normalized (width-units), via the canvas backing size. */
export function clientToNorm(canvas: HTMLCanvasElement, clientX: number, clientY: number): NormPoint {
  const rect = canvas.getBoundingClientRect()
  const pxX = ((clientX - rect.left) * canvas.width) / (rect.width || 1)
  const pxY = ((clientY - rect.top) * canvas.height) / (rect.height || 1)
  return { nx: pxX / canvas.width, ny: pxY / canvas.width }
}

/** Normalized (width-units) → canvas px. */
export function normToCanvas(nx: number, ny: number, canvasW: number): { x: number; y: number } {
  return { x: nx * canvasW, y: ny * canvasW }
}

/** A box's content origin (top-left) in canvas px. */
export function boxOriginPx(box: FlatBox, canvasW: number): { x: number; y: number } {
  return { x: box.frame.x * canvasW, y: box.frame.y * canvasW }
}

/** A box's bounding rect in normalized (width-units) from its laid-out size. */
export function boxBoundsNorm(box: FlatBox, layout: TextBoxLayout, canvasW: number) {
  return {
    x: box.frame.x,
    y: box.frame.y,
    w: layout.widthPx / canvasW,
    h: layout.heightPx / canvasW,
  }
}

/**
 * Topmost (last-drawn) box whose bounds contain the normalized point, or null.
 * `canvasW` is the backing width the layouts were computed at; a px pad keeps
 * thin/empty boxes clickable.
 */
export function hitTest(
  slide: FlatSlide,
  layouts: Map<string, TextBoxLayout>,
  nx: number,
  ny: number,
  canvasW: number,
  padPx = 6,
): string | null {
  const padNorm = padPx / canvasW
  for (let i = slide.textBoxes.length - 1; i >= 0; i--) {
    const box = slide.textBoxes[i]
    const layout = layouts.get(box.id)
    if (!layout) continue
    const b = boxBoundsNorm(box, layout, canvasW)
    if (nx >= b.x - padNorm && nx <= b.x + b.w + padNorm && ny >= b.y - padNorm && ny <= b.y + b.h + padNorm) {
      return box.id
    }
  }
  return null
}

/** Draw a dashed selection ring around a box's content bounds. */
export function drawSelection(
  ctx: CanvasRenderingContext2D,
  box: FlatBox,
  layout: TextBoxLayout,
  canvasW: number,
  color = '#5b9dff',
  // While a box is being dragged its model position is unchanged, so callers
  // pass the transient origin to draw the ring at the box's live spot.
  origin?: { x: number; y: number },
): void {
  const o = origin ?? boxOriginPx(box, canvasW)
  const w = layout.widthPx
  const h = layout.heightPx
  const pad = 4
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 4])
  ctx.strokeRect(o.x - pad, o.y - pad, w + pad * 2, h + pad * 2)
  ctx.restore()
}

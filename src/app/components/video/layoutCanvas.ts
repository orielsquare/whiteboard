import type { Slide, TextBox } from '@lib/project/schema'
import type { TextBoxLayout } from '@lib/project/layout'

/**
 * Coordinate + hit-test helpers for the slide layout canvas. All project
 * geometry is normalized to canvas WIDTH (1.0 = full width; y in width-units),
 * so a single conversion pair maps pointer events ↔ normalized coords through
 * the canvas backing size + getBoundingClientRect (mirrors editorCanvas).
 */

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
export function boxOriginPx(box: TextBox, canvasW: number): { x: number; y: number } {
  return { x: box.frame.x * canvasW, y: box.frame.y * canvasW }
}

/** A box's bounding rect in normalized (width-units) from its laid-out size. */
export function boxBoundsNorm(box: TextBox, layout: TextBoxLayout, canvasW: number) {
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
  slide: Slide,
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
  box: TextBox,
  layout: TextBoxLayout,
  canvasW: number,
  color = '#5b9dff',
): void {
  const o = boxOriginPx(box, canvasW)
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

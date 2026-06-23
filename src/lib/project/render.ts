import { sampleGlyph } from '@lib/animation/timeline'
import type { BrushSettings } from '@lib/manifest/schema'
import { paintStroke } from '@lib/render/brush'
import type { Transform } from '@lib/render/ribbon'
import type { TextBoxLayout } from './layout'

/**
 * Render a laid-out textbox at local time `tLocalMs` (ms since the box began
 * drawing). Pure w.r.t. inputs — the only side effect is drawing on `ctx`. This
 * is the seam shared by the live layout view, thumbnails, per-slide playback and
 * a future headless exporter.
 *
 * `originPx` is the box's top-left in canvas px. Underlines grow with the writing
 * and are drawn under the ink. A **static** (fully-drawn) render is just
 * `tLocalMs = Infinity`.
 */
export function renderTextBox(
  ctx: CanvasRenderingContext2D,
  layout: TextBoxLayout,
  originPx: { x: number; y: number },
  brush: BrushSettings,
  tLocalMs: number,
  minHalfWidth: number,
): void {
  // underlines first, so the ink sits on top
  for (const u of layout.underlines) {
    const span = u.revealAtMs - u.startMs
    const frac = span > 0 ? clamp01((tLocalMs - u.startMs) / span) : tLocalMs >= u.startMs ? 1 : 0
    if (frac <= 0) continue
    const x0 = originPx.x + u.x0Px
    const x1 = originPx.x + u.x0Px + frac * (u.x1Px - u.x0Px)
    const y = originPx.y + u.yPx
    fillRoundedBar(ctx, x0, y, x1 - x0, u.thicknessPx, u.color ?? brush.color, brush.opacity)
  }

  for (const inst of layout.instances) {
    const tr: Transform = {
      scale: inst.scale,
      ox: originPx.x + inst.xPx,
      oy: originPx.y + inst.baselineYPx,
    }
    const { reveals } = sampleGlyph(inst.prepared, tLocalMs - inst.startMs)
    const b = inst.color ? { ...brush, color: inst.color } : brush
    for (const r of reveals) {
      if (r.revealedLen <= 0 && !r.active) continue
      paintStroke(ctx, r.lut, r.revealedLen, tr, b, minHalfWidth, inst.seedSalt + r.id)
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** A horizontal rounded bar centred vertically on `cy`, width `w`, thickness `h`. */
function fillRoundedBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  cy: number,
  w: number,
  h: number,
  color: string,
  opacity: number,
): void {
  if (w <= 0 || h <= 0) return
  const r = Math.min(h / 2, w / 2)
  const top = cy - h / 2
  ctx.save()
  ctx.globalAlpha = opacity
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x + r, top)
  ctx.lineTo(x + w - r, top)
  ctx.arc(x + w - r, top + r, r, -Math.PI / 2, Math.PI / 2)
  ctx.lineTo(x + r, top + h)
  ctx.arc(x + r, top + r, r, Math.PI / 2, -Math.PI / 2)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

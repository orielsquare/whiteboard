import { revealVertices, type StrokeLUT } from '@lib/geometry/polyline'
import { hashStr, mulberry32 } from '@lib/geometry/rng'
import type { BrushSettings } from '@lib/manifest/schema'
import { drawRibbon, toCanvas, type Transform } from './ribbon'

/**
 * Paint a revealed stroke with the chosen brush. Shape comes from the
 * variable-width ribbon (orthogonal fronts); the brush decides the texture.
 * `seedKey` (the section id) makes chalk grain deterministic & reproducible.
 */
export function paintStroke(
  ctx: CanvasRenderingContext2D,
  lut: StrokeLUT,
  revealedLen: number,
  tr: Transform,
  brush: BrushSettings,
  minHalfWidth: number,
  seedKey: string,
) {
  if (revealedLen <= 0) return
  if (brush.style === 'chalk') paintChalk(ctx, lut, revealedLen, tr, brush, minHalfWidth, seedKey)
  else if (brush.style === 'marker') paintMarker(ctx, lut, revealedLen, tr, brush, minHalfWidth)
  else paintInk(ctx, lut, revealedLen, tr, brush, minHalfWidth)
}

function paintInk(
  ctx: CanvasRenderingContext2D,
  lut: StrokeLUT,
  revealedLen: number,
  tr: Transform,
  brush: BrushSettings,
  minHalfWidth: number,
) {
  ctx.save()
  ctx.globalAlpha = brush.opacity
  drawRibbon(ctx, lut, revealedLen, tr, {
    fill: brush.color,
    cap: 'round',
    minHalfWidth,
    widthScale: brush.sizeScale,
  })
  ctx.restore()
}

function paintMarker(
  ctx: CanvasRenderingContext2D,
  lut: StrokeLUT,
  revealedLen: number,
  tr: Transform,
  brush: BrushSettings,
  minHalfWidth: number,
) {
  // translucent + flat nib → overlaps build up where strokes cross
  ctx.save()
  ctx.globalAlpha = Math.min(1, brush.opacity * 0.8)
  drawRibbon(ctx, lut, revealedLen, tr, {
    fill: brush.color,
    cap: 'flat',
    minHalfWidth: minHalfWidth * 1.3,
    widthScale: brush.sizeScale * 1.15,
  })
  ctx.restore()
}

function paintChalk(
  ctx: CanvasRenderingContext2D,
  lut: StrokeLUT,
  revealedLen: number,
  tr: Transform,
  brush: BrushSettings,
  minHalfWidth: number,
  seedKey: string,
) {
  const verts = revealVertices(lut, revealedLen)
  if (verts.length === 0) return

  ctx.save()
  // faint dusty base so the stroke reads as continuous
  ctx.globalAlpha = 0.16 * brush.opacity
  drawRibbon(ctx, lut, revealedLen, tr, {
    fill: brush.color,
    cap: 'round',
    minHalfWidth,
    widthScale: brush.sizeScale,
  })

  // grain: scatter seeded specks across the stroke width
  ctx.fillStyle = brush.color
  const base = hashStr(seedKey)
  const grains = 4 + Math.round(brush.jitter * 4)
  const n = verts.length
  for (let i = 0; i < n; i++) {
    const prev = verts[Math.max(0, i - 1)].pos
    const next = verts[Math.min(n - 1, i + 1)].pos
    let tx = next.x - prev.x
    let ty = next.y - prev.y
    const l = Math.hypot(tx, ty) || 1
    tx /= l
    ty /= l
    const nx = -ty
    const ny = tx
    const hw = Math.max((verts[i].width / 2) * brush.sizeScale, minHalfWidth)
    const rng = mulberry32((base ^ Math.imul(i, 2654435761)) >>> 0)
    for (let g = 0; g < grains; g++) {
      const off = (rng() * 2 - 1) * hw
      const along = (rng() - 0.5) * hw * 0.7
      const gx = verts[i].pos.x + nx * off + tx * along
      const gy = verts[i].pos.y + ny * off + ty * along
      const c = toCanvas(tr, gx, gy)
      ctx.globalAlpha = (rng() * 0.5 + 0.25) * brush.opacity
      const r = rng() * 1.6 + 0.5
      ctx.beginPath()
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()
}

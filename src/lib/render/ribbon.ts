import { revealVertices, type StrokeLUT } from '@lib/geometry/polyline'
import type { Vec2 } from '@lib/geometry/vec'

/** Uniform glyph-units → canvas-px transform (scale is isotropic). */
export interface Transform {
  scale: number
  ox: number
  oy: number
}

export const toCanvas = (tr: Transform, x: number, y: number): Vec2 => ({
  x: x * tr.scale + tr.ox,
  y: y * tr.scale + tr.oy,
})

export interface RibbonStyle {
  fill: string
  cap?: 'flat' | 'round'
  /** Minimum half-width in glyph units, so very thin strokes still render. */
  minHalfWidth?: number
  /** Multiply the stroke width (brush size). */
  widthScale?: number
}

/**
 * Build the variable-width ribbon for a stroke revealed up to `revealedLen` and
 * fill it. The ribbon edges are offset ±halfWidth along the per-vertex normal,
 * so every cross-section — including the moving front — is orthogonal to the
 * centerline (no axis-aligned wipe). Round caps optionally added at the ends.
 */
export function drawRibbon(
  ctx: CanvasRenderingContext2D,
  lut: StrokeLUT,
  revealedLen: number,
  tr: Transform,
  style: RibbonStyle,
): { tip: Vec2 | null } {
  const verts = revealVertices(lut, revealedLen)
  if (verts.length === 0) return { tip: null }

  const minHW = style.minHalfWidth ?? 0
  const ws = style.widthScale ?? 1
  ctx.fillStyle = style.fill

  // single point → dot
  if (verts.length === 1) {
    const c = toCanvas(tr, verts[0].pos.x, verts[0].pos.y)
    const r = Math.max(1, Math.max((verts[0].width / 2) * ws, minHW) * tr.scale)
    ctx.beginPath()
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2)
    ctx.fill()
    return { tip: c }
  }

  const n = verts.length
  const left: Vec2[] = new Array(n)
  const right: Vec2[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const prev = verts[Math.max(0, i - 1)].pos
    const next = verts[Math.min(n - 1, i + 1)].pos
    let tx = next.x - prev.x
    let ty = next.y - prev.y
    const l = Math.hypot(tx, ty) || 1
    tx /= l
    ty /= l
    // normal = tangent rotated 90°
    const nx = -ty
    const ny = tx
    const hw = Math.max((verts[i].width / 2) * ws, minHW)
    const p = verts[i].pos
    left[i] = toCanvas(tr, p.x + nx * hw, p.y + ny * hw)
    right[i] = toCanvas(tr, p.x - nx * hw, p.y - ny * hw)
  }

  ctx.beginPath()
  ctx.moveTo(left[0].x, left[0].y)
  for (let i = 1; i < n; i++) ctx.lineTo(left[i].x, left[i].y)
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y)
  ctx.closePath()
  ctx.fill()

  // round caps (start = pen down, end = current front)
  if (style.cap !== 'flat') {
    const startC = toCanvas(tr, verts[0].pos.x, verts[0].pos.y)
    const endC = toCanvas(tr, verts[n - 1].pos.x, verts[n - 1].pos.y)
    ctx.beginPath()
    ctx.arc(startC.x, startC.y, Math.max(0.5, (verts[0].width / 2) * ws * tr.scale), 0, Math.PI * 2)
    ctx.arc(endC.x, endC.y, Math.max(0.5, (verts[n - 1].width / 2) * ws * tr.scale), 0, Math.PI * 2)
    ctx.fill()
  }

  return { tip: toCanvas(tr, verts[n - 1].pos.x, verts[n - 1].pos.y) }
}

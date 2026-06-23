import { orderedSections } from '@lib/manifest/edit'
import type { GlyphAnimation } from '@lib/manifest/schema'
import { toCanvas, type Transform } from '@lib/render/ribbon'
import type { Vec2 } from '@lib/geometry/vec'
import { hashStr } from '@lib/geometry/rng'

export function computeGlyphTransform(
  bbox: { x: number; y: number; w: number; h: number },
  W: number,
  H: number,
  margin = 60,
): Transform {
  const bw = Math.max(bbox.w, 1)
  const bh = Math.max(bbox.h, 1)
  const scale = Math.min((W - margin * 2) / bw, (H - margin * 2) / bh)
  return {
    scale,
    ox: (W - bw * scale) / 2 - bbox.x * scale,
    oy: (H - bh * scale) / 2 - bbox.y * scale,
  }
}

/** Stable colour for a stroke, derived from its id so it stays put on reorder. */
export function strokeColor(id: string): string {
  return `hsl(${hashStr(id) % 360}, 72%, 62%)`
}

/** Draw the static, editable section view (colour = draw order, arrows = direction). */
export function drawEditable(
  canvas: HTMLCanvasElement,
  glyph: GlyphAnimation,
  tr: Transform,
  selectedIds: Set<string>,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width
  const H = canvas.height
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = '#0b0d11'
  ctx.fillRect(0, 0, W, H)

  // baseline
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(20, tr.oy)
  ctx.lineTo(W - 20, tr.oy)
  ctx.stroke()

  const ordered = orderedSections(glyph)

  ordered.forEach((s, pos) => {
    const color = strokeColor(s.id)
    const selected = selectedIds.has(s.id)
    const pts = s.reversed ? [...s.points].reverse() : [...s.points]
    if (pts.length === 0) return

    // width body
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = color.replace('hsl(', 'hsla(').replace(')', ', 0.22)')
    for (let i = 1; i < pts.length; i++) {
      const a = toCanvas(tr, pts[i - 1].x, pts[i - 1].y)
      const b = toCanvas(tr, pts[i].x, pts[i].y)
      ctx.lineWidth = Math.max(1, ((pts[i - 1].width + pts[i].width) / 2) * tr.scale)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }

    // selection halo
    if (selected) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 3
      strokePolyline(ctx, tr, pts)
    }

    // bright centerline
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    strokePolyline(ctx, tr, pts)

    // direction arrow at the draw end
    if (pts.length >= 2) {
      const tip = toCanvas(tr, pts[pts.length - 1].x, pts[pts.length - 1].y)
      const ref = toCanvas(tr, pts[Math.max(0, pts.length - 4)].x, pts[Math.max(0, pts.length - 4)].y)
      arrow(ctx, ref, tip, color)
    }

    // order number at the draw start
    const start = toCanvas(tr, pts[0].x, pts[0].y)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(start.x, start.y, 9, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#0b0d11'
    ctx.font = 'bold 11px ui-sans-serif, system-ui'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(pos + 1), start.x, start.y + 0.5)
  })
}

function strokePolyline(ctx: CanvasRenderingContext2D, tr: Transform, pts: { x: number; y: number }[]) {
  ctx.beginPath()
  const p0 = toCanvas(tr, pts[0].x, pts[0].y)
  ctx.moveTo(p0.x, p0.y)
  for (let i = 1; i < pts.length; i++) {
    const p = toCanvas(tr, pts[i].x, pts[i].y)
    ctx.lineTo(p.x, p.y)
  }
  ctx.stroke()
}

function arrow(ctx: CanvasRenderingContext2D, from: Vec2, to: Vec2, color: string) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x)
  const size = 9
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - size * Math.cos(ang - 0.4), to.y - size * Math.sin(ang - 0.4))
  ctx.lineTo(to.x - size * Math.cos(ang + 0.4), to.y - size * Math.sin(ang + 0.4))
  ctx.closePath()
  ctx.fill()
}

export interface Pick {
  sectionId: string
  pointIndex: number // raw index into section.points
  distPx: number
}

/** Nearest section + raw point index to a canvas-space point (for select / split). */
export function pickNearest(
  glyph: GlyphAnimation,
  tr: Transform,
  pt: Vec2,
  maxDistPx = 28,
): Pick | null {
  let best: Pick | null = null
  for (const s of glyph.sections) {
    for (let i = 0; i < s.points.length; i++) {
      const c = toCanvas(tr, s.points[i].x, s.points[i].y)
      const d = Math.hypot(c.x - pt.x, c.y - pt.y)
      if (!best || d < best.distPx) best = { sectionId: s.id, pointIndex: i, distPx: d }
    }
  }
  return best && best.distPx <= maxDistPx ? best : null
}

import { buildLUT, type StrokeLUT } from '@lib/geometry/polyline'
import { paintStroke } from '@lib/render/brush'
import type { BrushSettings, StrokePoint } from '@lib/manifest/schema'
import type { Transform } from '@lib/render/ribbon'
import type { InkPoint, InkTool, SlideInk } from './schema'

/**
 * Direct-drawing ("ink") geometry + animation, pure and framework-free — shared
 * by the editor canvas, the preview and the headless exporter. All geometry here
 * is in FLAT width units (x and y both fractions of canvas WIDTH — isotropic, so
 * distances/angles are meaningful); `aspect.ts` converts the stored
 * fraction-of-height y on the way in, exactly like frames.
 */

/** Standard ink pen width (full width, fraction of canvas width) at widthScale 1. */
export const INK_BASE_WIDTH = 0.007
/** Minimum half-width so thin ink still renders (fraction units). */
export const INK_MIN_HALF_WIDTH = 0.0012
/** Drawing pace: canvas-width units per ms (≈ half the canvas in ~0.6s). */
const INK_PACE = 0.00083
/** Natural per-stroke duration bounds (ms). */
const MIN_STROKE_MS = 180
const MAX_STROKE_MS = 4000
/** Pen-lift before an arrowhead (ms). */
const HEAD_LIFT_MS = 90
/** Arrowhead: length relative to the shaft (capped) and half-angle. */
const HEAD_FRAC = 0.22
const HEAD_MAX = 0.06
const HEAD_MIN = 0.018
const HEAD_ANGLE = Math.PI / 7

const dist = (a: InkPoint, b: InkPoint) => Math.hypot(b.x - a.x, b.y - a.y)

export function polylineLength(pts: InkPoint[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i])
  return l
}

/** Drop micro-jitter: keep points at least `spacing` apart (ends preserved). */
export function resamplePoints(pts: InkPoint[], spacing: number): InkPoint[] {
  if (pts.length <= 2) return pts.slice()
  const out: InkPoint[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    if (dist(out[out.length - 1], pts[i]) >= spacing) out.push(pts[i])
  }
  out.push(pts[pts.length - 1])
  return out
}

/** Ramer–Douglas–Peucker simplification (keeps the shape, sheds the noise). */
export function simplifyRdp(pts: InkPoint[], eps: number): InkPoint[] {
  if (pts.length <= 2) return pts.slice()
  const keep = new Array<boolean>(pts.length).fill(false)
  keep[0] = keep[pts.length - 1] = true
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const A = pts[a]
    const B = pts[b]
    const abx = B.x - A.x
    const aby = B.y - A.y
    const ab2 = abx * abx + aby * aby || 1
    let worst = -1
    let worstD = eps
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i].x - A.x) * abx + (pts[i].y - A.y) * aby) / ab2))
      const d = Math.hypot(pts[i].x - (A.x + t * abx), pts[i].y - (A.y + t * aby))
      if (d > worstD) {
        worstD = d
        worst = i
      }
    }
    if (worst > 0) {
      keep[worst] = true
      stack.push([a, worst], [worst, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/** Centripetal-ish Catmull-Rom through the points (the "coerce to curve" pass). */
export function smoothCatmullRom(pts: InkPoint[], samplesPerSeg = 8): InkPoint[] {
  if (pts.length <= 2) return pts.slice()
  const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))]
  const out: InkPoint[] = [pts[0]]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = P(i - 1)
    const p1 = P(i)
    const p2 = P(i + 1)
    const p3 = P(i + 2)
    for (let s = 1; s <= samplesPerSeg; s++) {
      const t = s / samplesPerSeg
      const t2 = t * t
      const t3 = t2 * t
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      })
    }
  }
  return out
}

/**
 * Coerce a raw pointer trace into the tool's final polyline (FLAT width units):
 * freehand keeps the hand (lightly resampled), line/arrow snap to their two
 * ends, curve simplifies then smooths. Returns [] for degenerate input.
 */
export function coerceInkPoints(tool: InkTool, raw: InkPoint[]): InkPoint[] {
  const pts = resamplePoints(raw, 0.004)
  if (pts.length < 2 || polylineLength(pts) < 0.008) return []
  switch (tool) {
    case 'freehand':
      return pts
    case 'line':
    case 'arrow':
      return [pts[0], pts[pts.length - 1]]
    case 'curve':
      return smoothCatmullRom(simplifyRdp(pts, 0.01))
  }
}

/** The ink's pen sections: the main path, plus arrowhead wings for `arrow`. */
export function inkSections(tool: InkTool, pts: InkPoint[]): InkPoint[][] {
  if (pts.length < 2) return []
  if (tool !== 'arrow') return [pts]
  const tip = pts[pts.length - 1]
  const prev = pts[pts.length - 2]
  const ang = Math.atan2(tip.y - prev.y, tip.x - prev.x)
  const len = Math.min(HEAD_MAX, Math.max(HEAD_MIN, polylineLength(pts) * HEAD_FRAC))
  const wing = (side: 1 | -1): InkPoint[] => [
    {
      x: tip.x - Math.cos(ang + side * HEAD_ANGLE) * len,
      y: tip.y - Math.sin(ang + side * HEAD_ANGLE) * len,
    },
    tip,
  ]
  // shaft first, then the two wings — the pen finishes the line, lifts, adds the head
  return [pts, wing(1), wing(-1)]
}

export interface PreparedInkSeg {
  lut: StrokeLUT
  startMs: number
  durationMs: number
}

export interface PreparedInk {
  segs: PreparedInkSeg[]
  /** natural drawing time (ms) — the timing model's contentMs for this ink. */
  totalMs: number
}

const toStroke = (pts: InkPoint[], width: number): StrokePoint[] => pts.map((p) => ({ x: p.x, y: p.y, width }))

/**
 * Prepare a FLAT ink for animation: build each section's LUT and give it a
 * duration from its arc length at the standard pace (a pen-lift before the
 * arrowhead). Pure; memoize per ink.
 */
export function prepareInk(ink: Pick<SlideInk, 'tool' | 'points' | 'widthScale'>): PreparedInk {
  const width = INK_BASE_WIDTH * (ink.widthScale && ink.widthScale > 0 ? ink.widthScale : 1)
  const segs: PreparedInkSeg[] = []
  let cursor = 0
  const sections = inkSections(ink.tool, ink.points)
  sections.forEach((pts, i) => {
    const lut = buildLUT(toStroke(pts, width))
    if (lut.total <= 0) return
    if (i > 0) cursor += HEAD_LIFT_MS // pen-lift before each arrowhead wing
    const durationMs = Math.min(MAX_STROKE_MS, Math.max(i > 0 ? 80 : MIN_STROKE_MS, lut.total / INK_PACE))
    segs.push({ lut, startMs: cursor, durationMs })
    cursor += durationMs
  })
  return { segs, totalMs: cursor }
}

/**
 * Paint a prepared ink at time `t` (ms since its block began; Infinity = fully
 * drawn) into a canvas of width `canvasW` px. `ruboutFrac` retracts the tail of
 * every stroke (the closing-transition rubout). Pure — only draws on ctx.
 */
export function renderInk(
  ctx: CanvasRenderingContext2D,
  prepared: PreparedInk,
  canvasW: number,
  brush: BrushSettings,
  color: string | null | undefined,
  t: number,
  seedKey: string,
  ruboutFrac = 0,
): void {
  const keep = ruboutFrac > 0 ? 1 - ruboutFrac : 1
  if (keep <= 0) return
  const tr: Transform = { scale: canvasW, ox: 0, oy: 0 }
  const b = color != null ? { ...brush, color } : brush
  prepared.segs.forEach((s, i) => {
    const local = t - s.startMs
    const frac = local <= 0 ? 0 : local >= s.durationMs ? 1 : local / s.durationMs
    const len = frac * s.lut.total * keep
    if (len > 0) paintStroke(ctx, s.lut, len, tr, b, INK_MIN_HALF_WIDTH, `${seedKey}:${i}`)
  })
}

/** Axis-aligned bounds of a FLAT ink (for the selection ring), width units. */
export function inkBounds(pts: InkPoint[]): { x: number; y: number; w: number; h: number } | null {
  if (!pts.length) return null
  let x0 = pts[0].x
  let y0 = pts[0].y
  let x1 = x0
  let y1 = y0
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Distance from a point to the ink's polyline (width units) — the hit test. */
export function inkHitDistance(pts: InkPoint[], p: InkPoint): number {
  if (!pts.length) return Infinity
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const A = pts[i - 1]
    const B = pts[i]
    const abx = B.x - A.x
    const aby = B.y - A.y
    const ab2 = abx * abx + aby * aby || 1
    const t = Math.max(0, Math.min(1, ((p.x - A.x) * abx + (p.y - A.y) * aby) / ab2))
    const d = Math.hypot(p.x - (A.x + t * abx), p.y - (A.y + t * aby))
    if (d < best) best = d
  }
  return pts.length === 1 ? Math.hypot(p.x - pts[0].x, p.y - pts[0].y) : best
}

import { dist, distToSegment, polylineLength, type Vec2 } from '@lib/geometry/vec'
import { sampleField } from './distanceTransform'
import { rasterToGlyph, type RasterMask } from './raster'
import type { ExtractionParams, SectionKind } from './types'

export interface CleanSection {
  points: Vec2[] // glyph units
  widths: number[] // glyph units, parallel to points
  kind: SectionKind
}

/**
 * Turn a raw skeleton pixel run into a clean, smooth centerline with a per-point
 * width profile, expressed in glyph units.
 *   simplify (RDP) → detect hard corners → corner-preserving Catmull-Rom smooth →
 *   even arc-length resample → sample stroke width from the distance field.
 */
export function cleanupSection(
  pixels: number[],
  kind: SectionKind,
  mask: RasterMask,
  dt: Float32Array,
  params: ExtractionParams,
  freeStart = false,
  freeEnd = false,
): CleanSection {
  const raster: Vec2[] = pixels.map((i) => ({ x: i % mask.width, y: Math.floor(i / mask.width) }))

  if (raster.length === 1) {
    const g = rasterToGlyph(mask, raster[0].x, raster[0].y)
    const wpx = 2 * sampleField(dt, mask.width, mask.height, raster[0].x, raster[0].y)
    return { points: [g], widths: [wpx / mask.scale], kind }
  }

  const isLoop = kind === 'loop'
  const simplified = rdp(raster, params.rdpEpsilonPx)

  let shaped: Vec2[]
  if (params.smooth && simplified.length >= 3) {
    const corners = detectCorners(simplified, params.cornerAngleDeg, isLoop)
    shaped = smoothWithCorners(simplified, corners, isLoop)
  } else {
    shaped = simplified
  }

  const resampled = resampleByArcLength(shaped, params.resampleSpacingPx)

  const points: Vec2[] = new Array(resampled.length)
  const widths: number[] = new Array(resampled.length)
  for (let i = 0; i < resampled.length; i++) {
    const r = resampled[i]
    points[i] = rasterToGlyph(mask, r.x, r.y)
    const wpx = 2 * sampleField(dt, mask.width, mask.height, r.x, r.y)
    widths[i] = wpx / mask.scale
  }

  // Extend free terminals outward by ~half the local stroke width, compensating
  // the medial-axis retraction so the centerline reaches the visual stroke tip.
  if (freeStart && points.length >= 2) {
    const r = widths[0] / 2
    const dx = points[0].x - points[1].x
    const dy = points[0].y - points[1].y
    const l = Math.hypot(dx, dy) || 1
    points.unshift({ x: points[0].x + (dx / l) * r, y: points[0].y + (dy / l) * r })
    widths.unshift(widths[0])
  }
  if (freeEnd && points.length >= 2) {
    const n = points.length
    const r = widths[n - 1] / 2
    const dx = points[n - 1].x - points[n - 2].x
    const dy = points[n - 1].y - points[n - 2].y
    const l = Math.hypot(dx, dy) || 1
    points.push({ x: points[n - 1].x + (dx / l) * r, y: points[n - 1].y + (dy / l) * r })
    widths.push(widths[n - 1])
  }

  return { points, widths, kind }
}

// --- Ramer–Douglas–Peucker -------------------------------------------------

export function rdp(points: Vec2[], epsilon: number): Vec2[] {
  if (points.length < 3) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  rdpRec(points, 0, points.length - 1, epsilon, keep)
  const out: Vec2[] = []
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i])
  return out
}

function rdpRec(pts: Vec2[], lo: number, hi: number, eps: number, keep: Uint8Array) {
  if (hi <= lo + 1) return
  let maxD = -1
  let idx = -1
  for (let i = lo + 1; i < hi; i++) {
    const d = distToSegment(pts[i], pts[lo], pts[hi])
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD > eps && idx !== -1) {
    keep[idx] = 1
    rdpRec(pts, lo, idx, eps, keep)
    rdpRec(pts, idx, hi, eps, keep)
  }
}

// --- corner detection ------------------------------------------------------

function detectCorners(pts: Vec2[], angleDeg: number, isLoop: boolean): Set<number> {
  const thresh = (angleDeg * Math.PI) / 180
  const corners = new Set<number>()
  const n = pts.length
  for (let i = 1; i < n - 1; i++) {
    if (turnAngle(pts[i - 1], pts[i], pts[i + 1]) > thresh) corners.add(i)
  }
  if (isLoop && n > 2) {
    if (turnAngle(pts[n - 2], pts[0], pts[1]) > thresh) corners.add(0)
  }
  return corners
}

function turnAngle(a: Vec2, b: Vec2, c: Vec2): number {
  const v1x = b.x - a.x
  const v1y = b.y - a.y
  const v2x = c.x - b.x
  const v2y = c.y - b.y
  const l1 = Math.hypot(v1x, v1y)
  const l2 = Math.hypot(v2x, v2y)
  if (l1 === 0 || l2 === 0) return 0
  let cos = (v1x * v2x + v1y * v2y) / (l1 * l2)
  cos = Math.max(-1, Math.min(1, cos))
  return Math.acos(cos)
}

// --- centripetal Catmull-Rom smoothing, segmented at corners ----------------

function smoothWithCorners(pts: Vec2[], corners: Set<number>, isLoop: boolean): Vec2[] {
  // Split into runs at corner indices; smooth each run independently so corners
  // stay sharp. (Loops with a corner are treated as an open run for simplicity.)
  const breaks: number[] = [0]
  for (let i = 1; i < pts.length - 1; i++) if (corners.has(i)) breaks.push(i)
  breaks.push(pts.length - 1)

  if (breaks.length === 2 && isLoop && corners.size === 0) {
    return catmullRom(pts, true)
  }

  const out: Vec2[] = []
  for (let b = 0; b < breaks.length - 1; b++) {
    const run = pts.slice(breaks[b], breaks[b + 1] + 1)
    const smoothed = catmullRom(run, false)
    if (b > 0) smoothed.shift() // avoid duplicating the shared corner point
    out.push(...smoothed)
  }
  return out
}

const SAMPLES_PER_SEG = 12

function catmullRom(points: Vec2[], closed: boolean): Vec2[] {
  if (points.length < 3) return points.slice()
  const p = closed
    ? [points[points.length - 1], ...points, points[0], points[1]]
    : [points[0], ...points, points[points.length - 1]]

  const out: Vec2[] = []
  const last = closed ? p.length - 2 : p.length - 2
  for (let i = 1; i < last; i++) {
    crSegment(p[i - 1], p[i], p[i + 1], p[i + 2], out)
  }
  out.push(points[points.length - 1])
  return out
}

/** Centripetal Catmull-Rom (alpha = 0.5) sampling of the segment p1→p2. */
function crSegment(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, out: Vec2[]) {
  const alpha = 0.5
  const t0 = 0
  const t1 = t0 + Math.max(1e-6, Math.pow(dist(p0, p1), alpha))
  const t2 = t1 + Math.max(1e-6, Math.pow(dist(p1, p2), alpha))
  const t3 = t2 + Math.max(1e-6, Math.pow(dist(p2, p3), alpha))
  for (let s = 0; s < SAMPLES_PER_SEG; s++) {
    const t = t1 + ((t2 - t1) * s) / SAMPLES_PER_SEG
    const a1 = lerpT(p0, p1, t, t0, t1)
    const a2 = lerpT(p1, p2, t, t1, t2)
    const a3 = lerpT(p2, p3, t, t2, t3)
    const b1 = lerpT(a1, a2, t, t0, t2)
    const b2 = lerpT(a2, a3, t, t1, t3)
    out.push(lerpT(b1, b2, t, t1, t2))
  }
}

function lerpT(a: Vec2, b: Vec2, t: number, ta: number, tb: number): Vec2 {
  const d = tb - ta
  const u = d === 0 ? 0 : (t - ta) / d
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
}

// --- even arc-length resampling --------------------------------------------

export function resampleByArcLength(points: Vec2[], spacing: number): Vec2[] {
  if (points.length < 2) return points.slice()
  const total = polylineLength(points)
  if (total === 0) return [points[0]]
  const n = Math.max(1, Math.round(total / spacing))
  const step = total / n
  const out: Vec2[] = [points[0]]
  let segIdx = 1
  let segStart = points[0]
  let segEnd = points[1]
  let segLen = dist(segStart, segEnd)
  let acc = 0
  for (let i = 1; i < n; i++) {
    const target = i * step
    while (acc + segLen < target && segIdx < points.length - 1) {
      acc += segLen
      segIdx++
      segStart = points[segIdx - 1]
      segEnd = points[segIdx]
      segLen = dist(segStart, segEnd)
    }
    const t = segLen === 0 ? 0 : (target - acc) / segLen
    out.push({ x: segStart.x + (segEnd.x - segStart.x) * t, y: segStart.y + (segEnd.y - segStart.y) * t })
  }
  out.push(points[points.length - 1])
  return out
}

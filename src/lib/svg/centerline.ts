import type { Vec2 } from '@lib/geometry/vec'
import type { GenSection, StrokeParams, StrokePoint } from './types'

/**
 * Convert a flattened SVG outline polyline into a pen-stroke centerline section.
 * Unlike fonts (where the centerline is recovered by skeletonizing a raster),
 * an SVG path **is** the centerline already, so this is just even-resampling +
 * a constant pen width — no CV. Pure (inlines its only helper) so it runs in
 * isolation and headless. `closed` keeps a loop's last≈first vertex.
 */
export function strokeFromPolyline(
  poly: Vec2[],
  widthPx: number,
  params: StrokeParams,
  closed = false,
): GenSection | null {
  const pts = resample(poly, params.resampleSpacingPx)
  if (pts.length < 2) return null
  const w = Math.max(widthPx, params.minWidthPx ?? 0)
  const points: StrokePoint[] = pts.map((p) => ({ x: p.x, y: p.y, width: w }))
  return { points, kind: closed ? 'loop' : 'curve', role: 'outline' }
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Resample a polyline to an even arc-length spacing, preserving the endpoints. */
function resample(poly: Vec2[], spacing: number): Vec2[] {
  if (poly.length < 2 || spacing <= 0) return poly.slice()
  const out: Vec2[] = [{ x: poly[0].x, y: poly[0].y }]
  let carry = 0
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]
    const b = poly[i]
    const d = dist(a, b)
    if (d === 0) continue
    let t0 = 0
    while (carry + (1 - t0) * d >= spacing) {
      const t = t0 + (spacing - carry) / d
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
      t0 = t
      carry = 0
    }
    carry += (1 - t0) * d
  }
  const last = poly[poly.length - 1]
  if (dist(out[out.length - 1], last) > 1e-6) out.push({ x: last.x, y: last.y })
  return out
}

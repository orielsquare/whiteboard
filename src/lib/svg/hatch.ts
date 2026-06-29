import type { Vec2 } from '@lib/geometry/vec'
import type { FillParams, GenSection, StrokePoint } from './types'

/**
 * Generate diagonal "hand-shading" hatch strokes that fill a set of polygons.
 *
 * Input polygons are closed subpaths in viewBox units (y-down); holes are
 * expressed as additional subpaths under the **even-odd** fill rule. The output
 * is a set of constant-width pen strokes that zigzag across the shape — a
 * right-hander's diagonal shading — ready to feed the same ribbon/reveal
 * pipeline as glyph strokes. Pure (analytic scanline; no canvas), so it runs
 * identically in the editor and a future headless exporter.
 *
 * Approach: pick the hatch direction `u` (and unit perpendicular `v`), march one
 * scan line per `spacing` across the shape's `v`-extent, analytically intersect
 * each line with every polygon edge, pair the sorted crossings (even-odd) into
 * inside segments, and emit each segment as its OWN section. Keeping lines
 * separate (rather than merging into one zigzag) is what makes the "colouring-in"
 * work: each line is a separate ribbon fill, so where `line width > spacing` they
 * overlap and build up evenly under a <1 alpha. Boustrophedon order (alternate
 * direction per line) keeps the reveal a natural back-and-forth sweep and gives
 * downstream per-stroke fill easing a real per-line cadence.
 */
export function generateHatch(polygons: Vec2[][], params: FillParams): GenSection[] {
  const { angleDeg, spacingPx, lineWidthPx } = params
  const jitter = params.jitter ?? 0
  const wobbleDeg = params.lineWobbleDeg ?? 0
  if (polygons.length === 0 || spacingPx <= 0) return []

  const th = (angleDeg * Math.PI) / 180
  // u = hatch direction (slopes up-to-the-right for positive angle in y-down
  // space); v = unit perpendicular (the scan axis). {u,v} is orthonormal.
  const u: Vec2 = { x: Math.cos(th), y: -Math.sin(th) }
  const v: Vec2 = { x: Math.sin(th), y: Math.cos(th) }

  // perpendicular extent of every polygon vertex → scan range along v.
  let dMin = Infinity
  let dMax = -Infinity
  for (const poly of polygons) {
    for (const p of poly) {
      const d = p.x * v.x + p.y * v.y
      if (d < dMin) dMin = d
      if (d > dMax) dMax = d
    }
  }
  if (!isFinite(dMin) || dMax - dMin < 1e-6) return []

  // one scan line per spacing; collect inside segments (paired crossings) per line.
  interface Seg {
    aIn: number
    aOut: number
  }
  const lines: { d: number; segs: Seg[] }[] = []
  let li = 0
  for (let base = dMin + spacingPx / 2; base < dMax; base += spacingPx, li++) {
    // small deterministic offset to dodge exact vertex hits + add hand-wobble.
    const d = base + (jitter ? (pseudo(li) - 0.5) * spacingPx * jitter * 0.5 : 0)
    const crossings: number[] = []
    for (const poly of polygons) {
      const n = poly.length
      if (n < 2) continue
      for (let i = 0; i < n; i++) {
        const A = poly[i]
        const B = poly[(i + 1) % n]
        const sA = A.x * v.x + A.y * v.y - d
        const sB = B.x * v.x + B.y * v.y - d
        // half-open at 0 so a vertex exactly on the line is counted once.
        if (sA < 0 === sB < 0) continue
        const t = sA / (sA - sB)
        const ix = A.x + (B.x - A.x) * t
        const iy = A.y + (B.y - A.y) * t
        crossings.push(ix * u.x + iy * u.y) // coordinate along u
      }
    }
    if (crossings.length < 2) continue
    crossings.sort((a, b) => a - b)
    const segs: Seg[] = []
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      segs.push({ aIn: crossings[k], aOut: crossings[k + 1] })
    }
    if (segs.length) lines.push({ d, segs })
  }

  // Emit one section PER hatch line (no merged zigzag), in boustrophedon order.
  const pointAt = (a: number, d: number): StrokePoint => ({
    x: u.x * a + v.x * d,
    y: u.y * a + v.y * d,
    width: lineWidthPx,
  })
  const sections: GenSection[] = []
  let runSeed = 0x9e3779b9
  lines.forEach((ln, idx) => {
    const fwd = idx % 2 === 0
    const ordered = fwd ? ln.segs : [...ln.segs].reverse()
    for (const s of ordered) {
      const p0 = pointAt(fwd ? s.aIn : s.aOut, ln.d)
      const p1 = pointAt(fwd ? s.aOut : s.aIn, ln.d)
      // With wobble, subdivide the line and nudge interior vertices perpendicular
      // by a bounded, detrended random walk (pinned at both ends) → a hand stroke.
      const points =
        wobbleDeg > 0
          ? wobbleRun(p0, p1, wobbleDeg, lineWidthPx, spacingPx, makeRng((runSeed = (runSeed + 0x6d2b79f5) | 0)))
          : [p0, p1]
      sections.push({ points, kind: 'line', role: 'fill' })
    }
  })
  return sections
}

/** A hand-drawn version of the straight segment p0→p1: subdivided, with each
 *  interior vertex offset perpendicular by a clamped random walk, then detrended
 *  so both endpoints land exactly on the line (the stroke stays within a band of
 *  the ideal line — no drift, no crossing into the neighbouring hatch line). */
function wobbleRun(
  p0: StrokePoint,
  p1: StrokePoint,
  maxDeg: number,
  lineWidth: number,
  spacing: number,
  rng: () => number,
): StrokePoint[] {
  const dx = p1.x - p0.x
  const dy = p1.y - p0.y
  const L = Math.hypot(dx, dy)
  if (L < 1e-6) return [p0, p1]
  const nx = -dy / L
  const ny = dx / L
  const n = Math.max(2, Math.min(40, Math.round(L / 5)))
  const amp = (L / n) * Math.tan((maxDeg * Math.PI) / 180)
  const band = Math.min(spacing * 0.35, amp * 6)
  const walk: number[] = new Array(n + 1)
  walk[0] = 0
  for (let i = 1; i <= n; i++) {
    const v = walk[i - 1] + (rng() * 2 - 1) * amp
    walk[i] = v < -band ? -band : v > band ? band : v
  }
  const drift = walk[n]
  const pts: StrokePoint[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const off = walk[i] - drift * t // pin both ends to the ideal line
    pts.push({ x: p0.x + dx * t + nx * off, y: p0.y + dy * t + ny * off, width: lineWidth })
  }
  return pts
}

/** Small seeded PRNG (mulberry32) for deterministic, reproducible wobble. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic [0,1) hash for the per-line wobble (no Math.random). */
function pseudo(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

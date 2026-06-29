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
 * each line with every polygon edge, and pair the sorted crossings (even-odd) into
 * inside segments. Rather than drawing each line flat, the strokes are TILTED into a
 * continuous ZIG-ZAG: we walk ADJACENT scan lines and emit one "tooth" per gap, each
 * climbing the full `spacing` from one line's boundary crossing to the next line's.
 * The tooth direction alternates per gap (boustrophedon): an up-RIGHT tooth is a
 * "zig" (angled just ABOVE the basic hatch direction); the next up-LEFT tooth is a
 * "zag" (just BELOW it). Because each tooth ends exactly where the next begins (a
 * shared boundary crossing), the pen traces one unbroken zig-zag sweep — the end of
 * one line is the start of the next — and because both endpoints are real crossings
 * the teeth never overshoot the shape. Segments are paired by left-to-right column
 * index, so a hole's two sides (or any disjoint regions a scan line crosses) zig-zag
 * independently. The teeth are emitted COLUMN-MAJOR — one column's whole chain top to
 * bottom before the next starts — so the reveal sweeps one connected region at a time
 * rather than growing every column at once. Each tooth is its OWN section (not a
 * single merged path), which preserves the timeline's per-line reveal cadence and
 * keeps each a separate ribbon fill, so where `line width > spacing` they overlap and
 * build up evenly under a <1 alpha. Pure (analytic scanline; no canvas).
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

  const pointAt = (a: number, d: number): StrokePoint => ({
    x: u.x * a + v.x * d,
    y: u.y * a + v.y * d,
    width: lineWidthPx,
  })
  let runSeed = 0x9e3779b9
  // One "tooth" (one inside segment of one gap); with wobble, subdivide and nudge
  // interior vertices perpendicular by a bounded, detrended random walk (pinned at
  // both ends) → a hand stroke.
  const makeTooth = (p0: StrokePoint, p1: StrokePoint): StrokePoint[] =>
    wobbleDeg > 0
      ? wobbleRun(p0, p1, wobbleDeg, lineWidthPx, spacingPx, makeRng((runSeed = (runSeed + 0x6d2b79f5) | 0)))
      : [p0, p1]

  const sections: GenSection[] = []
  const push = (points: StrokePoint[]): void => void sections.push({ points, kind: 'line', role: 'fill' })

  // Too thin to zig-zag (a single scan line) → lay that line down flat.
  if (lines.length === 1) {
    for (const s of lines[0].segs) push(makeTooth(pointAt(s.aIn, lines[0].d), pointAt(s.aOut, lines[0].d)))
    return sections
  }

  // Build one tooth per gap between adjacent scan lines, paired by left-to-right
  // column. Even gaps climb up-RIGHT (in→out, a "zig"); odd gaps climb up-LEFT
  // (out→in, a "zag"). Teeth in the same column on consecutive gaps share a boundary
  // crossing on line `b`, so a column is one unbroken zig-zag.
  const gapTeeth: StrokePoint[][][] = []
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i]
    const b = lines[i + 1]
    const zig = i % 2 === 0
    const cols = Math.min(a.segs.length, b.segs.length)
    const row: StrokePoint[][] = []
    for (let j = 0; j < cols; j++) {
      const sa = a.segs[j]
      const sb = b.segs[j]
      row.push(makeTooth(pointAt(zig ? sa.aIn : sa.aOut, a.d), pointAt(zig ? sb.aOut : sb.aIn, b.d)))
    }
    gapTeeth.push(row)
  }

  // Emit COLUMN-MAJOR: walk each column straight down for as long as it exists, so a
  // disjoint region's entire zig-zag is drawn before the next one starts — the fill
  // animates one continuous sweep at a time, not every column growing at once.
  const consumed = gapTeeth.map((row) => row.map(() => false))
  for (let i = 0; i < gapTeeth.length; i++) {
    for (let j = 0; j < gapTeeth[i].length; j++) {
      for (let k = i; k < gapTeeth.length && j < gapTeeth[k].length && !consumed[k][j]; k++) {
        consumed[k][j] = true
        push(gapTeeth[k][j])
      }
    }
  }
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

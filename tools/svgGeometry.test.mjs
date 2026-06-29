// Standalone unit tests for the pure SVG geometry engines:
//   src/lib/svg/hatch.ts        (fill → diagonal hand-shading hatch strokes)
//   src/lib/svg/centerline.ts   (outline polyline → resampled pen stroke)
// Both have only `import type` deps, so esbuild strips them and we run them in
// isolation (cf. tools/layout.test.mjs). Run: node tools/svgGeometry.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

async function load(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
  const js = (await esbuild.transform(src, { loader: 'ts', format: 'esm' })).code
  const dir = mkdtempSync(join(tmpdir(), 'svg-'))
  const out = join(dir, 'mod.mjs')
  writeFileSync(out, js)
  return import(pathToFileURL(out).href)
}

const { generateHatch } = await load('../src/lib/svg/hatch.ts')
const { strokeFromPolyline } = await load('../src/lib/svg/centerline.ts')

let passed = 0
let failed = 0
const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps
const check = (name, cond, got) => {
  if (cond) passed++
  else {
    failed++
    console.error(`✗ ${name}` + (got !== undefined ? ` — got ${JSON.stringify(got)}` : ''))
  }
}
const allPoints = (secs) => secs.flatMap((s) => s.points)
const square = (lo, hi) => [
  { x: lo, y: lo },
  { x: hi, y: lo },
  { x: hi, y: hi },
  { x: lo, y: hi },
]

// 1) horizontal hatch (angle 0) across a 100×100 square: one segment per scanline
{
  const secs = generateHatch([square(0, 100)], { angleDeg: 0, spacingPx: 10, lineWidthPx: 2 })
  const pts = allPoints(secs)
  check('1 non-empty', secs.length >= 1, secs.length)
  const ys = [...new Set(pts.map((p) => Math.round(p.y)))].sort((a, b) => a - b)
  check('1 ten scanlines', ys.length === 10, ys)
  check('1 first line y≈5', approx(ys[0], 5), ys[0])
  check('1 last line y≈95', approx(ys[9], 95), ys[9])
  const xs = pts.map((p) => p.x)
  check('1 spans left edge', approx(Math.min(...xs), 0, 0.5), Math.min(...xs))
  check('1 spans right edge', approx(Math.max(...xs), 100, 0.5), Math.max(...xs))
  check('1 constant width 2', pts.every((p) => p.width === 2))
  check('1 all points inside', pts.every((p) => p.x >= -0.5 && p.x <= 100.5 && p.y >= -0.5 && p.y <= 100.5))
}

// 1z) zig-zag continuity: with one segment per scanline (10 scanlines), the fill is
//     a continuous zig-zag — one tooth per gap (9), each tooth ending exactly where
//     the next begins, and each tooth climbing a row (a tilted diagonal, not flat).
{
  const secs = generateHatch([square(0, 100)], { angleDeg: 0, spacingPx: 10, lineWidthPx: 2, jitter: 0 })
  check('1z one tooth per gap', secs.length === 9, secs.length)
  let joined = 0
  for (let i = 0; i + 1 < secs.length; i++) {
    const end = secs[i].points.at(-1)
    const start = secs[i + 1].points[0]
    if (approx(end.x, start.x) && approx(end.y, start.y)) joined++
  }
  check('1z consecutive teeth joined', joined === secs.length - 1, joined)
  // each tooth climbs one row, and the slope flips zig→zag between teeth
  const slope = (s) => (s.points.at(-1).y - s.points[0].y) / (s.points.at(-1).x - s.points[0].x)
  check('1z tooth tilts (not flat)', Math.abs(slope(secs[0])) > 0.01, slope(secs[0]))
  check('1z zig then zag', slope(secs[0]) * slope(secs[1]) < 0, [slope(secs[0]), slope(secs[1])])
}

// 1c) disjoint columns draw one-at-a-time: two side-by-side rectangles share every
//     scanline (2 columns per line). Column-major emission must output one column's
//     whole zig-zag chain before the other (so the reveal sweeps one region at a
//     time, not all columns at once). Distinguishes column-major from gap-major order.
{
  const left = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]
  const right = [{ x: 60, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 60, y: 40 }]
  const secs = generateHatch([left, right], { angleDeg: 0, spacingPx: 10, lineWidthPx: 2, jitter: 0 })
  // a "break" is where a section's end ≠ the next section's start (a chain boundary)
  let breaks = 0, breakAt = -1
  for (let i = 0; i + 1 < secs.length; i++) {
    const e = secs[i].points.at(-1), s = secs[i + 1].points[0]
    if (!(approx(e.x, s.x) && approx(e.y, s.y))) { breaks++; breakAt = i + 1 }
  }
  check('1c exactly one chain break (two runs)', breaks === 1, breaks)
  check('1c columns split evenly', breakAt === secs.length / 2, [breakAt, secs.length])
  // each run stays on its own side (left run x≤40, right run x≥60) — not interleaved
  const firstRun = secs.slice(0, breakAt).flatMap((s) => s.points)
  const secondRun = secs.slice(breakAt).flatMap((s) => s.points)
  check('1c first run is the left column', firstRun.every((p) => p.x <= 40.001), Math.max(...firstRun.map((p) => p.x)))
  check('1c second run is the right column', secondRun.every((p) => p.x >= 59.999), Math.min(...secondRun.map((p) => p.x)))
}

// 2) vertical hatch (angle 90): scanlines stride across x instead
{
  const secs = generateHatch([square(0, 100)], { angleDeg: 90, spacingPx: 10, lineWidthPx: 1 })
  const pts = allPoints(secs)
  const xs = [...new Set(pts.map((p) => Math.round(p.x)))].sort((a, b) => a - b)
  check('2 ten vertical lines', xs.length === 10, xs)
  check('2 spans top edge', approx(Math.min(...pts.map((p) => p.y)), 0, 0.5))
  check('2 spans bottom edge', approx(Math.max(...pts.map((p) => p.y)), 100, 0.5))
}

// 3) even-odd hole: outer square with an inner square hole → shading skips the hole
{
  const secs = generateHatch([square(0, 100), square(25, 75)], {
    angleDeg: 0,
    spacingPx: 10,
    lineWidthPx: 2,
  })
  const pts = allPoints(secs)
  // ink must reach the hole's vertical edges (x≈25 and x≈75) on the lines that cross it
  check('3 touches hole left edge', pts.some((p) => approx(p.x, 25, 0.5) && p.y > 30 && p.y < 70))
  check('3 touches hole right edge', pts.some((p) => approx(p.x, 75, 0.5) && p.y > 30 && p.y < 70))
  // and must NOT paint inside the hole interior
  const insideHole = pts.some((p) => p.x > 26 && p.x < 74 && p.y > 26 && p.y < 74)
  check('3 hole interior empty', !insideHole, insideHole)
}

// 4) degenerate inputs
{
  check('4 no polygons → []', generateHatch([], { angleDeg: 45, spacingPx: 5, lineWidthPx: 1 }).length === 0)
  check('4 zero spacing → []', generateHatch([square(0, 100)], { angleDeg: 45, spacingPx: 0, lineWidthPx: 1 }).length === 0)
}

// 5) 45° diagonal still fills (smoke + bounds)
{
  const secs = generateHatch([square(0, 100)], { angleDeg: 45, spacingPx: 8, lineWidthPx: 2, jitter: 0 })
  const pts = allPoints(secs)
  check('5 produces strokes', secs.length >= 1 && pts.length > 4, secs.length)
  check('5 within bounds', pts.every((p) => p.x >= -1 && p.x <= 101 && p.y >= -1 && p.y <= 101))
}

// 5b) line wobble: subdivides each hatch line but stays within the band (no drift,
//     no crossing into neighbours), and is deterministic
{
  const opts = { angleDeg: 0, spacingPx: 10, lineWidthPx: 2, jitter: 0 }
  const straight = generateHatch([square(0, 100)], opts)
  const wob = generateHatch([square(0, 100)], { ...opts, lineWobbleDeg: 1.5 })
  const ptsS = allPoints(straight)
  const ptsW = allPoints(wob)
  check('5b wobble subdivides', ptsW.length > ptsS.length * 2, [ptsS.length, ptsW.length])
  check('5b within bounds', ptsW.every((p) => p.x >= -3 && p.x <= 103 && p.y >= -3 && p.y <= 103))
  // each wobble tooth stays within the band (spacing*0.35 = 3.5) of the straight line
  // through its OWN endpoints — the random walk is clamped + detrended, so no drift.
  let maxDev = 0
  for (const s of wob) {
    const a0 = s.points[0], b0 = s.points.at(-1)
    const dx = b0.x - a0.x, dy = b0.y - a0.y, L = Math.hypot(dx, dy) || 1
    for (const p of s.points) {
      const dev = Math.abs(((p.x - a0.x) * dy - (p.y - a0.y) * dx) / L)
      if (dev > maxDev) maxDev = dev
    }
  }
  check('5b stays within band', maxDev <= 3.6, maxDev)
  // deterministic: same params → identical geometry
  const wob2 = generateHatch([square(0, 100)], { ...opts, lineWobbleDeg: 1.5 })
  check('5b deterministic', JSON.stringify(wob) === JSON.stringify(wob2))
  check('5b zero wobble == straight', JSON.stringify(generateHatch([square(0, 100)], { ...opts, lineWobbleDeg: 0 })) === JSON.stringify(straight))
}

// 6) centerline: resample an open line, constant width, endpoints preserved
{
  const sec = strokeFromPolyline(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    4,
    { resampleSpacingPx: 10, minWidthPx: 1 },
  )
  check('6 produced', !!sec)
  check('6 role outline', sec.role === 'outline', sec.role)
  check('6 kind curve', sec.kind === 'curve', sec.kind)
  check('6 ~11 points', sec.points.length === 11, sec.points.length)
  check('6 start (0,0)', approx(sec.points[0].x, 0) && approx(sec.points[0].y, 0))
  check('6 end (100,0)', approx(sec.points.at(-1).x, 100) && approx(sec.points.at(-1).y, 0))
  check('6 even spacing ~10', approx(sec.points[1].x, 10), sec.points[1].x)
  check('6 width 4', sec.points.every((p) => p.width === 4))
}

// 7) centerline: width floored by minWidthPx; closed flag → loop
{
  const thin = strokeFromPolyline([{ x: 0, y: 0 }, { x: 50, y: 0 }], 0.2, { resampleSpacingPx: 25, minWidthPx: 1.5 })
  check('7 width floored to 1.5', thin.points.every((p) => p.width === 1.5), thin.points[0].width)
  const loop = strokeFromPolyline(square(0, 20).concat([{ x: 0, y: 0 }]), 2, { resampleSpacingPx: 5 }, true)
  check('7 closed → loop', loop.kind === 'loop', loop.kind)
}

// 8) centerline: too-short polyline → null
{
  check('8 single point → null', strokeFromPolyline([{ x: 0, y: 0 }], 2, { resampleSpacingPx: 5 }) === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

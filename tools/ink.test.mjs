// Standalone unit test for the direct-drawing (ink) engine (src/lib/project/ink.ts):
// tool coercion, arrowheads, preparation (durations from arc length) and hit-testing.
// ink.ts pulls in the geometry + brush libs, so esbuild BUNDLES it with the @lib alias.
// Run: node tools/ink.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const dir = mkdtempSync(join(tmpdir(), 'ink-'))
const out = join(dir, 'ink.mjs')
await esbuild.build({
  entryPoints: [fileURLToPath(new URL('../src/lib/project/ink.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  outfile: out,
  alias: { '@lib': fileURLToPath(new URL('../src/lib', import.meta.url)) },
})
const I = await import(pathToFileURL(out).href)

let passed = 0
let failed = 0
const check = (name, cond, got) => {
  if (cond) passed++
  else { failed++; console.error(`✗ ${name}` + (got !== undefined ? ` — got ${JSON.stringify(got)}` : '')) }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

// a noisy horizontal scribble from (0.1,0.2) to (0.5,0.2)
const noisy = []
for (let i = 0; i <= 40; i++) noisy.push({ x: 0.1 + (0.4 * i) / 40, y: 0.2 + (i % 2 ? 0.002 : -0.002) })

// 1) line/arrow coerce to their two endpoints
{
  const line = I.coerceInkPoints('line', noisy)
  check('1 line = 2 points', line.length === 2, line.length)
  check('1 line snaps ends', near(line[0].x, 0.1) && near(line[1].x, 0.5), line)
  // legacy 'arrow' tool coerces like a line (the arrowhead is now a flag)
  const legacy = I.coerceInkPoints('arrow', noisy)
  check('1 legacy arrow tool = 2 points', legacy.length === 2, legacy.length)
}

// 2) freehand keeps the hand (many points); curve smooths but keeps the span
{
  const fh = I.coerceInkPoints('freehand', noisy)
  check('2 freehand keeps points', fh.length > 10, fh.length)
  const cv = I.coerceInkPoints('curve', noisy)
  check('2 curve produced', cv.length >= 2, cv.length)
  check('2 curve spans the stroke', near(cv[0].x, 0.1, 1e-3) && near(cv[cv.length - 1].x, 0.5, 1e-3), [cv[0], cv[cv.length - 1]])
}

// 3) degenerate input (a dot / tiny wiggle) is rejected
{
  check('3 dot rejected', I.coerceInkPoints('freehand', [{ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.5 }]).length === 0)
  check('3 empty rejected', I.coerceInkPoints('line', []).length === 0)
}

// 4) arrowhead sections = shaft + two head wings ending at the tip (flag on)
{
  const pts = [{ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }]
  const secs = I.inkSections(pts, true)
  check('4 three sections', secs.length === 3, secs.length)
  const tip = { x: 0.5, y: 0.5 }
  check('4 wings end at the tip', secs[1][1].x === tip.x && secs[2][1].x === tip.x, secs.slice(1))
  check('4 wings trail back-left', secs[1][0].x < tip.x && secs[2][0].x < tip.x)
  check('4 wings mirror around the shaft', near(secs[1][0].y + secs[2][0].y, 2 * tip.y, 1e-9), [secs[1][0].y, secs[2][0].y])
}

// 5) no arrowhead → a single section
{
  check('5 line one section', I.inkSections([{ x: 0, y: 0 }, { x: 0.3, y: 0 }], false).length === 1)
}

// 6) prepareInk: duration scales with arc length; the arrow flag adds pen-lifts + wings
{
  const short = I.prepareInk({ tool: 'line', points: [{ x: 0.1, y: 0.5 }, { x: 0.3, y: 0.5 }] })
  const long = I.prepareInk({ tool: 'line', points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] })
  check('6 longer stroke takes longer', long.totalMs > short.totalMs, [short.totalMs, long.totalMs])
  const plain = I.prepareInk({ tool: 'line', points: [{ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }] })
  check('6 no-arrow line = one seg', plain.segs.length === 1, plain.segs.length)
  const arrow = I.prepareInk({ tool: 'line', arrow: true, points: [{ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }] })
  check('6 arrow flag → three segs', arrow.segs.length === 3, arrow.segs.length)
  check('6 wings start after the shaft', arrow.segs[1].startMs > arrow.segs[0].durationMs, arrow.segs.map((s) => s.startMs))
  check('6 total covers the last wing', near(arrow.totalMs, arrow.segs[2].startMs + arrow.segs[2].durationMs), arrow.totalMs)
  // legacy tool 'arrow' still produces the wings (back-compat)
  const legacy = I.prepareInk({ tool: 'arrow', points: [{ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }] })
  check('6 legacy arrow tool → three segs', legacy.segs.length === 3, legacy.segs.length)
  // easing is carried onto the prepared ink (default linear)
  check('6 default easing linear', plain.easing === 'linear', plain.easing)
  check('6 easing carried', I.prepareInk({ tool: 'line', easing: 'cubicInOut', points: [{ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }] }).easing === 'cubicInOut')
}

// 7) hit-testing: near the polyline hits, far away misses; bounds wrap the stroke
{
  const pts = [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.2 }]
  check('7 on-line hit', I.inkHitDistance(pts, { x: 0.3, y: 0.205 }) < 0.01)
  check('7 far miss', I.inkHitDistance(pts, { x: 0.3, y: 0.4 }) > 0.15)
  const b = I.inkBounds(pts)
  check('7 bounds', b && near(b.x, 0.1) && near(b.w, 0.4) && near(b.y, 0.2) && near(b.h, 0), b)
  check('7 empty bounds null', I.inkBounds([]) === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

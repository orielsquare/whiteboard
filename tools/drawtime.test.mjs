// Standalone unit test for the drawing timeline (src/lib/drawing/timeline.ts) —
// part sequencing + the per-stroke timing overrides. timeline.ts has real deps
// (@lib/geometry/{polyline,easing}), so esbuild BUNDLES it with the @lib alias.
// Run: node tools/drawtime.test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const dir = mkdtempSync(join(tmpdir(), 'drawtime-'))
const out = join(dir, 'timeline.mjs')
await esbuild.build({
  entryPoints: [fileURLToPath(new URL('../src/lib/drawing/timeline.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  outfile: out,
  alias: { '@lib': fileURLToPath(new URL('../src/lib', import.meta.url)) },
})
const T = await import(pathToFileURL(out).href)

let passed = 0
let failed = 0
const check = (name, cond, got) => {
  if (cond) passed++
  else { failed++; console.error(`✗ ${name}` + (got !== undefined ? ` — got ${JSON.stringify(got)}` : '')) }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

// a horizontal stroke of the given length (LUT length === geometric length)
const sec = (id, len, timing) => ({
  id,
  points: [{ x: 0, y: 0, width: 2 }, { x: len, y: 0, width: 2 }],
  kind: 'line',
  ...(timing ? { timing } : {}),
})
const part = (sections, over = {}) => ({
  id: 'P',
  elementId: 'E',
  kind: 'outline',
  name: 'p',
  zOrder: 1,
  visible: true,
  sections,
  timing: { durationMs: 1000, delayBeforeMs: 100, easing: 'linear' },
  ...over,
})

// 1) no overrides, outline → envelope mode; exact configured duration
{
  const d = T.prepareDrawing([part([sec('a', 100), sec('b', 300)])])
  check('1 envelope mode', d.parts[0].mode === 'envelope', d.parts[0].mode)
  check('1 total = delay + duration', d.totalMs === 1100, d.totalMs)
  check('1 startMs = delay', d.parts[0].startMs === 100, d.parts[0].startMs)
}

// 2) fill parts keep per-stroke slices proportional to length
{
  const d = T.prepareDrawing([part([sec('a', 100), sec('b', 300)], { kind: 'fill' })])
  const p = d.parts[0]
  check('2 perStroke mode', p.mode === 'perStroke', p.mode)
  check('2 slice a = 250', near(p.segs[0].durationMs, 250), p.segs[0].durationMs)
  check('2 slice b = 750', near(p.segs[1].durationMs, 750), p.segs[1].durationMs)
  check('2 total 1100', near(d.totalMs, 1100), d.totalMs)
}

// 3) an explicit per-stroke duration wins; the others keep their proportional share
{
  const d = T.prepareDrawing([part([sec('a', 100, { durationMs: 500 }), sec('b', 300)])])
  const p = d.parts[0]
  check('3 override switches to perStroke', p.mode === 'perStroke', p.mode)
  check('3 a takes exactly 500', near(p.segs[0].durationMs, 500), p.segs[0].durationMs)
  check('3 b keeps its share (750)', near(p.segs[1].durationMs, 750), p.segs[1].durationMs)
  check('3 total stretches to the sum', near(d.totalMs, 100 + 500 + 750), d.totalMs)
  check('3 b starts after a', near(p.segs[1].startMs, 600), p.segs[1].startMs)
}

// 4) a per-stroke pen-lift delay inserts a gap before that stroke
{
  const d = T.prepareDrawing([part([sec('a', 100), sec('b', 300, { delayBeforeMs: 200 })])])
  const p = d.parts[0]
  check('4 a keeps its share (250)', near(p.segs[0].durationMs, 250), p.segs[0].durationMs)
  check('4 gap before b', near(p.segs[1].startMs, 100 + 250 + 200), p.segs[1].startMs)
  check('4 total includes the gap', near(d.totalMs, 100 + 250 + 200 + 750), d.totalMs)
}

// 5) sampling an overridden part: linear reveal per stroke, gap = pen down nowhere
{
  const d = T.prepareDrawing([part([sec('a', 100, { durationMs: 400 }), sec('b', 300, { delayBeforeMs: 100, durationMs: 600 })])])
  const p = d.parts[0]
  // a: [100, 500); gap; b: [600, 1200)
  const mid = T.samplePart(p, 300) // halfway through a
  check('5 a half revealed', near(mid.segs[0].revealedLen, 50), mid.segs[0].revealedLen)
  check('5 b untouched', near(mid.segs[1].revealedLen, 0), mid.segs[1].revealedLen)
  const gap = T.samplePart(p, 550) // in the pen-lift
  check('5 gap: a done', near(gap.segs[0].revealedLen, 100), gap.segs[0].revealedLen)
  check('5 gap: b still 0', near(gap.segs[1].revealedLen, 0), gap.segs[1].revealedLen)
  const end = T.samplePart(p, 1200)
  check('5 all revealed at end', near(end.segs[1].revealedLen, 300), end.segs[1].revealedLen)
}

// 6) hidden parts and parts after an overridden one sequence correctly
{
  const p1 = part([sec('a', 100, { durationMs: 300 })], { id: 'P1' })
  const hidden = part([sec('h', 50)], { id: 'H', visible: false })
  const p2 = part([sec('c', 200)], { id: 'P2', timing: { durationMs: 400, delayBeforeMs: 50, easing: 'linear' } })
  const d = T.prepareDrawing([p1, hidden, p2])
  check('6 hidden part skipped', d.parts.length === 2, d.parts.length)
  const q2 = d.parts.find((x) => x.id === 'P2')
  // P1: 100 delay + 300 override = 400; P2 starts at 400 + 50
  check('6 next part starts after the stretched one', near(q2.startMs, 450), q2.startMs)
  check('6 total', near(d.totalMs, 850), d.totalMs)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

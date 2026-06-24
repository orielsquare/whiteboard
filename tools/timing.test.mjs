// Standalone unit test for the pure timing model (src/lib/project/timing.ts).
// timing.ts has only `import type` deps, so esbuild strips them and it runs alone.
// Run: node tools/timing.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const src = readFileSync(new URL('../src/lib/project/timing.ts', import.meta.url), 'utf8')
const js = (await esbuild.transform(src, { loader: 'ts', format: 'esm' })).code
const dir = mkdtempSync(join(tmpdir(), 'timing-'))
const out = join(dir, 'timing.mjs')
writeFileSync(out, js)
const T = await import(pathToFileURL(out).href)

let passed = 0
let failed = 0
const check = (name, cond, got) => {
  if (cond) passed++
  else { failed++; console.error(`✗ ${name}` + (got !== undefined ? ` — got ${JSON.stringify(got)}` : '')) }
}

const box = (id, animOrder, delayBeforeMs) => ({ id, animOrder, delayBeforeMs })
const slide = (id, textBoxes, holdBeforeTransitionMs, transition) => ({ id, textBoxes, holdBeforeTransitionMs, transition })
const layouts = (entries) => new Map(entries.map(([id, contentMs]) => [id, { contentMs }]))

// 1) single box: start = delay, end = start + contentMs; hold + transition
{
  const s = slide('s', [box('a', 0, 100)], 1000, { kind: 'fade', durationMs: 600 })
  const t = T.computeSlideTiming(s, layouts([['a', 500]]))
  check('1 start=100', t.boxes[0].startMs === 100, t.boxes[0])
  check('1 end=600', t.boxes[0].endMs === 600, t.boxes[0])
  check('1 contentEnd=600', t.contentEndMs === 600, t.contentEndMs)
  check('1 holdEnd=1600', t.holdEndMs === 1600, t.holdEndMs)
  check('1 transitionMs=600', t.transitionMs === 600, t.transitionMs)
  check('1 total=2200', t.totalMs === 2200, t.totalMs)
}

// 2) boxes sequenced by animOrder (passed out of order), delays accumulate
{
  const s = slide('s', [box('A', 1, 50), box('B', 0, 100)], 0, { kind: 'none', durationMs: 600 })
  const t = T.computeSlideTiming(s, layouts([['A', 200], ['B', 300]]))
  check('2 first is B (animOrder 0)', t.boxes[0].boxId === 'B', t.boxes.map((b) => b.boxId))
  check('2 B start=100', t.boxes[0].startMs === 100, t.boxes[0])
  check('2 B end=400', t.boxes[0].endMs === 400, t.boxes[0])
  // A: cursor=400, start=400+50=450, end=650
  check('2 A start=450', t.boxes[1].startMs === 450, t.boxes[1])
  check('2 A end=650', t.boxes[1].endMs === 650, t.boxes[1])
  check('2 contentEnd=650', t.contentEndMs === 650, t.contentEndMs)
}

// 3) transition kind 'none' → transitionMs 0, total = holdEnd
{
  const s = slide('s', [box('a', 0, 0)], 500, { kind: 'none', durationMs: 600 })
  const t = T.computeSlideTiming(s, layouts([['a', 400]]))
  check('3 transitionMs=0', t.transitionMs === 0, t.transitionMs)
  check('3 total=holdEnd=900', t.totalMs === 900 && t.holdEndMs === 900, t)
}

// 4) missing layout → contentMs 0 (glyph not yet derived)
{
  const s = slide('s', [box('a', 0, 200)], 0, { kind: 'none', durationMs: 0 })
  const t = T.computeSlideTiming(s, layouts([])) // no layout for 'a'
  check('4 end=start (0 content)', t.boxes[0].startMs === 200 && t.boxes[0].endMs === 200, t.boxes[0])
}

// 5) project sequencing: slide N+1 starts at slide N's holdEnd (overlap)
{
  const s0 = slide('s0', [box('a', 0, 0)], 200, { kind: 'fade', durationMs: 300 }) // content300, hold->500, trans300, total800
  const s1 = slide('s1', [box('b', 0, 0)], 100, { kind: 'none', durationMs: 0 }) // content400, hold->500, total500
  const project = { slides: [s0, s1] }
  const lbs = new Map([
    ['s0', layouts([['a', 300]])],
    ['s1', layouts([['b', 400]])],
  ])
  const pt = T.computeProjectTiming(project, lbs)
  check('5 slide0 start=0', pt.slides[0].startMs === 0, pt.slides[0].startMs)
  check('5 slide1 starts at slide0 holdEnd(500)', pt.slides[1].startMs === 500, pt.slides[1].startMs)
  // total = slide1.start(500) + slide1.total(500) = 1000
  check('5 project total=1000', pt.totalMs === 1000, pt.totalMs)
  // slide0 still transitioning until 500+? slide0 total 800 → ends at 800, overlapping slide1 [500,800)
  check('5 slide0 total=800', pt.slides[0].timing.totalMs === 800, pt.slides[0].timing.totalMs)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

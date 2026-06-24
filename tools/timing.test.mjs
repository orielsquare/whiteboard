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

// 6) speed scales ONLY the writing; per-box delay, hold, transition are invariant
{
  const s = slide('s', [box('a', 0, 100)], 1000, { kind: 'fade', durationMs: 600 })
  const lay = layouts([['a', 500]])
  const t1 = T.computeSlideTiming(s, lay, 1)
  const t2 = T.computeSlideTiming(s, lay, 2)
  // speed 1: delay 100, writing 500 → end 600, contentEnd 600, holdEnd 1600, total 2200
  check('6 speed1 start=100', t1.boxes[0].startMs === 100, t1.boxes[0].startMs)
  check('6 speed1 contentEnd=600', t1.contentEndMs === 600, t1.contentEndMs)
  check('6 speed1 total=2200', t1.totalMs === 2200, t1.totalMs)
  // speed 2: delay STILL 100 (invariant), writing 250 → end 350
  check('6 speed2 start=100 (delay invariant)', t2.boxes[0].startMs === 100, t2.boxes[0].startMs)
  check('6 speed2 contentEnd=350', t2.contentEndMs === 350, t2.contentEndMs)
  // hold (1000) + transition (600) UNCHANGED → holdEnd 1350, total 1950
  check('6 speed2 holdEnd=1350 (hold invariant)', t2.holdEndMs === 1350, t2.holdEndMs)
  check('6 speed2 transition still 600', t2.transitionMs === 600, t2.transitionMs)
  check('6 speed2 total=1950', t2.totalMs === 1950, t2.totalMs)
  // The render maps writing time as (real - boxStart) × speed; the window must
  // satisfy (end - start) × speed === contentMs so the box finishes exactly at end.
  check('6 window×speed === contentMs', (t2.boxes[0].endMs - t2.boxes[0].startMs) * 2 === 500)
}

// 7) multi-box: per-box delays invariant across speeds; writing windows scale
{
  const s = slide('s', [box('A', 0, 200), box('B', 1, 300)], 0, { kind: 'none', durationMs: 0 })
  const lay = layouts([['A', 400], ['B', 600]])
  const t1 = T.computeSlideTiming(s, lay, 1)
  const t2 = T.computeSlideTiming(s, lay, 2)
  // speed1: A start200 end600; B start = 600+300=900, end 1500
  check('7 s1 A=[200,600]', t1.boxes[0].startMs === 200 && t1.boxes[0].endMs === 600, t1.boxes[0])
  check('7 s1 B=[900,1500]', t1.boxes[1].startMs === 900 && t1.boxes[1].endMs === 1500, t1.boxes[1])
  // speed2: A start200 (delay invariant) end 200+200=400; B start = 400+300=700 (delay invariant), end 700+300=1000
  check('7 s2 A=[200,400]', t2.boxes[0].startMs === 200 && t2.boxes[0].endMs === 400, t2.boxes[0])
  check('7 s2 B start=700 (delay invariant)', t2.boxes[1].startMs === 700, t2.boxes[1].startMs)
  check('7 s2 B end=1000', t2.boxes[1].endMs === 1000, t2.boxes[1].endMs)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

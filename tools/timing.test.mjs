// Standalone unit test for the pure timing model (src/lib/project/timing.ts).
// timing.ts has only `import type` deps, so esbuild strips them and it runs alone.
// Run: node tools/timing.test.mjs
//
// Timing model v2 (the container-bar envelope): an element's `speed` sets its
// animation block (contentMs / speed); `delayBeforeMs` is the block's offset
// (padding-before) INSIDE its envelope; `envelopeMs` pins the envelope's length
// (unset = tight/auto: offset + block). The envelope is master — an overflowing
// block clamps + compresses to fit. The global rate scales WHOLE envelopes;
// slide hold + transition stay invariant. Elements are sequenced envelope-end
// to envelope-start.
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
const span = (t) => [t.startMs, t.animStartMs, t.animEndMs, t.endMs]

// 1) single box: envelope = offset + block (auto); hold + transition follow
{
  const s = slide('s', [box('a', 0, 100)], 1000, { kind: 'fade', durationMs: 600 })
  const t = T.computeSlideTiming(s, layouts([['a', 500]]))
  check('1 envelope [0,600]', t.boxes[0].startMs === 0 && t.boxes[0].endMs === 600, span(t.boxes[0]))
  check('1 block [100,600]', t.boxes[0].animStartMs === 100 && t.boxes[0].animEndMs === 600, span(t.boxes[0]))
  check('1 contentEnd=600', t.contentEndMs === 600, t.contentEndMs)
  check('1 holdEnd=1600', t.holdEndMs === 1600, t.holdEndMs)
  check('1 transitionMs=600', t.transitionMs === 600, t.transitionMs)
  check('1 total=2200', t.totalMs === 2200, t.totalMs)
}

// 2) boxes sequenced by animOrder (passed out of order); the next envelope starts
//    where the previous one ends
{
  const s = slide('s', [box('A', 1, 50), box('B', 0, 100)], 0, { kind: 'none', durationMs: 600 })
  const t = T.computeSlideTiming(s, layouts([['A', 200], ['B', 300]]))
  check('2 first is B (animOrder 0)', t.boxes[0].boxId === 'B', t.boxes.map((b) => b.boxId))
  check('2 B env [0,400] block [100,400]', span(t.boxes[0]).join() === '0,100,400,400', span(t.boxes[0]))
  check('2 A env [400,650] block [450,650]', span(t.boxes[1]).join() === '400,450,650,650', span(t.boxes[1]))
  check('2 contentEnd=650', t.contentEndMs === 650, t.contentEndMs)
}

// 3) transition kind 'none' → transitionMs 0, total = holdEnd
{
  const s = slide('s', [box('a', 0, 0)], 500, { kind: 'none', durationMs: 600 })
  const t = T.computeSlideTiming(s, layouts([['a', 400]]))
  check('3 transitionMs=0', t.transitionMs === 0, t.transitionMs)
  check('3 total=holdEnd=900', t.totalMs === 900 && t.holdEndMs === 900, t)
}

// 4) missing layout → contentMs 0: the envelope is just the padding
{
  const s = slide('s', [box('a', 0, 200)], 0, { kind: 'none', durationMs: 0 })
  const t = T.computeSlideTiming(s, layouts([])) // no layout for 'a'
  check('4 env [0,200], zero block at 200', span(t.boxes[0]).join() === '0,200,200,200', span(t.boxes[0]))
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
  check('5 project total=1000', pt.totalMs === 1000, pt.totalMs)
  check('5 slide0 total=800', pt.slides[0].timing.totalMs === 800, pt.slides[0].timing.totalMs)
}

// 6) global rate scales the WHOLE envelope (padding + block); hold + transition invariant
{
  const s = slide('s', [box('a', 0, 100)], 1000, { kind: 'fade', durationMs: 600 })
  const lay = layouts([['a', 500]])
  const t1 = T.computeSlideTiming(s, lay, new Map(), 1)
  const t2 = T.computeSlideTiming(s, lay, new Map(), 2)
  check('6 rate1 contentEnd=600', t1.contentEndMs === 600, t1.contentEndMs)
  check('6 rate1 total=2200', t1.totalMs === 2200, t1.totalMs)
  // rate 2: envelope halves (padding included) → [0,300], block [50,300]
  check('6 rate2 env [0,300]', t2.boxes[0].startMs === 0 && t2.boxes[0].endMs === 300, span(t2.boxes[0]))
  check('6 rate2 block [50,300] (padding scales too)', t2.boxes[0].animStartMs === 50 && t2.boxes[0].animEndMs === 300, span(t2.boxes[0]))
  check('6 rate2 holdEnd=1300 (hold invariant)', t2.holdEndMs === 1300, t2.holdEndMs)
  check('6 rate2 transition still 600', t2.transitionMs === 600, t2.transitionMs)
  check('6 rate2 total=1900', t2.totalMs === 1900, t2.totalMs)
  // the render samples the block at contentMs/(animEnd−animStart) — must recover contentMs
  check('6 block×rate === contentMs', (t2.boxes[0].animEndMs - t2.boxes[0].animStartMs) * 2 === 500)
}

// 7) multi-box under rate: whole envelopes scale, sequence stays contiguous
{
  const s = slide('s', [box('A', 0, 200), box('B', 1, 300)], 0, { kind: 'none', durationMs: 0 })
  const lay = layouts([['A', 400], ['B', 600]])
  const t1 = T.computeSlideTiming(s, lay, new Map(), 1)
  const t2 = T.computeSlideTiming(s, lay, new Map(), 2)
  check('7 r1 A env[0,600] block[200,600]', span(t1.boxes[0]).join() === '0,200,600,600', span(t1.boxes[0]))
  check('7 r1 B env[600,1500] block[900,1500]', span(t1.boxes[1]).join() === '600,900,1500,1500', span(t1.boxes[1]))
  check('7 r2 A env[0,300] block[100,300]', span(t2.boxes[0]).join() === '0,100,300,300', span(t2.boxes[0]))
  check('7 r2 B env[300,750] block[450,750]', span(t2.boxes[1]).join() === '300,450,750,750', span(t2.boxes[1]))
}

// 8) placed drawings interleave with boxes by shared animOrder
{
  const s = {
    id: 's',
    textBoxes: [box('A', 0, 0), box('B', 2, 100)],
    drawings: [{ id: 'D', animOrder: 1, delayBeforeMs: 50 }],
    holdBeforeTransitionMs: 0,
    transition: { kind: 'none', durationMs: 0 },
  }
  const lay = layouts([['A', 400], ['B', 200]])
  const dur = new Map([['D', 600]])
  const t1 = T.computeSlideTiming(s, lay, dur, 1)
  check('8 A env[0,400]', t1.boxes[0].startMs === 0 && t1.boxes[0].endMs === 400, span(t1.boxes[0]))
  check('8 D env[400,1050] block[450,1050]', span(t1.drawings[0]).join() === '400,450,1050,1050', span(t1.drawings[0]))
  check('8 B env[1050,1350] block[1150,1350]', span(t1.boxes[1]).join() === '1050,1150,1350,1350', span(t1.boxes[1]))
  check('8 contentEnd=1350', t1.contentEndMs === 1350, t1.contentEndMs)
  const t2 = T.computeSlideTiming(s, lay, dur, 2)
  check('8 rate2 D env[200,525] block[225,525]', span(t2.drawings[0]).join() === '200,225,525,525', span(t2.drawings[0]))
  check('8 rate2 B env[525,675]', t2.boxes[1].startMs === 525 && t2.boxes[1].endMs === 675, span(t2.boxes[1]))
}

// 9) a slide with no drawings field still works (back-compat)
{
  const s = slide('s', [box('a', 0, 100)], 0, { kind: 'none', durationMs: 0 })
  const t = T.computeSlideTiming(s, layouts([['a', 300]]))
  check('9 no-drawings drawings=[]', Array.isArray(t.drawings) && t.drawings.length === 0, t.drawings)
  check('9 box env[0,400] block[100,400]', span(t.boxes[0]).join() === '0,100,400,400', span(t.boxes[0]))
}

// 10) per-drawing speed shrinks the block (auto envelope hugs it); the rate scales again
{
  const s = {
    id: 's', textBoxes: [],
    drawings: [{ id: 'D', animOrder: 0, delayBeforeMs: 0, speed: 2 }],
    holdBeforeTransitionMs: 0, transition: { kind: 'none', durationMs: 0 },
  }
  const dur = new Map([['D', 600]])
  const t1 = T.computeSlideTiming(s, new Map(), dur, 1)
  check('10 speed×2 halves the block (600→300)', t1.drawings[0].endMs === 300, t1.drawings[0])
  const t2 = T.computeSlideTiming(s, new Map(), dur, 2)
  check('10 speed×2 + rate×2 → 150', t2.drawings[0].endMs === 150, t2.drawings[0])
  const sNo = { ...s, drawings: [{ id: 'D', animOrder: 0, delayBeforeMs: 0 }] }
  check('10 no speed → ×1 (600)', T.computeSlideTiming(sNo, new Map(), dur, 1).drawings[0].endMs === 600)
}

// 11) per-BOX speed: the block shrinks; the auto envelope hugs padding + block
{
  const s = slide('s', [{ ...box('a', 0, 100), speed: 2 }], 0, { kind: 'none', durationMs: 0 })
  const t1 = T.computeSlideTiming(s, layouts([['a', 500]]), new Map(), 1)
  check('11 env[0,350] block[100,350]', span(t1.boxes[0]).join() === '0,100,350,350', span(t1.boxes[0]))
  const t2 = T.computeSlideTiming(s, layouts([['a', 500]]), new Map(), 2)
  check('11 rate2 block = 125', t2.boxes[0].animEndMs - t2.boxes[0].animStartMs === 125, span(t2.boxes[0]))
}

// 12) a pinned envelope holds its size whatever the content (edits keep the pace)
{
  const mk = (contentMs) => {
    const s = slide('s', [{ ...box('a', 0, 100), envelopeMs: 2000 }], 0, { kind: 'none', durationMs: 0 })
    return T.computeSlideTiming(s, layouts([['a', contentMs]]))
  }
  const short = mk(500)
  const long = mk(5000)
  check('12 short: env [0,2000], block [100,600] + trailing pad', span(short.boxes[0]).join() === '0,100,600,2000', span(short.boxes[0]))
  check('12 long: env still [0,2000]', long.boxes[0].endMs === 2000, span(long.boxes[0]))
  check('12 long: block compressed to fit [100,2000]', long.boxes[0].animStartMs === 100 && long.boxes[0].animEndMs === 2000, span(long.boxes[0]))
  check('12 padding lives INSIDE the envelope', short.boxes[0].startMs === 0 && short.boxes[0].animStartMs === 100, span(short.boxes[0]))
}

// 13) speed and envelope are INDEPENDENT: a fast block just leaves more padding-after
{
  const s = slide('s', [{ ...box('a', 0, 0), speed: 4, envelopeMs: 1000 }], 0, { kind: 'none', durationMs: 0 })
  const t1 = T.computeSlideTiming(s, layouts([['a', 500]]), new Map(), 1)
  check('13 block 125 inside env 1000', span(t1.boxes[0]).join() === '0,0,125,1000', span(t1.boxes[0]))
  const t2 = T.computeSlideTiming(s, layouts([['a', 500]]), new Map(), 2)
  check('13 rate2 scales env AND block', span(t2.boxes[0]).join() === '0,0,62.5,500', span(t2.boxes[0]))
}

// 14) envelope on a drawing + empty-content envelope = a timed spacer
{
  const s = {
    id: 's', textBoxes: [{ ...box('b', 1, 0), envelopeMs: 800 }],
    drawings: [{ id: 'D', animOrder: 0, delayBeforeMs: 0, speed: 3, envelopeMs: 400 }],
    holdBeforeTransitionMs: 0, transition: { kind: 'none', durationMs: 0 },
  }
  const t = T.computeSlideTiming(s, layouts([]), new Map([['D', 600]]), 1)
  check('14 drawing block 200 in env 400', span(t.drawings[0]).join() === '0,0,200,400', span(t.drawings[0]))
  check('14 empty box reserves its envelope', t.boxes[0].startMs === 400 && t.boxes[0].endMs === 1200, span(t.boxes[0]))
  check('14 contentEnd includes the spacer', t.contentEndMs === 1200, t.contentEndMs)
}

// 16) direct drawings (inks) interleave in the same sequence with the same slot model
{
  const s = {
    id: 's',
    textBoxes: [box('A', 0, 0)],
    inks: [{ id: 'K', animOrder: 1, delayBeforeMs: 50, envelopeMs: 500 }],
    drawings: [{ id: 'D', animOrder: 2, delayBeforeMs: 0 }],
    holdBeforeTransitionMs: 0,
    transition: { kind: 'none', durationMs: 0 },
  }
  const t = T.computeSlideTiming(s, layouts([['A', 300]]), new Map([['D', 400]]), 1, new Map([['K', 200]]))
  check('16 A env[0,300]', t.boxes[0].endMs === 300, span(t.boxes[0]))
  check('16 K env[300,800] block[350,550]', span(t.inks[0]).join() === '300,350,550,800', span(t.inks[0]))
  check('16 D follows the ink envelope', t.drawings[0].startMs === 800 && t.drawings[0].endMs === 1200, span(t.drawings[0]))
  check('16 contentEnd=1200', t.contentEndMs === 1200, t.contentEndMs)
}

// 15) elementSlot directly (the shared slot math)
{
  const eq = (s, env, off, anim) => s.envMs === env && s.animOffMs === off && s.animMs === anim
  check('15 natural', eq(T.elementSlot(600), 600, 0, 600))
  check('15 speed', eq(T.elementSlot(600, 2), 300, 0, 300))
  check('15 offset grows the auto envelope', eq(T.elementSlot(600, 1, undefined, 150), 750, 150, 600))
  check('15 envelope holds a fast block + padding', eq(T.elementSlot(600, 2, 1500, 100), 1500, 100, 300))
  check('15 overflow compresses the block', eq(T.elementSlot(5000, 1, 2000, 100), 2000, 100, 1900))
  check('15 offset clamps into the envelope', eq(T.elementSlot(500, 1, 200, 300), 200, 200, 0))
  check('15 zero/negative envelope = auto', eq(T.elementSlot(600, 2, 0), 300, 0, 300))
  check('15 bad speed ignored', eq(T.elementSlot(600, 0), 600, 0, 600))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

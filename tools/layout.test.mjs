// Standalone unit test for the pure layout engine (src/lib/project/layout.ts).
// layout.ts has only `import type` deps, so esbuild strips them and we can run
// it in isolation with fake prepared glyphs. Run: node tools/layout.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const src = readFileSync(new URL('../src/lib/project/layout.ts', import.meta.url), 'utf8')
const js = (await esbuild.transform(src, { loader: 'ts', format: 'esm' })).code
const dir = mkdtempSync(join(tmpdir(), 'layout-'))
const out = join(dir, 'layout.mjs')
writeFileSync(out, js)
const { layoutTextBox } = await import(pathToFileURL(out).href)

const metrics = { unitsPerEm: 1000, ascender: 800, descender: -200 }
const EM = 100 // baseEmFraction(0.1) * canvasW(1000)
const SCALE = 0.1 // 0.1 * 1000 upm / 1000

const g = (adv, total) => ({
  sections: [],
  totalMs: total,
  advanceWidth: adv,
  bbox: { x: 0, y: 0, w: adv * 0.8, h: 700 },
})
// every lowercase letter: advance 500, 100ms
const glyphs = new Map()
for (const ch of 'abxy') glyphs.set(ch, g(500, 100))

const box = (over = {}) => ({
  id: 'B',
  frame: { x: 0, y: 0, w: null },
  align: 'left',
  runs: [{ text: 'ab' }],
  lineHeightScale: 1.2,
  animOrder: 0,
  delayBeforeMs: 0,
  interCharDelayMs: 50,
  ...over,
})
const lay = (over) => layoutTextBox(box(over), glyphs, metrics, 0.1, 1000)

let passed = 0
let failed = 0
const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps
const check = (name, cond, got) => {
  if (cond) { passed++; }
  else { failed++; console.error(`✗ ${name}` + (got !== undefined ? ` — got ${JSON.stringify(got)}` : '')) }
}

// 1) single word, left, no wrap: positions + timing + metrics
{
  const l = lay()
  check('1 two instances', l.instances.length === 2, l.instances.length)
  check('1 x0=0', approx(l.instances[0].xPx, 0), l.instances[0].xPx)
  check('1 x1=50px', approx(l.instances[1].xPx, 500 * SCALE), l.instances[1].xPx)
  check('1 start0=0', l.instances[0].startMs === 0)
  check('1 start1=150', l.instances[1].startMs === 150, l.instances[1].startMs)
  check('1 contentMs=250', l.contentMs === 250, l.contentMs)
  check('1 baseline=ascent80', approx(l.instances[0].baselineYPx, 800 * SCALE), l.instances[0].baselineYPx)
  check('1 widthPx=100', approx(l.widthPx, 100), l.widthPx)
  check('1 heightPx=100', approx(l.heightPx, 100), l.heightPx)
  check('1 seedSalt stable', l.instances[0].seedSalt === 'B:0' && l.instances[1].seedSalt === 'B:1', l.instances.map((i) => i.seedSalt))
}

// 2) word wrap onto two lines
{
  // "ab ab": word=100px, space=30px, wrapW=0.12*1000=120 → second word wraps
  const l = lay({ runs: [{ text: 'ab ab' }], frame: { x: 0, y: 0, w: 0.12 } })
  check('2 four instances', l.instances.length === 4, l.instances.length)
  const ys = [...new Set(l.instances.map((i) => Math.round(i.baselineYPx)))]
  check('2 two baselines', ys.length === 2, ys)
  // line2 baseline = 80 + (descent20 + ascent80)*1.2 = 200
  check('2 line2 baseline=200', approx(l.instances[2].baselineYPx, 200), l.instances[2].baselineYPx)
  check('2 line2 x reset to 0', approx(l.instances[2].xPx, 0), l.instances[2].xPx)
}

// 3) alignment (center / right) within a fixed wrap width
{
  const c = lay({ runs: [{ text: 'a' }], align: 'center', frame: { x: 0, y: 0, w: 0.5 } })
  check('3 center offset=225', approx(c.instances[0].xPx, (500 - 50) / 2), c.instances[0].xPx)
  const r = lay({ runs: [{ text: 'a' }], align: 'right', frame: { x: 0, y: 0, w: 0.5 } })
  check('3 right offset=450', approx(r.instances[0].xPx, 500 - 50), r.instances[0].xPx)
}

// 4) underline segment timing + geometry
{
  const l = lay({ runs: [{ text: 'ab', underline: true }] })
  check('4 one underline', l.underlines.length === 1, l.underlines.length)
  const u = l.underlines[0]
  check('4 u.startMs=0', u.startMs === 0, u.startMs)
  check('4 u.revealAtMs=250', u.revealAtMs === 250, u.revealAtMs) // last glyph end
  check('4 u.x0=0', approx(u.x0Px, 0), u.x0Px)
  check('4 u.x1=100', approx(u.x1Px, 100), u.x1Px)
  check('4 u.y=baseline+0.06em', approx(u.yPx, 80 + 0.06 * EM), u.yPx)
  check('4 u.thick=0.04em', approx(u.thicknessPx, 0.04 * EM), u.thicknessPx)
}

// 5) mixed sizes on one line: anchor to max ascent
{
  const l = lay({ runs: [{ text: 'a' }, { text: 'b', sizeScale: 2 }] })
  check('5 two instances', l.instances.length === 2, l.instances.length)
  // max ascent = 800*0.2 = 160
  check('5 baseline=160', approx(l.instances[0].baselineYPx, 160), l.instances[0].baselineYPx)
  check('5 both same baseline', approx(l.instances[0].baselineYPx, l.instances[1].baselineYPx))
  check('5 b scale=0.2', approx(l.instances[1].scale, 0.2), l.instances[1].scale)
  // height = 160 + maxDescent(200*0.2=40) = 200
  check('5 height=200', approx(l.heightPx, 200), l.heightPx)
}

// 6) explicit newline
{
  const l = lay({ runs: [{ text: 'a\nb' }] })
  check('6 two instances', l.instances.length === 2, l.instances.length)
  check('6 line2 baseline=200', approx(l.instances[1].baselineYPx, 200), l.instances[1].baselineYPx)
}

// 7) missing glyph: advances pen (0.5em), no instance, no time
{
  const l = lay({ runs: [{ text: 'a?b' }] }) // '?' not in glyph map
  check('7 two instances', l.instances.length === 2, l.instances.length)
  // b.x = aAdv(50) + missing(0.5em=50) = 100
  check('7 b.x=100', approx(l.instances[1].xPx, 100), l.instances[1].xPx)
  // timing: a@0 (end100), b@ 100+delay50 = 150 (missing adds no time)
  check('7 b.start=150', l.instances[1].startMs === 150, l.instances[1].startMs)
}

// 8) empty box still has one line of height + selectable bounds
{
  const l = lay({ runs: [{ text: '' }] })
  check('8 no instances', l.instances.length === 0, l.instances.length)
  check('8 height>0', l.heightPx > 0, l.heightPx)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

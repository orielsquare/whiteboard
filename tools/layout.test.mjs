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
// single-font set for the bulk of the cases
const fonts = { byId: new Map([['F', { glyphs, metrics }]]), defaultId: 'F' }
const lay = (over) => layoutTextBox(box(over), fonts, 0.1, 1000)

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

// 4) underline drawn AFTER the word is written (human-style), then geometry
{
  const l = lay({ runs: [{ text: 'ab', underline: true }] })
  check('4 one underline', l.underlines.length === 1, l.underlines.length)
  const u = l.underlines[0]
  // glyph a@0..100, b@150..250 → word ends at 250; underline waits +130 = 380
  check('4 u starts after word (380)', u.startMs === 380, u.startMs)
  check('4 u starts after last glyph end', u.startMs >= 250, u.startMs)
  // spanEm = 100/100 = 1 → drawMs = 120 + 180 = 300 → reveal at 680
  check('4 u.revealAtMs=680', u.revealAtMs === 680, u.revealAtMs)
  check('4 contentMs = underline end (680)', l.contentMs === 680, l.contentMs)
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

// 9) kerning (letterSpacing) adds trailing advance per glyph
{
  // a advance = 50px + kern(0.1*EM=10) = 60 → b starts at x=60
  const l = lay({ runs: [{ text: 'ab', letterSpacing: 0.1 }] })
  check('9 kern b.x=60', approx(l.instances[1].xPx, 60), l.instances[1].xPx)
}

// default-font minHalfWidth = unitsPerEm(1000) * 0.004 = 4
check('1b minHalfWidth=4', approx(lay().instances[0].minHalfWidth, 4), lay().instances[0].minHalfWidth)

// 10) per-run font: a run with fontId resolves to that font's glyphs + metrics
{
  const metricsB = { unitsPerEm: 2000, ascender: 1600, descender: -400 }
  const glyphsB = new Map()
  for (const ch of 'ab') glyphsB.set(ch, g(1000, 100))
  const fontsAB = { byId: new Map([['F', { glyphs, metrics }], ['B', { glyphs: glyphsB, metrics: metricsB }]]), defaultId: 'F' }
  const l = layoutTextBox(box({ runs: [{ text: 'a', fontId: 'B' }] }), fontsAB, 0.1, 1000)
  // font B: scale = 0.1*1000/2000 = 0.05 ; minHalfWidth = 2000*0.004 = 8
  check('10 fontB scale=0.05', approx(l.instances[0].scale, 0.05), l.instances[0].scale)
  check('10 fontB minHalfWidth=8', approx(l.instances[0].minHalfWidth, 8), l.instances[0].minHalfWidth)
  // unknown fontId falls back to the default font
  const l2 = layoutTextBox(box({ runs: [{ text: 'a', fontId: 'NOPE' }] }), fontsAB, 0.1, 1000)
  check('10 unknown font → default scale 0.1', approx(l2.instances[0].scale, 0.1), l2.instances[0].scale)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

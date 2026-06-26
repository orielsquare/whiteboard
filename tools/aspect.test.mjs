// Standalone unit test for the dual-aspect seam (src/lib/project/aspect.ts).
// aspect.ts has value imports (coords + schema), so bundle it. Run:
//   node tools/aspect.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = await esbuild.build({
  stdin: { contents: `export * from '@lib/project/aspect'`, resolveDir: ROOT, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@lib': join(ROOT, 'src/lib') },
})
const dir = mkdtempSync(join(tmpdir(), 'aspect-'))
const out = join(dir, 'aspect.mjs')
writeFileSync(out, res.outputFiles[0].text)
const A = await import(pathToFileURL(out).href)

const H16 = 9 / 16 // 0.5625
const H9 = 16 / 9 // 1.7778

let passed = 0
let failed = 0
const ok = (cond, msg) => {
  if (cond) passed++
  else {
    failed++
    console.error('  ✗ ' + msg)
  }
}
const approx = (a, b, msg, eps = 1e-9) => ok(Math.abs(a - b) < eps, `${msg} (got ${a}, want ${b})`)

const mkBox = (over = {}) => ({
  id: 'b',
  frame: { '16:9': { x: 0.2, y: 0.5, w: 0.7 }, '9:16': { x: 0.2, y: 0.5, w: 0.7 } },
  align: 'left',
  runs: [{ text: 'x' }],
  lineHeightScale: 1.2,
  animOrder: 0,
  delayBeforeMs: 0,
  interCharDelayMs: 50,
  ...over,
})
const mkSlide = (boxes, over = {}) => ({
  id: 's',
  background: '#000',
  textBoxes: boxes,
  holdBeforeTransitionMs: 0,
  transition: { kind: 'none', durationMs: 0 },
  ...over,
})
const mkProject = (slides, over = {}) => ({
  version: 2,
  id: 'p',
  name: 'P',
  fontId: 'F',
  lockDefault: { position: true, content: true },
  brush: {},
  playbackRate: 1,
  baseEmFraction: 0.085,
  defaults: {},
  slides,
  namedStyles: [],
  voiceover: [],
  ...over,
})

// --- frameOf: x,w identity; y scaled by aspect height ---------------------
{
  const b = mkBox()
  const f16 = A.frameOf(b, '16:9')
  const f9 = A.frameOf(b, '9:16')
  approx(f16.x, 0.2, 'frameOf x identity (16:9)')
  approx(f16.w, 0.7, 'frameOf w identity (16:9)')
  approx(f16.y, 0.5 * H16, 'frameOf y → width-units (16:9)')
  approx(f9.y, 0.5 * H9, 'frameOf y → width-units (9:16)')
  ok(A.frameOf(mkBox({ frame: { '16:9': { x: 0, y: 0, w: null }, '9:16': { x: 0, y: 0, w: null } } }), '16:9').w === null, 'frameOf null wrap → null')
}

// --- round-trip: toStoredY ∘ frameOf.y = identity, both directions --------
{
  for (const aspect of ['16:9', '9:16']) {
    const y = 0.37
    const widthUnits = y * (aspect === '16:9' ? H16 : H9)
    approx(A.toStoredY(widthUnits, aspect), y, `toStoredY round-trips (${aspect})`)
  }
}

// --- projectForAspect: flat frames, aspect set, content untouched ----------
{
  const p = mkProject([mkSlide([mkBox()])])
  const flat = A.projectForAspect(p, '9:16')
  ok(flat.aspect === '9:16', 'projectForAspect sets aspect')
  const fb = flat.slides[0].textBoxes[0]
  ok(typeof fb.frame.x === 'number' && fb.frame['16:9'] === undefined, 'flat box frame is a single NormRect')
  approx(fb.frame.y, 0.5 * H9, 'flat box y in width-units for 9:16')
  ok(fb.runs[0].text === 'x', 'content passes through')
  // switching aspect twice on a linked box is stable (frame stays equal in store)
  approx(A.projectForAspect(p, '16:9').slides[0].textBoxes[0].frame.y, 0.5 * H16, 'projectForAspect 16:9 y')
}

// --- migrateProject: v1 (flat frame, width-units y) → v2 (per-aspect, frac-height)
{
  const v1 = {
    version: 1,
    id: 'old',
    name: 'Old',
    fontId: 'F',
    aspect: '9:16',
    brush: {},
    playbackRate: 1,
    baseEmFraction: 0.085,
    defaults: { sizeScale: 1 },
    slides: [mkSlide([{ ...mkBox(), frame: { x: 0.1, y: 0.8, w: 0.5 } }])],
  }
  const { project, aspect } = A.migrateProject(v1)
  ok(aspect === '9:16', 'migrate returns saved aspect')
  ok(project.version === 2, 'migrate bumps version to 2')
  ok(project.aspect === undefined, 'migrate strips aspect from the document')
  ok(project.lockDefault && project.lockDefault.position === true, 'migrate seeds lockDefault')
  const fr = project.slides[0].textBoxes[0].frame
  ok(fr['16:9'] && fr['9:16'], 'migrated box has BOTH frame keys')
  approx(fr['16:9'].y, 0.8 / H9, 'migrate converts width-units y → fraction-of-height')
  approx(fr['16:9'].y, fr['9:16'].y, 'migrated box is linked (both keys equal)')
  approx(fr['16:9'].x, 0.1, 'migrate keeps x')
  approx(fr['16:9'].w, 0.5, 'migrate keeps w')
  // round-trip: rendering the migrated box in its saved aspect reproduces the v1 y
  approx(A.frameOf(project.slides[0].textBoxes[0], '9:16').y, 0.8, 'migrated box renders at the original width-units y in its saved aspect')
}

// --- migrateProject idempotent on v2 (frame untouched) --------------------
{
  const p = mkProject([mkSlide([mkBox()])])
  const { project } = A.migrateProject(p)
  const fr = project.slides[0].textBoxes[0].frame
  approx(fr['16:9'].y, 0.5, 'v2 migrate leaves frame y untouched')
  ok(fr['16:9'] && fr['9:16'], 'v2 migrate keeps both keys')
}

// --- effLock: box → slide → project default -------------------------------
{
  const proj = mkProject([], { lockDefault: { position: true, content: false } })
  const slide = mkSlide([], { lock: { content: true } })
  ok(A.effLock(proj, slide, mkBox()).position === true, 'effLock inherits project default (position)')
  ok(A.effLock(proj, slide, mkBox()).content === true, 'effLock slide overrides project default (content)')
  ok(A.effLock(proj, slide, mkBox({ lock: { content: false } })).content === false, 'effLock box overrides slide')
  ok(A.effLock(proj, slide, mkBox({ lock: { position: false } })).position === false, 'effLock box overrides project default')
}

// --- framesDiverge --------------------------------------------------------
{
  ok(A.framesDiverge(mkBox()) === false, 'linked (equal) frames do not diverge')
  ok(A.framesDiverge(mkBox({ frame: { '16:9': { x: 0.2, y: 0.5, w: 0.7 }, '9:16': { x: 0.2, y: 0.6, w: 0.7 } } })) === true, 'differing y diverges')
  ok(A.framesDiverge(mkBox({ frame: { '16:9': { x: 0.2, y: 0.5, w: 0.7 }, '9:16': { x: 0.2, y: 0.5, w: null } } })) === true, 'wrap on one side only diverges')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)

// Standalone unit test for the Phase-2 lock/frame helpers in videoEdit.ts.
// videoEdit is framework-free (pure project transforms); bundle + run:
//   node tools/videoEdit.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = await esbuild.build({
  stdin: { contents: `export * from '@app/state/videoEdit'`, resolveDir: ROOT, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@lib': join(ROOT, 'src/lib'), '@app': join(ROOT, 'src/app') },
})
const dir = mkdtempSync(join(tmpdir(), 'vedit-'))
const out = join(dir, 'videoEdit.mjs')
writeFileSync(out, res.outputFiles[0].text)
const E = await import(pathToFileURL(out).href)

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
const mkProject = (boxes, slideOver = {}) => ({
  version: 2,
  id: 'p',
  name: 'P',
  fontId: 'F',
  lockDefault: { position: true, content: true },
  brush: {},
  playbackRate: 1,
  baseEmFraction: 0.085,
  defaults: {},
  slides: [{ id: 's', background: '#000', textBoxes: boxes, holdBeforeTransitionMs: 0, transition: { kind: 'none', durationMs: 0 }, ...slideOver }],
  namedStyles: [],
  voiceover: [],
})
const box0 = (p) => p.slides[0].textBoxes[0]

// --- updateTextBoxFrame writes only the listed aspects ---------------------
{
  const p = mkProject([mkBox()])
  const only9 = E.updateTextBoxFrame(p, 's', 'b', { y: 0.8 }, ['9:16'])
  approx(box0(only9).frame['9:16'].y, 0.8, 'writeAspects=[9:16] updates 9:16')
  approx(box0(only9).frame['16:9'].y, 0.5, 'writeAspects=[9:16] leaves 16:9 (diverges)')
  const both = E.updateTextBoxFrame(p, 's', 'b', { y: 0.8 }, ['16:9', '9:16'])
  approx(box0(both).frame['16:9'].y, 0.8, 'both: 16:9 updated')
  approx(box0(both).frame['9:16'].y, 0.8, 'both: 9:16 updated')
  // immutability: original untouched
  approx(box0(p).frame['9:16'].y, 0.5, 'original project not mutated')
}

// --- setBoxPositionLink: unlink leaves frames; relink converges (active wins)
{
  let p = mkProject([mkBox()])
  p = E.setBoxPositionLink(p, 's', 'b', false, '16:9')
  ok(box0(p).lock && box0(p).lock.position === false, 'unlink sets box.lock.position = false')
  // diverge by editing only the active aspect
  p = E.updateTextBoxFrame(p, 's', 'b', { y: 0.9 }, ['16:9'])
  ok(box0(p).frame['16:9'].y === 0.9 && box0(p).frame['9:16'].y === 0.5, 'edit while unlinked diverges')
  // relink while viewing 16:9 → 9:16 should adopt 16:9's value (active wins)
  const relinked = E.setBoxPositionLink(p, 's', 'b', true, '16:9')
  ok(box0(relinked).lock.position === true, 'relink sets lock.position = true')
  approx(box0(relinked).frame['9:16'].y, 0.9, 'relink converges other aspect to the active one')
  approx(box0(relinked).frame['16:9'].y, 0.9, 'relink keeps the active aspect')
  // relink while viewing 9:16 instead → 16:9 adopts 9:16's value
  const relinked9 = E.setBoxPositionLink(p, 's', 'b', true, '9:16')
  approx(box0(relinked9).frame['16:9'].y, 0.5, 'relink (active=9:16) converges 16:9 to 9:16')
}

// --- setSlidePositionLink: clears box overrides + converges all -----------
{
  let p = mkProject([mkBox({ id: 'a', lock: { position: false }, frame: { '16:9': { x: 0.1, y: 0.2, w: 0.7 }, '9:16': { x: 0.1, y: 0.6, w: 0.7 } } }), mkBox({ id: 'c' })])
  // unlink all
  const unl = E.setSlidePositionLink(p, 's', false, '16:9')
  ok(unl.slides[0].lock.position === false, 'unlink-all sets slide.lock.position = false')
  ok(!unl.slides[0].textBoxes[0].lock, 'unlink-all clears the box-level position override')
  // link all (active 16:9) → both boxes converge 9:16 ← 16:9
  const lnk = E.setSlidePositionLink(p, 's', true, '16:9')
  ok(lnk.slides[0].lock.position === true, 'link-all sets slide.lock.position = true')
  approx(lnk.slides[0].textBoxes[0].frame['9:16'].y, 0.2, 'link-all converges diverged box (active wins)')
  ok(!lnk.slides[0].textBoxes[0].lock, 'link-all clears box override so it inherits the slide')
}

// --- format lock: content write-through + converge ------------------------
{
  const p = mkProject([mkBox()])
  // content-linked → writes the shared base, no override
  const linked = E.updateTextBoxContent(p, 's', 'b', { align: 'center' }, '16:9', true)
  ok(box0(linked).align === 'center' && !box0(linked).contentByAspect, 'content linked → writes base, no override')
  // content-unlinked → writes only the active aspect's override
  const unl = E.updateTextBoxContent(p, 's', 'b', { align: 'right' }, '16:9', false)
  ok(box0(unl).align === 'left', 'content unlinked → shared base untouched')
  ok(box0(unl).contentByAspect['16:9'].align === 'right', 'content unlinked → active override set')
  ok(!box0(unl).contentByAspect['9:16'], 'content unlinked → other aspect has no override (tracks base)')
  // applyTextStyle while unlinked diverges runs into the active override
  const styled = E.applyTextStyle(p, 's', 'b', 0, 1, { color: '#f00' }, '9:16', false)
  ok(box0(styled).contentByAspect['9:16'].runs[0].color === '#f00', 'applyTextStyle unlinked → active override runs')
  ok(box0(styled).runs[0].color === undefined, 'applyTextStyle unlinked → base runs untouched')
  // re-link converges (active wins) + clears overrides
  const relink = E.setBoxFormatLink(unl, 's', 'b', true, '16:9')
  ok(box0(relink).align === 'right' && !box0(relink).contentByAspect, 'setBoxFormatLink(true) converges active→base, clears overrides')
  ok(box0(relink).lock.content === true, 'setBoxFormatLink(true) sets lock.content')
  const u2 = E.setBoxFormatLink(p, 's', 'b', false, '16:9')
  ok(u2.slides[0].textBoxes[0].lock.content === false, 'setBoxFormatLink(false) sets lock.content false')
}

// --- setSlideFormatLink converges all -------------------------------------
{
  const p = mkProject([mkBox({ contentByAspect: { '9:16': { runs: [{ text: 'y' }], align: 'center', lineHeightScale: 1.5 } }, lock: { content: false } })])
  const lnk = E.setSlideFormatLink(p, 's', true, '16:9')
  ok(lnk.slides[0].lock.content === true, 'setSlideFormatLink sets slide.lock.content')
  ok(!lnk.slides[0].textBoxes[0].contentByAspect, 'link-all clears content overrides')
  ok(lnk.slides[0].textBoxes[0].align === 'left', 'link-all converges to the active (16:9 base) content')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)

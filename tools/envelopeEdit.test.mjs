// Standalone unit test for the timing-edit modal math (envelopeEdit.ts):
// 3 fields × {change envelope | compensate} × compensator choice + failure cases.
// Run: node tools/envelopeEdit.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = await esbuild.build({
  stdin: { contents: `export * from '@app/components/video/envelopeEdit'`, resolveDir: ROOT, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@lib': join(ROOT, 'src/lib'), '@app': join(ROOT, 'src/app') },
})
const dir = mkdtempSync(join(tmpdir(), 'envedit-'))
const out = join(dir, 'envelopeEdit.mjs')
writeFileSync(out, res.outputFiles[0].text)
const E = await import(pathToFileURL(out).href)

let passed = 0
let failed = 0
const ok = (cond, msg, got) => {
  if (cond) passed++
  else {
    failed++
    console.error(`  ✗ ${msg}` + (got !== undefined ? ` — got ${JSON.stringify(got)}` : ''))
  }
}
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps

// the working partition: 5.0s envelope = 0.8s pad · 3.4s animation · 0.8s pad
const P = { env: 5000, startPad: 800, bubble: 3400, endPad: 800, contentMs: 8700 }

// --- mode 'envelope': the delta lands on the envelope; the others hold --------
{
  const a = E.applyTimingEdit(P, 'initial', 1300, 'envelope', 'final')
  ok(a.ok && a.patch.envelopeMs === 5500 && a.patch.delayBeforeMs === 1300 && a.patch.speed === undefined, 'initial+500 grows the envelope, others hold', a)
  const b = E.applyTimingEdit(P, 'animation', 2600, 'envelope', 'initial')
  ok(b.ok && b.patch.envelopeMs === 4200 && near(b.patch.speed, 8700 / 2600), 'animation edit re-times + resizes the envelope', b)
  const c = E.applyTimingEdit(P, 'final', 300, 'envelope', 'initial')
  ok(c.ok && c.patch.envelopeMs === 4500 && c.patch.delayBeforeMs === undefined && c.patch.speed === undefined, 'final−500 shrinks the envelope only', c)
}

// --- mode 'compensate': envelope fixed; the chosen value absorbs --------------
{
  const a = E.applyTimingEdit(P, 'initial', 1300, 'compensate', 'final')
  ok(a.ok && a.patch.envelopeMs === 5000 && a.patch.delayBeforeMs === 1300 && a.patch.speed === undefined, 'initial+500 ↔ final−500 (derived)', a)
  const b = E.applyTimingEdit(P, 'initial', 1300, 'compensate', 'animation')
  ok(b.ok && b.patch.envelopeMs === 5000 && b.patch.delayBeforeMs === 1300 && near(b.patch.speed, 8700 / 2900), 'initial+500 ↔ animation−500', b)
  const c = E.applyTimingEdit(P, 'final', 1400, 'compensate', 'initial')
  ok(c.ok && c.patch.envelopeMs === 5000 && c.patch.delayBeforeMs === 200 && c.patch.speed === undefined, 'final+600 ↔ initial−600', c)
  const d = E.applyTimingEdit(P, 'animation', 2000, 'compensate', 'initial')
  ok(d.ok && d.patch.envelopeMs === 5000 && d.patch.delayBeforeMs === 2200 && near(d.patch.speed, 8700 / 2000), 'shrinking always fits (compensator grows)', d)
}

// --- failures: the compensator would drop below its floor ---------------------
{
  const a = E.applyTimingEdit(P, 'animation', 4400, 'compensate', 'final')
  ok(!a.ok && a.neededEnvMs === 5200, 'animation+1000 vs final 800 → needs 5.2s', a)
  const b = E.applyTimingEdit(P, 'animation', 4400, 'compensate', 'initial')
  ok(!b.ok && b.neededEnvMs === 5200, 'animation+1000 vs initial 800 → needs 5.2s', b)
  const c = E.applyTimingEdit(P, 'final', 4300, 'compensate', 'animation')
  ok(!c.ok && c.neededEnvMs === 4300 + 800 + E.MIN_ANIM_MS, 'final+3500 vs animation floor → needs env incl. min block', c)
  // exactly-at-floor fits (final can reach 0)
  const d = E.applyTimingEdit(P, 'initial', 1600, 'compensate', 'final')
  ok(d.ok && d.patch.delayBeforeMs === 1600, 'compensator can land exactly on its floor', d)
}

// --- floors + degenerate content ----------------------------------------------
{
  const a = E.applyTimingEdit(P, 'animation', 3, 'compensate', 'final')
  ok(a.ok && near(a.patch.speed, 8700 / E.MIN_ANIM_MS), 'animation clamps to the minimum block', a)
  const b = E.applyTimingEdit(P, 'initial', -50, 'compensate', 'final')
  ok(b.ok && b.patch.delayBeforeMs === 0, 'negative padding clamps to 0', b)
  const empty = E.applyTimingEdit({ ...P, contentMs: 0, bubble: 0 }, 'animation', 500, 'compensate', 'final')
  ok(empty.ok && empty.patch.envelopeMs === 5000 && empty.patch.speed === undefined, 'no content → animation edit just pins the envelope', empty)
}

// --- default compensator --------------------------------------------------------
{
  ok(E.defaultCompensator('initial') === 'final', 'editing initial → final compensates by default')
  ok(E.defaultCompensator('animation') === 'initial', 'editing animation → initial by default')
  ok(E.defaultCompensator('final') === 'initial', 'editing final → initial by default')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

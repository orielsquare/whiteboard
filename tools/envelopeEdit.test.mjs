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

// --- applyEnvelopeResize: scale OFF — the block's absolute length holds ---------
{
  // grow: pads share the leftover in their current ratio (here 1:1)
  const a = E.applyEnvelopeResize(P, 8000, false)
  ok(
    a.patch.envelopeMs === 8000 &&
      a.patch.delayBeforeMs === 2300 &&
      near(a.patch.speed, 8700 / 3400) &&
      near(a.bubble, 3400),
    'grow: block absolute, pads split leftover 1:1',
    a,
  )
  // shrink, pads still cover it: block holds, pads shrink in ratio
  const b = E.applyEnvelopeResize(P, 4000, false)
  ok(b.patch.delayBeforeMs === 300 && near(b.bubble, 3400) && near(b.patch.speed, 8700 / 3400), 'shrink into padding: block holds', b)
  // shrink below the block: padding fully consumed → the block shrinks with the envelope
  const c = E.applyEnvelopeResize(P, 3000, false)
  ok(c.patch.delayBeforeMs === 0 && near(c.bubble, 3000) && near(c.patch.speed, 8700 / 3000), 'shrink past padding: block = envelope', c)
  // zero end pad (the auto-pinned shape): all growth lands in the start pad
  const zp = { env: 1600, startPad: 1000, bubble: 600, endPad: 0, contentMs: 600 }
  const d = E.applyEnvelopeResize(zp, 2100, false)
  ok(d.patch.delayBeforeMs === 1500 && near(d.bubble, 600), 'zero end pad: growth goes to the start pad', d)
  // zero padding both sides: block first, new space becomes end pad
  const np = { env: 600, startPad: 0, bubble: 600, endPad: 0, contentMs: 600 }
  const e = E.applyEnvelopeResize(np, 1000, false)
  ok(e.patch.delayBeforeMs === 0 && near(e.bubble, 600), 'no padding at all: growth becomes end pad', e)
  // a COMPRESSED block (natural ≫ shown) is canonicalized: speed pins the shown length
  const comp = { env: 5000, startPad: 800, bubble: 3400, endPad: 800, contentMs: 34000 }
  const f = E.applyEnvelopeResize(comp, 9000, false)
  ok(near(f.bubble, 3400) && near(f.patch.speed, 34000 / 3400), 'compressed block: resize pins the SHOWN length via speed', f)
}

// --- applyEnvelopeResize: degenerate blocks — envelope-only writes ---------------
{
  // no content (e.g. an emptied textbox in auto mode, startPad = whole envelope):
  // the delay must NOT be rewritten, or text typed later animates in 0ms
  const empty = { env: 800, startPad: 800, bubble: 0, endPad: 0, contentMs: 0 }
  const a = E.applyEnvelopeResize(empty, 5000, false)
  ok(
    a.patch.envelopeMs === 5000 && a.patch.delayBeforeMs === undefined && a.patch.speed === undefined && near(a.startPad, 800),
    'no content → envelope-only write, delay preserved',
    a,
  )
  const a2 = E.applyEnvelopeResize(empty, 5000, true)
  ok(a2.patch.delayBeforeMs === undefined && a2.patch.speed === undefined, 'no content → envelope-only even when scaling', a2)
  // block clamped away (legacy delay ≥ envelope): growing must RECOVER the block,
  // not preserve "0" (which would write delay = env and speed = content/10ms)
  const clamped = { env: 1000, startPad: 1000, bubble: 0, endPad: 0, contentMs: 2000, naturalMs: 2000 }
  const b = E.applyEnvelopeResize(clamped, 5000, false)
  ok(
    b.patch.envelopeMs === 5000 && b.patch.delayBeforeMs === undefined && b.patch.speed === undefined,
    'clamped-away block → envelope-only write (recovery)',
    b,
  )
  ok(near(b.startPad, 1000) && near(b.bubble, 2000), 'recovery preview: block re-expands to natural in the new room', b)
  // shrinking while still degenerate stays an envelope-only write
  const c = E.applyEnvelopeResize(clamped, 500, false)
  ok(c.patch.envelopeMs === 500 && c.patch.delayBeforeMs === undefined && near(c.startPad, 500) && near(c.bubble, 0), 'still-degenerate shrink: envelope only', c)
}

// --- applyEnvelopeResize: scale ON — everything scales by env1/env0 -------------
{
  const a = E.applyEnvelopeResize(P, 10000, true)
  ok(
    a.patch.envelopeMs === 10000 && a.patch.delayBeforeMs === 1600 && near(a.bubble, 6800) && near(a.patch.speed, 8700 / 6800),
    'scale ×2: pads + block double (proportions hold)',
    a,
  )
  const b = E.applyEnvelopeResize(P, 2500, true)
  ok(b.patch.delayBeforeMs === 400 && near(b.bubble, 1700) && near(b.patch.speed, 8700 / 1700), 'scale ×0.5: pads + block halve', b)
  // proportions hold: startPad/env and bubble/env are invariant
  ok(near(a.startPad / 10000, P.startPad / P.env) && near(a.bubble / 10000, P.bubble / P.env), 'fractions invariant when scaling')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

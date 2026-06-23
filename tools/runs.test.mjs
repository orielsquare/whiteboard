// Standalone unit test for the pure run-surgery engine (src/lib/project/runs.ts).
// runs.ts has only `import type` deps, so esbuild strips them and it runs alone.
// Run: node tools/runs.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const src = readFileSync(new URL('../src/lib/project/runs.ts', import.meta.url), 'utf8')
const js = (await esbuild.transform(src, { loader: 'ts', format: 'esm' })).code
const dir = mkdtempSync(join(tmpdir(), 'runs-'))
const out = join(dir, 'runs.mjs')
writeFileSync(out, js)
const R = await import(pathToFileURL(out).href)

let passed = 0
let failed = 0
// Order-insensitive deep equality (run objects may emit keys in any order).
const norm = (v) =>
  Array.isArray(v)
    ? v.map(norm)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
      : v
const eq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b))
const check = (name, cond, got) => {
  if (cond) passed++
  else { failed++; console.error(`✗ ${name}` + (got !== undefined ? ` — got ${JSON.stringify(got)}` : '')) }
}

// runsToPlainText
check('plain text', R.runsToPlainText([{ text: 'ab' }, { text: 'cd', underline: true }]) === 'abcd')

// styleKey equality ignores text, distinguishes style
check('styleKey same', R.styleKey({ text: 'a' }) === R.styleKey({ text: 'b' }))
check('styleKey diff size', R.styleKey({ text: 'a', sizeScale: 2 }) !== R.styleKey({ text: 'a' }))
check('styleKey color null==absent', R.styleKey({ text: 'a', color: null }) === R.styleKey({ text: 'a' }))

// normalizeRuns: drop empty + merge adjacent equal-style
{
  const n = R.normalizeRuns([{ text: 'a' }, { text: '' }, { text: 'b' }, { text: 'c', underline: true }])
  check('normalize merge', eq(n, [{ text: 'ab' }, { text: 'c', underline: true }]), n)
}
// normalizeRuns never returns [] — preserves leading style on full delete
{
  const n = R.normalizeRuns([{ text: '', sizeScale: 2 }])
  check('normalize empty keeps one run', n.length === 1 && n[0].text === '', n)
  check('normalize empty keeps style', n[0].sizeScale === 2, n)
}

// splitRunAt: boundary inside a run
{
  const s = R.splitRunAt([{ text: 'abcd', underline: true }], 2)
  check('split mid', eq(s, [{ text: 'ab', underline: true }, { text: 'cd', underline: true }]), s)
  const s2 = R.splitRunAt([{ text: 'abcd' }], 0) // boundary at 0 → no split
  check('split at 0', eq(s2, [{ text: 'abcd' }]), s2)
  const s3 = R.splitRunAt([{ text: 'ab' }, { text: 'cd' }], 2) // already a boundary
  check('split at existing boundary', eq(s3, [{ text: 'ab' }, { text: 'cd' }]), s3)
}

// applyStyleToRange: style a middle slice
{
  const r = R.applyStyleToRange([{ text: 'abcde' }], 1, 4, { underline: true })
  check('apply mid underline', eq(r, [{ text: 'a' }, { text: 'bcd', underline: true }, { text: 'e' }]), r)
}
// applyStyleToRange: size to whole
{
  const r = R.applyStyleToRange([{ text: 'abc' }], 0, 3, { sizeScale: 2 })
  check('apply whole size', eq(r, [{ text: 'abc', sizeScale: 2 }]), r)
}
// applyStyleToRange: toggle a style OFF (patch underline:false) merges back
{
  const start = [{ text: 'ab', underline: true }, { text: 'cd', underline: true }]
  const r = R.applyStyleToRange(start, 0, 4, { underline: false })
  check('apply toggle off merges', eq(r, [{ text: 'abcd' }]), r)
}
// applyStyleToRange: empty selection = no-op (normalized)
{
  const r = R.applyStyleToRange([{ text: 'ab' }, { text: 'cd' }], 2, 2, { underline: true })
  check('apply empty sel noop', eq(r, [{ text: 'abcd' }]), r)
}

// setPlainTextPreservingStyles: insert in the middle inherits LEFT style
{
  const start = [{ text: 'ab', underline: true }, { text: 'cd' }]
  const r = R.setPlainTextPreservingStyles(start, 'abXcd') // insert X after "ab"
  check('insert inherits left', eq(r, [{ text: 'abX', underline: true }, { text: 'cd' }]), r)
}
// insert at a boundary where left run ends — still left style ("ab|cd" insert at 2)
{
  const start = [{ text: 'ab', color: '#f00' }, { text: 'cd' }]
  const r = R.setPlainTextPreservingStyles(start, 'abZcd')
  check('insert at boundary inherits left', eq(r, [{ text: 'abZ', color: '#f00' }, { text: 'cd' }]), r)
}
// delete spanning runs preserves surrounding styles
{
  const start = [{ text: 'ab', underline: true }, { text: 'cd' }, { text: 'ef', sizeScale: 2 }]
  const r = R.setPlainTextPreservingStyles(start, 'abef') // delete "cd"
  check('delete middle', eq(r, [{ text: 'ab', underline: true }, { text: 'ef', sizeScale: 2 }]), r)
}
// append at end inherits last run style
{
  const start = [{ text: 'ab' }, { text: 'cd', underline: true }]
  const r = R.setPlainTextPreservingStyles(start, 'abcdef')
  check('append inherits last', eq(r, [{ text: 'ab' }, { text: 'cdef', underline: true }]), r)
}
// no change
{
  const start = [{ text: 'ab', underline: true }]
  const r = R.setPlainTextPreservingStyles(start, 'ab')
  check('no change', eq(r, start), r)
}
// full clear → single empty run, keeps leading style
{
  const start = [{ text: 'ab', sizeScale: 2 }]
  const r = R.setPlainTextPreservingStyles(start, '')
  check('clear keeps one run', r.length === 1 && r[0].text === '', r)
}

// runStyleAt: reports the style of the char at the offset
{
  const runs = [{ text: 'ab', underline: true }, { text: 'cd', sizeScale: 2 }]
  check('styleAt 0', R.runStyleAt(runs, 0).underline === true)
  check('styleAt 2 (start of 2nd run)', R.runStyleAt(runs, 2).sizeScale === 2, R.runStyleAt(runs, 2))
  check('styleAt end clamps to last', R.runStyleAt(runs, 4).sizeScale === 2)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

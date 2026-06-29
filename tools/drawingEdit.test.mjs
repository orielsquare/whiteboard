// Unit tests for the new Drawing editing primitives:
//   src/lib/drawing/partEdit.ts  (split / merge / flip / move / reorder / delete on
//                                 a part's stroke sections)
//   src/lib/svg/derive.ts        (asOutline: coerce a fill into its boundary path)
// Both pull in runtime deps (vec.dist / hatch / centerline), so we bundle via
// esbuild (cf. tools/drawingVideo.test.mjs). Run: node tools/drawingEdit.test.mjs
import esbuild from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = await esbuild.build({
  stdin: {
    contents: `
      export { reorderSections, moveSection, flipSection, deleteSection, splitSection, mergeSections } from '@lib/drawing/partEdit'
      export { deriveSections } from '@lib/svg/derive'
    `,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@lib': join(ROOT, 'src/lib'), '@app': join(ROOT, 'src/app') },
})
const dir = mkdtempSync(join(tmpdir(), 'dwgedit-'))
const out = join(dir, 'm.mjs')
writeFileSync(out, res.outputFiles[0].text)
const m = await import(pathToFileURL(out).href)

let passed = 0
let failed = 0
const check = (name, cond, got) => {
  if (cond) passed++
  else { failed++; console.error(`✗ ${name}` + (got !== undefined ? ` — got ${JSON.stringify(got)}` : '')) }
}

const pt = (x, y) => ({ x, y, width: 2 })
const sec = (id, pts) => ({ id, points: pts, kind: 'curve' })

// ── partEdit: split ───────────────────────────────────────────────────────────
{
  const s = sec('a', [pt(0, 0), pt(1, 0), pt(2, 0), pt(3, 0), pt(4, 0)])
  const out = m.splitSection([s], 'a')
  check('split → 2 sections', out.length === 2, out.length)
  check('split shares the cut point', out[0].points.at(-1).x === out[1].points[0].x, [out[0].points.at(-1).x, out[1].points[0].x])
  check('split covers all points', out[0].points.length + out[1].points.length === s.points.length + 1, [out[0].points.length, out[1].points.length])
  check('split fresh ids', out[0].id !== 'a' && out[1].id !== 'a' && out[0].id !== out[1].id)
  // a straight 2-point stroke splits by inserting an interpolated midpoint
  const two = m.splitSection([sec('b', [pt(0, 0), pt(2, 0)])], 'b')
  check('split 2-point inserts a midpoint', two.length === 2 && two[0].points.at(-1).x === 1 && two[1].points[0].x === 1, two.map((s) => s.points.map((p) => p.x)))
  check('split single point is a no-op', m.splitSection([sec('c', [pt(0, 0)])], 'c').length === 1)
}

// ── partEdit: merge (nearest endpoints, auto-oriented) ──────────────────────────
{
  const a = sec('a', [pt(0, 0), pt(1, 0), pt(2, 0)])
  const b = sec('b', [pt(2, 0), pt(3, 0), pt(4, 0)]) // b starts where a ends
  const out = m.mergeSections([a, b], 'a', 'b')
  check('merge → 1 section', out.length === 1, out.length)
  check('merge drops shared join point', out[0].points.length === 5, out[0].points.length)
  check('merge spans both ends', out[0].points[0].x === 0 && out[0].points.at(-1).x === 4, [out[0].points[0].x, out[0].points.at(-1).x])
  // order-independent + auto-orient: reversed b, selected b-first, still joins cleanly
  const b2 = sec('b', [pt(4, 0), pt(3, 0), pt(2, 0)])
  const out2 = m.mergeSections([a, b2], 'b', 'a')
  check('merge auto-orients', out2.length === 1 && out2[0].points.length === 5, out2[0]?.points.length)
}

// ── partEdit: flip / move / reorder / delete ────────────────────────────────────
{
  const list = [sec('a', [pt(0, 0), pt(1, 1)]), sec('b', [pt(2, 2), pt(3, 3)]), sec('c', [pt(4, 4), pt(5, 5)])]
  const flipped = m.flipSection(list, 'a')
  check('flip reverses points', flipped[0].points[0].x === 1 && flipped[0].points.at(-1).x === 0, flipped[0].points.map((p) => p.x))
  check('flip leaves others', flipped[1] === list[1])
  check('move down', m.moveSection(list, 'a', 1).map((s) => s.id).join('') === 'bac')
  check('move up clamped', m.moveSection(list, 'a', -1).map((s) => s.id).join('') === 'abc')
  check('reorder by ids', m.reorderSections(list, ['c', 'a', 'b']).map((s) => s.id).join('') === 'cab')
  check('delete', m.deleteSection(list, 'b').map((s) => s.id).join('') === 'ac')
}

// ── derive: coerce a fill into a path (asOutline) ───────────────────────────────
{
  const square = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]
  const pe = {
    sourceId: 'sq', label: 'sq', subpaths: [{ points: square, closed: true }],
    hasStroke: false, strokeWidth: 0, strokeColor: null, hasFill: true, fillColor: '#333',
    bbox: { x: 0, y: 0, w: 40, h: 40 },
  }
  const shaded = m.deriveSections(pe, {})
  check('default fill → hatch lines', shaded.some((g) => g.kind === 'line' && g.role === 'fill'), shaded.map((g) => g.kind))

  const asPath = m.deriveSections(pe, { asOutline: true })
  check('asOutline → some sections', asPath.length >= 1, asPath.length)
  check('asOutline → no hatch lines', asPath.every((g) => g.kind !== 'line'), asPath.map((g) => g.kind))
  check('asOutline → traces the boundary loop', asPath.some((g) => g.kind === 'loop'), asPath.map((g) => g.kind))
  check('asOutline → role fill (stays in the shading part)', asPath.every((g) => g.role === 'fill'), asPath.map((g) => g.role))
  check('asOutline → far fewer sections than hatch', asPath.length < shaded.length, [asPath.length, shaded.length])

  // outlineFill (boundary + shading) is unaffected: boundary as role 'outline' + hatch
  const both = m.deriveSections(pe, { outlineFill: true })
  check('outlineFill keeps boundary + hatch', both.some((g) => g.role === 'outline') && both.some((g) => g.role === 'fill' && g.kind === 'line'), both.map((g) => `${g.role}:${g.kind}`))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

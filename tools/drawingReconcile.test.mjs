// Regression test for the "Sketch boundary before shading" toggle: it must NOT
// reset the surviving shading part (name, colour, alpha, timing, visibility, z, id).
// Reproduces exactly what the store's `setElementOutlineFill` does — re-derive the
// element, build fresh parts, then `reconcileElementParts` against the user's edited
// parts — but on the pure seam (no React/zustand). Bundles seed.ts via esbuild
// (it has runtime deps on the svg engines). Run: node tools/drawingReconcile.test.mjs
import esbuild from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = await esbuild.build({
  stdin: {
    contents: `
      export { seedDrawingElement, rederiveElement, buildElementParts, reconcileElementParts } from '@lib/drawing/seed'
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
const dir = mkdtempSync(join(tmpdir(), 'dwgrec-'))
const out = join(dir, 'seed.mjs')
writeFileSync(out, res.outputFiles[0].text)
const { seedDrawingElement, rederiveElement, buildElementParts, reconcileElementParts } = await import(pathToFileURL(out).href)

let passed = 0
let failed = 0
const check = (name, cond, got) => {
  if (cond) passed++
  else { failed++; console.error(`✗ ${name}` + (got !== undefined ? ` — got ${JSON.stringify(got)}` : '')) }
}

// A fill-only square (no stroke) — the case where the "Sketch boundary before
// shading" checkbox is offered. Hand-built ParsedElement (parseSvg needs a DOM).
const square = [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
]
const pe = {
  sourceId: 'eye',
  label: 'circle · eye',
  subpaths: [{ points: square, closed: true }],
  hasStroke: false,
  strokeWidth: 0,
  strokeColor: null,
  hasFill: true,
  fillColor: '#333',
  bbox: { x: 0, y: 0, w: 100, h: 100 },
}

// Seed → one fill-only "shading" part (no outline, since the source has no stroke).
const seeded = seedDrawingElement(pe)
check('0 seeds shading only', seeded.parts.length === 1 && seeded.parts[0].kind === 'fill', seeded.parts.map((p) => p.kind))
const element = seeded.element

// The user edits the shading part: rename, recolour, change alpha + timing, hide it.
const editedFill = {
  ...seeded.parts[0],
  name: 'LEFT EYE ★',
  color: '#ff0066',
  opacity: 0.5,
  visible: false,
  zOrder: 7,
  timing: { ...seeded.parts[0].timing, durationMs: 2000, easing: 'cubicInOut' },
}
const editedId = editedFill.id

// --- toggle "Sketch boundary before shading" ON (structurally ADDS an outline) ---
const elOn = { ...element, outlineFill: true }
const onGeom = rederiveElement(elOn, pe)
const onRebuilt = reconcileElementParts([editedFill], buildElementParts(elOn, onGeom))

const outOn = onRebuilt.find((p) => p.kind === 'outline')
const fillOn = onRebuilt.find((p) => p.kind === 'fill')
check('1 boundary part added', !!outOn && onRebuilt.length === 2, onRebuilt.map((p) => p.kind))
check('1 outline drawn before shading', onRebuilt[0].kind === 'outline' && onRebuilt[1].kind === 'fill', onRebuilt.map((p) => p.kind))
check('1 shading NAME preserved', fillOn.name === 'LEFT EYE ★', fillOn.name)
check('1 shading colour preserved', fillOn.color === '#ff0066', fillOn.color)
check('1 shading alpha preserved', fillOn.opacity === 0.5, fillOn.opacity)
check('1 shading visibility preserved', fillOn.visible === false, fillOn.visible)
check('1 shading z preserved', fillOn.zOrder === 7, fillOn.zOrder)
check('1 shading id preserved', fillOn.id === editedId, fillOn.id)
check('1 shading timing preserved', fillOn.timing.durationMs === 2000 && fillOn.timing.easing === 'cubicInOut', fillOn.timing)
check('1 shading geometry refreshed (not empty)', fillOn.sections.length > 0, fillOn.sections.length)
// the freshly-added boundary keeps its default name/colour
check('1 new boundary is fresh default', outOn.name === `${element.label} · outline` && outOn.color === null, [outOn.name, outOn.color])

// --- toggle OFF again (structurally REMOVES the outline) ---
const elOff = { ...elOn, outlineFill: false }
const offGeom = rederiveElement(elOff, pe)
const offRebuilt = reconcileElementParts(onRebuilt, buildElementParts(elOff, offGeom))
const fillOff = offRebuilt.find((p) => p.kind === 'fill')
check('2 boundary removed', offRebuilt.length === 1 && offRebuilt[0].kind === 'fill', offRebuilt.map((p) => p.kind))
check('2 shading still preserved across off-toggle', fillOff.name === 'LEFT EYE ★' && fillOff.color === '#ff0066' && fillOff.id === editedId, [fillOff.name, fillOff.color, fillOff.id])

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

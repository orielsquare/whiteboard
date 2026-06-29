// Headless integration test: a placed drawing on a video slide renders + animates
// through the SAME pure seam the editor/preview and MP4 export use. Bundles the
// render seam (esbuild) and renders frames with @napi-rs/canvas (real pixel
// readback), asserting the drawing is painted within its frame, only after its
// animation has progressed. Run: node tools/drawingVideo.test.mjs
import esbuild from 'esbuild'
import { createCanvas } from '@napi-rs/canvas'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const res = await esbuild.build({
  stdin: {
    contents: `
      export { buildRenderContext, renderProject, projectDurationMs } from '@lib/project/render'
      export { prepareDrawing } from '@lib/drawing/timeline'
      export { canvasSize, exportCanvasW } from '@lib/project/coords'
      export { projectForAspect, migrateProject } from '@lib/project/aspect'
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
const dir = mkdtempSync(join(tmpdir(), 'dwgvid-'))
const out = join(dir, 'seam.mjs')
writeFileSync(out, res.outputFiles[0].text)
const seam = await import(pathToFileURL(out).href)

let passed = 0
let failed = 0
const check = (name, cond, got) => {
  if (cond) passed++
  else { failed++; console.error(`✗ ${name}` + (got !== undefined ? ` — got ${JSON.stringify(got)}` : '')) }
}

const DRAWING_ID = 'dwg-test'
const rawProject = {
  version: 2,
  id: 'p',
  name: 'drawing render test',
  fontId: 'F',
  lockDefault: { position: true, content: true },
  brush: { style: 'ink', color: '#ffffff', sizeScale: 1, opacity: 1, jitter: 0, nibModel: 'round', cap: 'round', seed: 1 },
  playbackRate: 1,
  baseEmFraction: 0.085,
  defaults: {},
  namedStyles: [],
  voiceover: [],
  slides: [
    {
      id: 's1',
      background: '#101010',
      textBoxes: [],
      drawings: [
        {
          id: 'inst1',
          drawingId: DRAWING_ID,
          frame: { '16:9': { x: 0.3, y: 0.3, w: 0.4 }, '9:16': { x: 0.3, y: 0.3, w: 0.4 } },
          animOrder: 0,
          delayBeforeMs: 0,
        },
      ],
      holdBeforeTransitionMs: 1000,
      transition: { kind: 'none', durationMs: 0 },
    },
  ],
  createdAt: 'x',
  updatedAt: 'x',
}

// A drawing whose single outline stroke is a diagonal line across a 100×100 viewBox,
// drawn linearly over 500ms.
const parts = [
  {
    id: 'inst1-outline',
    elementId: 'e1',
    kind: 'outline',
    name: 'line',
    zOrder: 1,
    visible: true,
    color: null,
    sections: [
      {
        id: 's0',
        kind: 'curve',
        points: [
          { x: 10, y: 10, width: 4 },
          { x: 90, y: 90, width: 4 },
        ],
      },
    ],
    timing: { durationMs: 500, delayBeforeMs: 0, easing: 'linear' },
  },
]

const { project: migrated } = seam.migrateProject(rawProject)
const flat = seam.projectForAspect(migrated, '16:9')
const fontSet = { byId: new Map([['F', { glyphs: new Map(), metrics: { unitsPerEm: 1000, ascender: 800, descender: -200 } }]]), defaultId: 'F' }
const prepared = seam.prepareDrawing(parts)
const drawingSet = new Map([[DRAWING_ID, { prepared, viewBox: { x: 0, y: 0, w: 100, h: 100 } }]])

const w = 320
const h = seam.canvasSize('16:9', w).h
const rc = seam.buildRenderContext(flat, fontSet, drawingSet, w, 1)

// total duration = content(500) + hold(1000) + tail; the drawing draws [0,500].
check('1 timing includes drawing window', rc.timing.slides[0].timing.drawings.length === 1, rc.timing.slides[0].timing.drawings)
check('1 drawing end ≈ 500', Math.abs(rc.timing.slides[0].timing.drawings[0].endMs - 500) < 1, rc.timing.slides[0].timing.drawings[0])

const canvas = createCanvas(w, h)
const ctx = canvas.getContext('2d')

// Max luminance in a square region (probe for drawn ink).
const maxLumaAround = (cx, cy, r) => {
  const x0 = Math.max(0, cx - r)
  const y0 = Math.max(0, cy - r)
  const data = ctx.getImageData(x0, y0, Math.min(w - x0, 2 * r), Math.min(h - y0, 2 * r)).data
  let max = 0
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    if (luma > max) max = luma
  }
  return max
}

// The viewBox midpoint (50,50) maps to the centre of the placed frame.
// originX = 0.3·w = 96 ; widthPx = 0.4·w = 128 ; midX = 96 + 64 = 160.
// flatY = 0.3 · aspectHeightUnits(16:9)=0.5625 = 0.16875 ; originY = 54 ; heightPx = 128 ; midY = 118.
const MID_X = 160
const MID_Y = 118

// Frame fully past the drawing's end → the diagonal is fully drawn through the centre.
seam.renderProject(ctx, flat, rc, 700, w, h)
check('2 drawing fully drawn at t=700 (bright centre)', maxLumaAround(MID_X, MID_Y, 8) > 180, maxLumaAround(MID_X, MID_Y, 8))
// background outside the line stays dark (top-right corner of the frame, away from the diagonal)
check('2 corner away from line stays dark', maxLumaAround(96 + 110, 54 + 18, 6) < 60, maxLumaAround(96 + 110, 54 + 18, 6))

// Very early frame → the line has barely started (near viewBox 10,10 = frame top-left),
// so the CENTRE is still background.
seam.renderProject(ctx, flat, rc, 8, w, h)
check('3 centre dark at t=8 (not yet drawn)', maxLumaAround(MID_X, MID_Y, 6) < 60, maxLumaAround(MID_X, MID_Y, 6))

// A drawing whose id is missing from the DrawingSet must not throw / must render nothing extra.
{
  const flat2 = seam.projectForAspect(seam.migrateProject({ ...rawProject, slides: [{ ...rawProject.slides[0], drawings: [{ ...rawProject.slides[0].drawings[0], drawingId: 'absent' }] }] }).project, '16:9')
  const rc2 = seam.buildRenderContext(flat2, fontSet, drawingSet, w, 1)
  ctx.clearRect(0, 0, w, h)
  let threw = false
  try {
    seam.renderProject(ctx, flat2, rc2, 700, w, h)
  } catch {
    threw = true
  }
  check('4 missing drawing id does not throw', !threw)
  check('4 missing drawing paints nothing (dark centre)', maxLumaAround(MID_X, MID_Y, 8) < 60, maxLumaAround(MID_X, MID_Y, 8))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

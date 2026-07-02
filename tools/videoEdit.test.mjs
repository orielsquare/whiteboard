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

// --- shared boxes+drawings animOrder invariant (contiguous 0..n-1, no ties) --
{
  const seq = (p) => {
    const s = p.slides[0]
    return [...s.textBoxes.map((b) => b.animOrder), ...(s.drawings ?? []).map((d) => d.animOrder)]
  }
  const contiguous = (p) => [...seq(p)].sort((a, b) => a - b).every((v, i) => v === i)
  const unique = (p) => new Set(seq(p)).size === seq(p).length
  const animOf = (p, id) => {
    const s = p.slides[0]
    return (s.textBoxes.find((b) => b.id === id) ?? (s.drawings ?? []).find((d) => d.id === id))?.animOrder
  }

  // addDrawing → next shared slot (after the boxes)
  let p = mkProject([mkBox({ id: 'A', animOrder: 0 }), mkBox({ id: 'B', animOrder: 1 })])
  const add = E.addDrawing(p, 's', 'dwg', 'D', 0.3, 0.1, 0.3)
  p = add.project
  ok(contiguous(p) && animOf(p, add.instanceId) === 2, 'addDrawing → contiguous, drawing at shared slot 2')

  // deleteTextBox reindexes boxes AND drawings together
  const pd = E.deleteTextBox(p, 's', 'A')
  ok(contiguous(pd) && unique(pd), 'deleteTextBox → contiguous + unique across boxes+drawings')
  ok(animOf(pd, 'B') === 0 && animOf(pd, add.instanceId) === 1, 'deleteTextBox → B=0, drawing=1 (no gap)')

  // removeDrawing reindexes (no orphaned animOrder)
  let pr = mkProject([mkBox({ id: 'A', animOrder: 0 })])
  pr = E.addDrawing(pr, 's', 'd1', 'D1', 0.3, 0.1, 0.3).project
  pr = E.addDrawing(pr, 's', 'd2', 'D2', 0.3, 0.1, 0.3).project // A0 D1 D2
  pr = E.removeDrawing(pr, 's', pr.slides[0].drawings[0].id) // remove D1
  ok(contiguous(pr) && unique(pr), 'removeDrawing → contiguous + unique')

  // reorderTextBoxes keeps an interleaved drawing in its slot, no collision
  let p4 = mkProject([mkBox({ id: 'A', animOrder: 0 }), mkBox({ id: 'B', animOrder: 2 })])
  p4 = E.addDrawing(p4, 's', 'dwg', 'D', 0.3, 0.1, 0.3).project
  const dId = p4.slides[0].drawings[0].id
  p4 = E.updateDrawing(p4, 's', dId, { animOrder: 1 }) // A0 D1 B2
  p4 = E.reorderTextBoxes(p4, 's', ['B', 'A'])
  ok(contiguous(p4) && unique(p4), 'reorderTextBoxes → contiguous + unique (no ties)')
  ok(animOf(p4, 'B') < animOf(p4, dId) && animOf(p4, dId) < animOf(p4, 'A'), 'reorder keeps drawing between B and A')

  // pasteTextBox uses the shared pool (no collision with a drawing)
  let p5 = mkProject([mkBox({ id: 'A', animOrder: 0 })])
  p5 = E.addDrawing(p5, 's', 'dwg', 'D', 0.3, 0.1, 0.3).project // A0 D1
  p5 = E.pasteTextBox(p5, 's', mkBox({ id: 'A', animOrder: 0 })).project
  ok(contiguous(p5) && unique(p5), 'pasteTextBox → contiguous + unique')

  // reorderSlideItems reorders the COMBINED boxes+drawings sequence by the new id order
  let p6 = mkProject([mkBox({ id: 'A', animOrder: 0 }), mkBox({ id: 'B', animOrder: 1 })])
  p6 = E.addDrawing(p6, 's', 'dwg', 'D', 0.3, 0.1, 0.3).project // A0 B1 D2
  const did = p6.slides[0].drawings[0].id
  p6 = E.reorderSlideItems(p6, 's', [did, 'A', 'B']) // drawing first, then A, then B
  ok(contiguous(p6) && unique(p6), 'reorderSlideItems → contiguous + unique')
  ok(animOf(p6, did) === 0 && animOf(p6, 'A') === 1 && animOf(p6, 'B') === 2, 'reorderSlideItems → D0 A1 B2 (combined order)')

  // copySlide keeps a drawing-less slide shape-identical (no drawings:[] injected)
  const cp = E.copySlide(mkProject([mkBox({ id: 'A', animOrder: 0 })]), 's')
  ok(!('drawings' in cp.project.slides.find((s) => s.id === cp.slideId)), 'copySlide → drawing-less slide omits drawings field')
}

// --- drawing locks: position links frames across aspects; format is a flag ---
{
  const draw0 = (p) => p.slides[0].drawings[0]
  const withDrawing = () => E.addDrawing(mkProject([mkBox({ id: 'A', animOrder: 0 })]), 's', 'dwg', 'D', 0.3, 0.1, 0.3).project

  // unlink position → lock.position=false; editing the active aspect diverges
  let p = withDrawing()
  const id = draw0(p).id
  p = E.setDrawingPositionLink(p, 's', id, false, '16:9')
  ok(draw0(p).lock && draw0(p).lock.position === false, 'drawing unlink → lock.position=false')
  p = E.updateDrawingFrame(p, 's', id, { y: 0.9 }, ['16:9'])
  ok(draw0(p).frame['16:9'].y === 0.9 && draw0(p).frame['9:16'].y === 0.1, 'drawing edit while unlinked diverges')
  // relink (active 16:9) → other aspect converges, override cleared
  const relink = E.setDrawingPositionLink(p, 's', id, true, '16:9')
  ok(relink.slides[0].drawings[0].lock.position === true, 'drawing relink → lock.position=true')
  approx(draw0(relink).frame['9:16'].y, 0.9, 'drawing relink converges other aspect (active wins)')

  // format link is a plain stored flag (no content to converge)
  const fp = withDrawing()
  const fid = draw0(fp).id
  const f = E.setDrawingFormatLink(fp, 's', fid, false)
  ok(draw0(f).lock.content === false, 'drawing setFormatLink(false) → lock.content=false')
  const f2 = E.setDrawingFormatLink(f, 's', fid, true)
  ok(draw0(f2).lock.content === true, 'drawing setFormatLink(true) → lock.content=true')

  // slide-level position "link all" converges drawings too (active wins) + clears override
  let p2 = withDrawing()
  const id2 = draw0(p2).id
  p2 = E.setDrawingPositionLink(p2, 's', id2, false, '16:9')
  p2 = E.updateDrawingFrame(p2, 's', id2, { y: 0.7 }, ['16:9'])
  const sl = E.setSlidePositionLink(p2, 's', true, '16:9')
  approx(sl.slides[0].drawings[0].frame['9:16'].y, 0.7, 'slide link-all converges the drawing too')
  ok(!sl.slides[0].drawings[0].lock, 'slide link-all clears the drawing position override')

  // slide-level format "link all" clears a drawing's content override
  let p3 = withDrawing()
  p3 = E.setDrawingFormatLink(p3, 's', draw0(p3).id, false)
  const sf = E.setSlideFormatLink(p3, 's', true, '16:9')
  ok(!sf.slides[0].drawings[0].lock, 'slide format link-all clears the drawing content override')
}

// --- multi-element ops: translate / remove / collect / paste ----------------
{
  const H = 9 / 16 // aspectHeightUnits('16:9')
  const mkInk = (over = {}) => ({
    id: 'k',
    tool: 'freehand',
    points: [
      { x: 0.1, y: 0.2 },
      { x: 0.3, y: 0.25 },
    ],
    animOrder: 2,
    delayBeforeMs: 0,
    ...over,
  })
  const mkDraw = (over = {}) => ({
    id: 'd',
    drawingId: 'D1',
    frame: { '16:9': { x: 0.4, y: 0.3, w: 0.3 }, '9:16': { x: 0.4, y: 0.3, w: 0.3 } },
    animOrder: 1,
    delayBeforeMs: 0,
    ...over,
  })
  const base = () => mkProject([mkBox()], { drawings: [mkDraw()], inks: [mkInk()] })

  // translate: one write moves a box + a drawing + an ink; linked frames stay equal
  {
    const p = E.translateElements(base(), 's', new Set(['b', 'd', 'k']), 0.1, 0.1125, '16:9') // dyW 0.1125 → dyStored 0.2
    const b = box0(p)
    approx(b.frame['16:9'].x, 0.3, 'translate: box x moved')
    approx(b.frame['16:9'].y, 0.7, 'translate: box stored-y moved by dyW/H')
    approx(b.frame['9:16'].x, 0.3, 'translate: linked box keeps both cuts equal (x)')
    approx(b.frame['9:16'].y, 0.7, 'translate: linked box keeps both cuts equal (y)')
    approx(p.slides[0].drawings[0].frame['16:9'].x, 0.5, 'translate: drawing moved')
    approx(p.slides[0].inks[0].points[0].x, 0.2, 'translate: ink x moved')
    approx(p.slides[0].inks[0].points[0].y, 0.4, 'translate: ink y moved by dyW/H')
    void H
  }
  // translate ignores unselected elements + clamps to [0,1]
  {
    const p = E.translateElements(base(), 's', new Set(['b']), 0.9, 0, '16:9')
    approx(box0(p).frame['16:9'].x, 1, 'translate: clamped to 1')
    approx(p.slides[0].drawings[0].frame['16:9'].x, 0.4, 'translate: unselected drawing untouched')
  }
  // remove: any mix of kinds in one write, sequence reindexed contiguously
  {
    const p = E.removeElements(base(), 's', new Set(['b', 'k']))
    ok(p.slides[0].textBoxes.length === 0, 'remove: box gone')
    ok(p.slides[0].inks.length === 0, 'remove: ink gone')
    ok(p.slides[0].drawings.length === 1 && p.slides[0].drawings[0].animOrder === 0, 'remove: survivor reindexed to 0')
  }
  // collect + paste: clones land with fresh ids, nudged, appended in order
  {
    const src = base()
    const clip = E.collectElements(src.slides[0], new Set(['b', 'd', 'k']))
    ok(clip.length === 3 && clip[0].kind === 'box' && clip[1].kind === 'drawing' && clip[2].kind === 'ink', 'collect: all three, in animOrder')
    // deep clone: mutating the clip must not touch the source
    clip[0].box.frame['16:9'].x = 0.99
    approx(box0(src).frame['16:9'].x, 0.2, 'collect: clones are independent')

    const { project: pasted, ids } = E.pasteElements(src, 's', E.collectElements(src.slides[0], new Set(['b', 'd', 'k'])))
    ok(ids.length === 3, 'paste: three new ids')
    ok(pasted.slides[0].textBoxes.length === 2 && pasted.slides[0].drawings.length === 2 && pasted.slides[0].inks.length === 2, 'paste: all appended')
    const newBox = pasted.slides[0].textBoxes.find((b) => b.id === ids[0])
    approx(newBox.frame['16:9'].x, 0.23, 'paste: nudged +0.03')
    ok(newBox.id !== 'b', 'paste: fresh id')
    // appended after the existing sequence, preserving relative order
    const orders = ids.map((id) =>
      [...pasted.slides[0].textBoxes, ...pasted.slides[0].drawings, ...pasted.slides[0].inks].find((el) => el.id === id).animOrder,
    )
    ok(orders[0] === 3 && orders[1] === 4 && orders[2] === 5, 'paste: appended in original relative order')
    // paste onto ANOTHER slide works too (cross-slide clipboard)
    const two = { ...src, slides: [...src.slides, { id: 's2', background: '#000', textBoxes: [], holdBeforeTransitionMs: 0, transition: { kind: 'none', durationMs: 0 } }] }
    const { project: crossed, ids: ids2 } = E.pasteElements(two, 's2', E.collectElements(two.slides[0], new Set(['b', 'k'])))
    ok(crossed.slides[1].textBoxes.length === 1 && crossed.slides[1].inks.length === 1, 'paste: lands on the other slide')
    const orders2 = ids2.map((id) =>
      [...crossed.slides[1].textBoxes, ...crossed.slides[1].inks].find((el) => el.id === id).animOrder,
    )
    ok(orders2[0] === 0 && orders2[1] === 1, 'paste: fresh sequence on an empty slide')
  }
}

// --- translateCues / shiftCuesFrom (timeline multi-select + envelope-resize lock) --
{
  const cue = (id, startMs, endMs) => ({ id, startMs, endMs, text: id })
  const withCues = (cs) => ({ ...mkProject([mkBox()]), voiceover: cs })
  const p = withCues([cue('a', 1000, 2000), cue('b', 5000, 6500), cue('c', 9000, 9800)])

  // translateCues: only the listed cues move; durations preserved
  const t = E.translateCues(p, new Set(['a', 'c']), 400)
  ok(
    t.voiceover[0].startMs === 1400 && t.voiceover[0].endMs === 2400 && t.voiceover[1].startMs === 5000 && t.voiceover[2].startMs === 9400,
    'translateCues moves only the set, keeping durations',
  )
  // clamped at t=0, duration preserved
  const t2 = E.translateCues(p, new Set(['a']), -1500)
  ok(t2.voiceover[0].startMs === 0 && t2.voiceover[0].endMs === 1000, 'translateCues clamps at 0, duration kept')
  // zero delta = no-op (same reference — no history churn)
  ok(E.translateCues(p, new Set(['a']), 0.2) === p, 'translateCues ~0 delta is a no-op')

  // shiftCuesFrom: everything at/after the boundary moves (later slides' audio lock)
  const s = E.shiftCuesFrom(p, 5000, 700)
  ok(
    s.voiceover[0].startMs === 1000 && s.voiceover[1].startMs === 5700 && s.voiceover[1].endMs === 7200 && s.voiceover[2].startMs === 9700,
    'shiftCuesFrom moves cues at/after the boundary only',
  )
  const back = E.shiftCuesFrom(p, 5000, -700)
  ok(back.voiceover[1].startMs === 4300 && back.voiceover[0].startMs === 1000, 'shiftCuesFrom shifts backwards too')
  ok(E.shiftCuesFrom(p, 5000, 0.3) === p, 'shiftCuesFrom ~0 delta is a no-op')
  ok(E.shiftCuesFrom(withCues([]), 0, 500).voiceover.length === 0, 'no cues → no-op')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)

# Handover — continue here

Read `CLAUDE.md` first for the project overview/architecture. This doc captures **current status**
and the **design for the remaining Video-editor phases (VP2–VP5)** so you can continue without
re-deriving anything. (The original approved plan + design notes lived under the old repo path's
`~/.claude/plans/` and did **not** move with the repo — the relevant content is reproduced below.)

## Status

**Done & verified in-browser:**
- Font animator end-to-end: M1 scaffold, M2 extraction + debug overlay, M3 manifest/persistence/store,
  M4 animation timeline + plain-pen preview, M5 chalk/ink/marker brushes + drag-reorder + stable
  per-stroke colours, M6 editor (split/merge/reorder/flip/timing/save).
- Cross-tab refactor: shared `selectedChar`/`params`/`brush` + single `GlyphExtractor` in App; central
  debounced re-derivation (`ensureGlyphDerived`, `edited`/`derivedSig` provenance, zundo-paused
  commits); brush removed from the manifest (it's an applied style, picker in the Animation tab);
  legacy-manifest migration sets `edited:true`.
- **Video editor VP1**: `VideoProject` data model, `useVideoStore`+`videoEdit`, `/api/projects`
  endpoint + `ProjectStore`, the **Video tab**, global toolbar (aspect 16:9/9:16, base size, brush,
  New/Save/Load/Undo/Redo), and the **slide panel** (add/copy/delete/drag-reorder). Verified: Save
  writes `projects/<id>.json` to disk and Load lists it.

**Video editor VP2 done & verified:** the layout view is live — `layout.ts` (pure `layoutTextBox`,
unit-tested in `tools/layout.test.mjs`, 35 assertions), `render.ts` (`renderTextBox`, static =
`tLocalMs:Infinity`), `layoutCanvas.ts` (coord/hit/selection), `SlideCanvas.tsx` (static render +
select/drag/add-on-empty-click, one undo per drag, Layout/Order toggle — Order is a VP4 placeholder),
`SlideThumbnail.tsx` (content-hash-gated canvas thumb in the slide panel). `VideoView` builds the
`char→PreparedGlyph` map + metrics and derives project glyphs (gated on `fontId`). Verified in-browser:
text lays out in the font, select ring, live drag, add/deselect, 16:9↔9:16 re-render; `tsc` clean.

**Video editor VP3 done & verified:** inline rich text — `runs.ts` (pure, immutable run surgery:
`runsToPlainText`, `styleKey`, `normalizeRuns`, `splitRunAt`, `applyStyleToRange`,
`setPlainTextPreservingStyles` prefix/suffix diff, `runStyleAt`; unit-tested in `tools/runs.test.mjs`,
23 assertions), `RunEditor.tsx` (textarea bound to the flat text → `setPlainTextPreservingStyles`;
size stepper / colour / underline apply to the live selection via `applyStyleToRange`; styled HTML
preview), and `Inspector.tsx` (selected textbox: RunEditor + align + wrap-width `frame.w` nullable +
`delayBeforeMs` + `interCharDelayMs` + delete; plus the slide transition/hold controls moved out of
VideoView). Verified in-browser: typing updates runs + canvas; underline renders per-run on the canvas;
`runStyleAt` drives the active-style highlight; align/wrap/delete via clicks; delete-to-zero stays
healthy; `tsc` + both test suites clean. Selection ↔ runs uses fresh `textarea.selectionStart/End`.

**Video editor VP4 done & verified:** animation engine + order view + per-slide playback —
`timing.ts` (`computeSlideTiming` boxes-by-animOrder with delay accumulation + hold + transition;
`computeProjectTiming` overlapping slides; unit-tested in `tools/timing.test.mjs`, 19 assertions),
`transitions.ts` (`composeTransition` fade/rubout/scroll-up/scroll-left via draw callbacks +
`transitionProgress`), `render.ts` additions (`buildRenderContext`, `renderSlideContent`,
`renderSlide` per-slide incl. closing transition, `renderProject` with overlap compositing,
`projectDurationMs` — the headless-export seam), `AnimationOrderList.tsx` (dnd reorder →
`reorderTextBoxes`; per-box delay input), and `SlideOrderView.tsx` (per-slide Play/scrub/speed/loop rAF
over `renderSlide`, with an all-chars-derived ready gate; shown in SlideCanvas's Order view). Verified
in-browser by scrubbing: ordered writing-on with per-box delays (box A completes, then box B begins
after its delay), fade / rubout (reverse-reveal) / scroll-up closing transitions, order reorder + delay
inputs. `tsc` + `npm run build` clean; all three test suites green (35+23+19).

**Video editor VP5 done & verified:** play-all + scoped playback. `PlaybackCanvas.tsx` (shared
canvas + rAF + play/pause/restart/scrub/speed/loop driven by a `draw(ctx,t,w,h)` callback — used by
both players); `ProjectPlayer.tsx` (an **All slides** / **Selected** scope, builds a sub-project for the
chosen slides and plays it through `renderProject` — slides write on in order with closing transitions
overlapping); the slide panel shows a per-row checkbox in Play mode (`playSelectedIds` in the store,
pruned on delete); SlideCanvas's view toggle is now **Layout / Order / ▶ Play**; `SlideOrderView`
refactored onto `PlaybackCanvas`. A single ticked slide plays on its own; a subset plays in project
order. Verified in-browser by scrubbing a 2-slide project: play-all sequenced slide 1 ("Text") →
fade → slide 2 ("II") with total 13.4s; Selected=slide 2 only played "II" from t=0 at 3.4s;
Selected=both = 13.4s. `tsc` + `npm run build` clean; all three suites green.

**Play auto-starts:** opening the **Order** or **Play** view starts playback automatically (the
`▶ Play` view-toggle was previously just switching views, and `t=0` is blank because of box start
delays, so it looked like nothing happened). `PlaybackCanvas` takes an `autoPlay` prop (both players
pass it) and starts once content is `ready`, rewinding per `resetKey`; a manual pause is not overridden
(`autoStartedRef`).

**The Video editor (VP1–VP5) is complete.** Remaining work is the "later" list below (MP4 export,
batch glyph extraction, mid-stroke pause UI). The pure render seam (`buildRenderContext` +
`renderProject` / `projectDurationMs`, all in `src/lib/project/`) is ready to drive a headless
Node+ffmpeg exporter.

## Files already created for the Video feature (VP1)

- `src/lib/project/schema.ts` — `VideoProject / Slide / TextBox / TextRun / NormRect /
  ClosingTransition`, defaults, `newVideoProject/newSlide/newTextBox`, `makeId`. **Coords are
  normalized to canvas width**; size is `baseEmFraction × (run.sizeScale ?? 1)`; per-box `animOrder` +
  `delayBeforeMs` + `interCharDelayMs`; per-slide `holdBeforeTransitionMs` + `transition`.
- `src/lib/project/coords.ts` — `aspectHeightUnits`, `canvasSize`.
- `src/lib/persistence/ProjectStore.ts` — `projectStore` client (list/load/save/remove).
- `src/app/state/videoEdit.ts` — pure mutations (slides + textboxes + project), `reindexOrder`.
- `src/app/state/videoStore.ts` — `useVideoStore` (zundo, `partialize:{project}`), `videoHistory`,
  `ensureProjectGlyphsDerived(extractor, project, params)`.
- `src/app/components/video/VideoView.tsx` — tab root + toolbar + inspector (slide transition/hold).
  Currently renders a **placeholder** center — replace with `<SlideCanvas/>` in VP2.
- `src/app/components/video/SlidePanel.tsx` — slide list (dnd + add/copy/delete). Uses a text-only
  thumbnail for now; swap to `<SlideThumbnail/>` (canvas) in VP2.
- `vite.config.ts` — `projectStorePlugin()` registered.
- App passes `{ font, extractor, params, brush }` to `VideoView`.

## Engine APIs to reuse (already built)

- `prepareGlyph(glyph: GlyphAnimation): PreparedGlyph` → `{ sections:{id,lut,drawStartMs,durationMs,
  pauses,easing,spanMs}[], totalMs, advanceWidth, bbox }` (`@lib/animation/timeline`).
- `sampleGlyph(prepared, tMs)` → `{ reveals:{id,lut,revealedLen,active}[], done }`.
- `paintStroke(ctx, lut, revealedLen, tr: Transform, brush: BrushSettings, minHalfWidth, seedKey)`
  (`@lib/render/brush`); `Transform={scale,ox,oy}`, `toCanvas` (`@lib/render/ribbon`). Glyph coords are
  design units, y-down, baseline 0; `scale` maps design→px. `minHalfWidth = unitsPerEm*0.004`.
- Glyphs: `useEditorStore.getState().manifest.glyphs[String(codePoint)]` → `prepareGlyph`. Metrics
  (`unitsPerEm/ascender/descender`) from `manifest.metadata` (or `font.unitsPerEm`, `font.font.ascender/
  descender`). Ensure all project chars via `ensureProjectGlyphsDerived` before playback.

---

## VP2 — Layout view  (next step; start here)

**`src/lib/project/layout.ts`** — pure. `layoutTextBox(box, glyphs: Map<char,PreparedGlyph>, metrics
{unitsPerEm,ascender,descender}, baseEmFraction, canvasW)` → `{ instances, underlines, contentMs,
widthPx, heightPx, bbox }`.
- `GlyphInstance = { prepared, scale, xPx, baselineYPx, color: string|null, startMs, seedSalt }`
  where `scale = baseEmFraction × (run.sizeScale??1) × canvasW / unitsPerEm`.
- Algorithm: flatten runs → char slots (tag size/colour/underline; space = `0.3em` advance; missing
  glyph = ~`0.5em` advance, no instance/time). Greedy **word-wrap** to `frame.w×canvasW` (`null`=no
  wrap), honouring explicit `\n`. Per line, `ascent=max(ascender×scale)`, `descent=max(|descender|×
  scale)` over its chars (handles mixed sizes); first baseline `=ascent`, then `baseline += (prevDescent
  + ascent) × lineHeightScale`. Alignment uses `contentWidth = wrapWidthPx ?? maxLineWidth`. Assign each
  drawn glyph `xPx`, `baselineYPx`, `startMs` (accumulate `prepared.totalMs + box.interCharDelayMs`,
  like `layoutText`), `seedSalt = box.id + ':' + glyphIndex` (stable → deterministic chalk; do NOT use
  array index that shifts on edits elsewhere).
- **Underlines**: one `UnderlineSegment {x0Px,x1Px,yPx,thicknessPx,color,startMs,revealAtMs}` per
  maximal underlined run **per line** (spans underlined spaces); revealed between its first glyph
  `startMs` and last glyph end. `yPx = baseline + ~0.06em`, `thickness ~0.04em` (em of max scale on seg).
- `contentMs = max(instance.startMs+totalMs, underline.revealAtMs)`; `bbox` = union of transformed glyph
  bboxes (for rubout/scroll); `widthPx/heightPx` of laid-out content.

**`src/lib/project/render.ts`** — pure. `renderTextBox(ctx, layout, originPx{x,y}, brush, tLocalMs,
minHalfWidth)`: per instance `tr={scale:inst.scale, ox:originPx.x+inst.xPx, oy:originPx.y+inst.baselineYPx}`,
`sampleGlyph(inst.prepared, tLocalMs-inst.startMs)`, `paintStroke(..., inst.color ? {...brush,color:inst.color}
: brush, minHalfWidth, inst.seedSalt+r.id)`. Underlines: filled rounded rect from `x0` to `x0+frac*(x1-x0)`,
`frac=clamp((tLocal-startMs)/(revealAt-startMs))`. **Static render = call with `tLocalMs=Infinity`** (full
reveal) — used by the layout view and thumbnails. (renderSlideContent/renderProject come in VP4.)

**`src/app/components/video/layoutCanvas.ts`** — `clientToNorm(canvas,clientX,clientY)` /
`normToCanvas` (via `getBoundingClientRect` + backing size, like `editorCanvas`/`EditorView`); per-box
`boxOriginPx = {x:frame.x×canvasW, y:frame.y×canvasW}`; `boxBoundsNorm(box, layout)` from layout
width/height; `hitTest(slide, layouts, nx, ny)` → topmost box id; `drawSelection(ctx, box, layout, …)`.

**`src/app/components/video/SlideCanvas.tsx`** — center stage; reads selected slide + `slideView` from
store. **Layout view**: a `<canvas>` sized via `canvasSize(project.aspect, W)`; fill bg; for each box
compute `layoutTextBox` (memoize on box content + canvasW + available glyphs) and `renderTextBox(...,
Infinity, ...)`; draw selection ring on the selected box. Pointer: `pointerdown` → hitTest → select +
record normalized grab offset + `videoHistory.pause()`; `pointermove` (while dragging) →
`updateTextBoxFrame(slideId, boxId, {x,y})` clamped 0..1; `pointerup` → `videoHistory.resume()` (one
undo entry per drag). Click empty → add-textbox (or deselect). **Animation-order view**: placeholder
in VP2 (built in VP4). Add the layout/order toggle (from `slideView`/`setSlideView`).

**`src/app/components/video/SlideThumbnail.tsx`** — small `<canvas>` rendered **once per content hash**
(useEffect keyed on a cheap signature of that slide), static (`renderTextBox(..., Infinity)`), per-slide
store subscription. Use in `SlidePanel` instead of the text stub.

**Wire-up:** in `VideoView`, replace the placeholder with `<SlideCanvas/>`; add an effect (gated
`useEditorStore.getState().manifest?.metadata.fontId === font.hash`) calling
`ensureProjectGlyphsDerived(extractor, project, params)` whenever the project text/params change, so
glyphs exist to render. Build the `glyphs: Map<char,PreparedGlyph>` from the manifest (memoized).

## VP3 — Inline rich text

**`src/lib/project/runs.ts`** (pure, immutable; mirror `manifest/edit.ts`): `runsToPlainText`,
`styleKey(run)` (canonical of sizeScale|color|underline), `splitRunAt(runs, offset)`,
`applyStyleToRange(runs, start, end, patch)` (split at start/end → apply patch to enclosed pieces →
`normalizeRuns`), `setPlainTextPreservingStyles(runs, nextText)` (common prefix/suffix diff; changed
middle inherits boundary run's style), `normalizeRuns` (drop empty + merge adjacent equal-style).
**Selection coords are offsets into the flattened string**, converted to run splits at apply time — never
cache a runs↔selection map; re-read `textarea.selectionStart/End` fresh on apply.

**`src/app/components/video/RunEditor.tsx`** — a `<textarea>` bound to `runsToPlainText(box.runs)`
(typing → `setPlainTextPreservingStyles` → `updateTextBoxRuns`); size stepper / colour input / underline
toggle apply to the current selection range via `applyStyleToRange`; a styled HTML preview (`<span>`s with
font-size/color/underline) shows the runs. Host it in **`Inspector.tsx`** (selected textbox) alongside
align, wrap-width (`frame.w`, allow null), `delayBeforeMs`, and delete-textbox.

## VP4 — Animation engine + order view + per-slide playback

**`src/lib/project/timing.ts`** (pure): `computeSlideTiming(slide, layouts)` → boxes sorted by
`animOrder`; `cursor=0`; per box `start=cursor+delayBeforeMs`, `end=start+layout.contentMs`,
`cursor=end`; `contentEndMs=cursor`; `holdEndMs=contentEndMs+holdBeforeTransitionMs`;
`transitionMs = kind==='none'?0:transition.durationMs`; `totalMs=holdEndMs+transitionMs`.
`computeProjectTiming` sequences slides so **slide N+1 starts at slide N's `holdEndMs`** (the closing
transition overlaps the incoming slide).

**`src/lib/project/transitions.ts`** (Canvas 2D, param `p=clamp((tLocal-holdEndMs)/transitionMs,0..1)`):
`fade` (globalAlpha 1→1-p), `rubout` (reverse-reveal: redraw strokes with shrinking `revealedLen` from
the end — deterministic, reuses `paintStroke`; optional eraser-sweep via `destination-out`), `scroll-up`
/`scroll-left` (translate outgoing by `-p×canvasH`/`-p×canvasW`; incoming coupled).

**`src/lib/project/render.ts`** (add): `buildRenderContext(project, glyphs, canvasW, metrics)` memoizes
layouts+timing; `renderProject(ctx, project, rc, tMs, w, h)` = `slideAtTime` → active (and during overlap,
incoming under + outgoing through its transition) → `renderSlideContent` (each box at `tLocal-boxStart`).
`projectDurationMs`. **This is the headless-ffmpeg seam — keep it pure.**

**UI:** `AnimationOrderList.tsx` (dnd reorder → `reorderTextBoxes`; per-box "time before display" input
→ `updateTextBox {delayBeforeMs}`). SlideCanvas animation-order view shows it + a **Play** button
driving an rAF loop over `renderSlideContent` for the slide incl. its closing transition (reuse the
`PreviewView` tRef/scrub/speed/loop pattern). Await an "all chars derived" ready flag before playing.

## VP5 — Play-all transport  ✅ done

Built as `ProjectPlayer.tsx` (project-level rAF over `renderProject`, via the shared
`PlaybackCanvas.tsx`) with an **All slides / Selected** scope so you can play everything, a single
slide, or any subset (ticked in the slide panel → `playSelectedIds`). Same pure render path → ready to
feed a future MP4 exporter.

## Pitfalls (from the adversarial design review — mitigate these)

1. Mixed-size lines: per-line max ascent/descent, anchor to first baseline.
2. Underline during reveal: one segment per underlined run per line, grow with the writing.
3. Rubout/grain determinism: drive off `p` only (no Math.random/now); stable `seedSalt` per box+glyph index.
4. Missing (not-yet-derived) glyphs: layout = space-advance, render skips; recompute when glyph set changes.
5. Perf: `buildRenderContext` once; per frame only `sampleGlyph`+`paintStroke`. Optional: cache fully-drawn
   glyphs to a per-slide offscreen "ink" canvas; only re-paint the active writing front (also what
   rubout/scroll operate on).
6. Undo flooding on drag: `videoHistory.pause()` during a drag gesture, resume + one commit on drop.
7. Selection↔runs: offsets into flat string; `normalizeRuns` after every mutation.
8. Order bookkeeping: always `reindexOrder` survivors after delete/reorder.
9. Deleting selected slide/textbox: reconcile selection in the same `set` (already done in store).
10. Font switch / glyph derivation: gate on `manifest.metadata.fontId === font.hash` (as App + PreviewView do).
11. Normalized coord drag math: one `clientToNorm`/`normToCanvas` pair through `getBoundingClientRect`; clamp 0..1.
12. Thumbnails: render once per content hash, not per frame; subscribe per-slide.

## Verification recipe

`npm run dev`; open the **Video** tab. Toggle aspect; add/copy/delete/reorder slides; add+drag
textboxes (one undo entry per drag); type + select-and-style; set order + delays; **Play** (writes on
in order, then closing transition: test all 5); play-all; **Save** → inspect `projects/<id>.json` →
reload → **Load** restores it. `tsc --noEmit` clean; check `preview_console_logs` (ignore stale
`?t=` HMR noise). Remember the preview-env caveats in CLAUDE.md (screenshots + scrubbing, not pixel reads).

## TODO checklist
- [x] VP2 — layout.ts, render.ts (renderTextBox + static), layoutCanvas.ts, SlideCanvas (layout view + drag/select/add), SlideThumbnail; wired into VideoView/SlidePanel + glyph derivation. (`tools/layout.test.mjs` covers the layout engine.)
- [x] VP3 — runs.ts (+ `tools/runs.test.mjs`), RunEditor, Inspector (styling/align/wrap/delay/delete). Slide controls moved into Inspector.
- [x] VP4 — timing.ts (+ `tools/timing.test.mjs`), transitions.ts, render.ts (buildRenderContext/renderProject/renderSlide/projectDurationMs), AnimationOrderList, SlideOrderView per-slide Play.
- [x] VP5 — PlaybackCanvas (shared transport), ProjectPlayer (All/Selected scope play-all), slide-panel play checkboxes, Layout/Order/Play toggle.
- [ ] VP5 — play-all transport.
- [ ] (later) MP4 export via headless renderProject + ffmpeg; batch "extract all glyphs"; mid-stroke pause UI.

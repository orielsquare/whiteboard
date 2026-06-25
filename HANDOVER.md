# Handover — continue here

Read `CLAUDE.md` first for the project overview/architecture. This doc captures **current status** and
designs so you can continue without re-deriving anything.

> ## 👉 CURRENT IN-FLIGHT WORK (start here)
>
> The **Video editor (VP1–VP5)** and all post-VP5 polish are **done & verified**, and the **Voiceover**
> feature is **complete & verified**: a project-wide WebVTT track synced to the animation, **TTS via
> ElevenLabs** (P1–P4), audio **muxed into the MP4 export** + **optional captions** on the export preview,
> and the full-width **Timeline** (sections/zoom/thumbnails, mouse-wheel zoom + Space/Shift scroll, audio-
> length bars with stale shading, deferred-write leader-line drag). Closing transitions now include
> scroll-down/right; playback speed goes to ×12. **Next: the remaining "later" items** (image/photo slide
> backgrounds; batch "extract all glyphs"; mid-stroke pause UI; scope MP4 export to the play selection; and
> converting `SlideCanvas`'s textbox drag to the deferred-write pattern — see [[zundo-pause-stranding]]).
> Jump to the **"Voiceover feature"** section near the bottom for decisions, what's built, and integration
> points.
>
> **Setup:** TTS needs `ELEVENLABS_API_KEY` in a gitignored `.env` (the key needs the `text_to_speech` +
> `voices_read` scopes; `vite.config.ts` loads `.env` into `process.env`). Run `npm run dev`, open
> **Video → VTT** for the editor and **Video → Timeline** for the timeline; `node tools/vtt.test.mjs` (32)
> covers the pure engine. Dev-server routes: `POST /api/tts`, `GET /api/voices`, `GET /api/voiceover/<project>/<file>`,
> `POST /api/export`.

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
`transitions.ts` (`composeTransition` fade/rubout/scroll-up/scroll-down/scroll-left/scroll-right via draw callbacks +
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

## Post-VP5 follow-ups  ✅ done

- **Per-slide background colour** — Inspector "Slide" section has a colour-well + hex input bound to
  `slide.background` via `updateSlide`. (Image backgrounds: later.)
- **Human-style underline** — the underline is now drawn *after* its word is fully written: in
  `layout.ts` the segment's `startMs` = last underlined glyph's end + a pen-lift pause, then a quick
  left→right sweep (`underlineDrawMs` scales with the segment's em-width); `contentMs` includes it.
- **MP4 export** — `tools/videoExport.mjs` bundles the pure render seam with esbuild (resolving `@lib`),
  renders every frame with `@napi-rs/canvas` (skia; prebuilt, no system deps) and pipes PNGs into
  `ffmpeg` (libx264, yuv420p). Dev-server `exportPlugin` (`vite.config.ts`): `POST /api/export`
  `{project, glyphs, metrics, fps, width, slideIds?, name}` → writes `exports/<name>.mp4`, returns
  `{file,bytes,w,h,durationMs,frames}`; `GET /api/export/<file>` streams it (range-aware). UI: a **🎬
  Export MP4** button in the video toolbar POSTs the live project + manifest glyphs and shows an inline
  `<video>` preview + download link. Verified: exported frames show glyphs, per-slide bg, and underline.
  Runnable headless too: `node tools/videoExport.mjs <projectFile> [out.mp4] [width] [fps]`.

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
in order, then closing transition: test all 7); play-all; **Save** → inspect `projects/<id>.json` →
reload → **Load** restores it. `tsc --noEmit` clean; check `preview_console_logs` (ignore stale
`?t=` HMR noise). Remember the preview-env caveats in CLAUDE.md (screenshots + scrubbing, not pixel reads).

## TODO checklist
- [x] VP2 — layout.ts, render.ts (renderTextBox + static), layoutCanvas.ts, SlideCanvas (layout view + drag/select/add), SlideThumbnail; wired into VideoView/SlidePanel + glyph derivation. (`tools/layout.test.mjs` covers the layout engine.)
- [x] VP3 — runs.ts (+ `tools/runs.test.mjs`), RunEditor, Inspector (styling/align/wrap/delay/delete). Slide controls moved into Inspector.
- [x] VP4 — timing.ts (+ `tools/timing.test.mjs`), transitions.ts, render.ts (buildRenderContext/renderProject/renderSlide/projectDurationMs), AnimationOrderList, SlideOrderView per-slide Play.
- [x] VP5 — PlaybackCanvas (shared transport), ProjectPlayer (All/Selected scope play-all), slide-panel play checkboxes, Layout/Order/Play toggle.
- [x] Per-slide background colour; human-style underline (drawn after the word); **MP4 export** (`tools/videoExport.mjs` + `@napi-rs/canvas` + ffmpeg, `/api/export`, toolbar button).
- [x] Project **playback speed** (`VideoProject.playbackRate`, ×0.25–12) on its own transport row. Speed scales **only the writing animation** (per-glyph reveal + inter-char cadence + underline): `computeSlideTiming` gives each box a real-time window of `contentMs / speed` and `boxStart = cursor + delayBeforeMs` (**delay invariant**); `holdBeforeTransitionMs` + `transition.durationMs` are **invariant** and anchored to the real writing-end. The reveal is scaled at render time — `renderSlideContent` samples each box at writing time `(tLocalMs − boxStart) × rc.speed`, so the box finishes drawing exactly at `boxEnd` (= `boxStart + contentMs/speed`), before the hold/transition. Preview rAF + export both advance at **real time** and read `rc.speed` (built via `buildRenderContext(…, playbackRate)`); the static Layout view/thumbnails use `Infinity` and are unaffected. Per-**textbox brush** (`TextBox.brush`) with an Inspector "custom brush" toggle (style/colour/size/opacity); render uses `box.brush ?? project.brush` everywhere (canvas, thumbnail, export).
- [x] **Hold-before-transition** is a number input (step 500ms, min 0, arbitrarily large) instead of a slider. (`/api/export` cache-busts the `tools/videoExport.mjs` import so edits load without a server restart.)

### Voiceover feature (in progress)

Decisions: project-wide list of **absolute-time WebVTT cues** with **no explicit box/slide link**
(`VideoProject.voiceover: VoiceoverCue[]` = `{id, startMs, endMs, text, audio?}`), TTS in scope,
new views are **Video sub-views** (the Layout/Order/Play switch now also has **Timeline** + **VTT**;
the toggle was lifted from SlideCanvas to VideoView).

- [x] **P1** — `src/lib/project/vtt.ts` (parse/serialize/format/estimate/reconcile/`cuesInRange`/staleness, + `tools/vtt.test.mjs` 24 tests); `timing.ts` `slideTimeWindows`; store cue actions (`setVoiceover/addCue/updateCue/removeCue/setCueAudio`); **VttView** (editable raw WebVTT, live parse, reconcile preserving audio by id); read-only **SlideVttExtract** beneath the Layout canvas (highlights in-range cues).
- [x] **P2** — TTS: `tools/tts.mjs` (**ElevenLabs** → ffmpeg → `.m4a` + duration; see "Voice synthesis" below); `ttsPlugin` in `vite.config.ts` (`POST /api/tts`, `GET /api/voices`, `GET /api/voiceover/<project>/<file>` range-aware); VttView cue list with Generate/Generate-all/Play/regenerate + audio shading; generating sets `cue.endMs = startMs + durationMs` and `cue.audio.{tts,textHash}` (**staleness is text-only**). Synced playback: `PlaybackCanvas` takes `audioCues` and schedules `<audio>` against the clock; `ProjectPlayer` supplies them for the **All-slides** scope (clock == project time).
- [x] **P3 — Timeline view** done & verified — `TimelineView.tsx` is now a full-width, real-time-scaled
  track (DOM divs, not canvas) with horizontal scroll + zoom (`pxPerSec`, −/＋/Fit). Built off
  `buildRenderContext` + `slideTimeWindows`: **slide sections** cleanly partition `[projStart, nextStart)`
  (alternating tint, numbered, click→select); **numbered textbox writing sub-bars**; the **hold** region
  (striped) and the closing **transition** drawn as a semi-transparent overlay on top that *bleeds into
  the next section* (the real overlap); a **time ruler** with nice ticks; and floating **slide
  thumbnails** (reused `SlideThumbnail`, aspect-aware width gate) below wide-enough sections. New `.tl-*`
  CSS in `styles.css`. Verified in-browser: section geometry is arithmetically exact (clean partition,
  hold = xOf(holdMs), transition bleed starts at the boundary), thumbnails render, zoom/Fit work.
- [x] **P4 — leader lines** done & verified — one labelled vertical line per cue (`LeaderLine`) on a
  staircase (`level = sortedIndex % 4`) so neighbours don't collide; hover brings to front; **drag** the
  label/handle to re-time the cue, **preserving its duration and id** (so audio survives), clamped ≥0.
  **Drag is deferred-write**: pointermove only updates a local `translateX` transform on the dragged line —
  the cue model (and so the VTT + the whole timeline re-layout) is written **once on pointerup** via a
  single `updateCue` (≡ one natural undo step; no `pause()/resume()` needed). So sliding never re-sorts or
  re-lays-out the timeline mid-gesture; the order/staircase settle once on release. (`rc =
  buildRenderContext` is also memoized on `project.slides`/`baseEmFraction`, not the whole project, so cue
  edits don't rebuild slide layout.) Audio-bearing cues are shaded; **double-click empty band space adds a
  cue**. `tsc` + `npm run build` clean.
- [x] **Mux voiceover audio into the MP4 export** done & verified — `tools/videoExport.mjs` renders the
  silent video to a temp file, then a second ffmpeg pass mixes each cue's clip in at its absolute
  `startMs` (`adelay` per clip → `amix=normalize=0` → `apad`, with `-shortest` clamping to the video
  length; video stream copied, audio AAC). Resolves clips from `voiceover/<safeSeg(projectId)>/`; skipped
  when the export is slide-scoped (`slideIds`) since cue times are project-wide, and falls back to the
  silent video if a mux fails (returns `audioMuxed`/`audioCues`/`audioWarning`). `includeAudio` plumbs
  through `/api/export`; the toolbar result shows "🔊 N voiceover clip(s)". Verified end-to-end (API +
  CLI): `silencedetect` confirms audio lands exactly at each cue's start (e.g. 0.5s, 4.0s).
- [x] **UX additions (done & verified):** (a) **Timeline mouse-wheel zoom** (cursor-anchored) + **Space/
  Shift + wheel** horizontal scroll (native non-passive `wheel` listener on `.tl-scroll`; `spaceRef` via
  window keydown/keyup, suppressing the page space-scroll only while hovered); (b) playback **speed max
  raised to ×12** (`PlaybackCanvas` slider); (c) two new closing transitions **scroll-down** + **scroll-
  right** (`transitions.ts` + `TransitionKind` + Inspector dropdown; mirror scroll-up/left); (d) Timeline
  **audio-length bar** — a yellow line (opacity 0.7) right of each leader's foot, width = `audio.durationMs
  × pxPerSec`, so clip lengths + overlaps are visible (`.tl-leader-audio`) — gated on `!isAudioStale` so a
  stale clip drops the bar/♪/green tint (matches the VTT view); (f) **optional captions** on the
  exported-video preview — `vtt.ts` `captionsVtt(cues)` (escapes `&<>` for the native parser; drops
  zero-length cues) is **snapshotted into `exportResult` at export time** so captions match the rendered
  MP4 even after the script is edited, served as a `<track>` blob, toggled via a checkbox
  (`textTracks[0].mode`), in `VideoView`. The wheel handler pans on horizontal-dominant gestures (only
  vertical zooms) and clears Space on window `blur`.
- [ ] (later) image/photo slide backgrounds; batch "extract all glyphs"; mid-stroke pause UI; scope MP4
  export to the play selection.

#### Voiceover — files & integration map (what exists)

- **Model**: `src/lib/project/schema.ts` `VoiceoverCue {id,startMs,endMs,text,audio?}` + `VoiceoverAudio
  {file,durationMs,voice?,textHash?}`; `VideoProject.voiceover: VoiceoverCue[]` (newVideoProject → `[]`;
  read everywhere as `project.voiceover ?? []`). Times are **absolute project real-time ms**.
- **Pure engine**: `src/lib/project/vtt.ts` — `parseVtt`/`serializeVtt` (cue id is the WebVTT identifier,
  used to keep audio across text edits), `formatTimestamp`/`parseTimestamp`, `reconcileParsed(prev,parsed,
  makeId)`, `estimateDurationMs`, `cuesInRange`, `hashText`, `isAudioStale`. `src/lib/project/timing.ts`
  `slideTimeWindows(timing)` → `{slideId,startMs,endMs}[]` (a slide owns `[start, nextStart)`; last → total).
- **Store** (`videoStore`/`videoEdit`): `setVoiceover/addCue(startMs,text?)/updateCue(id,patch)/removeCue/
  setCueAudio`. `slideView` now `'layout'|'order'|'play'|'timeline'|'vtt'`.
- **UI**: `VttView.tsx` (raw WebVTT textarea bound to `serializeVtt`, re-syncs from the model when not
  focused; typing → `parseVtt`→`reconcileParsed`→`setVoiceover`; a cue list with Generate/Generate-all/
  Play/regenerate/delete; **exports `cueAudioUrl(projectId,cue)`**). `SlideVttExtract.tsx` (read-only,
  beneath the Layout canvas — `SlideCanvas` computes the selected slide's window via `buildRenderContext`
  + `slideTimeWindows`). View toggle lives in `VideoView` (lifted out of `SlideCanvas`).
- **TTS (ElevenLabs)**: `tools/tts.mjs` `generateTts({text,voiceId,model,direction,settings,outPath})` →
  `{durationMs,voiceId,model}`, and `listVoices()` → `[{voiceId,name,accent,description,category,previewUrl}]`
  (`previewUrl` = ElevenLabs' free hosted sample — voice preview costs nothing, no extra key scope beyond
  `voices_read`). **Auth = an `ELEVENLABS_API_KEY` env var** (server-side only; never sent to the browser).
  POSTs `/v1/text-to-speech/{voiceId}?output_format=mp3_44100_128` with `{text, model_id, voice_settings?}`;
  ffmpeg encodes the returned audio (mp3, or pcm if `ELEVENLABS_OUTPUT_FORMAT=pcm_*`) to `.m4a`. The
  **accent is the voice**. v3 (`eleven_v3`) takes a free-text `direction` prepended to the text (audio-tag
  cues); other models take `voice_settings` {stability,similarity_boost,style,use_speaker_boost,speed}.
  Config via env (`ELEVENLABS_API_KEY`, `ELEVENLABS_OUTPUT_FORMAT`, `ELEVENLABS_BASE_URL`). `vite.config.ts`
  `ttsPlugin` — `POST /api/tts {projectId,cueId,text,voiceId,model,direction,settings}` writes
  `voiceover/<projectId>/<cueId>.m4a`; `GET /api/voices` proxies the account voice list + preview urls
  (returns `{ok:false,error}` cleanly if the key is unset/under-scoped); `GET /api/voiceover/<projectId>/<file>`
  streams it (ignores the `?v=` cache-bust). Generate stores `audio.{tts,textHash,version}` (the full
  settings snapshot) and sets `cue.endMs = startMs + durationMs`. Blank cue text / no voice are rejected.
- **Voice settings**: `VideoProject.tts: { voiceId, voiceName, model, direction, settings:
  {stability,similarityBoost,style,speed} }` (default model `eleven_multilingual_v2`, empty voiceId until
  voices load); store action `setTts(patch)` deep-merges `settings`. The VTT **Voice panel** (below the
  script, above the clips) has a **model** `<select>`, a **voice** `<select>` populated from `/api/voices`
  (auto-selects a British voice on first load) with a ▶ **preview** button (plays `previewUrl`), and —
  depending on the model — a v3 **direction** `<textarea>` or **stability/similarity/style/speed** sliders.
  Each cue chip shows the clip's voice name as a **button** → confirm → `setTts(audio.tts)` to reuse that
  clip's exact settings. **Staleness is text-only**: `isAudioStale(cue)` = `audio.textHash !== hashText(text)`;
  voice/model/settings differences are NOT stale (the chip surfaces them instead). The MP4 export muxes
  whatever clips exist, so ElevenLabs audio flows into exports unchanged.
- **Synced audio**: `PlaybackCanvas` accepts `audioCues: AudioCue[] {id,startMs,endMs,url}` and schedules
  `<audio>` against `tRef` in the rAF tick (play when `t∈[start,end)`, pause otherwise, resync on >0.35s
  drift). `ProjectPlayer` builds them from `project.voiceover` **only for the `all` scope** (clock ==
  project time); per-slide/`selected` get none.

#### P3 — Timeline view (design)  ✅ implemented in `TimelineView.tsx` (this is the design it was built to)

Full-width, **scaled to real project time**, scroll + zoom (a `pxPerSec` state; horizontal `overflow-x:auto`
track of width `totalMs/1000·pxPerSec`). Build `rc = buildRenderContext(project, glyphs, BACKING_W, metrics,
playbackRate)`; `totalMs = rc.timing.totalMs`; per slide `i`: `projStart = rc.timing.slides[i].startMs`,
`st = rc.timing.slides[i].timing` (has `boxes[{boxId,startMs,endMs}]` slide-local, `contentEndMs`,
`holdEndMs`, `transitionMs`, `totalMs`); windows via `slideTimeWindows`. `xOf(ms)=ms/1000·pxPerSec`.

- **Slide sections** = a clean partition at `[projStart, nextStart)` (the non-overlapping window). Label
  each with its slide number; alternate a subtle tint.
- **Textbox writing sub-bars** inside each section: box `b` spans `[projStart + b.startMs, projStart +
  b.endMs]` (project time). Thin labelled bars (sequential, so side-by-side).
- **Zoomed-in colours** (only when a section is wide enough to read): the **hold / "end-delay"** region
  `[projStart+contentEndMs, projStart+holdEndMs]`; the **transition** region `[projStart+holdEndMs,
  projStart+totalMs]` — note this **overlaps the next slide** (real overlap), so draw it as a
  **semi-transparent overlay on top**, bleeding over the next section's start. Last slide's transition
  runs to project end.
- **Time axis** with nice tick spacing chosen from `pxPerSec`.
- **Slide screenshots** floating *below* each section when its width exceeds a threshold — reuse
  `SlideThumbnail` (takes `slide` + `glyphs` + `metrics`) absolutely-positioned under the section.
- Render with **DOM divs + maybe SVG** (NOT canvas) for crisp text/hover/drag. Keep it visually polished
  (the user explicitly wants a satisfying tool).

#### P4 — Leader lines (design)  ✅ implemented in `TimelineView.tsx` `LeaderLine` (drag preserves cue duration + id)

Above the timeline bar, one **vertical line per cue** rising from `xOf(cue.startMs)` up to a **voiceover
label** showing the cue text. Use a **repeating staircase of heights** so many close cues don't overlap
(e.g. height = base + (index mod N)·step). **Hover a line/label → bring to front** (raise z-index). A
**drag handle** appears on hover where the line meets the timeline; dragging left/right moves a local
`translateX` transform and commits `cue.startMs` once on pointerup via a single `updateCue(id,{startMs,
endMs})` (clamp ≥0; px→ms with `pxPerSec`; one natural undo, no pause/resume). Shade labels of cues that **have audio** (`cue.audio`) — the
"audio exists" indicator (no textbox link, so it lives on the cue/label, per the chosen model).
Re-serialised VTT/extract update automatically since they read `project.voiceover`.

Pitfalls: cue times are absolute, so changing **speed** reflows the section widths but leaves leader
lines put — that's intended ("Fixed timeline time"). The dual-module-instance gotcha (eval-imported
store ≠ app store) bites verification — drive the **real DOM**, not an `import()`ed `useVideoStore`.

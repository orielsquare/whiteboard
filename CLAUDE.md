# Font Animator — project guide

A suite for producing **styled videos of live numeracy/maths solutions** (eventual export: MP4).
The core idea: turn a font into reusable **per-character handwriting animations** (each glyph drawn
as natural pen strokes), then **compose those into slides** to build an animated text video.

Built with **Vite + React + TypeScript**. Runs entirely in the browser; a small Vite dev-server
middleware persists data to disk. Node 20 and ffmpeg are available locally (ffmpeg only matters for
the future MP4 export).

> **Continuing in-flight work?** Read `HANDOVER.md` — it has the current status and the detailed
> design for the next phases (the Video editor, VP2–VP5).

## Run / build / verify

```bash
npm run dev        # http://localhost:5173  (Vite; serves /api/fonts + /api/projects)
npm run build      # tsc + vite build
node_modules/.bin/tsc --noEmit   # typecheck (do this after every change set)
```

- **npm install gotcha:** the global npm cache (`~/.npm`) has root-owned files and fails with
  `EACCES`. Use a project-local cache: `npm install --cache ./.npm-cache --no-audit --no-fund`.
- **Preview/verification env caveats** (the Claude preview tool, not real browsers): it throttles
  `requestAnimationFrame`, `canvas.getImageData` reads back **transparent**, and synthetic canvas
  clicks / dnd-kit drags often don't register. So **verify via `preview_screenshot` + DOM/state
  reads, not pixel reads**; drive animations by **scrubbing to a fixed time** (deterministic), and
  treat stale `?t=<old-hash>` console errors as buffered HMR noise (they don't clear on reload).
  The app itself works fine in a normal browser.

## Architecture principles

- **One pure data pipeline, framework-free.** All extraction, animation, rendering, layout, and
  project logic lives in `src/lib/` with **no React/DOM-store imports**, so the same code drives the
  live preview *and* a future headless Node+ffmpeg exporter. React lives only in `src/app/`.
- **Geometry immutable; intent is flags.** Extracted glyph centerlines are never mutated; editorial
  intent (order, reversed direction, splits/merges, timing, pauses) is applied at `evaluate()`/render
  time. Editing is lossless.
- **Pure seams for export:** `evaluate(glyph, tMs)` (single glyph) and `renderProject(ctx, project,
  tMs, w, h)` (video) are time-as-argument pure functions → preview and headless export share them.
- **Video coordinates are normalized to canvas width** (aspect/resolution-independent); px is derived
  per-frame as `value × canvasW`.
- **Rendering = a variable-width "ribbon"** whose cross-section is orthogonal to the stroke centerline
  (natural moving pen-front), textured by chalk/ink/marker brushes (deterministic seeded grain).

## Directory map

```
src/lib/
  extraction/   font glyph → centerline pen-strokes (runs in a Web Worker)
                outline → raster → Guo-Hall skeleton → distance transform → graph split at junctions
                → junction path-linking + leaf pruning + endpoint extension → cleaned sections.
                index.ts = GlyphExtractor (worker client). types.ts has ExtractionParams + extractionSig.
  geometry/     vec, polyline (arc-length LUT), easing, rng (seeded mulberry32 for chalk).
  manifest/     schema.ts (FontManifest/GlyphAnimation/StrokeSection/BrushSettings),
                seed.ts (seedGlyphAnimation/seedFontManifest), edit.ts (pure split/merge/reorder/...).
  animation/    timeline.ts: prepareGlyph(glyph)→PreparedGlyph; sampleGlyph(prepared,tMs); layoutText.
  render/       ribbon.ts (Transform/toCanvas + variable-width ribbon), brush.ts (paintStroke: chalk/ink/marker).
  font/         load.ts (opentype.js LoadedFont {font, buffer, family, unitsPerEm, hash}).
  persistence/  FontStore.ts + ProjectStore.ts (fetch clients for the dev-server endpoints).
  project/      schema.ts (VideoProject/Slide/TextBox/TextRun + VoiceoverCue), coords.ts, layout.ts,
                timing.ts (computeSlide/ProjectTiming + slideTimeWindows), render.ts (buildRenderContext/
                renderProject/renderSlide), transitions.ts, runs.ts, vtt.ts (WebVTT parse/serialize/etc).
                Pure engines unit-tested in tools/{layout,runs,timing,vtt}.test.mjs (esbuild standalone).
src/app/
  App.tsx       shell: owns font, single shared GlyphExtractor, params, selectedChar, brush; 4 tabs.
  state/        store.ts (useEditorStore — font manifest, zundo, ensureGlyphDerived/commitDerivedGlyph),
                videoStore.ts (useVideoStore — video project, zundo) + videoEdit.ts (pure helpers).
  components/   EditorView, ExtractionView, PreviewView, editorCanvas, overlay; video/ (VideoView owns the
                Layout/Order/Play/Timeline/VTT switch; SlideCanvas, SlidePanel, Inspector, RunEditor,
                SlideOrderView/ProjectPlayer/PlaybackCanvas, AnimationOrderList, VttView, SlideVttExtract,
                TimelineView [placeholder]).
vite.config.ts  React + fontStorePlugin (/api/fonts) + projectStorePlugin (/api/projects) +
                exportPlugin (/api/export → MP4) + ttsPlugin (/api/tts, /api/voices, /api/voiceover/<project>/<file>).
tools/          videoExport.mjs (headless MP4), tts.mjs (ElevenLabs TTS + voice list→ffmpeg), *.test.mjs (pure-engine tests).
fonts/<id>/     saved font manifests (manifest.json + font.ttf).   projects/<id>.json  saved videos.
exports/<name>.mp4  rendered videos.   voiceover/<projectId>/<cueId>.m4a  generated TTS clips.
public/fonts/   bundled OFL samples: Patrick Hand (handwriting), Fira Sans (sans).
```

## Data, stores, persistence

- **`useEditorStore`** (zundo): the per-font `FontManifest` (glyph stroke sections + per-section
  timing). `updateGlyph`/`markReviewed` set `edited:true`; `ensureGlyphDerived(extractor,char,params)`
  seeds-or-re-derives a glyph (skips `edited` ones; compares `derivedSig`); `commitDerivedGlyph` pauses
  history so auto-derivations aren't undoable. Saved to `fonts/<hash>/manifest.json` (+ `font.ttf`).
- **`useVideoStore`** (zundo, separate history): the `VideoProject` (slides). Document state tracked;
  selection/view transient (`partialize`). Saved to `projects/<id>.json`. `ensureProjectGlyphsDerived`
  derives every char used in the project.
- **Brush is an applied style, NOT glyph data** — it's transient app state, the picker lives in the
  Animation tab; the video project carries its own global `brush`. Never store brush in the font manifest.

## The four tabs (App.tsx)

1. **Editor** — pick a glyph; reorder/flip/split/merge stroke sections (drag + buttons); per-section
   timing; brush-less neutral-pen play preview; Save font / Reload / Undo / Redo.
2. **Stroke extraction** — read-only debug overlay of the automatic extraction; tune params (live).
3. **Animation preview** — animate holding text with the chosen brush; reflects per-glyph edits.
4. **Video** — slide-based animated-text editor. Its own view switch (in `VideoView`):
   **Layout** (drag/select/add textboxes + voiceover-in-range extract), **Order** (animation order +
   per-slide Play), **▶ Play** (project play-all + synced voiceover), **Timeline** (real-time voiceover
   timeline — WIP), **VTT** (editable WebVTT script + TTS). See HANDOVER.md for the in-flight voiceover work.

**Shared across tabs** (in App): `selectedChar`, extraction `params`, `brush`, and a single
`GlyphExtractor` (one Web Worker per font). Tuning params re-derives the active glyph centrally,
gated on `manifest.metadata.fontId === font.hash`.

## Conventions

- Render loops: a single `requestAnimationFrame` reading **refs** (not React state per frame); time
  in a `tRef`; transport (play/pause/scrub/speed/loop) like `PreviewView`.
- Reordering/lists: **dnd-kit** (`DndContext`+`SortableContext`+`useSortable`+`arrayMove`,
  `PointerSensor` distance 4), with `↑/↓` buttons as a verified fallback.
- Pure edit helpers return new objects (immutable); store actions are thin `set` wrappers.
- New dev-server routes: add a plugin in `vite.config.ts` mirroring `fontStorePlugin` and a fetch
  client mirroring `FontStore.ts`.

## Status

Font tooling (load → extract → edit → animate → save) is complete. The **Video editor (VP1–VP5) is
complete**: slides (add/copy/delete/drag-reorder + save/load), the **Layout** view (drag/select/add
textboxes), **inline rich text** (per-selection size/colour/underline via `runs.ts`/`RunEditor`), the
**Order** view (per-box animation order + delays + per-slide Play), **Play** (project-level play-all
with an All/Selected scope for single-slide or subset playback), per-slide **background colour**,
human-style **underlines** (drawn after the word), a project **playback speed** (`playbackRate`, ×0.25–6) that
scales **only the writing animation** — each box gets a real-time window `contentMs/speed` and the
reveal is sampled at `(tLocal − boxStart)×speed`, while per-box `delayBeforeMs`, the hold, and the
transition are **invariant** (preview + export both run at real time off `rc.speed`), and
per-**textbox brush** overrides (`TextBox.brush`, falling back to the project brush; a run's colour
still wins). **MP4 export** is done: the pure render seam
(`src/lib/project/` `buildRenderContext` + `renderProject`/`renderSlide`/`projectDurationMs`, with
`tools/{layout,runs,timing,vtt}.test.mjs` covering the pure engines) is driven headlessly by
`tools/videoExport.mjs` (`@napi-rs/canvas` → ffmpeg) behind `POST /api/export` and a toolbar button.
Voiceover audio is muxed in a second ffmpeg pass (silent video → mix each cue's clip at its absolute
`startMs` via `adelay`/`amix`/`apad` + `-shortest`); skipped when slide-scoped, falls back to silent on
failure.

**Voiceover — complete** (a project-wide WebVTT track synced to the animation; see `HANDOVER.md` →
"Voiceover feature" for decisions + design). **P1–P4 done & verified:** the data model
(`VideoProject.voiceover: VoiceoverCue[]`, absolute-time cues, no box/slide link), the pure `vtt.ts`
engine, the editable **VTT** sub-view + read-only slide extract, **TTS** (**ElevenLabs** — `ELEVENLABS_API_KEY`
env key; the VTT Voice panel picks an account voice [accent comes from the voice], a model, and per-model
steering [v3 = free-text direction, else stability/style/speed sliders] — → ffmpeg `.m4a` via `/api/tts`,
voices listed via `/api/voices`, with audio-exists/stale shading and clock-synced `<audio>` playback), the
full-width **Timeline**
view (`TimelineView.tsx` — real-time-scaled DOM track: slide sections + numbered writing sub-bars + hold
+ bleeding transition overlays + ruler + floating thumbnails, with zoom/Fit), and draggable voiceover
**leader lines** (re-time a cue live, preserving its duration + id, as one atomic undo; double-click to
add). Voiceover audio is now **muxed into the MP4 export** too (a second ffmpeg pass places each cue's
clip at its absolute `startMs`). **Next — "later" items:** image/photo backgrounds, batch "extract all
glyphs", mid-stroke pause UI, scope MP4 export to the play selection.

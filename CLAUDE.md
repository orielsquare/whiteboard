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
  project/      schema.ts (VideoProject/Slide/TextBox/TextRun), coords.ts. (layout/timing/render/
                transitions/runs to be added in VP2–VP4 — see HANDOVER.md.)
src/app/
  App.tsx       shell: owns font, single shared GlyphExtractor, params, selectedChar, brush; 4 tabs.
  state/        store.ts (useEditorStore — font manifest, zundo, ensureGlyphDerived/commitDerivedGlyph),
                videoStore.ts (useVideoStore — video project, zundo) + videoEdit.ts (pure helpers).
  components/   EditorView, ExtractionView, PreviewView, editorCanvas, overlay; video/ (VideoView, SlidePanel, …).
vite.config.ts  React plugin + fontStorePlugin (/api/fonts) + projectStorePlugin (/api/projects).
fonts/<id>/     saved font manifests (manifest.json + font.ttf).   projects/<id>.json  saved videos.
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
4. **Video** — slide-based animated-text editor (in progress; see HANDOVER.md).

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

Font tooling (load → extract → edit → animate → save) is complete. The **Video editor** is mid-build:
**VP1 done** (data model, store, persistence, tab, slide panel). **VP2–VP5 remain** — see `HANDOVER.md`.

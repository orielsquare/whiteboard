# Font Animator

A tool for turning any font into **reusable per-character handwriting animations** — each
glyph is decomposed into ordered pen strokes that draw on like natural handwriting, in chalk,
ink, or marker.

It's the proof-of-concept first tool in a suite for producing styled **numeracy / maths
solution videos** (eventual output: MP4). The per-glyph stroke data this tool produces is
saved to an editable manifest that later tools (a slide editor, a headless video exporter)
consume.

## Quick start

Requires **Node 20+**.

```bash
npm install
npm run dev      # → http://localhost:5173
```

> If `npm install` fails with `EACCES` on `~/.npm` (root-owned cache from a past `sudo npm`),
> use a project-local cache instead of `sudo chown`:
> `npm install --cache ./.npm-cache --no-audit --no-fund`

Other scripts: `npm run build` (typecheck + production build), `npm run preview`, `npm run typecheck`.

## What it does

The app has three tabs:

### 1. Editor (main)
Pick a glyph and shape its animation:
- **Reorder** strokes — drag the `⠿` handle (or the `↑ ↓` buttons).
- **Flip direction** (`⇄`) — draw a stroke as an upstroke instead of a downstroke.
- **Split** (`✂`, then click a point on a stroke) and **Merge** (select two strokes, then `⤙`) —
  re-decide how the automation divided the glyph into strokes (e.g. make an 'r' the vertical
  as one stroke and the arch as another).
- **Brush** — chalk / ink / marker, plus colour, opacity and size.
- **Timing** — per-stroke duration, delay, easing.
- **Pen-lift** (`✎`), **delete** (`×`), **Reset glyph** (re-run the automation).
- **▶ Play glyph** to preview, and **💾 Save font** to write the whole configuration to disk.

Stroke colours are stable per stroke (they identify a stroke); draw **order** is shown by the
numbered badges.

### 2. Stroke extraction (debug)
Visualises the automatic extraction for a glyph — source outline, skeleton, the decomposed
stroke sections (colour-coded), endpoints/junctions and default directions. Tune the extraction
parameters (spur-prune `k`, raster resolution, smoothing) live.

### 3. Animation preview
Type holding text and watch it animate as handwriting with the chosen brush, reflecting your
per-glyph edits. Transport: play / pause / scrub / speed / loop.

## How extraction works

A font glyph is a *filled outline*, but handwriting needs the **centerline** the pen travels.
The pipeline (in a Web Worker, `src/lib/extraction/`):

1. flatten the glyph outline and **rasterize** it to a binary mask;
2. **Guo–Hall thinning** → a 1px skeleton;
3. **chamfer distance transform** → stroke width at each point;
4. walk the skeleton into a graph and split at junctions into **stroke sections**;
5. **junction path-linking** (rejoin collinear through-strokes), width-based **leaf pruning**,
   and **endpoint extension** (so strokes reach the ink tips);
6. **simplify + smooth** (RDP + centripetal Catmull–Rom) and apply default order/direction.

Rendering uses a **variable-width ribbon** whose cross-section is always orthogonal to the
centerline, so the animating pen-front looks natural rather than like an axis-aligned wipe.

## Data & persistence

`💾 Save font` writes the full configuration to disk under `fonts/<fontId>/`:

- `manifest.json` — versioned, editable: font metadata, per-glyph stroke sections (centerline +
  width), draw order, direction, timing, and brush defaults.
- `font.ttf` — the font bytes, so the config is self-contained.

Saved fonts reload automatically when you open them. The dev server serves a small
`/api/fonts` endpoint (defined in `vite.config.ts`) that reads/writes these files.

**Edit model:** extracted geometry is immutable; editorial intent (order, direction, pauses,
splits/merges) is applied at render time, so editing is lossless and `Reset glyph` can always
re-run the automation.

## Project structure

```
src/
  lib/                 # framework-free TypeScript (reusable by future tools)
    extraction/        # outline → skeleton → stroke sections (runs in a Web Worker)
    geometry/          # vectors, polyline/arc-length, easing, seeded RNG
    manifest/          # the editable schema + seed + pure edit ops (split/merge/reorder/…)
    animation/         # evaluate(glyph, tMs) timeline — the seam for headless MP4 export
    render/            # ribbon shape + chalk/ink/marker brushes (Canvas 2D)
    font/              # font loading (opentype.js)
    persistence/       # FontStore client for /api/fonts
  app/                 # React UI (the only place React lives)
    state/             # Zustand store (single source of truth) + undo/redo
    components/        # Editor / extraction / preview views
public/fonts/          # bundled sample fonts (Patrick Hand, Fira Sans — OFL)
fonts/                 # saved manifests + font files (output)
```

Architectural rule: `lib/` never imports from `app/`, and animation/render never import React —
so the same code drives the live preview and (later) a headless Node + ffmpeg frame renderer.

## Status

The full proof-of-concept (font load → stroke extraction → editor → animated preview with
brushes → save/reload) is built and working.

Not yet built: **MP4 export** (the pure `evaluate()` + renderer seam is ready for a headless
ffmpeg pass), batch "extract all glyphs", per-glyph brush overrides, and a mid-stroke pause
editor (the data model already supports pauses).

## Notes

- Clean sans / handwriting fonts (e.g. Fira Sans) extract very cleanly. Painterly brush fonts
  with blobby terminals (e.g. Patrick Hand) extract well but occasionally want a manual
  touch-up — that's what the split/merge/reset tools are for.
- Bundled sample fonts are licensed under the SIL Open Font License.

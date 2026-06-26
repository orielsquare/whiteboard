# Dual aspect-ratio authoring — design

Status: **Phases 1–2 + the Editor/navigator restructure + format-lock content divergence landed & verified. Remaining: the Phase-3 *directional* re-link modal (re-link currently warns + converges active-wins).** Companion to `HANDOVER.md`.

The Video tool must let one project author **both** a 16:9 and a 9:16 cut. The two cuts are
**stored separately** but keep a **preserved relationship** governed by per-textbox **locks**. This
doc is the worked-out implementation plan; it supersedes the current single-`aspect` behaviour
(where `setAspect` just swaps the enum and reinterprets the same coords in a differently-shaped
canvas).

---

## 1. Decisions (locked in)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Coordinates are proportional per axis.** `x`,`w` = fraction of **width**; `y` = fraction of **height**. | Both cuts then share the same numbers when linked; "matching" is automatic, no remap function. |
| D2 | **Position match = identity in x/w, identity in y (as a fraction of height).** Rendered, `y` lands at `y × H_dst/H_src` of the old vertical position — i.e. it scales with the frame. | This is the per-axis-proportional ("Figma Scale") behaviour the user chose, **not** the naive "scale all positions" (which would wrongly scale x too). |
| D3 | **Font size is invariant** (same fraction of width). Reflow is a **manual** action: unlock and narrow the box → more lines. | Keeps type legible/consistent; the user drives any density change deliberately. |
| D4 | **Per-AR pixel dimensions:** 16:9 → 1920×1080, 9:16 → 1080×1920. Each cut renders at its own `canvasW`. | Real export targets. Proportional storage makes this free. |
| D5 | **Two locks per box: `position` (x,y,w) and `content` (runs/text/style/align/line-height/brush).** Default **both locked**. Resolvable per-box, per-slide, project-default. | The user's spec. |
| D6 | **Voiceover may diverge** — accepted. One shared track by default; per-aspect track is a later option. | User: "we can live with divergent v/o without any problem." |
| D7 | **The render/layout/timing/export pipeline is untouched**, behind one pure selector `projectForAspect(p, aspect)`. | These all read only `box.frame`/`box.runs`/`slide.textBoxes`/`project.slides`. |
| D8 | **Slide list, order, timing and animation order stay shared.** No portrait-only slides; no box that exists in one cut only. | Keeps the two cuts structurally parallel and the shared narration valid. |

### The trade-off the user accepted (D2)
Matching `y` proportionally **spreads boxes apart vertically** to fill the taller portrait frame: the
gap *between* two boxes grows ~3.16× (16:9 `H`=0.5625 → 9:16 `H`=1.7778). *Within* a box, line
spacing is unchanged (it's px-based off font size). Good for a vertical stack of solution steps;
the only loser is two boxes meant to hug each other, which you'd then unlock and place by hand.

---

## 2. Coordinate model

`aspectHeightUnits`: 16:9 → `9/16 = 0.5625`, 9:16 → `16/9 = 1.7778` (canvas height ÷ width).

| Field | Stored as | Render to px (per cut, with that cut's `canvasW`/`canvasH`) |
|-------|-----------|---------------|
| `frame.x` | fraction of width `[0,1]` | `x · canvasW` |
| `frame.w` | fraction of width, or `null` | `w · canvasW` |
| `frame.y` | **fraction of height `[0,1]`** (was width-units) | `y · canvasH` where `canvasH = canvasW · aspectHeightUnits(aspect)` |
| font size | `baseEmFraction · sizeScale` (fraction of width) | `… · canvasW` |

**Why "scale all positions" is wrong, and what's right.** `x` and `w` are proportions of the shared
width basis → **identical** across cuts, zero transform. Only `y` is proportional to the axis that
*differs* (height); storing it as a fraction of height makes it identical across cuts too, and the
per-cut `× canvasH` conversion is the "scale to the other AR" the user wanted — applied to `y`
only, never to `x`.

**Round-trip:** exact. Linked boxes hold identical proportional values in both keys; nothing is
recomputed, so 16:9 → 9:16 → 16:9 is the identity.

**Bonus:** because `y` is now `[0,1]`, the pre-existing `clamp01`-on-`y` bug
(`SlideCanvas`/`videoEdit.pasteTextBox`, which slammed legal portrait boxes to `y≤1` when `y` was in
width-units up to 1.778) **becomes correct** — provided the drag/hit-test code normalises `y` by
`canvasH` (not `canvasW`).

**Font consequence of D4 (note, not a blocker):** same fraction of width × a narrower portrait
`canvasW` ⇒ portrait type is physically smaller and occupies less of the tall frame. If portrait
ever needs bigger type globally, make `baseEmFraction` per-aspect — a clean future knob, independent
of the per-box locks.

---

## 3. Data model (`schema.ts`, `PROJECT_VERSION` 1 → 2)

```ts
export interface BoxLockState { position: boolean; content: boolean }

// y is now a fraction of HEIGHT; x,w fractions of width.
export interface NormRect { x: number; y: number; w: number | null }

// Content that MAY diverge under a content-unlock (Phase 4 only).
interface BoxContent { runs: TextRun[]; align: TextAlign; lineHeightScale: number; brush?: BrushSettings }

export interface TextBox {
  id: string                              // ONE logical box, shared across cuts
  frame: Record<Aspect, NormRect>         // REPLACES single `frame`; both keys always present
  // shared content (the common, content-locked case):
  align: TextAlign
  runs: TextRun[]
  lineHeightScale: number
  brush?: BrushSettings
  // ALWAYS shared (drive shared timing + the shared voiceover):
  animOrder: number
  delayBeforeMs: number
  interCharDelayMs: number
  // opt-in per-aspect content override (Phase 4; absent unless content-unlocked AND diverged):
  contentByAspect?: Partial<Record<Aspect, BoxContent>>
  // lock override; undefined = inherit slide, then project default:
  lock?: Partial<BoxLockState>
}

export interface Slide { /* …id, background, textBoxes, holdBeforeTransitionMs, transition… */
  lock?: Partial<BoxLockState>            // slide-level "lock/unlock all" target
}

export interface VideoProject { /* …all existing shared fields… */
  version: 2
  lockDefault: BoxLockState               // { position: true, content: true }
  // `aspect` is REMOVED from the document — the active editing aspect is transient UI state.
}
```

Notes:
- **Always-both-keys** `frame` (not shared-`frame`+override): write-through is a plain object copy
  (no remap math, since `y` is already a fraction of height), and divergence detection is a plain
  equality check. Locked → both keys equal; unlocked → they may differ. The 6 extra floats are
  negligible.
- **Lock state stored once** per box (a lock describes the *relationship* between the two cuts —
  per-AR lock storage is incoherent). `vAnchor` from the earlier draft is **dropped** — proportional
  `y` needs no anchor.
- `contentByAspect` holds **only** runs/align/line-height/brush. `animOrder`/`delayBeforeMs`/
  `interCharDelayMs` are never per-aspect (they sequence the shared timing + voiceover).

### Migration (v1 → v2)
Version-keyed (`raw.version < 2`) — **never** "is `box.frame` flat?", because a *projected* box has a
flat frame and that predicate would double-migrate on the CLI export path. For each box: read the
saved single `frame` (its `y` is width-units against the saved `project.aspect`), convert
`y_v2 = y_v1 / aspectHeightUnits(savedAspect)`, and seed **both** `frame` keys with the identical
converted rect (the saved cut is the source of truth; the other cut starts linked). Default `lock`
absent (inherits locked). `lockDefault = {position:true, content:true}`.

---

## 4. The projection seam

New framework-free `src/lib/project/aspect.ts` (unit-tested in `tools/aspect.test.mjs`):

```ts
projectForAspect(p: VideoProject, aspect: Aspect): VideoProject
// maps each box → { ...box,
//   frame: { x, y: y * aspectHeightUnits(aspect), w },     // y(frac-height) → legacy width-units
//   ...(box.contentByAspect?.[aspect] ?? {}) }             // fold content override (Phase 4)
// and drops frame-map / contentByAspect / lock → the legacy single-aspect shape that
// layout.ts / render.ts / timing.ts / videoExport.mjs already consume, BYTE-FOR-BYTE UNCHANGED.

aspectHeightUnits(aspect)        // (re-exported from coords.ts)
effLock(p, slide, box)           // box.lock?.X ?? slide.lock?.X ?? p.lockDefault.X
framesDiverge(box)               // frame['16:9'] != frame['9:16'] within epsilon ~0.002
```

`render.ts` `boxOrigin` does `frame.y * canvasW`; feeding it the projected `y` (= frac-height ×
`aspectHeightUnits`) yields `frac-height × aspectHeightUnits × canvasW = frac-height × canvasH`. ✅
So `layout.ts`, `render.ts`, `timing.ts`, `transitions.ts`, `runs.ts`, `vtt.ts`,
`videoExport.mjs` internals are **untouched**.

---

## 5. Locks, divergence, merge

**Resolution:** `effLock` = box override → slide override → `project.lockDefault`. A fresh box sets no
flag (inherits locked). Slide-level "lock/unlock all" writes `slide.lock`; an explicit box override
still wins (surface this; offer a "clear box overrides" affordance).

**Write-through (in `videoEdit.ts`, `active` = editing aspect, `other` = the sibling):**
- **Position lock ON** → after writing `frame[active]`, set `frame[other] = { ...frame[active] }`
  (plain copy). The deferred-write drag commits both keys inside one `set()` = **one undo entry**
  (matches the existing pointer-up commit pattern).
- **Position lock OFF** → write only `frame[active]`; the keys diverge and the box is flagged.
- **Content lock ON** → content lives in the shared box fields, so editing affects both cuts
  automatically — write-through is a literal **no-op** (the cuts physically cannot drift in
  wording/style). Honest consequence, not a bug.
- **Content lock OFF then edited** → promote edited fields into `contentByAspect[active]`. *Phase 4.*

**Divergence indicator:** a box whose two `frame` keys differ draws a dashed "diverged" outline + an
Inspector "differs from {other}" note (mirroring the voiceover-stale amber language).

**Re-lock merge (OFF → ON after divergence):**
- If the cuts already match (epsilon) → flip the flag silently.
- Else open a **directional** modal: *"Re-link position across aspect ratios"* →
  **[Make {other} match {this}]** (default = the cut you're viewing) / **[Make {this} match {other}]**
  / **[Cancel]**, with a before/after thumbnail of the cut being changed.
- The winner's `frame` is copied to the loser; **defer the flag flip until the user confirms**, so
  flag + overwrite land in **one** `set()` (otherwise undo strands a locked-but-divergent box).
- Slide/project-scope re-lock over N diverged boxes → one modal, a count, one global winner choice.

---

## 6. Shared vs per-aspect

**Shared (one copy, drives both cuts):** slide list + order; each slide's `background`,
`holdBeforeTransitionMs`, `transition`; box `id`, `animOrder`, `delayBeforeMs`, `interCharDelayMs`;
all timing; `voiceover` + `tts`; `playbackRate`, `fontId` (+ per-run `fontId`), `baseEmFraction`,
project `brush`, `namedStyles`, `defaults`; lock state; **content** (runs/align/line-height/brush)
while content-locked.

**Per-aspect:** `frame` (x,y,w) — diverges under position-unlock; `contentByAspect[aspect]` —
under content-unlock + actual divergence (Phase 4).

**Transient (not in the document, not undoable):** the active editing aspect.

---

## 7. Editor integration

- **Active aspect** lives in the **transient** store slice (next to `selection`/`selectedSlideId`),
  **not** on the undoable `project` (`videoStore` partializes `{project}` — putting aspect on the
  project would make every AR toggle an undo step). Persist "last viewed AR" to `localStorage` if
  reload-restore is wanted.
- **`videoStore`:** add `migrateV1toV2` in `normalizeProject` (version-keyed); add `activeAspect`
  + `setActiveAspect`; thin actions for the new edit helpers. The char-collection loop reads the
  shared box list (runs are shared).
- **`videoEdit.ts`:** `updateTextBoxFrame` writes `frame[active]` + (if position-locked)
  `frame[other]` in one `set`; add `setBoxLock`/`setSlideLock`/`setLockDefault`/`relock`;
  `setAspect` **removed**; fix `copySlide`/`cloneTextBox`/`pasteTextBox`/`addTextBox`/`newTextBox`/
  `newSlide` to build/clone **both** `frame` keys (copy verbatim — never re-derive). `clamp01` on
  `y` is now correct given `y` is frac-height.
- **Read-site sweep** — every editor site that reads `box.frame` directly must go through a
  `frameOf(box, aspect)` accessor + the px conversion (`x,w × canvasW`, `y × canvasH`):
  `SlideCanvas` (drag seed + `drawScene` feeds `projectForAspect(project, activeAspect)` to
  `buildRenderContext`), `layoutCanvas` (`boxOriginPx`/`boxBoundsNorm`/hit-test/selection),
  `TextBoxOverlay` (on-canvas editor), `Inspector` (wrap-width control), `SlideThumbnail`,
  `ProjectPlayer`, `TimelineView`. **This sweep is the bulk of the diff and the silent-failure
  surface** — route everything through the one accessor and grep for stray `.frame.`.
- **`VideoView`:** the aspect buttons call `setActiveAspect` (view switch, no coordinate touch); the
  char-scan loops + `doExport` read the projected project / shared box list; add per-box lock
  toggles to the Inspector + the re-lock modal.

---

## 8. Export

- Per-AR dimensions (D4): 16:9 → 1920×1080, 9:16 → 1080×1920 (replace the hardcoded 1280).
  `videoExport.mjs` reads `projects/<id>.json` directly → must **migrate then `projectForAspect`**
  before rendering, and pick `canvasW` by aspect.
- "**Export both**" loops `ASPECTS` through `projectForAspect` → two MP4s (`name-16x9` /
  `name-9x16`). MP4 is single-resolution, so it's always one file per cut.

---

## 9. Edge cases

- **`clamp01`-on-`y`:** resolved by the frac-height representation **iff** drag/paste normalise `y`
  by `canvasH`. Verify in `SlideCanvas` + `videoEdit.pasteTextBox`.
- **Migrator/live must agree** on the `y` conversion (÷ `aspectHeightUnits(savedAspect)`), or
  migrated boxes open falsely "diverged".
- **`copySlide`/clone/paste/new\*\*:** build/clone **both** `frame` keys; `copySlide` copies both
  verbatim (preserve a diverged portrait layout) — never re-derive.
- **`w = null`** (no-wrap): copy `null → null`; off-canvas checks for the inactive cut use the
  projected layout width, not `frame.w`.
- **Slide list is shared** — no portrait-only slide breakdown (hard product constraint, state it).
  Box add/delete seed/remove both keys, so "box with no counterpart" is structurally impossible.
- **CLI export path** must key migration on `version` only (a projected box has a flat frame).
- **9:16 → 16:9 overflow:** a low box (`y` high) with tall content can exceed the short landscape
  frame. **Flag** with an overflow badge; do **not** silently auto-shrink (hurts maths legibility).
  An opt-in PowerPoint-style "Ensure Fit" (uniform `k` on x,y,size) is an explicit escape hatch, not
  the default.
- **zundo atomicity:** re-lock flag flip is deferred to modal-confirm so flag + overwrite are one
  `set()`.

---

## 10. Phasing

- **Phase 1 — data + seam (no behaviour change). ✅ DONE.** Reshaped `TextBox.frame →
  Record<Aspect,NormRect>` with `y` as frac-height; added `aspect.ts` (`projectForAspect`,
  `frameOf`/`boxForAspect`/`flattenSlide`, `toStoredY`, `effLock`, `framesDiverge`, `migrateProject` —
  the migrator is shared with the exporter so they can't drift); pipeline (`layout`/`timing`/`render`)
  retyped to the Flat\* shapes (bodies unchanged); active aspect moved to the transient store slice;
  every editor read-site routed through the flattened slide; per-AR export width (1920×1080 / 1080×1920);
  aspect-aware y clamp. Verified: `tsc` clean, full `vite build` clean, `tools/aspect.test.mjs`
  (31 cases: frameOf/round-trip/projectForAspect/migrate v1→v2/idempotent v2/effLock/framesDiverge) +
  the existing layout/runs/timing/vtt suites all green, and in-browser the aspect toggle reshapes the
  canvas with a stable round-trip, a real v1 project migrates and opens identically in its saved cut.
  NOTE: editor preview keeps `BACKING_W` for both cuts (proportions already match export; only the
  exported MP4 uses per-AR pixel size). Boxes are written to BOTH frame keys (locked-by-default) until
  Phase 2 adds the unlock path.
- **Phase 2 — locks + position write-through. ✅ DONE.** `effLock` resolver (box→slide→project,
  default locked); `updateTextBoxFrame` takes `writeAspects` and the store passes BOTH cuts when
  position-locked / only the active aspect when unlocked (one `set()` ≡ one undo). Per-box **link
  position** toggle + slide-level **Link all / Unlink all** in the Inspector; diverged boxes
  (`framesDiverge`) get an amber dashed ring on the canvas + an Inspector note naming the other cut.
  Re-linking **auto-converges (active aspect wins)** — Phase 3 upgrades this to the directional
  winner modal + preview; it is not a no-op now. Content lock is shown only as a muted "text & style
  are shared" note. Verified: `tsc`/`vite build` clean, `tools/videoEdit.test.mjs` (16 cases) + all
  prior suites green, and in-browser: unlink → edit one cut → 16:9=40%/9:16=70% with the divergence
  note; re-link converges (active wins, note clears); linked edits mirror to both cuts; slide-level
  unlink-all cascades to the box.
- **Editor restructure (between 2 and 3). ✅ DONE.** Merged the **Layout** + **Order** tabs into one
  **Editor** tab (tabs now Editor / VTT / Timeline / Play); the left panel became a tabbed
  **Slides / Textboxes** navigator (`NavigatorPanel`). The textbox list (`TextboxNavigator`, replacing
  `AnimationOrderList`) keeps reorder + per-box delay and adds the **p / f padlock columns** — per-row
  toggles, a clickable **column header** that bulk-applies to the slide (tri-state mixed), and diverged
  boxes shown amber. The **slide** navigator (`SlidePanel`) carries the same per-slide padlocks (apply
  to all boxes on the slide). Re-linking a diverged box pops a **revert-warning confirm** (`useConfirm`
  / `ConfirmDialog`) before converging (active aspect wins). The **format (`f`) padlock is present but
  disabled** ("coming soon") — content stays shared until content-divergence lands. Per-slide play was
  removed (Play tab unchanged); the Phase-2 lock controls were removed from the Inspector (locks live in
  the navigator now; the canvas amber outline stays). Deleted `SlideOrderView` + `AnimationOrderList`.
  Verified in-browser: tab merge, navigator tabs, per-box + header + slide padlocks, diverge → amber →
  re-link confirm → active-wins converge; `tsc`/`build` clean, all test suites green.
- **Editor consolidation (follow-up). ✅ DONE.** The navigator tab (`navTab`, in the store) now **gates the
  Inspector** (Textboxes → frame/timing props; Slides → background/transition); clicking a textbox on the
  canvas forces the Textboxes tab. The per-row "+ms" delay chip moved into the Inspector; the per-box
  custom-brush control was removed. The **Play tab folded into the Editor** as a `▶ Play / ■ Stop` toggle
  (`editorPlaying`, transient) swapping the canvas for the inline `ProjectPlayer` + the scope-ticking slide
  list. Aspect 16:9/9:16 buttons now show toggle state (`.video-top button` vs `.tool-on` specificity fix);
  padlocks/headers carry `Position`/`Format` tooltips; navigator restyled (underline tabs + drop shadow +
  top gap). Verified in-browser; `tsc`/`build` clean.
- **Inline playback rework (follow-up). ✅ DONE.** Replaced the pseudo-tab Play toggle with a **single
  shared editor canvas** (edits when idle, plays when a scope is set) and a **permanent transport** under
  it (`Transport` + `usePlaybackEngine`, extracted from the old `PlaybackCanvas`). The transport plays the
  whole project (with voiceover audio); each **slide and textbox chip** has a ▶/■ that loops just that
  slide/textbox on the canvas; **Stop** returns to the editing layout. Store: `editorPlaying`/`playSelectedIds`
  → `playback: {kind:'project'|'slide'|'box', …} | null` (transient); selecting/tab-switching resets it.
  Editing `layouts` now reuse the playback `rc.layoutsBySlide`. The **"All/Selected slides" scope was
  dropped** (chips supersede it); `ProjectPlayer` + `PlaybackCanvas` deleted. Verified in-browser:
  transport project-play, slide-chip loop, textbox-chip loop, stop→edit; `tsc`/`build`/tests clean.
- **Phase 3 — re-lock merge.** Upgrade the revert-confirm into a directional winner modal + before/after
  thumbnail (choose which cut wins, not just active-wins); deferred flag flip; slide/project bulk merge
  with a count.
- **Phase 3.5 — format-lock behaviour (per-aspect content divergence). ✅ DONE.** The `f` padlock is
  live. `contentByAspect` (runs/align/line-height/brush) is folded in `boxForAspect`/`projectForAspect`
  (so canvas/layout/thumbnail/export show the right cut) and read via `contentOf` in FormatBar /
  TextBoxOverlay / Inspector. Content write-through (`applyTextStyle` / `updateTextBoxRuns` /
  `updateTextBoxContent` / `applyNamedStyle`) routes to the shared base when format-linked or the
  active aspect's override when unlinked; `setBox/Slide/ProjectFormatLink` converge active-wins on
  re-link with the same confirm. `contentsDiverge` drives the diverged indicator. The `f` columns
  (per-box, slide, project header) are enabled and mirror the `p` behaviour. Verified: `tsc`/`build`
  clean, `tools/{aspect,videoEdit}.test.mjs` extended (content fold / divergence / lock-aware
  write-through / converge — 40 + 28 cases), and in-browser: unlink `f` → change line-height in 16:9 →
  16:9=2.0 / 9:16=1.2 (diverged, amber) → re-link converges (active wins) via the confirm; slide &
  project `f` headers toggle. NOTE: text edits diverge per-aspect too, so the two cuts can now have
  genuinely different wording — voiceover stays one shared track (accepted earlier).
- **Phase 4 (deferred).** Per-aspect **content** divergence via `contentByAspect` (route all content
  readers through `projectForAspect`); per-aspect `baseEmFraction`; per-aspect `lineHeightScale`;
  optional **auto vertical-fit** of line-height (needs a real box-height concept — see below);
  "Ensure Fit"; per-aspect voiceover track if one-track-best-effort proves insufficient.

---

## 11. Deferred / open

- **Auto "line-height fits the flow"** (the user's phrasing): there's currently no box *height* —
  height is content-derived — so there's nothing to fit *into*. For now `lineHeightScale` is an
  authored value (per-aspect-capable in Phase 4 so portrait spacing can be tightened by hand). True
  vertical-justification needs a new box-height field; deferred to Phase 4.
- **Default presentation:** single canvas + AR toggle (recommended, minimal churn). A read-only
  thumbnail of the inactive cut in the Inspector is a cheap middle ground; side-by-side dual preview
  is a bigger build.

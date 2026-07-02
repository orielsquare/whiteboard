# UX rationalisation — design + status

Status: **implemented & verified** (typecheck + all pure-engine suites green; in-browser
verification of the envelope pipeline, per-stroke drawing timing, refresh/autosave
restore, timeline-zoom persistence and the shared Files menus).
Companion to `CLAUDE.md` / `HANDOVER.md`. Scope: (1) consistent file management across
Font/Drawing/Video, (2) session-state preservation across refreshes and tab switches,
(3) richer timing models (per-stroke times baked into files; transient preview speed;
per-element speed + fixed time envelopes in videos).

## 1. File management (fonts / drawings / videos)

One consistent surface per tool, built from shared pieces:

- **`FilesMenu`** (`src/app/components/files/FilesMenu.tsx`) — a shared "Files ▾"
  dropdown used by all three tools. Lists saved artifacts (name + meta + updatedAt,
  current file marked ●) with per-row **Open / Rename / Duplicate / Delete** and a
  refresh-on-open. Rename edits inline in the row (load → patch name → PUT; if the
  renamed file is open, the in-memory name updates too). Delete confirms first.
- **`PromptDialog`** (`src/app/components/files/PromptDialog.tsx`) — a `useConfirm`-style
  `usePrompt()` hook replacing `window.prompt` (used for Duplicate-as names).
- **Consistent action bar** in every tool: `↶ ↷ · Name · 💾 Save (greyed when clean) ·
  Files ▾ · New/Import · Reload`. Name commits on **blur/Enter** everywhere (Drawing's
  per-keystroke rename is aligned to this). Reload = re-load the open artifact from the
  server (added to Video + Drawing; Font already had it).
- **Dirty guards**: opening another file / New / Reload with unsaved changes asks first
  (shared confirm), in all three tools.
- **Fonts catch up with the others**: an Open-saved-fonts list (was impossible — only
  bundled/upload existed), Delete (new `DELETE /api/fonts/:id` server route, trashes
  manifest + bytes), and Duplicate (new `POST /api/fonts/:id/copy` route copying
  manifest + bytes under a new id). Opening a saved font loads its bytes and overrides
  `LoadedFont.hash` with the **stored id** so duplicated treatments (same bytes,
  different id) work with the existing `fontId`-gated derivation.
- **Video** gains dirty tracking (`project !== savedProjectRef`), so Save greys out
  like the other tools.

Identity model is unchanged: fonts = content-hash id (copies get `<hash>-<suffix>`),
videos = uuid, drawings = `svg-<hash>` (+ copy suffix). Names stay cosmetic and live in
the artifact + Drive filename (server-authoritative for videos/drawings, now surfaced
identically for fonts).

## 2. Session-state preservation

- **`src/app/state/sessionPrefs.ts`** — tiny typed localStorage helpers (`prefGet` /
  `prefSet`, JSON, try/catch). All keys under `wb.*`.
- Persisted view state: top tab (already existed) **+ font source
  (bundled url / saved id / uploaded hash), font sub-tab, selected glyph, brush,
  video slideView + activeAspect + last project id, per-project timeline zoom &
  scroll, drawing last id + preview speed/loop, export quality**.
- **Timeline zoom/scroll move into `useVideoStore`** (transient fields), so they
  survive tab switches; they're also mirrored to localStorage per project id so they
  survive refreshes. Drawing part selection similarly moves into `useDrawingStore`.
- **Auto-reopen on mount**: Video loads the last project id (falls back to New);
  Drawing loads the last drawing id; Font reopens the last source (saved fonts by id;
  un-saved uploads can't be restored — the file input is the only source of bytes).
- **Autosave (crash/refresh safety)**: a single-slot, debounced (~800 ms) working-copy
  snapshot per tool in localStorage (`wb.autosave.<kind>`), size-capped (~2.5 MB,
  fonts/drawings can exceed it — then skipped), cleared on Save. On reopen, if the
  snapshot is **newer than the server copy**, it's restored, marked dirty, and the
  status line says so; "Reload" discards it back to the saved state.

## 3. Per-stroke timing (fonts + drawings), preview speed

- **Fonts** already store per-section `SectionTiming {durationMs, delayBeforeMs,
  easing, pauses}`; the Editor gains exact **numeric ms inputs** beside the sliders
  and a **transient play speed** control (PreviewView already had one). Nothing new
  is baked beyond what the user edits.
- **Drawings** gain optional per-section timing: `PartSection.timing?:
  { durationMs?, delayBeforeMs? }`.
  - Absent everywhere → exactly today's behaviour (envelope / perStroke).
  - Effective section duration = explicit `durationMs` ?? its length-proportional
    share of `part.timing.durationMs` (the part duration remains the "base pace").
    `delayBeforeMs` inserts a pen-lift gap before that section.
  - Any override in a part → the part reveals **per-section sequentially** (each
    section eased individually); the part panel shows the computed total.
  - Editor: duration/delay inputs on the selected stroke in the part's stroke list.
- Preview speed stays **transient** in every tool (never written to a manifest).

## 4. Video element timing — per-element speed + envelope

Writing is always **sequential** (one pen); the slide cursor model is unchanged.
All fields are optional/additive (no project version bump):

- `TextBox.speed?: number` — writing-speed multiplier, parity with the existing
  `SlideDrawing.speed`. Compounds with the project `playbackRate` exactly like
  drawings do today.
- `TextBox.envelopeMs?` / `SlideDrawing.envelopeMs?` — a **fixed writing window**
  (real ms at rate 1). When set, the element occupies exactly `envelopeMs /
  playbackRate` of timeline regardless of its content; the reveal is scaled to fill
  it (implied speed = `contentMs / envelopeMs`). Editing the content keeps the
  chosen pace of the video — the element's window doesn't move.
  - Envelope **wins over** `speed` when both are set (the Inspector shows the
    derived ×, and disables the speed slider while an envelope is active).
  - Empty content + envelope = a timed spacer (the window is still reserved).
  - `delayBeforeMs`, hold and transition remain invariant, as today.
- **Engine**: `computeSlideTiming` computes each item's window as
  `envelopeMs ?? contentMs / speed`, then `/ rate`. Rendering derives each item's
  sampling factor **from its timing window** — `contentMs / (endMs − startMs)` —
  replacing the duplicated `speed × dSpeed` math (preview + export share it via the
  pure seam, so parity is automatic).
- **UI**: Inspector gets "writing speed ×" (boxes) and "fixed duration" (boxes +
  drawings, seconds, 0 = natural); the Timeline marks envelope-fixed bars.
- **Tests**: `tools/timing.test.mjs` extended (envelope fixes the window under
  content edits and global rate; box speed scales like drawing speed; empty-content
  envelope).

## 5. Envelope v2 — the container-bar model (supersedes §4's "envelope wins")

Agreed with the user (2026-07-02):

- **`speed` is the animation block's own rate** (`animMs = contentMs / speed`), always
  active — it is NOT overridden by the envelope.
- **`envelopeMs` is the container** the element occupies on the timeline. The old
  `delayBeforeMs` is REINTERPRETED as the **padding-before / offset** of the animation
  block inside its envelope (one concept, no separate delay); padding-after is derived
  (`envelope − offset − anim`). The block can be **slid** within the bar (offset), the
  bar's end dragged (envelope length).
- **Unset envelope = tight/auto**: `envelope = offset + animMs` — grows with content
  (classic behaviour, and the migration story: nothing to migrate).
- **Overflow rule — the envelope is master**: if `offset + animMs > envelopeMs`, the
  offset clamps into the envelope and the animation **compresses to fit** the remaining
  span; the UI shows the effective ×. Editing content never moves the timeline.
- **The global `playbackRate` scales WHOLE envelopes** (offset + animation + trailing
  pad all ÷ rate) — note this supersedes the old "per-element delays are invariant"
  rule. Slide hold + transition durations remain invariant.
- **Sequencing**: the next element starts when the previous **envelope** ends.

Engine: `elementSlot(contentMs, speed?, envelopeMs?, offsetMs)` → `{envMs, animOffMs,
animMs}` at ×1 (timing.ts); `computeSlideTiming` divides the whole slot by the rate and
emits per element `{startMs, endMs, animStartMs, animEndMs}` (start/end = envelope
bounds). Render samples writing at `(t − animStartMs) × contentMs/(animEndMs −
animStartMs)`, fully drawn past `animEndMs`. Chip playback plays the whole envelope.
UI: an **EnvelopeBar** widget in the Inspector (drag the bar end = envelope length,
drag the block = offset, deferred-write commits once on release), numeric fields, and
"compressed — effective ×N" when overflowing; the Timeline draws the envelope as a
lighter slot bar with the solid animation block inside.

## 6. Direct drawings ("inks") on slides

Agreed with the user (2026-07-02): all four tools (freehand · straight line ·
freehand-coerced-to-curve · line with arrowhead [end only in v1]), per-ink colour +
width override (pen texture stays the project brush), post-draw select/move/delete/
re-time (no point-level reshaping in v1), Escape cancels an in-progress stroke, one
undo step per completed stroke.

- **Stored inline in the slide** (`Slide.inks?: SlideInk[]` in the project file), NOT
  as saved drawing artifacts. Points normalized like frames (x = fraction of width,
  y = fraction of height), shared across aspects (position-locked in v1).
- Animated **sequentially** through the shared `animOrder` with the same
  speed/envelope model; natural duration from arc length at a default ink pace.
  Arrowheads draw as pen strokes AFTER the shaft (like the human-style underline).
- Rendered via the existing ribbon/brush pipeline (LUT per section; project brush +
  per-ink colour/widthScale), so preview, thumbnails, transitions (rubout) and MP4
  export all share the seam automatically.
- Editor: a small tool strip on the slide canvas (Select ✎ ─ ~ →); drawing captures
  the pointer; curve tool simplifies (RDP) + smooths (Catmull-Rom); inks are
  hit-testable + draggable in Select mode; navigator Elements lists them; Inspector
  shows colour/width/speed/EnvelopeBar/delete. `reindexSlideOrder` spans boxes +
  drawings + inks.

## Checklist

- [x] P1 — video engine: schema fields, timing/render unification, tests
      (`tools/timing.test.mjs` → 59)
- [x] P2 — video UI: Inspector speed/envelope, Timeline envelope marker (⧖ +
      `tl-fixed`) + drawing bars (`tl-draw`)
- [x] P3 — drawing per-section timing (schema/engine/UI + `tools/drawtime.test.mjs`
      → 23) + font editor numeric ms inputs + editor preview speed
- [x] P4 — sessionPrefs + autosave + auto-reopen + timeline zoom/scroll in the store
- [x] P5 — FilesMenu/PromptDialog + all three tools adopted + `DELETE
      /whiteboard/api/fonts/:id` (spreadsheet-builder repo) + rename/dirty/Reload
      consistency
- [x] P6 — typecheck, pure tests, in-browser verification (play-based)
- [x] P7 — post-review fixes (undo cleared on save-as document switch; autosave keeps
      the last-fitting slot on size overflow; NaN-safe `slotIsNewer` server compare)
- [x] P8 — envelope v2 (§5): `elementSlot` engine + timing/render/chip-playback on
      anim windows, EnvelopeBar widget, Timeline envelope+block bars, tests rewritten
- [x] P9 — direct drawings (§6): `SlideInk` schema + `ink.ts` engine (coerce/
      arrowheads/prepare/render/hit), aspect flattening, timing/render/rubout/
      thumbnails, canvas pen tools (Esc cancel, Delete removes), navigator rows,
      Inspector panel, `tools/ink.test.mjs` + timing test 16
- [x] P10 — EnvelopeBar v3 (user feedback): the lozenge always fills the panel
      (= the envelope, 100% of its time); the block inside **slides** (pad-before)
      and **stretches on both edges** — resizing writes the element's `speed`
      (`contentMs / blockMs`); envelope length set via fixed-length toggle +
      seconds field; verified in-browser (grip drag → ×2.56 exactly as computed)
- [x] P12 — EnvelopeBar drag fix (user feedback): the lozenge is a fixed-length
      envelope of start-pad + block + **end-pad**. Body-slide moves start↔end pad
      (block fixed); left edge resizes block + start-pad (end-pad fixed); right edge
      resizes block + end-pad (start-pad fixed). Every drag pins `envelopeMs` so the
      length holds; block min ≈2px, max = 100% of the envelope. Verified in-browser
      (end-pad 211→211px on left-edge, block 380px fixed on slide, start-pad + env
      fixed on right-edge).
- [x] P13 — ink: per-ink **easing** (EasingName, applied in `renderInk`), and the
      **arrowhead is an on/off flag** on line & curve (`SlideInk.arrow`) — the
      `'arrow'` tool is gone (legacy value still renders wings). Tool strip: ↖ ✎ ─ ～
      + an arrowhead toggle (line/curve only); Inspector adds the arrowhead checkbox
      + easing dropdown. `tools/ink.test.mjs` updated.
- [x] P14 — timing panel rationalised (user spec): cadence + speed sliders + the
      fixed-length checkbox are GONE (speed remains only as storage for animation
      length). One stack per element: an absolute-ms envelope slider (500–10,000)
      + keyboard field + **resize with content** (checked = auto envelope, hugging
      padding + animation; any timing edit pins it; re-ticking un-pins/fits), the
      lozenge, then three live editable values — **initial padding · animation
      length · final padding**. A keyboard edit of any of the three opens a modal
      (edited value checked + greyed; the other two act as radio compensators,
      defaulting to initial padding — or final when initial is the edited one)
      with **[change envelope]** (delta lands on the envelope, others hold) /
      **[compensate internally]** (envelope holds; the chosen value absorbs; a
      non-fitting change fails with a modal giving the needed envelope length) /
      cancel. Matrix is pure + tested (`envelopeEdit.ts`,
      `tools/envelopeEdit.test.mjs`, 17 assertions); every path verified
      in-browser to the millisecond.
- [x] P11 — multi-select + element clipboard: marquee on empty canvas,
      shift/ctrl-⌘ click toggles, group drag (one write, verified numerically —
      4 boxes moved +0.10/+0.10, unselected ink untouched), group delete
      (key + Inspector "N elements" panel), format-together (FormatBar applies
      run styles/align/line-height to every selected box — one undo), and
      ⌘C/X/V for mixed element sets across slides (`ClipboardElement[]`;
      `translateElements`/`removeElements`/`collectElements`/`pasteElements` in
      videoEdit, +21 test assertions)

Verified in-browser (builder server down = graceful offline): envelope 5s → timeline
total exactly 6.9s (0.3 delay + 5 + 1 hold + 0.6 fade), ⧖ bar marker, box chip plays a
5.0s window in real time; drawing stroke override 718→3000ms grew the total 3.3→5.6s
with a ⏱ badge and live playback; a page refresh restored the open (never-saved) video
from the autosave slot ("restored unsaved changes"), the top/sub tabs, and the
per-project timeline zoom.

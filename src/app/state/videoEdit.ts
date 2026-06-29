import {
  makeId,
  newSlide,
  newSlideDrawing,
  newTextBox,
  type Aspect,
  type BoxContent,
  type BoxLockState,
  type NamedStyle,
  type NormRect,
  type ProjectDefaults,
  type Slide,
  type SlideDrawing,
  type TextBox,
  type TextRun,
  type TtsSettings,
  type VideoProject,
  type VoiceoverAudio,
  type VoiceoverCue,
} from '@lib/project/schema'
import { contentOf, otherAspect } from '@lib/project/aspect'
import { DEFAULT_TTS, DEFAULT_TTS_VOICE_SETTINGS } from '@lib/project/schema'
import type { BrushSettings } from '@lib/manifest/schema'
import { applyStyleToRange, type StylePatch } from '@lib/project/runs'
import { estimateDurationMs } from '@lib/project/vtt'

function mapSlide(p: VideoProject, slideId: string, fn: (s: Slide) => Slide): VideoProject {
  return { ...p, slides: p.slides.map((s) => (s.id === slideId ? fn(s) : s)) }
}

/** Re-assign contiguous animOrder 0..n-1 across a slide's boxes AND drawings,
 *  preserving their current relative order. The two share ONE animation sequence,
 *  so any structural change (add/delete/reorder/paste) must reindex both together
 *  — reindexing boxes alone would collide with a drawing's animOrder. Keeps the
 *  `drawings` field optional (only present if the slide already had one). */
function reindexSlideOrder(s: Slide): Slide {
  const items = [
    ...s.textBoxes.map((b) => ({ id: b.id, animOrder: b.animOrder })),
    ...(s.drawings ?? []).map((d) => ({ id: d.id, animOrder: d.animOrder })),
  ].sort((a, b) => a.animOrder - b.animOrder)
  const idx = new Map(items.map((it, i) => [it.id, i]))
  return {
    ...s,
    textBoxes: s.textBoxes.map((b) => ({ ...b, animOrder: idx.get(b.id) ?? b.animOrder })),
    ...(s.drawings ? { drawings: s.drawings.map((d) => ({ ...d, animOrder: idx.get(d.id) ?? d.animOrder })) } : {}),
  }
}

// --- slides ---------------------------------------------------------------

export function addSlide(p: VideoProject): { project: VideoProject; slideId: string } {
  const s = newSlide(p.defaults)
  return { project: { ...p, slides: [...p.slides, s] }, slideId: s.id }
}

export function copySlide(p: VideoProject, slideId: string): { project: VideoProject; slideId: string } {
  const i = p.slides.findIndex((s) => s.id === slideId)
  if (i < 0) return { project: p, slideId }
  const src = p.slides[i]
  const clone: Slide = {
    ...src,
    id: makeId(),
    transition: { ...src.transition },
    textBoxes: src.textBoxes.map((b) => ({
      ...b,
      id: makeId(),
      frame: { '16:9': { ...b.frame['16:9'] }, '9:16': { ...b.frame['9:16'] } },
      runs: b.runs.map((r) => ({ ...r })),
    })),
    // Only carry a `drawings` field if the source had one (keep drawing-less
    // slides shape-identical after a copy).
    ...(src.drawings
      ? {
          drawings: src.drawings.map((d) => ({
            ...d,
            id: makeId(),
            frame: { '16:9': { ...d.frame['16:9'] }, '9:16': { ...d.frame['9:16'] } },
          })),
        }
      : {}),
  }
  const slides = [...p.slides]
  slides.splice(i + 1, 0, clone)
  return { project: { ...p, slides }, slideId: clone.id }
}

export function deleteSlide(p: VideoProject, slideId: string): VideoProject {
  return { ...p, slides: p.slides.filter((s) => s.id !== slideId) }
}

export function reorderSlides(p: VideoProject, orderedIds: string[]): VideoProject {
  const byId = new Map(p.slides.map((s) => [s.id, s]))
  const slides = orderedIds.map((id) => byId.get(id)).filter((s): s is Slide => !!s)
  for (const s of p.slides) if (!orderedIds.includes(s.id)) slides.push(s)
  return { ...p, slides }
}

export function updateSlide(p: VideoProject, slideId: string, patch: Partial<Slide>): VideoProject {
  return mapSlide(p, slideId, (s) => ({ ...s, ...patch }))
}

export function setSlideTransition(
  p: VideoProject,
  slideId: string,
  patch: Partial<Slide['transition']>,
): VideoProject {
  return mapSlide(p, slideId, (s) => ({ ...s, transition: { ...s.transition, ...patch } }))
}

// --- textboxes ------------------------------------------------------------

export function addTextBox(
  p: VideoProject,
  slideId: string,
  x: number,
  y: number,
): { project: VideoProject; boxId: string } {
  const id = makeId()
  const project = mapSlide(p, slideId, (s) => {
    const box = { ...newTextBox(p.defaults, x, y, nextAnimOrder(s)), id }
    return { ...s, textBoxes: [...s.textBoxes, box] }
  })
  return { project, boxId: id }
}

export function updateTextBox(
  p: VideoProject,
  slideId: string,
  boxId: string,
  patch: Partial<TextBox>,
): VideoProject {
  return mapSlide(p, slideId, (s) => ({
    ...s,
    textBoxes: s.textBoxes.map((b) => (b.id === boxId ? { ...b, ...patch } : b)),
  }))
}

/** Patch a box's frame into the given aspect key(s). `patch.y` is in stored units
 *  (fraction of HEIGHT) — the store converts editor width-units first. The store
 *  resolves the position lock and passes BOTH aspects when linked (so the cuts
 *  stay identical) or just the active aspect when unlinked (so they diverge). */
export function updateTextBoxFrame(
  p: VideoProject,
  slideId: string,
  boxId: string,
  patch: Partial<NormRect>,
  writeAspects: Aspect[],
): VideoProject {
  return mapSlide(p, slideId, (s) => ({
    ...s,
    textBoxes: s.textBoxes.map((b) => {
      if (b.id !== boxId) return b
      const frame = { ...b.frame }
      for (const a of writeAspects) frame[a] = { ...frame[a], ...patch }
      return { ...b, frame }
    }),
  }))
}

// --- placed drawings ------------------------------------------------------

/** The next animation slot on a slide, shared across its boxes AND drawings. */
function nextAnimOrder(s: Slide): number {
  let max = -1
  for (const b of s.textBoxes) max = Math.max(max, b.animOrder)
  for (const d of s.drawings ?? []) max = Math.max(max, d.animOrder)
  return max + 1
}

/** Place a saved drawing on a slide; it draws last (highest animOrder) by default. */
export function addDrawing(
  p: VideoProject,
  slideId: string,
  drawingId: string,
  name: string,
  x: number,
  y: number,
  w: number,
): { project: VideoProject; instanceId: string } {
  const base = newSlideDrawing(drawingId, name, x, y, w, 0)
  const project = mapSlide(p, slideId, (s) => ({
    ...s,
    drawings: [...(s.drawings ?? []), { ...base, animOrder: nextAnimOrder(s) }],
  }))
  return { project, instanceId: base.id }
}

/** Patch a placed drawing's frame into the given aspect key(s) (mirrors updateTextBoxFrame). */
export function updateDrawingFrame(
  p: VideoProject,
  slideId: string,
  instanceId: string,
  patch: Partial<NormRect>,
  writeAspects: Aspect[],
): VideoProject {
  return mapSlide(p, slideId, (s) => ({
    ...s,
    drawings: (s.drawings ?? []).map((d) => {
      if (d.id !== instanceId) return d
      const frame = { ...d.frame }
      for (const a of writeAspects) frame[a] = { ...frame[a], ...patch }
      return { ...d, frame }
    }),
  }))
}

/** Patch a placed drawing's non-frame fields (animOrder, delayBeforeMs, name). */
export function updateDrawing(
  p: VideoProject,
  slideId: string,
  instanceId: string,
  patch: Partial<SlideDrawing>,
): VideoProject {
  return mapSlide(p, slideId, (s) => ({
    ...s,
    drawings: (s.drawings ?? []).map((d) => (d.id === instanceId ? { ...d, ...patch } : d)),
  }))
}

export function removeDrawing(p: VideoProject, slideId: string, instanceId: string): VideoProject {
  return mapSlide(p, slideId, (s) =>
    reindexSlideOrder({ ...s, drawings: (s.drawings ?? []).filter((d) => d.id !== instanceId) }),
  )
}

/** Reorder the slide's combined animation sequence (boxes AND drawings) to match
 *  `orderedIds` (the new top-to-bottom order in the Elements list). */
export function reorderSlideItems(p: VideoProject, slideId: string, orderedIds: string[]): VideoProject {
  return mapSlide(p, slideId, (s) => {
    const pos = new Map(orderedIds.map((id, i) => [id, i]))
    const textBoxes = s.textBoxes.map((b) => ({ ...b, animOrder: pos.get(b.id) ?? b.animOrder }))
    return reindexSlideOrder({
      ...s,
      textBoxes,
      ...(s.drawings ? { drawings: s.drawings.map((d) => ({ ...d, animOrder: pos.get(d.id) ?? d.animOrder })) } : {}),
    })
  })
}

const cleanLock = (lock: Partial<BoxLockState>): Partial<BoxLockState> | undefined =>
  Object.keys(lock).length ? lock : undefined

/** Set a box's position link explicitly. Linking a diverged box CONVERGES it —
 *  the active aspect wins (copied onto the other), matching the eventual re-link
 *  modal's default direction; one undo step. */
export function setBoxPositionLink(
  p: VideoProject,
  slideId: string,
  boxId: string,
  linked: boolean,
  activeAspect: Aspect,
): VideoProject {
  return mapSlide(p, slideId, (s) => ({
    ...s,
    textBoxes: s.textBoxes.map((b) => {
      if (b.id !== boxId) return b
      const lock = { ...b.lock, position: linked }
      const frame = linked
        ? { ...b.frame, [otherAspect(activeAspect)]: { ...b.frame[activeAspect] } }
        : b.frame
      return { ...b, lock: cleanLock(lock), frame }
    }),
  }))
}

/** Set every box on a slide's position link: set `slide.lock.position`, clear each
 *  box's own position override (so they inherit uniformly), and on link converge
 *  every box (active aspect wins). */
function linkSlidePositions(s: Slide, linked: boolean, activeAspect: Aspect): Slide {
  return {
    ...s,
    lock: cleanLock({ ...s.lock, position: linked }),
    textBoxes: s.textBoxes.map((b) => {
      const lock = { ...b.lock }
      delete lock.position
      const frame = linked
        ? { ...b.frame, [otherAspect(activeAspect)]: { ...b.frame[activeAspect] } }
        : b.frame
      return { ...b, lock: cleanLock(lock), frame }
    }),
  }
}

/** Slide-level "link/unlink all positions". */
export function setSlidePositionLink(
  p: VideoProject,
  slideId: string,
  linked: boolean,
  activeAspect: Aspect,
): VideoProject {
  return mapSlide(p, slideId, (s) => linkSlidePositions(s, linked, activeAspect))
}

/** Project-level "link/unlink all positions" (every box on every slide). */
export function setProjectPositionLink(p: VideoProject, linked: boolean, activeAspect: Aspect): VideoProject {
  return { ...p, slides: p.slides.map((s) => linkSlidePositions(s, linked, activeAspect)) }
}

// --- format lock (per-aspect content) -------------------------------------

/** Converge a box's content onto the active aspect: the active cut's effective
 *  content becomes the shared base, and the per-aspect overrides are dropped. */
function convergeContent(box: TextBox, activeAspect: Aspect): TextBox {
  const base = contentOf(box, activeAspect)
  const { contentByAspect: _drop, ...rest } = box
  return { ...rest, runs: base.runs, align: base.align, lineHeightScale: base.lineHeightScale, brush: base.brush }
}

/** Set a box's format link explicitly. Linking CONVERGES it (active aspect wins). */
export function setBoxFormatLink(
  p: VideoProject,
  slideId: string,
  boxId: string,
  linked: boolean,
  activeAspect: Aspect,
): VideoProject {
  return mapSlide(p, slideId, (s) => ({
    ...s,
    textBoxes: s.textBoxes.map((b) => {
      if (b.id !== boxId) return b
      const lock = cleanLock({ ...b.lock, content: linked })
      return linked ? { ...convergeContent(b, activeAspect), lock } : { ...b, lock }
    }),
  }))
}

function linkSlideFormats(s: Slide, linked: boolean, activeAspect: Aspect): Slide {
  return {
    ...s,
    lock: cleanLock({ ...s.lock, content: linked }),
    textBoxes: s.textBoxes.map((b) => {
      const lock = { ...b.lock }
      delete lock.content
      const cleaned = cleanLock(lock)
      return linked ? { ...convergeContent(b, activeAspect), lock: cleaned } : { ...b, lock: cleaned }
    }),
  }
}

/** Slide-level "link/unlink all formats". */
export function setSlideFormatLink(p: VideoProject, slideId: string, linked: boolean, activeAspect: Aspect): VideoProject {
  return mapSlide(p, slideId, (s) => linkSlideFormats(s, linked, activeAspect))
}

/** Project-level "link/unlink all formats" (every box on every slide). */
export function setProjectFormatLink(p: VideoProject, linked: boolean, activeAspect: Aspect): VideoProject {
  return { ...p, slides: p.slides.map((s) => linkSlideFormats(s, linked, activeAspect)) }
}

/** Write content fields into a box, honouring the format lock. Linked → write the
 *  shared base and drop any per-aspect overrides (cuts stay identical). Unlinked →
 *  write only the active aspect's override (cuts diverge). */
function writeContent(box: TextBox, aspect: Aspect, linked: boolean, patch: Partial<BoxContent>): TextBox {
  if (linked) {
    const { contentByAspect: _drop, ...rest } = box
    return { ...rest, ...patch }
  }
  return {
    ...box,
    contentByAspect: { ...box.contentByAspect, [aspect]: { ...contentOf(box, aspect), ...patch } },
  }
}

/** Patch content (align / line-height / brush) into a box per the format lock. */
export function updateTextBoxContent(
  p: VideoProject,
  slideId: string,
  boxId: string,
  patch: Partial<BoxContent>,
  aspect: Aspect,
  linked: boolean,
): VideoProject {
  return mapSlide(p, slideId, (s) => ({
    ...s,
    textBoxes: s.textBoxes.map((b) => (b.id === boxId ? writeContent(b, aspect, linked, patch) : b)),
  }))
}

export function updateTextBoxRuns(
  p: VideoProject,
  slideId: string,
  boxId: string,
  runs: TextRun[],
  aspect: Aspect,
  linked: boolean,
): VideoProject {
  return updateTextBoxContent(p, slideId, boxId, { runs }, aspect, linked)
}

/** Apply a style patch to the ACTIVE aspect's runs over [start, end) (flattened-
 *  text offsets), honouring the format lock. Only fields present in `patch` are
 *  written, so untouched (incl. mixed) fields on each run are preserved. */
export function applyTextStyle(
  p: VideoProject,
  slideId: string,
  boxId: string,
  start: number,
  end: number,
  patch: StylePatch,
  aspect: Aspect,
  linked: boolean,
): VideoProject {
  return mapSlide(p, slideId, (s) => ({
    ...s,
    textBoxes: s.textBoxes.map((b) => {
      if (b.id !== boxId) return b
      const runs = applyStyleToRange(contentOf(b, aspect).runs, start, end, patch)
      return writeContent(b, aspect, linked, { runs })
    }),
  }))
}

export function reorderTextBoxes(p: VideoProject, slideId: string, orderedIds: string[]): VideoProject {
  return mapSlide(p, slideId, (s) => {
    // Reorder boxes WITHIN the animOrder slots boxes currently occupy, leaving any
    // interleaved drawings in their own slots, then reindex the whole sequence.
    const posOf = new Map(orderedIds.map((id, i) => [id, i]))
    const slots = s.textBoxes.map((b) => b.animOrder).sort((a, b) => a - b)
    const ordered = [...s.textBoxes].sort((a, b) => (posOf.get(a.id) ?? 0) - (posOf.get(b.id) ?? 0))
    const newOrder = new Map(ordered.map((b, i) => [b.id, slots[i] ?? b.animOrder]))
    const boxes = s.textBoxes.map((b) => ({ ...b, animOrder: newOrder.get(b.id) ?? b.animOrder }))
    return reindexSlideOrder({ ...s, textBoxes: boxes })
  })
}

export function deleteTextBox(p: VideoProject, slideId: string, boxId: string): VideoProject {
  return mapSlide(p, slideId, (s) => reindexSlideOrder({ ...s, textBoxes: s.textBoxes.filter((b) => b.id !== boxId) }))
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Deep-clone a textbox (for the copy/cut clipboard — independent of later edits). */
export function cloneTextBox(box: TextBox): TextBox {
  return {
    ...box,
    frame: { '16:9': { ...box.frame['16:9'] }, '9:16': { ...box.frame['9:16'] } },
    runs: box.runs.map((r) => ({ ...r })),
    brush: box.brush ? { ...box.brush } : undefined,
  }
}

/** Paste a (clipboard) box onto a slide as a new box: fresh id, nudged position,
 *  appended animation order. Returns the new box id (for selection). */
export function pasteTextBox(
  p: VideoProject,
  slideId: string,
  box: TextBox,
): { project: VideoProject; boxId: string } {
  const id = makeId()
  const project = mapSlide(p, slideId, (s) => {
    const nudge = (r: NormRect): NormRect => ({ ...r, x: clamp01(r.x + 0.03), y: clamp01(r.y + 0.03) })
    const clone: TextBox = {
      ...cloneTextBox(box),
      id,
      frame: { '16:9': nudge(box.frame['16:9']), '9:16': nudge(box.frame['9:16']) },
      animOrder: nextAnimOrder(s),
    }
    return { ...s, textBoxes: [...s.textBoxes, clone] }
  })
  return { project, boxId: id }
}

// --- project-level --------------------------------------------------------

export function setBaseEmFraction(p: VideoProject, baseEmFraction: number): VideoProject {
  return { ...p, baseEmFraction }
}
export function setPlaybackRate(p: VideoProject, playbackRate: number): VideoProject {
  return { ...p, playbackRate }
}

/** Set the project's default font (the font an unset `run.fontId` resolves to). */
export function setProjectFont(p: VideoProject, fontId: string): VideoProject {
  return { ...p, fontId }
}

// --- named styles ---------------------------------------------------------

const styles = (p: VideoProject): NamedStyle[] => p.namedStyles ?? []

export function addNamedStyle(p: VideoProject, name: string, style: StylePatch): { project: VideoProject; id: string } {
  const id = makeId()
  return { project: { ...p, namedStyles: [...styles(p), { id, name, style }] }, id }
}

export function updateNamedStyle(p: VideoProject, id: string, patch: Partial<NamedStyle>): VideoProject {
  return { ...p, namedStyles: styles(p).map((s) => (s.id === id ? { ...s, ...patch } : s)) }
}

export function removeNamedStyle(p: VideoProject, id: string): VideoProject {
  return { ...p, namedStyles: styles(p).filter((s) => s.id !== id) }
}

/** Apply a saved style's patch to [start,end) of a textbox (honours the format lock). */
export function applyNamedStyle(
  p: VideoProject,
  slideId: string,
  boxId: string,
  start: number,
  end: number,
  styleId: string,
  aspect: Aspect,
  linked: boolean,
): VideoProject {
  const ns = styles(p).find((s) => s.id === styleId)
  if (!ns) return p
  return applyTextStyle(p, slideId, boxId, start, end, ns.style, aspect, linked)
}

/** Patch the new-textbox format defaults (the format bar with nothing selected). */
export function setDefaults(p: VideoProject, patch: Partial<ProjectDefaults>): VideoProject {
  return { ...p, defaults: { ...p.defaults, ...patch } }
}

// --- voiceover ------------------------------------------------------------

const cues = (p: VideoProject): VoiceoverCue[] => p.voiceover ?? []

export function setVoiceover(p: VideoProject, voiceover: VoiceoverCue[]): VideoProject {
  return { ...p, voiceover }
}

export function addCue(p: VideoProject, startMs: number, text = 'Voiceover…'): { project: VideoProject; cueId: string } {
  const id = makeId()
  const cue: VoiceoverCue = { id, startMs: Math.max(0, Math.round(startMs)), endMs: 0, text }
  cue.endMs = cue.startMs + estimateDurationMs(text)
  return { project: { ...p, voiceover: [...cues(p), cue] }, cueId: id }
}

export function updateCue(p: VideoProject, id: string, patch: Partial<VoiceoverCue>): VideoProject {
  return { ...p, voiceover: cues(p).map((c) => (c.id === id ? { ...c, ...patch } : c)) }
}

export function removeCue(p: VideoProject, id: string): VideoProject {
  return { ...p, voiceover: cues(p).filter((c) => c.id !== id) }
}

export function setCueAudio(p: VideoProject, id: string, audio: VoiceoverAudio | undefined): VideoProject {
  return { ...p, voiceover: cues(p).map((c) => (c.id === id ? { ...c, audio } : c)) }
}
export function setBrush(p: VideoProject, brush: BrushSettings): VideoProject {
  return { ...p, brush }
}

export function setTts(p: VideoProject, patch: Partial<TtsSettings>): VideoProject {
  const cur = { ...DEFAULT_TTS, ...(p.tts ?? {}) }
  return {
    ...p,
    tts: {
      ...cur,
      ...patch,
      // deep-merge nested settings so a single-slider patch keeps the rest
      settings: { ...DEFAULT_TTS_VOICE_SETTINGS, ...(cur.settings ?? {}), ...(patch.settings ?? {}) },
    },
  }
}

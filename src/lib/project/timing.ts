import type { TextBoxLayout } from './layout'
import type { FlatProject, FlatSlide } from './aspect'

/**
 * Pure timing model. Turns laid-out slides into absolute time windows so the
 * renderer can sample any instant. No React/DOM — shared by the live preview and
 * a future headless exporter.
 */

export interface BoxTiming {
  boxId: string
  /** when this box's ENVELOPE begins, within the slide's local timeline (ms). */
  startMs: number
  /** when this box's envelope ends — the next element starts here (ms). */
  endMs: number
  /** when the writing itself begins (envelope start + padding-before). */
  animStartMs: number
  /** when the writing finishes (before any trailing padding). */
  animEndMs: number
}

/** Slide-local timing for a placed drawing (parallel to BoxTiming). */
export interface DrawingTiming {
  /** the SlideDrawing instance id. */
  id: string
  startMs: number
  endMs: number
  animStartMs: number
  animEndMs: number
}

/** Slide-local timing for a direct drawing (ink); same shape as DrawingTiming. */
export type InkTiming = DrawingTiming

export interface SlideTiming {
  /** boxes in animation order, with absolute (slide-local) start/end. */
  boxes: BoxTiming[]
  /** placed drawings, with absolute (slide-local) start/end (interleaved with boxes by animOrder). */
  drawings: DrawingTiming[]
  /** direct drawings (inks), interleaved with boxes + drawings by animOrder. */
  inks: InkTiming[]
  /** when the last box/drawing finishes (ms). */
  contentEndMs: number
  /** when the slide's hold ends and its closing transition begins (ms). */
  holdEndMs: number
  /** duration of the closing transition (0 for `none`). */
  transitionMs: number
  /** full slide duration including hold + closing transition (ms). */
  totalMs: number
}

/** An element's time slot at ×1 rate: the envelope (its footprint on the
 *  timeline), the animation block's offset within it, and the block's length. */
export interface ElementSlot {
  /** the envelope's length (ms at ×1). */
  envMs: number
  /** where the animation block begins inside the envelope (padding-before). */
  animOffMs: number
  /** the animation block's length (compressed to fit if it overflows). */
  animMs: number
}

/**
 * The container-bar model. An element's `speed` sets its animation block
 * (`contentMs / speed`); `offsetMs` (the schema's `delayBeforeMs`) is the
 * padding before the block inside its envelope; `envelopeMs`, when set, pins the
 * envelope's length — the block slides within it and padding-after is whatever
 * remains. Unset envelope = tight/auto (offset + block, grows with content).
 * **The envelope is master**: an overflowing block first clamps its offset into
 * the envelope, then compresses to fit the remaining span — so content edits
 * never move the rest of the timeline. Shared by timing, render and the UI.
 */
export function elementSlot(contentMs: number, speed?: number, envelopeMs?: number, offsetMs = 0): ElementSlot {
  const natural = contentMs / (speed && speed > 0 ? speed : 1)
  const off = Math.max(0, offsetMs)
  if (envelopeMs == null || envelopeMs <= 0) return { envMs: off + natural, animOffMs: off, animMs: natural }
  const envMs = envelopeMs
  const animOffMs = Math.min(off, envMs)
  const animMs = Math.min(natural, envMs - animOffMs)
  return { envMs, animOffMs, animMs }
}

/**
 * Sequence a slide's boxes + drawings by their shared `animOrder` into a
 * real-time timeline of ENVELOPES: each element occupies its slot (see
 * `elementSlot`), the next element starts when the previous envelope ends, and
 * the writing runs inside the slot at `[animStartMs, animEndMs]`. The global
 * `speed` (playbackRate) scales WHOLE envelopes — padding and animation alike;
 * the hold-before-transition and the transition duration remain invariant.
 */
export function computeSlideTiming(
  slide: FlatSlide,
  layouts: Map<string, TextBoxLayout>,
  drawingDurations: Map<string, number> = new Map(),
  speed = 1,
  inkDurations: Map<string, number> = new Map(),
): SlideTiming {
  const rate = speed > 0 ? speed : 1
  type Item = { kind: 'box' | 'drawing' | 'ink'; id: string; animOrder: number; slot: ElementSlot }
  const items: Item[] = [
    ...slide.textBoxes.map((b) => ({
      kind: 'box' as const,
      id: b.id,
      animOrder: b.animOrder,
      slot: elementSlot(layouts.get(b.id)?.contentMs ?? 0, b.speed, b.envelopeMs, b.delayBeforeMs),
    })),
    ...(slide.drawings ?? []).map((d) => ({
      kind: 'drawing' as const,
      id: d.id,
      animOrder: d.animOrder,
      slot: elementSlot(drawingDurations.get(d.id) ?? 0, d.speed, d.envelopeMs, d.delayBeforeMs),
    })),
    ...(slide.inks ?? []).map((k) => ({
      kind: 'ink' as const,
      id: k.id,
      animOrder: k.animOrder,
      slot: elementSlot(inkDurations.get(k.id) ?? 0, k.speed, k.envelopeMs, k.delayBeforeMs),
    })),
  ].sort((a, b) => a.animOrder - b.animOrder)

  let cursor = 0
  const boxes: BoxTiming[] = []
  const drawings: DrawingTiming[] = []
  const inks: InkTiming[] = []
  for (const it of items) {
    const startMs = cursor
    const endMs = startMs + it.slot.envMs / rate
    const animStartMs = startMs + it.slot.animOffMs / rate
    const animEndMs = animStartMs + it.slot.animMs / rate
    if (it.kind === 'box') boxes.push({ boxId: it.id, startMs, endMs, animStartMs, animEndMs })
    else if (it.kind === 'drawing') drawings.push({ id: it.id, startMs, endMs, animStartMs, animEndMs })
    else inks.push({ id: it.id, startMs, endMs, animStartMs, animEndMs })
    cursor = endMs
  }
  const contentEndMs = cursor
  const holdEndMs = contentEndMs + slide.holdBeforeTransitionMs // hold invariant
  const transitionMs = slide.transition.kind === 'none' ? 0 : slide.transition.durationMs // invariant
  return { boxes, drawings, inks, contentEndMs, holdEndMs, transitionMs, totalMs: holdEndMs + transitionMs }
}

export interface ProjectSlideTiming {
  slideId: string
  /** when this slide begins, in project time (ms). */
  startMs: number
  timing: SlideTiming
}

export interface ProjectTiming {
  slides: ProjectSlideTiming[]
  totalMs: number
}

/**
 * Sequence slides so slide N+1 starts at slide N's `holdEndMs` — i.e. N's closing
 * transition overlaps the start of N+1 (the two are visible together during it).
 */
export function computeProjectTiming(
  project: FlatProject,
  layoutsBySlide: Map<string, Map<string, TextBoxLayout>>,
  drawingDurationsBySlide: Map<string, Map<string, number>> = new Map(),
  speed = 1,
  inkDurationsBySlide: Map<string, Map<string, number>> = new Map(),
): ProjectTiming {
  let cursor = 0
  const slides: ProjectSlideTiming[] = []
  for (const slide of project.slides) {
    const timing = computeSlideTiming(
      slide,
      layoutsBySlide.get(slide.id) ?? new Map(),
      drawingDurationsBySlide.get(slide.id) ?? new Map(),
      speed,
      inkDurationsBySlide.get(slide.id) ?? new Map(),
    )
    slides.push({ slideId: slide.id, startMs: cursor, timing })
    cursor += timing.holdEndMs // next slide starts as this one's transition begins
  }
  const last = slides[slides.length - 1]
  const totalMs = last ? last.startMs + last.timing.totalMs : 0
  return { slides, totalMs }
}

export interface SlideWindow {
  slideId: string
  startMs: number
  /** end of this slide's range — the next slide's start (its transition overlaps), or project end for the last. */
  endMs: number
}

/**
 * Each slide's [start, end) range in project time. A slide owns the interval up
 * to where the next slide begins (its own closing transition overlaps the next);
 * the last slide runs to the project end.
 */
export function slideTimeWindows(timing: ProjectTiming): SlideWindow[] {
  return timing.slides.map((s, i) => ({
    slideId: s.slideId,
    startMs: s.startMs,
    endMs: i + 1 < timing.slides.length ? timing.slides[i + 1].startMs : timing.totalMs,
  }))
}

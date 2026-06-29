import type { TextBoxLayout } from './layout'
import type { FlatProject, FlatSlide } from './aspect'

/**
 * Pure timing model. Turns laid-out slides into absolute time windows so the
 * renderer can sample any instant. No React/DOM — shared by the live preview and
 * a future headless exporter.
 */

export interface BoxTiming {
  boxId: string
  /** when this box begins drawing, within the slide's local timeline (ms). */
  startMs: number
  /** when this box has finished drawing (ms). */
  endMs: number
}

/** Slide-local timing for a placed drawing (parallel to BoxTiming). */
export interface DrawingTiming {
  /** the SlideDrawing instance id. */
  id: string
  startMs: number
  endMs: number
}

export interface SlideTiming {
  /** boxes in animation order, with absolute (slide-local) start/end. */
  boxes: BoxTiming[]
  /** placed drawings, with absolute (slide-local) start/end (interleaved with boxes by animOrder). */
  drawings: DrawingTiming[]
  /** when the last box/drawing finishes (ms). */
  contentEndMs: number
  /** when the slide's hold ends and its closing transition begins (ms). */
  holdEndMs: number
  /** duration of the closing transition (0 for `none`). */
  transitionMs: number
  /** full slide duration including hold + closing transition (ms). */
  totalMs: number
}

/**
 * Sequence a slide's boxes by `animOrder` into a real-time timeline. `speed`
 * scales ONLY the writing animation (a box's `contentMs`, i.e. glyph reveal +
 * inter-char cadence + underline). Everything else is **invariant**: per-box
 * `delayBeforeMs` (textbox-order delays), the hold-before-transition, and the
 * transition duration. So each box's writing occupies `contentMs / speed` of real
 * time; the transition begins after the last box finishes writing + the hold.
 */
export function computeSlideTiming(
  slide: FlatSlide,
  layouts: Map<string, TextBoxLayout>,
  drawingDurations: Map<string, number> = new Map(),
  speed = 1,
): SlideTiming {
  const rate = speed > 0 ? speed : 1
  // One animation sequence over boxes AND drawings, ordered by the shared
  // animOrder. A drawing's "writing" (its pen reveal) scales by speed exactly
  // like a textbox's; its delay (like a box's) is invariant.
  type Item = { kind: 'box' | 'drawing'; id: string; animOrder: number; delayBeforeMs: number; contentMs: number }
  const items: Item[] = [
    ...slide.textBoxes.map((b) => ({
      kind: 'box' as const,
      id: b.id,
      animOrder: b.animOrder,
      delayBeforeMs: b.delayBeforeMs,
      contentMs: layouts.get(b.id)?.contentMs ?? 0,
    })),
    ...(slide.drawings ?? []).map((d) => ({
      kind: 'drawing' as const,
      id: d.id,
      animOrder: d.animOrder,
      delayBeforeMs: d.delayBeforeMs,
      // per-drawing speed shrinks its content window (the global rate scales it again below)
      contentMs: (drawingDurations.get(d.id) ?? 0) / (d.speed && d.speed > 0 ? d.speed : 1),
    })),
  ].sort((a, b) => a.animOrder - b.animOrder)

  let cursor = 0
  const boxes: BoxTiming[] = []
  const drawings: DrawingTiming[] = []
  for (const it of items) {
    const writingMs = it.contentMs / rate // only the writing scales
    const startMs = cursor + it.delayBeforeMs // delay invariant
    const endMs = startMs + writingMs
    if (it.kind === 'box') boxes.push({ boxId: it.id, startMs, endMs })
    else drawings.push({ id: it.id, startMs, endMs })
    cursor = endMs
  }
  const contentEndMs = cursor
  const holdEndMs = contentEndMs + slide.holdBeforeTransitionMs // hold invariant
  const transitionMs = slide.transition.kind === 'none' ? 0 : slide.transition.durationMs // invariant
  return { boxes, drawings, contentEndMs, holdEndMs, transitionMs, totalMs: holdEndMs + transitionMs }
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
): ProjectTiming {
  let cursor = 0
  const slides: ProjectSlideTiming[] = []
  for (const slide of project.slides) {
    const timing = computeSlideTiming(
      slide,
      layoutsBySlide.get(slide.id) ?? new Map(),
      drawingDurationsBySlide.get(slide.id) ?? new Map(),
      speed,
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

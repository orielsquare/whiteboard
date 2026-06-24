import type { TextBoxLayout } from './layout'
import type { Slide, VideoProject } from './schema'

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

export interface SlideTiming {
  /** boxes in animation order, with absolute (slide-local) start/end. */
  boxes: BoxTiming[]
  /** when the last box finishes (ms). */
  contentEndMs: number
  /** when the slide's hold ends and its closing transition begins (ms). */
  holdEndMs: number
  /** duration of the closing transition (0 for `none`). */
  transitionMs: number
  /** full slide duration including hold + closing transition (ms). */
  totalMs: number
}

/** Sequence a slide's boxes by `animOrder`, accumulating delays + content time. */
export function computeSlideTiming(slide: Slide, layouts: Map<string, TextBoxLayout>): SlideTiming {
  const ordered = [...slide.textBoxes].sort((a, b) => a.animOrder - b.animOrder)
  let cursor = 0
  const boxes: BoxTiming[] = []
  for (const box of ordered) {
    const contentMs = layouts.get(box.id)?.contentMs ?? 0
    const startMs = cursor + box.delayBeforeMs
    const endMs = startMs + contentMs
    boxes.push({ boxId: box.id, startMs, endMs })
    cursor = endMs
  }
  const contentEndMs = cursor
  const holdEndMs = contentEndMs + slide.holdBeforeTransitionMs
  const transitionMs = slide.transition.kind === 'none' ? 0 : slide.transition.durationMs
  return { boxes, contentEndMs, holdEndMs, transitionMs, totalMs: holdEndMs + transitionMs }
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
  project: VideoProject,
  layoutsBySlide: Map<string, Map<string, TextBoxLayout>>,
): ProjectTiming {
  let cursor = 0
  const slides: ProjectSlideTiming[] = []
  for (const slide of project.slides) {
    const timing = computeSlideTiming(slide, layoutsBySlide.get(slide.id) ?? new Map())
    slides.push({ slideId: slide.id, startMs: cursor, timing })
    cursor += timing.holdEndMs // next slide starts as this one's transition begins
  }
  const last = slides[slides.length - 1]
  const totalMs = last ? last.startMs + last.timing.totalMs : 0
  return { slides, totalMs }
}

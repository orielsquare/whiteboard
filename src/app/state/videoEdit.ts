import {
  makeId,
  newSlide,
  newTextBox,
  type Aspect,
  type NormRect,
  type Slide,
  type TextBox,
  type TextRun,
  type VideoProject,
} from '@lib/project/schema'
import type { BrushSettings } from '@lib/manifest/schema'

function mapSlide(p: VideoProject, slideId: string, fn: (s: Slide) => Slide): VideoProject {
  return { ...p, slides: p.slides.map((s) => (s.id === slideId ? fn(s) : s)) }
}

/** Re-assign contiguous animOrder 0..n-1, preserving relative order. */
function reindexOrder(boxes: TextBox[]): TextBox[] {
  const sorted = [...boxes].sort((a, b) => a.animOrder - b.animOrder)
  const idx = new Map(sorted.map((b, i) => [b.id, i]))
  return boxes.map((b) => ({ ...b, animOrder: idx.get(b.id) ?? b.animOrder }))
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
      frame: { ...b.frame },
      runs: b.runs.map((r) => ({ ...r })),
    })),
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
    const box = { ...newTextBox(p.defaults, x, y, s.textBoxes.length), id }
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

export function updateTextBoxFrame(
  p: VideoProject,
  slideId: string,
  boxId: string,
  patch: Partial<NormRect>,
): VideoProject {
  return mapSlide(p, slideId, (s) => ({
    ...s,
    textBoxes: s.textBoxes.map((b) => (b.id === boxId ? { ...b, frame: { ...b.frame, ...patch } } : b)),
  }))
}

export function updateTextBoxRuns(
  p: VideoProject,
  slideId: string,
  boxId: string,
  runs: TextRun[],
): VideoProject {
  return updateTextBox(p, slideId, boxId, { runs })
}

export function reorderTextBoxes(p: VideoProject, slideId: string, orderedIds: string[]): VideoProject {
  return mapSlide(p, slideId, (s) => {
    const pos = new Map(orderedIds.map((id, i) => [id, i]))
    const boxes = s.textBoxes.map((b) => ({ ...b, animOrder: pos.get(b.id) ?? b.animOrder }))
    return { ...s, textBoxes: reindexOrder(boxes) }
  })
}

export function deleteTextBox(p: VideoProject, slideId: string, boxId: string): VideoProject {
  return mapSlide(p, slideId, (s) => ({
    ...s,
    textBoxes: reindexOrder(s.textBoxes.filter((b) => b.id !== boxId)),
  }))
}

// --- project-level --------------------------------------------------------

export function setAspect(p: VideoProject, aspect: Aspect): VideoProject {
  return { ...p, aspect }
}
export function setBaseEmFraction(p: VideoProject, baseEmFraction: number): VideoProject {
  return { ...p, baseEmFraction }
}
export function setPlaybackRate(p: VideoProject, playbackRate: number): VideoProject {
  return { ...p, playbackRate }
}
export function setBrush(p: VideoProject, brush: BrushSettings): VideoProject {
  return { ...p, brush }
}

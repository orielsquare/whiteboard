import {
  makeId,
  newSlide,
  newTextBox,
  type Aspect,
  type NamedStyle,
  type NormRect,
  type ProjectDefaults,
  type Slide,
  type TextBox,
  type TextRun,
  type TtsSettings,
  type VideoProject,
  type VoiceoverAudio,
  type VoiceoverCue,
} from '@lib/project/schema'
import { DEFAULT_TTS, DEFAULT_TTS_VOICE_SETTINGS } from '@lib/project/schema'
import type { BrushSettings } from '@lib/manifest/schema'
import { applyStyleToRange, type StylePatch } from '@lib/project/runs'
import { estimateDurationMs } from '@lib/project/vtt'

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

/** Apply a style patch to a textbox's runs over [start, end) (flattened-text
 *  offsets). The format bar's per-run controls route through here. Only the
 *  fields present in `patch` are written, so untouched (incl. mixed) fields on
 *  each run are preserved. */
export function applyTextStyle(
  p: VideoProject,
  slideId: string,
  boxId: string,
  start: number,
  end: number,
  patch: StylePatch,
): VideoProject {
  return mapSlide(p, slideId, (s) => ({
    ...s,
    textBoxes: s.textBoxes.map((b) =>
      b.id === boxId ? { ...b, runs: applyStyleToRange(b.runs, start, end, patch) } : b,
    ),
  }))
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

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Deep-clone a textbox (for the copy/cut clipboard — independent of later edits). */
export function cloneTextBox(box: TextBox): TextBox {
  return {
    ...box,
    frame: { ...box.frame },
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
    const clone: TextBox = {
      ...cloneTextBox(box),
      id,
      frame: { ...box.frame, x: clamp01(box.frame.x + 0.03), y: clamp01(box.frame.y + 0.03) },
      animOrder: s.textBoxes.length,
    }
    return { ...s, textBoxes: [...s.textBoxes, clone] }
  })
  return { project, boxId: id }
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

/** Apply a saved style's patch to [start,end) of a textbox. */
export function applyNamedStyle(
  p: VideoProject,
  slideId: string,
  boxId: string,
  start: number,
  end: number,
  styleId: string,
): VideoProject {
  const ns = styles(p).find((s) => s.id === styleId)
  if (!ns) return p
  return applyTextStyle(p, slideId, boxId, start, end, ns.style)
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

import { create } from 'zustand'
import { temporal } from 'zundo'
import type { LoadedFont } from '@lib/font/load'
import { projectStore } from '@lib/persistence/ProjectStore'
import { httpStore } from '@lib/persistence/FontStore'
import { ensureGlyphDerived } from './store'
import type { ExtractionParams, GlyphExtractor } from '@lib/extraction'
import {
  newVideoProject,
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
import { migrateProject, toStoredY } from '@lib/project/aspect'
import type { BrushSettings } from '@lib/manifest/schema'
import type { StylePatch } from '@lib/project/runs'
import * as E from './videoEdit'

/** A sub-range selection inside a textbox's flattened text (offsets). Transient
 *  UI state — never persisted/undoable. `anchor === focus` is a bare caret. */
export interface TextSelection {
  boxId: string
  anchor: number
  focus: number
}

const nowIso = () => new Date().toISOString()
type SlideView = 'layout' | 'order' | 'play' | 'timeline' | 'vtt'

interface VideoState {
  project: VideoProject | null
  loaded: boolean
  // transient UI state — NOT undoable, NOT persisted (see partialize)
  /** the aspect ratio currently being edited/previewed (16:9 or 9:16). */
  activeAspect: Aspect
  selectedSlideId: string | null
  selectedTextBoxId: string | null
  /** active sub-range selection inside the selected textbox (for the format bar). */
  selection: TextSelection | null
  /** copy/cut buffer for a textbox (transient — survives slide switches). */
  clipboardBox: TextBox | null
  slideView: SlideView
  /** slides ticked for scoped ("Selected") play; project order applied at play time. */
  playSelectedIds: string[]

  selectSlide: (id: string | null) => void
  selectTextBox: (id: string | null) => void
  setSelection: (sel: TextSelection | null) => void
  setSlideView: (v: SlideView) => void
  togglePlaySelected: (id: string) => void
  setPlaySelected: (ids: string[]) => void

  addSlide: () => void
  copySlide: (id: string) => void
  deleteSlide: (id: string) => void
  reorderSlides: (orderedIds: string[]) => void
  updateSlide: (id: string, patch: Partial<Slide>) => void
  setSlideTransition: (id: string, patch: Partial<Slide['transition']>) => void

  addTextBox: (slideId: string, x: number, y: number) => string
  updateTextBox: (slideId: string, boxId: string, patch: Partial<TextBox>) => void
  updateTextBoxFrame: (slideId: string, boxId: string, patch: Partial<NormRect>) => void
  updateTextBoxRuns: (slideId: string, boxId: string, runs: TextRun[]) => void
  /** apply a run-style patch to [start,end) of a textbox (format bar). */
  applyTextStyle: (slideId: string, boxId: string, start: number, end: number, patch: StylePatch) => void
  reorderTextBoxes: (slideId: string, orderedIds: string[]) => void
  deleteTextBox: (slideId: string, boxId: string) => void
  // textbox clipboard (Cmd/Ctrl C / X / V); works across slides
  copyTextBox: (slideId: string, boxId: string) => void
  cutTextBox: (slideId: string, boxId: string) => void
  pasteTextBox: (slideId: string) => void

  setActiveAspect: (a: Aspect) => void
  setBaseEmFraction: (v: number) => void
  setPlaybackRate: (v: number) => void
  setBrush: (b: BrushSettings) => void
  /** patch the new-textbox format defaults (format bar with nothing selected). */
  setDefaults: (patch: Partial<ProjectDefaults>) => void
  /** set the project default font (the fallback for runs with no fontId). */
  setProjectFont: (fontId: string) => void

  // named styles (per-project reusable text styles)
  addNamedStyle: (name: string, style: StylePatch) => string
  updateNamedStyle: (id: string, patch: Partial<NamedStyle>) => void
  removeNamedStyle: (id: string) => void
  applyNamedStyle: (slideId: string, boxId: string, start: number, end: number, styleId: string) => void

  setTts: (patch: Partial<TtsSettings>) => void

  setVoiceover: (cues: VoiceoverCue[]) => void
  addCue: (startMs: number, text?: string) => string
  updateCue: (id: string, patch: Partial<VoiceoverCue>) => void
  removeCue: (id: string) => void
  setCueAudio: (id: string, audio: VoiceoverAudio | undefined) => void

  newProject: (fontId: string, brush: BrushSettings) => void
  loadProject: (id: string) => Promise<void>
  saveProject: (font: LoadedFont) => Promise<void>
}

export const useVideoStore = create<VideoState>()(
  temporal(
    (set, get) => ({
      project: null,
      loaded: false,
      activeAspect: '16:9',
      selectedSlideId: null,
      selectedTextBoxId: null,
      selection: null,
      clipboardBox: null,
      slideView: 'layout',
      playSelectedIds: [],

      selectSlide: (id) => set({ selectedSlideId: id, selectedTextBoxId: null, selection: null }),
      selectTextBox: (id) =>
        set((s) => ({
          selectedTextBoxId: id,
          // keep a same-box selection alive; drop it when the box changes
          selection: s.selection && s.selection.boxId === id ? s.selection : null,
        })),
      setSelection: (sel) => set({ selection: sel }),
      setSlideView: (v) => set({ slideView: v }),
      togglePlaySelected: (id) =>
        set((s) => ({
          playSelectedIds: s.playSelectedIds.includes(id)
            ? s.playSelectedIds.filter((x) => x !== id)
            : [...s.playSelectedIds, id],
        })),
      setPlaySelected: (ids) => set({ playSelectedIds: ids }),

      addSlide: () =>
        set((s) => {
          if (!s.project) return s
          const { project, slideId } = E.addSlide(s.project)
          return { project, selectedSlideId: slideId, selectedTextBoxId: null }
        }),
      copySlide: (id) =>
        set((s) => {
          if (!s.project) return s
          const { project, slideId } = E.copySlide(s.project, id)
          return { project, selectedSlideId: slideId, selectedTextBoxId: null }
        }),
      deleteSlide: (id) =>
        set((s) => {
          if (!s.project) return s
          const i = s.project.slides.findIndex((sl) => sl.id === id)
          const project = E.deleteSlide(s.project, id)
          let sel = s.selectedSlideId
          if (sel === id) {
            const next = project.slides[Math.min(i, project.slides.length - 1)]
            sel = next ? next.id : null
          }
          return {
            project,
            selectedSlideId: sel,
            selectedTextBoxId: null,
            playSelectedIds: s.playSelectedIds.filter((x) => x !== id),
          }
        }),
      reorderSlides: (orderedIds) =>
        set((s) => (s.project ? { project: E.reorderSlides(s.project, orderedIds) } : s)),
      updateSlide: (id, patch) =>
        set((s) => (s.project ? { project: E.updateSlide(s.project, id, patch) } : s)),
      setSlideTransition: (id, patch) =>
        set((s) => (s.project ? { project: E.setSlideTransition(s.project, id, patch) } : s)),

      addTextBox: (slideId, x, y) => {
        const s = get()
        if (!s.project) return ''
        // x is a fraction of width; the editor passes y in width-units → store as a fraction of height.
        const { project, boxId } = E.addTextBox(s.project, slideId, x, toStoredY(y, s.activeAspect))
        set({ project, selectedTextBoxId: boxId })
        return boxId
      },
      updateTextBox: (slideId, boxId, patch) =>
        set((s) => (s.project ? { project: E.updateTextBox(s.project, slideId, boxId, patch) } : s)),
      updateTextBoxFrame: (slideId, boxId, patch) =>
        set((s) => {
          if (!s.project) return s
          // The editor works in width-units for y; store it as a fraction of height.
          const p2 = patch.y != null ? { ...patch, y: toStoredY(patch.y, s.activeAspect) } : patch
          return { project: E.updateTextBoxFrame(s.project, slideId, boxId, p2) }
        }),
      updateTextBoxRuns: (slideId, boxId, runs) =>
        set((s) => (s.project ? { project: E.updateTextBoxRuns(s.project, slideId, boxId, runs) } : s)),
      applyTextStyle: (slideId, boxId, start, end, patch) =>
        set((s) => (s.project ? { project: E.applyTextStyle(s.project, slideId, boxId, start, end, patch) } : s)),
      reorderTextBoxes: (slideId, orderedIds) =>
        set((s) => (s.project ? { project: E.reorderTextBoxes(s.project, slideId, orderedIds) } : s)),
      deleteTextBox: (slideId, boxId) =>
        set((s) =>
          s.project
            ? {
                project: E.deleteTextBox(s.project, slideId, boxId),
                selectedTextBoxId: s.selectedTextBoxId === boxId ? null : s.selectedTextBoxId,
                selection: s.selection?.boxId === boxId ? null : s.selection,
              }
            : s,
        ),

      copyTextBox: (slideId, boxId) => {
        const box = get()
          .project?.slides.find((sl) => sl.id === slideId)
          ?.textBoxes.find((b) => b.id === boxId)
        if (box) set({ clipboardBox: E.cloneTextBox(box) })
      },
      cutTextBox: (slideId, boxId) =>
        set((s) => {
          const box = s.project?.slides.find((sl) => sl.id === slideId)?.textBoxes.find((b) => b.id === boxId)
          if (!s.project || !box) return s
          return {
            clipboardBox: E.cloneTextBox(box),
            project: E.deleteTextBox(s.project, slideId, boxId),
            selectedTextBoxId: s.selectedTextBoxId === boxId ? null : s.selectedTextBoxId,
            selection: s.selection?.boxId === boxId ? null : s.selection,
          }
        }),
      pasteTextBox: (slideId) =>
        set((s) => {
          if (!s.project || !s.clipboardBox) return s
          const { project, boxId } = E.pasteTextBox(s.project, slideId, s.clipboardBox)
          return { project, selectedTextBoxId: boxId, selection: null }
        }),

      setActiveAspect: (a) => set({ activeAspect: a }),
      setBaseEmFraction: (v) =>
        set((s) => (s.project ? { project: E.setBaseEmFraction(s.project, v) } : s)),
      setPlaybackRate: (v) =>
        set((s) => (s.project ? { project: E.setPlaybackRate(s.project, v) } : s)),
      setBrush: (b) => set((s) => (s.project ? { project: E.setBrush(s.project, b) } : s)),
      setDefaults: (patch) => set((s) => (s.project ? { project: E.setDefaults(s.project, patch) } : s)),
      setProjectFont: (fontId) => set((s) => (s.project ? { project: E.setProjectFont(s.project, fontId) } : s)),

      addNamedStyle: (name, style) => {
        const s = get()
        if (!s.project) return ''
        const { project, id } = E.addNamedStyle(s.project, name, style)
        set({ project })
        return id
      },
      updateNamedStyle: (id, patch) => set((s) => (s.project ? { project: E.updateNamedStyle(s.project, id, patch) } : s)),
      removeNamedStyle: (id) => set((s) => (s.project ? { project: E.removeNamedStyle(s.project, id) } : s)),
      applyNamedStyle: (slideId, boxId, start, end, styleId) =>
        set((s) => (s.project ? { project: E.applyNamedStyle(s.project, slideId, boxId, start, end, styleId) } : s)),

      setTts: (patch) => set((s) => (s.project ? { project: E.setTts(s.project, patch) } : s)),

      setVoiceover: (cues) => set((s) => (s.project ? { project: E.setVoiceover(s.project, cues) } : s)),
      addCue: (startMs, text) => {
        const s = get()
        if (!s.project) return ''
        const { project, cueId } = E.addCue(s.project, startMs, text)
        set({ project })
        return cueId
      },
      updateCue: (id, patch) => set((s) => (s.project ? { project: E.updateCue(s.project, id, patch) } : s)),
      removeCue: (id) => set((s) => (s.project ? { project: E.removeCue(s.project, id) } : s)),
      setCueAudio: (id, audio) => set((s) => (s.project ? { project: E.setCueAudio(s.project, id, audio) } : s)),

      newProject: (fontId, brush) => {
        const p = newVideoProject(fontId, brush, nowIso())
        set({
          project: p,
          loaded: true,
          activeAspect: '16:9',
          selectedSlideId: p.slides[0]?.id ?? null,
          selectedTextBoxId: null,
          selection: null,
          slideView: 'layout',
          playSelectedIds: [],
        })
      },
      loadProject: async (id) => {
        const loaded = await projectStore.load(id)
        if (!loaded) return
        const { project: p, aspect } = migrateProject(loaded)
        set({
          project: p,
          loaded: true,
          activeAspect: aspect,
          selectedSlideId: p.slides[0]?.id ?? null,
          selectedTextBoxId: null,
          selection: null,
          slideView: 'layout',
          playSelectedIds: [],
        })
      },
      saveProject: async (font) => {
        const p = get().project
        if (!p) return
        // Don't rebrand the project's default font to whatever the Font tab has
        // open — the default font is chosen in the Video tool (see setProjectFont).
        const next = { ...p, updatedAt: nowIso() }
        set({ project: next })
        await projectStore.save(next)
        // Persist the editor font's bytes so the project's default font is on disk
        // (other referenced fonts are saved via the Font tab).
        await httpStore.saveFont(font.hash, font.buffer)
      },
    }),
    { limit: 60, partialize: (s) => ({ project: s.project }) },
  ),
)

export const videoHistory = {
  undo: () => useVideoStore.temporal.getState().undo(),
  redo: () => useVideoStore.temporal.getState().redo(),
  clear: () => useVideoStore.temporal.getState().clear(),
  pause: () => useVideoStore.temporal.getState().pause(),
  resume: () => useVideoStore.temporal.getState().resume(),
}

/** Derive (seed) every character used across the project so it can animate. */
export async function ensureProjectGlyphsDerived(
  extractor: GlyphExtractor,
  project: VideoProject,
  params: ExtractionParams,
): Promise<void> {
  const chars = new Set<string>()
  for (const slide of project.slides)
    for (const box of slide.textBoxes)
      for (const run of box.runs) for (const ch of run.text) if (ch.trim().length) chars.add(ch)
  for (const ch of chars) await ensureGlyphDerived(extractor, ch, params)
}

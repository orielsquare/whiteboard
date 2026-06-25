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
  type NormRect,
  type Slide,
  type TextBox,
  type TextRun,
  type TtsSettings,
  type VideoProject,
  type VoiceoverAudio,
  type VoiceoverCue,
} from '@lib/project/schema'
import type { BrushSettings } from '@lib/manifest/schema'
import * as E from './videoEdit'

const nowIso = () => new Date().toISOString()
type SlideView = 'layout' | 'order' | 'play' | 'timeline' | 'vtt'

interface VideoState {
  project: VideoProject | null
  loaded: boolean
  // transient UI state — NOT undoable, NOT persisted (see partialize)
  selectedSlideId: string | null
  selectedTextBoxId: string | null
  slideView: SlideView
  /** slides ticked for scoped ("Selected") play; project order applied at play time. */
  playSelectedIds: string[]

  selectSlide: (id: string | null) => void
  selectTextBox: (id: string | null) => void
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
  reorderTextBoxes: (slideId: string, orderedIds: string[]) => void
  deleteTextBox: (slideId: string, boxId: string) => void

  setAspect: (a: Aspect) => void
  setBaseEmFraction: (v: number) => void
  setPlaybackRate: (v: number) => void
  setBrush: (b: BrushSettings) => void

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
      selectedSlideId: null,
      selectedTextBoxId: null,
      slideView: 'layout',
      playSelectedIds: [],

      selectSlide: (id) => set({ selectedSlideId: id, selectedTextBoxId: null }),
      selectTextBox: (id) => set({ selectedTextBoxId: id }),
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
        const { project, boxId } = E.addTextBox(s.project, slideId, x, y)
        set({ project, selectedTextBoxId: boxId })
        return boxId
      },
      updateTextBox: (slideId, boxId, patch) =>
        set((s) => (s.project ? { project: E.updateTextBox(s.project, slideId, boxId, patch) } : s)),
      updateTextBoxFrame: (slideId, boxId, patch) =>
        set((s) => (s.project ? { project: E.updateTextBoxFrame(s.project, slideId, boxId, patch) } : s)),
      updateTextBoxRuns: (slideId, boxId, runs) =>
        set((s) => (s.project ? { project: E.updateTextBoxRuns(s.project, slideId, boxId, runs) } : s)),
      reorderTextBoxes: (slideId, orderedIds) =>
        set((s) => (s.project ? { project: E.reorderTextBoxes(s.project, slideId, orderedIds) } : s)),
      deleteTextBox: (slideId, boxId) =>
        set((s) =>
          s.project
            ? {
                project: E.deleteTextBox(s.project, slideId, boxId),
                selectedTextBoxId: s.selectedTextBoxId === boxId ? null : s.selectedTextBoxId,
              }
            : s,
        ),

      setAspect: (a) => set((s) => (s.project ? { project: E.setAspect(s.project, a) } : s)),
      setBaseEmFraction: (v) =>
        set((s) => (s.project ? { project: E.setBaseEmFraction(s.project, v) } : s)),
      setPlaybackRate: (v) =>
        set((s) => (s.project ? { project: E.setPlaybackRate(s.project, v) } : s)),
      setBrush: (b) => set((s) => (s.project ? { project: E.setBrush(s.project, b) } : s)),
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
          selectedSlideId: p.slides[0]?.id ?? null,
          selectedTextBoxId: null,
          slideView: 'layout',
          playSelectedIds: [],
        })
      },
      loadProject: async (id) => {
        const p = await projectStore.load(id)
        if (!p) return
        set({
          project: p,
          loaded: true,
          selectedSlideId: p.slides[0]?.id ?? null,
          selectedTextBoxId: null,
          slideView: 'layout',
          playSelectedIds: [],
        })
      },
      saveProject: async (font) => {
        const p = get().project
        if (!p) return
        const next = { ...p, fontId: font.hash, updatedAt: nowIso() }
        set({ project: next })
        await projectStore.save(next)
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

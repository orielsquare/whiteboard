import { create } from 'zustand'
import { temporal } from 'zundo'
import type { LoadedFont } from '@lib/font/load'
import { projectStore } from '@lib/persistence/ProjectStore'
import { httpStore } from '@lib/persistence/FontStore'
import { ensureGlyphDerived } from './store'
import type { GlyphExtractor } from '@lib/extraction'
import {
  makeId,
  newVideoProject,
  type Aspect,
  type BoxContent,
  type InkPoint,
  type InkTool,
  type NamedStyle,
  type NormRect,
  type ProjectDefaults,
  type Slide,
  type SlideDrawing,
  type SlideInk,
  type TextBox,
  type TextRun,
  type TtsSettings,
  type VideoProject,
  type VoiceoverAudio,
  type VoiceoverCue,
} from '@lib/project/schema'
import { ASPECTS, contentOf, effLock, migrateProject, toStoredY } from '@lib/project/aspect'
import { runsToPlainText } from '@lib/project/runs'
import { autosaveClear, autosaveWrite } from './autosave'

/** Resolve a box's effective content (format) lock for write-through routing. */
function contentLinked(project: VideoProject, slideId: string, boxId: string): boolean {
  const slide = project.slides.find((sl) => sl.id === slideId)
  const box = slide?.textBoxes.find((b) => b.id === boxId)
  return slide && box ? effLock(project, slide, box).content : true
}

/** Derive the primary-selection fields (what the Inspector shows) from a
 *  multi-selection: the LAST id wins; its kind is looked up on the current slide. */
function primaryFrom(
  s: { project: VideoProject | null; selectedSlideId: string | null },
  ids: string[],
): { selectedTextBoxId: string | null; selectedDrawingId: string | null; selectedInkId: string | null } {
  const none = { selectedTextBoxId: null, selectedDrawingId: null, selectedInkId: null }
  const id = ids[ids.length - 1]
  if (!id || !s.project) return none
  const slide = s.project.slides.find((sl) => sl.id === s.selectedSlideId) ?? s.project.slides[0]
  if (!slide) return none
  if (slide.textBoxes.some((b) => b.id === id)) return { ...none, selectedTextBoxId: id }
  if ((slide.drawings ?? []).some((d) => d.id === id)) return { ...none, selectedDrawingId: id }
  if ((slide.inks ?? []).some((k) => k.id === id)) return { ...none, selectedInkId: id }
  return none
}
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
type SlideView = 'editor' | 'timeline' | 'vtt'
/** which list the Editor's left navigator shows (drives the Inspector too). */
type NavTab = 'slides' | 'boxes'
/** What the editor canvas is playing (null = editing). Project plays the whole
 *  video; slide/box loop just that item (chip play buttons). Transient UI state. */
export type Playback =
  | { kind: 'project' }
  | { kind: 'slide'; slideId: string }
  | { kind: 'box'; slideId: string; boxId: string }
  | { kind: 'drawing'; slideId: string; drawingId: string }
  | { kind: 'ink'; slideId: string; inkId: string }

interface VideoState {
  project: VideoProject | null
  loaded: boolean
  /** The project object as of the last save/load — the dirty baseline
   *  (`dirty = project !== savedProject`). Transient, not undoable. */
  savedProject: VideoProject | null
  // transient UI state — NOT undoable, NOT persisted (see partialize)
  /** the aspect ratio currently being edited/previewed (16:9 or 9:16). */
  activeAspect: Aspect
  selectedSlideId: string | null
  selectedTextBoxId: string | null
  /** the selected placed drawing (mutually exclusive with a selected textbox). */
  selectedDrawingId: string | null
  /** the selected direct drawing (mutually exclusive with box/drawing selection). */
  selectedInkId: string | null
  /** ALL selected elements on the current slide (boxes/drawings/inks mixed) — the
   *  marquee / shift-click multi-selection. The single `selected*Id` fields hold
   *  the PRIMARY (last-picked) element and drive the Inspector; when this list is
   *  non-empty the primary is one of its members. */
  selectedElementIds: string[]
  /** the active direct-drawing pen on the canvas; null = select/move mode. */
  inkTool: InkTool | null
  /** active sub-range selection inside the selected textbox (for the format bar). */
  selection: TextSelection | null
  /** copy/cut buffer for elements (any mix of kinds; survives slide switches). */
  clipboardElements: E.ClipboardElement[] | null
  slideView: SlideView
  /** Editor navigator tab; also gates which properties the Inspector shows. */
  navTab: NavTab
  /** what the editor canvas is playing (null = editing). */
  playback: Playback | null
  /** Timeline zoom (px per second); null = not initialized for this project yet
   *  (the Timeline view restores it from prefs). Transient — survives tab
   *  switches; mirrored to localStorage per project for refresh survival. */
  tlZoom: number | null
  /** Timeline horizontal scroll (px). Same lifecycle as `tlZoom`. */
  tlScroll: number

  selectSlide: (id: string | null) => void
  selectTextBox: (id: string | null) => void
  selectDrawing: (id: string | null) => void
  selectInk: (id: string | null) => void
  /** shift/ctrl-click: toggle an element in/out of the multi-selection. */
  toggleSelectElement: (id: string) => void
  /** marquee: replace the multi-selection wholesale (last id becomes primary). */
  setSelectedElements: (ids: string[]) => void
  /** move every selected element by (dx, dyWidthUnits) in ONE write (one undo). */
  translateSelected: (slideId: string, ids: string[], dx: number, dyW: number) => void
  /** delete a set of elements in one write. */
  removeElements: (slideId: string, ids: string[]) => void
  setInkTool: (tool: InkTool | null) => void
  setSelection: (sel: TextSelection | null) => void
  setSlideView: (v: SlideView) => void
  setNavTab: (t: NavTab) => void
  setPlayback: (p: Playback | null) => void
  setTlZoom: (v: number) => void
  setTlScroll: (v: number) => void

  addSlide: () => void
  copySlide: (id: string) => void
  deleteSlide: (id: string) => void
  reorderSlides: (orderedIds: string[]) => void
  updateSlide: (id: string, patch: Partial<Slide>) => void
  setSlideTransition: (id: string, patch: Partial<Slide['transition']>) => void

  // placed drawings (saved-drawing instances on a slide)
  addDrawing: (slideId: string, drawingId: string, name: string, x: number, y: number, w: number) => string
  updateDrawingFrame: (slideId: string, instanceId: string, patch: Partial<NormRect>) => void
  updateDrawing: (slideId: string, instanceId: string, patch: Partial<SlideDrawing>) => void
  removeDrawing: (slideId: string, instanceId: string) => void
  /** reorder the slide's combined boxes+drawings+inks animation sequence. */
  reorderSlideItems: (slideId: string, orderedIds: string[]) => void

  // direct drawings (hand-drawn annotations on a slide)
  addInk: (slideId: string, tool: InkTool, points: InkPoint[], color?: string | null, widthScale?: number) => string
  updateInk: (slideId: string, inkId: string, patch: Partial<SlideInk>) => void
  removeInk: (slideId: string, inkId: string) => void

  addTextBox: (slideId: string, x: number, y: number) => string
  updateTextBox: (slideId: string, boxId: string, patch: Partial<TextBox>) => void
  updateTextBoxFrame: (slideId: string, boxId: string, patch: Partial<NormRect>) => void
  updateTextBoxRuns: (slideId: string, boxId: string, runs: TextRun[]) => void
  /** patch a box's content (align / line-height / brush), honouring the format lock. */
  setBoxContent: (slideId: string, boxId: string, patch: Partial<BoxContent>) => void
  /** apply a run-style patch to [start,end) of a textbox (format bar). */
  applyTextStyle: (slideId: string, boxId: string, start: number, end: number, patch: StylePatch) => void
  /** apply a run-style patch to the FULL text of several boxes at once (the
   *  format bar on a multi-selection) — one write ≡ one undo step. */
  applyTextStyleToBoxes: (slideId: string, boxIds: string[], patch: StylePatch) => void
  /** patch content (align / line-height / brush) on several boxes at once. */
  setBoxContentForBoxes: (slideId: string, boxIds: string[], patch: Partial<BoxContent>) => void
  reorderTextBoxes: (slideId: string, orderedIds: string[]) => void
  deleteTextBox: (slideId: string, boxId: string) => void
  /** link/unlink a box's position across aspects (linking converges, active wins). */
  setBoxPositionLink: (slideId: string, boxId: string, linked: boolean) => void
  /** link/unlink every box's position on a slide. */
  setSlidePositionLink: (slideId: string, linked: boolean) => void
  /** link/unlink every box's position across the whole project. */
  setProjectPositionLink: (linked: boolean) => void
  /** link/unlink a placed drawing's position across aspects (linking converges, active wins). */
  setDrawingPositionLink: (slideId: string, drawingId: string, linked: boolean) => void
  /** link/unlink a placed drawing's format flag (redundant — kept for UI parity). */
  setDrawingFormatLink: (slideId: string, drawingId: string, linked: boolean) => void
  /** link/unlink a box's format (content) across aspects (linking converges, active wins). */
  setBoxFormatLink: (slideId: string, boxId: string, linked: boolean) => void
  /** link/unlink every box's format on a slide. */
  setSlideFormatLink: (slideId: string, linked: boolean) => void
  /** link/unlink every box's format across the whole project. */
  setProjectFormatLink: (linked: boolean) => void
  // element clipboard (Cmd/Ctrl C / X / V); works across slides within the project
  copySelection: (slideId: string) => void
  cutSelection: (slideId: string) => void
  pasteClipboard: (slideId: string) => void

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
  /** Adopt an autosaved working copy — like a load, but the document starts
   *  DIRTY (it differs from what's on Drive until saved). */
  restoreProject: (raw: VideoProject) => void
  saveProject: (font: LoadedFont) => Promise<void>
  /** Rename the open project (cosmetic; persisted on next save, which renames the
   *  Drive file too). */
  renameProject: (name: string) => void
  /** Save a copy: persist the current project, then server-duplicate it (+ its
   *  voiceover clips) under a new id/name, and switch the editor to the copy.
   *  Returns the new project id. */
  saveProjectAs: (name: string, font: LoadedFont) => Promise<string>
}

export const useVideoStore = create<VideoState>()(
  temporal(
    (set, get) => ({
      project: null,
      loaded: false,
      savedProject: null,
      activeAspect: '16:9',
      selectedSlideId: null,
      selectedTextBoxId: null,
      selectedDrawingId: null,
      selectedInkId: null,
      selectedElementIds: [],
      inkTool: null,
      selection: null,
      clipboardElements: null,
      slideView: 'editor',
      navTab: 'slides',
      playback: null,
      tlZoom: null,
      tlScroll: 0,

      // Selecting a slide/box returns to the editing layout (stops any playback).
      selectSlide: (id) =>
        set({ selectedSlideId: id, selectedTextBoxId: null, selectedDrawingId: null, selectedInkId: null, selectedElementIds: [], selection: null, playback: null }),
      selectTextBox: (id) =>
        set((s) => ({
          selectedTextBoxId: id,
          selectedDrawingId: id ? null : s.selectedDrawingId,
          selectedInkId: id ? null : s.selectedInkId,
          selectedElementIds: id ? [id] : [],
          // keep a same-box selection alive; drop it when the box changes
          selection: s.selection && s.selection.boxId === id ? s.selection : null,
          // selecting a box (e.g. clicking it on the canvas) reveals it in the navigator
          ...(id ? { navTab: 'boxes' as const } : null),
          playback: null,
        })),
      selectDrawing: (id) =>
        set({ selectedDrawingId: id, selectedTextBoxId: null, selectedInkId: null, selectedElementIds: id ? [id] : [], selection: null, playback: null }),
      selectInk: (id) =>
        set((s) => ({
          selectedInkId: id,
          selectedTextBoxId: null,
          selectedDrawingId: null,
          selectedElementIds: id ? [id] : [],
          selection: null,
          playback: null,
          ...(id ? { navTab: 'boxes' as const } : null),
          // picking an ink implicitly returns to select mode (no accidental over-draw)
          inkTool: id ? null : s.inkTool,
        })),
      toggleSelectElement: (id) =>
        set((s) => {
          const ids = s.selectedElementIds.includes(id)
            ? s.selectedElementIds.filter((x) => x !== id)
            : [...s.selectedElementIds, id]
          return { ...primaryFrom(s, ids), selectedElementIds: ids, selection: null, playback: null, navTab: 'boxes' }
        }),
      setSelectedElements: (ids) =>
        set((s) => ({ ...primaryFrom(s, ids), selectedElementIds: ids, selection: null, playback: null, ...(ids.length ? { navTab: 'boxes' as const } : null) })),
      translateSelected: (slideId, ids, dx, dyW) =>
        set((s) => (s.project ? { project: E.translateElements(s.project, slideId, new Set(ids), dx, dyW, s.activeAspect) } : s)),
      removeElements: (slideId, ids) =>
        set((s) => {
          if (!s.project) return s
          const gone = new Set(ids)
          return {
            project: E.removeElements(s.project, slideId, gone),
            selectedElementIds: s.selectedElementIds.filter((x) => !gone.has(x)),
            selectedTextBoxId: s.selectedTextBoxId && gone.has(s.selectedTextBoxId) ? null : s.selectedTextBoxId,
            selectedDrawingId: s.selectedDrawingId && gone.has(s.selectedDrawingId) ? null : s.selectedDrawingId,
            selectedInkId: s.selectedInkId && gone.has(s.selectedInkId) ? null : s.selectedInkId,
            selection: s.selection && gone.has(s.selection.boxId) ? null : s.selection,
          }
        }),
      setInkTool: (tool) =>
        set({ inkTool: tool, ...(tool ? { selectedTextBoxId: null, selectedDrawingId: null, selectedInkId: null, selectedElementIds: [], selection: null, playback: null } : null) }),
      setSelection: (sel) => set({ selection: sel }),
      // changing the top view stops inline playback (it's an Editor-only mode).
      setSlideView: (v) => set({ slideView: v, playback: null }),
      setNavTab: (t) => set({ navTab: t }),
      setPlayback: (p) => set({ playback: p }),
      setTlZoom: (v) => set({ tlZoom: v }),
      setTlScroll: (v) => set({ tlScroll: v }),

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
            selectedDrawingId: null,
            selectedInkId: null,
            selectedElementIds: [],
            playback: null,
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

      addDrawing: (slideId, drawingId, name, x, y, w) => {
        const s = get()
        if (!s.project) return ''
        // y arrives in width-units (editor space) → store as a fraction of height.
        const { project, instanceId } = E.addDrawing(s.project, slideId, drawingId, name, x, toStoredY(y, s.activeAspect), w)
        set({ project, selectedDrawingId: instanceId, selectedTextBoxId: null })
        return instanceId
      },
      updateDrawingFrame: (slideId, instanceId, patch) =>
        set((s) => {
          if (!s.project) return s
          const slide = s.project.slides.find((sl) => sl.id === slideId)
          const drawing = slide?.drawings?.find((d) => d.id === instanceId)
          if (!slide || !drawing) return s
          // Editor works in width-units for y → store as a fraction of height.
          const p2 = patch.y != null ? { ...patch, y: toStoredY(patch.y, s.activeAspect) } : patch
          // Position-locked → write BOTH cuts (stay identical); unlocked → only the
          // active aspect (the cuts diverge). One set() ≡ one undo.
          const targets = effLock(s.project, slide, drawing).position ? ASPECTS : [s.activeAspect]
          return { project: E.updateDrawingFrame(s.project, slideId, instanceId, p2, targets) }
        }),
      updateDrawing: (slideId, instanceId, patch) =>
        set((s) => (s.project ? { project: E.updateDrawing(s.project, slideId, instanceId, patch) } : s)),
      removeDrawing: (slideId, instanceId) =>
        set((s) =>
          s.project
            ? {
                project: E.removeDrawing(s.project, slideId, instanceId),
                selectedDrawingId: s.selectedDrawingId === instanceId ? null : s.selectedDrawingId,
                selectedElementIds: s.selectedElementIds.filter((x) => x !== instanceId),
              }
            : s,
        ),
      reorderSlideItems: (slideId, orderedIds) =>
        set((s) => (s.project ? { project: E.reorderSlideItems(s.project, slideId, orderedIds) } : s)),

      addInk: (slideId, tool, points, color, widthScale) => {
        const s = get()
        if (!s.project) return ''
        const { project, inkId } = E.addInk(s.project, slideId, tool, points, color, widthScale)
        set({ project, selectedInkId: inkId, selectedTextBoxId: null, selectedDrawingId: null })
        return inkId
      },
      updateInk: (slideId, inkId, patch) =>
        set((s) => (s.project ? { project: E.updateInk(s.project, slideId, inkId, patch) } : s)),
      removeInk: (slideId, inkId) =>
        set((s) =>
          s.project
            ? {
                project: E.removeInk(s.project, slideId, inkId),
                selectedInkId: s.selectedInkId === inkId ? null : s.selectedInkId,
                selectedElementIds: s.selectedElementIds.filter((x) => x !== inkId),
              }
            : s,
        ),
      updateTextBox: (slideId, boxId, patch) =>
        set((s) => (s.project ? { project: E.updateTextBox(s.project, slideId, boxId, patch) } : s)),
      updateTextBoxFrame: (slideId, boxId, patch) =>
        set((s) => {
          if (!s.project) return s
          const slide = s.project.slides.find((sl) => sl.id === slideId)
          const box = slide?.textBoxes.find((b) => b.id === boxId)
          if (!slide || !box) return s
          // The editor works in width-units for y; store it as a fraction of height.
          const p2 = patch.y != null ? { ...patch, y: toStoredY(patch.y, s.activeAspect) } : patch
          // Position-locked → write BOTH cuts (stay identical); unlocked → only the
          // active aspect (the cuts diverge). One set() ≡ one undo.
          const targets = effLock(s.project, slide, box).position ? ASPECTS : [s.activeAspect]
          return { project: E.updateTextBoxFrame(s.project, slideId, boxId, p2, targets) }
        }),
      updateTextBoxRuns: (slideId, boxId, runs) =>
        set((s) =>
          s.project
            ? { project: E.updateTextBoxRuns(s.project, slideId, boxId, runs, s.activeAspect, contentLinked(s.project, slideId, boxId)) }
            : s,
        ),
      setBoxContent: (slideId, boxId, patch) =>
        set((s) =>
          s.project
            ? { project: E.updateTextBoxContent(s.project, slideId, boxId, patch, s.activeAspect, contentLinked(s.project, slideId, boxId)) }
            : s,
        ),
      applyTextStyle: (slideId, boxId, start, end, patch) =>
        set((s) =>
          s.project
            ? { project: E.applyTextStyle(s.project, slideId, boxId, start, end, patch, s.activeAspect, contentLinked(s.project, slideId, boxId)) }
            : s,
        ),
      applyTextStyleToBoxes: (slideId, boxIds, patch) =>
        set((s) => {
          if (!s.project) return s
          let project = s.project
          for (const boxId of boxIds) {
            const sl = project.slides.find((x) => x.id === slideId)
            const b = sl?.textBoxes.find((x) => x.id === boxId)
            if (!sl || !b) continue
            const len = runsToPlainText(contentOf(b, s.activeAspect).runs).length
            project = E.applyTextStyle(project, slideId, boxId, 0, len, patch, s.activeAspect, contentLinked(project, slideId, boxId))
          }
          return { project }
        }),
      setBoxContentForBoxes: (slideId, boxIds, patch) =>
        set((s) => {
          if (!s.project) return s
          let project = s.project
          for (const boxId of boxIds) {
            project = E.updateTextBoxContent(project, slideId, boxId, patch, s.activeAspect, contentLinked(project, slideId, boxId))
          }
          return { project }
        }),
      reorderTextBoxes: (slideId, orderedIds) =>
        set((s) => (s.project ? { project: E.reorderTextBoxes(s.project, slideId, orderedIds) } : s)),
      setBoxPositionLink: (slideId, boxId, linked) =>
        set((s) =>
          s.project ? { project: E.setBoxPositionLink(s.project, slideId, boxId, linked, s.activeAspect) } : s,
        ),
      setSlidePositionLink: (slideId, linked) =>
        set((s) =>
          s.project ? { project: E.setSlidePositionLink(s.project, slideId, linked, s.activeAspect) } : s,
        ),
      setProjectPositionLink: (linked) =>
        set((s) => (s.project ? { project: E.setProjectPositionLink(s.project, linked, s.activeAspect) } : s)),
      setDrawingPositionLink: (slideId, drawingId, linked) =>
        set((s) => (s.project ? { project: E.setDrawingPositionLink(s.project, slideId, drawingId, linked, s.activeAspect) } : s)),
      setDrawingFormatLink: (slideId, drawingId, linked) =>
        set((s) => (s.project ? { project: E.setDrawingFormatLink(s.project, slideId, drawingId, linked) } : s)),
      setBoxFormatLink: (slideId, boxId, linked) =>
        set((s) => (s.project ? { project: E.setBoxFormatLink(s.project, slideId, boxId, linked, s.activeAspect) } : s)),
      setSlideFormatLink: (slideId, linked) =>
        set((s) => (s.project ? { project: E.setSlideFormatLink(s.project, slideId, linked, s.activeAspect) } : s)),
      setProjectFormatLink: (linked) =>
        set((s) => (s.project ? { project: E.setProjectFormatLink(s.project, linked, s.activeAspect) } : s)),
      deleteTextBox: (slideId, boxId) =>
        set((s) =>
          s.project
            ? {
                project: E.deleteTextBox(s.project, slideId, boxId),
                selectedTextBoxId: s.selectedTextBoxId === boxId ? null : s.selectedTextBoxId,
                selectedElementIds: s.selectedElementIds.filter((x) => x !== boxId),
                selection: s.selection?.boxId === boxId ? null : s.selection,
              }
            : s,
        ),

      copySelection: (slideId) => {
        const s = get()
        const slide = s.project?.slides.find((sl) => sl.id === slideId)
        if (!slide || !s.selectedElementIds.length) return
        const clip = E.collectElements(slide, new Set(s.selectedElementIds))
        if (clip.length) set({ clipboardElements: clip })
      },
      cutSelection: (slideId) =>
        set((s) => {
          const slide = s.project?.slides.find((sl) => sl.id === slideId)
          if (!s.project || !slide || !s.selectedElementIds.length) return s
          const ids = new Set(s.selectedElementIds)
          const clip = E.collectElements(slide, ids)
          if (!clip.length) return s
          return {
            clipboardElements: clip,
            project: E.removeElements(s.project, slideId, ids),
            selectedElementIds: [],
            selectedTextBoxId: null,
            selectedDrawingId: null,
            selectedInkId: null,
            selection: null,
          }
        }),
      pasteClipboard: (slideId) =>
        set((s) => {
          if (!s.project || !s.clipboardElements?.length) return s
          const { project, ids } = E.pasteElements(s.project, slideId, s.clipboardElements)
          return {
            project,
            selectedElementIds: ids,
            ...primaryFrom({ project, selectedSlideId: slideId }, ids),
            selection: null,
          }
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
        set((s) =>
          s.project
            ? { project: E.applyNamedStyle(s.project, slideId, boxId, start, end, styleId, s.activeAspect, contentLinked(s.project, slideId, boxId)) }
            : s,
        ),

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
          savedProject: p, // fresh default content — nothing worth guarding yet
          activeAspect: '16:9',
          selectedSlideId: p.slides[0]?.id ?? null,
          selectedTextBoxId: null,
          selectedDrawingId: null,
          selectedInkId: null,
          selectedElementIds: [],
          inkTool: null,
          selection: null,
          slideView: 'editor',
          navTab: 'slides',
          playback: null,
          tlZoom: null,
          tlScroll: 0,
        })
      },
      loadProject: async (id) => {
        const loaded = await projectStore.load(id)
        if (!loaded) return
        const { project: p, aspect } = migrateProject(loaded)
        set({
          project: p,
          loaded: true,
          savedProject: p,
          activeAspect: aspect,
          selectedSlideId: p.slides[0]?.id ?? null,
          selectedTextBoxId: null,
          selectedDrawingId: null,
          selectedInkId: null,
          selectedElementIds: [],
          inkTool: null,
          selection: null,
          slideView: 'editor',
          navTab: 'slides',
          playback: null,
          tlZoom: null,
          tlScroll: 0,
        })
      },

      restoreProject: (raw) => {
        const { project: p, aspect } = migrateProject(raw)
        set({
          project: p,
          loaded: true,
          savedProject: null, // differs from disk until saved
          activeAspect: aspect,
          selectedSlideId: p.slides[0]?.id ?? null,
          selectedTextBoxId: null,
          selectedDrawingId: null,
          selectedInkId: null,
          selectedElementIds: [],
          inkTool: null,
          selection: null,
          slideView: 'editor',
          navTab: 'slides',
          playback: null,
          tlZoom: null,
          tlScroll: 0,
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
        set({ savedProject: next }) // disk is the truth again
        autosaveClear('video')
      },
      renameProject: (name) =>
        set((s) => (s.project ? { project: { ...s.project, name, updatedAt: nowIso() } } : s)),
      saveProjectAs: async (name, font) => {
        const p = get().project
        if (!p) return ''
        // The server copies the STORED project, so make sure it's current first.
        const saved = { ...p, updatedAt: nowIso() }
        set({ project: saved })
        await projectStore.save(saved)
        await httpStore.saveFont(font.hash, font.buffer)
        const newId = makeId()
        await projectStore.copy(saved.id, newId, name)
        // Switch the editor to the copy; its voiceover cues now resolve under the
        // new id (the server deep-copied the clips into the copy's folder).
        const copy = { ...saved, id: newId, name, updatedAt: nowIso() }
        set({ project: copy, savedProject: copy })
        autosaveClear('video')
        return newId
      },
    }),
    { limit: 60, partialize: (s) => ({ project: s.project }) },
  ),
)

// Autosave the working copy while dirty (debounced, single slot; cleared on save).
// Undoing back to the saved state drops the slot — otherwise a refresh would
// resurrect the undone edits.
useVideoStore.subscribe((s, prev) => {
  if (!s.project || s.project === prev.project) return
  if (s.project !== s.savedProject) autosaveWrite('video', s.project.id, s.project)
  else if (prev.project !== prev.savedProject) autosaveClear('video')
})

export const videoHistory = {
  undo: () => useVideoStore.temporal.getState().undo(),
  redo: () => useVideoStore.temporal.getState().redo(),
  clear: () => useVideoStore.temporal.getState().clear(),
  pause: () => useVideoStore.temporal.getState().pause(),
  resume: () => useVideoStore.temporal.getState().resume(),
}

/** Derive (seed) every character used across the project so it can animate.
 *  Each glyph derives with its own stored extraction settings (or defaults). */
export async function ensureProjectGlyphsDerived(
  extractor: GlyphExtractor,
  project: VideoProject,
): Promise<void> {
  const chars = new Set<string>()
  for (const slide of project.slides)
    for (const box of slide.textBoxes)
      for (const run of box.runs) for (const ch of run.text) if (ch.trim().length) chars.add(ch)
  for (const ch of chars) await ensureGlyphDerived(extractor, ch)
}

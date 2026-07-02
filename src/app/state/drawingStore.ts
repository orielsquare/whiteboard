import { create } from 'zustand'
import { temporal } from 'zundo'
import { hashStr } from '@lib/geometry/rng'
import { parseSvg, type ParsedElement, type ParsedSvg } from '@lib/svg/parse'
import type { FillParams, StrokeParams } from '@lib/svg/types'
import { buildElementParts, reconcileElementParts, rederiveElement, seedDrawingManifest, withContiguousZ } from '@lib/drawing/seed'
import {
  deleteSection as secDelete,
  flipSection as secFlip,
  mergeSections as secMerge,
  moveSection as secMove,
  reorderSections as secReorder,
  splitSection as secSplit,
} from '@lib/drawing/partEdit'
import type { DrawingElement, DrawingManifest, DrawingPart, PartKind, PartSectionTiming, PartTiming } from '@lib/drawing/schema'
import { autosaveClear, autosaveWrite } from './autosave'

export type OrderDim = 'draw' | 'z'

/** A part's copyable settings: its style (colour/alpha/timing) + the backing
 *  element's hatch/stroke geometry (so e.g. one eye can match the other). */
export interface PartStyleClip {
  color: string | null
  opacity?: number
  timing: PartTiming
  fillParams?: FillParams
  strokeParams?: StrokeParams
  sourceKind: PartKind
}

const nowIso = () => new Date().toISOString()

interface DrawingState {
  manifest: DrawingManifest | null
  /** parsed source, kept so param changes re-derive an element's geometry. */
  parsed: ParsedSvg | null
  svgText: string | null
  editRev: number
  savedRev: number
  error: string | null
  /** transient (not in history): copied part settings for paste. */
  styleClipboard: PartStyleClip | null
  importSvg: (svgText: string, name: string, fileName?: string) => void
  /** Replace the current drawing with a loaded manifest, re-parsing its stored
   *  source SVG so param changes can still re-derive geometry. */
  loadManifest: (manifest: DrawingManifest) => void
  /** Like `loadManifest`, but the document starts DIRTY (an autosaved working
   *  copy that differs from what's on Drive until saved). */
  restoreAutosaved: (manifest: DrawingManifest) => void
  // part edits (the user-managed animation/display units)
  renamePart: (id: string, name: string) => void
  togglePartVisible: (id: string) => void
  setPartColor: (id: string, color: string | null) => void
  setPartOpacity: (id: string, opacity: number) => void
  setPartTiming: (id: string, patch: Partial<PartTiming>) => void
  /** Per-stroke timing override (baked into the file). Passing `undefined` for a
   *  field clears it; a section with no remaining fields drops its override. */
  setPartSectionTiming: (partId: string, sectionId: string, patch: Partial<PartSectionTiming>) => void
  /** reorder the DRAW (animation) order — the parts array. */
  reorderParts: (orderedIds: string[]) => void
  /** reorder the Z (stacking) order — the `zOrder` fields (first id = highest z). */
  reorderZ: (orderedIds: string[]) => void
  copyPartStyle: (id: string) => void
  pastePartStyle: (targetId: string) => void
  // element geometry params (re-derive the backing geometry, preserving part edits)
  setElementFillParams: (elementId: string, params: FillParams) => void
  setElementStrokeParams: (elementId: string, params: StrokeParams) => void
  setElementOutlineFill: (elementId: string, on: boolean) => void
  /** draw a fill as its traced boundary path instead of hatch shading (and back). */
  setElementAsOutline: (elementId: string, on: boolean) => void
  /** Re-derive an element's geometry from its current params, refreshing the parts'
   *  sections (discards manual per-section splits/merges; keeps name/colour/timing). */
  rederiveElement: (elementId: string) => void
  // per-section stroke editing within a part (break up / merge / reorder strokes)
  movePartSection: (partId: string, sectionId: string, dir: -1 | 1) => void
  flipPartSection: (partId: string, sectionId: string) => void
  deletePartSection: (partId: string, sectionId: string) => void
  splitPartSection: (partId: string, sectionId: string) => void
  mergePartSections: (partId: string, idA: string, idB: string) => void
  reorderPartSections: (partId: string, orderedIds: string[]) => void
  setName: (name: string) => void
  markSaved: () => void
  clear: () => void
}

const bump = (s: DrawingState, manifest: DrawingManifest): Partial<DrawingState> => ({
  manifest: { ...manifest, updatedAt: nowIso() },
  editRev: s.editRev + 1,
})

function parsedForElement(parsed: ParsedSvg | null, el: DrawingElement): ParsedElement | undefined {
  return parsed?.elements.find((p) => p.sourceId === el.sourceId)
}

/** Map over a single part by id, returning a bumped manifest. */
function patchPart(s: DrawingState, id: string, fn: (p: DrawingPart) => DrawingPart): Partial<DrawingState> {
  if (!s.manifest) return s
  const parts = s.manifest.parts.map((p) => (p.id === id ? fn(p) : p))
  return bump(s, { ...s.manifest, parts })
}

export const useDrawingStore = create<DrawingState>()(
  temporal(
    (set) => ({
      manifest: null,
      parsed: null,
      svgText: null,
      editRev: 0,
      savedRev: 0,
      error: null,
      styleClipboard: null,

      importSvg: (svgText, name, fileName) => {
        try {
          const parsed = parseSvg(svgText)
          if (parsed.elements.length === 0) {
            set({ error: 'No drawable shapes found in this SVG.' })
            return
          }
          const hash = `svg-${hashStr(svgText).toString(36)}`
          const manifest = seedDrawingManifest(parsed, name, hash, nowIso(), fileName, svgText)
          set({ manifest, parsed, svgText, editRev: 0, savedRev: 0, error: null })
        } catch (e) {
          set({ error: String(e instanceof Error ? e.message : e) })
        }
      },

      loadManifest: (manifest) => {
        let parsed: ParsedSvg | null = null
        try {
          if (manifest.source) parsed = parseSvg(manifest.source)
        } catch {
          parsed = null // can't re-derive without a valid source; baked geometry still renders
        }
        set({ manifest, parsed, svgText: manifest.source ?? null, editRev: 0, savedRev: 0, error: null })
      },

      restoreAutosaved: (manifest) => {
        let parsed: ParsedSvg | null = null
        try {
          if (manifest.source) parsed = parseSvg(manifest.source)
        } catch {
          parsed = null
        }
        set({ manifest, parsed, svgText: manifest.source ?? null, editRev: 1, savedRev: 0, error: null })
      },

      renamePart: (id, name) => set((s) => patchPart(s, id, (p) => ({ ...p, name }))),
      togglePartVisible: (id) => set((s) => patchPart(s, id, (p) => ({ ...p, visible: !p.visible }))),
      setPartColor: (id, color) => set((s) => patchPart(s, id, (p) => ({ ...p, color }))),
      setPartOpacity: (id, opacity) => set((s) => patchPart(s, id, (p) => ({ ...p, opacity }))),
      setPartTiming: (id, patch) => set((s) => patchPart(s, id, (p) => ({ ...p, timing: { ...p.timing, ...patch } }))),
      setPartSectionTiming: (partId, sectionId, patch) =>
        set((s) =>
          patchPart(s, partId, (p) => ({
            ...p,
            sections: p.sections.map((sec) => {
              if (sec.id !== sectionId) return sec
              const merged: PartSectionTiming = { ...sec.timing, ...patch }
              if (merged.durationMs == null) delete merged.durationMs
              if (merged.delayBeforeMs == null) delete merged.delayBeforeMs
              const { timing: _drop, ...rest } = sec
              return merged.durationMs != null || merged.delayBeforeMs != null ? { ...rest, timing: merged } : rest
            }),
          })),
        ),

      reorderParts: (orderedIds) =>
        set((s) => {
          if (!s.manifest) return s
          const byId = new Map(s.manifest.parts.map((p) => [p.id, p]))
          const parts = orderedIds.map((id) => byId.get(id)).filter((p): p is DrawingPart => !!p)
          if (parts.length !== s.manifest.parts.length) return s
          return bump(s, { ...s.manifest, parts })
        }),

      reorderZ: (orderedIds) =>
        set((s) => {
          if (!s.manifest) return s
          // orderedIds are top-of-list first, and the top of the list is the
          // HIGHEST z (drawn on top), so the first id gets the largest zOrder.
          const n = orderedIds.length
          const rank = new Map(orderedIds.map((id, i) => [id, n - i]))
          if (rank.size !== s.manifest.parts.length) return s
          const parts = s.manifest.parts.map((p) => (p.zOrder === rank.get(p.id) ? p : { ...p, zOrder: rank.get(p.id)! }))
          return bump(s, { ...s.manifest, parts })
        }),

      copyPartStyle: (id) =>
        set((s) => {
          const part = s.manifest?.parts.find((p) => p.id === id)
          const el = part && s.manifest?.elements.find((e) => e.id === part.elementId)
          if (!part || !el) return s
          return {
            styleClipboard: {
              color: part.color ?? null,
              opacity: part.opacity,
              timing: { ...part.timing },
              fillParams: el.fillParams ? { ...el.fillParams } : undefined,
              strokeParams: el.strokeParams ? { ...el.strokeParams } : undefined,
              sourceKind: part.kind,
            },
          }
        }),

      pastePartStyle: (targetId) =>
        set((s) => {
          const clip = s.styleClipboard
          if (!clip || !s.manifest) return s
          const ti = s.manifest.parts.findIndex((p) => p.id === targetId)
          if (ti < 0) return s
          const target = s.manifest.parts[ti]
          const ei = s.manifest.elements.findIndex((e) => e.id === target.elementId)
          if (ei < 0) return s
          // 1) apply geometry params to the backing element (matching what it supports)
          const el: DrawingElement = { ...s.manifest.elements[ei] }
          if (clip.fillParams && el.hasFill) el.fillParams = { ...clip.fillParams }
          if (clip.strokeParams && el.hasOutline) el.strokeParams = { ...clip.strokeParams }
          const elements = [...s.manifest.elements]
          elements[ei] = el
          // 2) apply the part-level style to the target part
          let parts = [...s.manifest.parts]
          parts[ti] = { ...target, color: clip.color, opacity: clip.opacity, timing: { ...clip.timing } }
          // 3) re-derive the element's geometry into its parts' sections
          const pe = parsedForElement(s.parsed, el)
          if (pe) {
            const { outline, fill, derivedSig } = rederiveElement(el, pe)
            const groups = { outline, fill }
            elements[ei] = { ...el, derivedSig }
            parts = parts.map((p) => {
              if (p.elementId !== el.id) return p
              const next = groups[p.kind]
              return next.length ? { ...p, sections: next } : p
            })
          }
          return bump(s, { ...s.manifest, elements, parts })
        }),

      setElementFillParams: (elementId, params) =>
        set((s) => replaceElementGeometry(s, elementId, (el) => ({ ...el, fillParams: params }))),

      setElementStrokeParams: (elementId, params) =>
        set((s) => replaceElementGeometry(s, elementId, (el) => ({ ...el, strokeParams: params }))),

      setElementOutlineFill: (elementId, on) =>
        set((s) => rebuildElementParts(s, elementId, (el) => ({ ...el, outlineFill: on }))),

      // Geometry swap (kinds unchanged: a fill part keeps its identity, its sections
      // become the traced boundary or the hatch), so part edits are preserved.
      setElementAsOutline: (elementId, on) =>
        set((s) => replaceElementGeometry(s, elementId, (el) => ({ ...el, asOutline: on }))),

      rederiveElement: (elementId) => set((s) => replaceElementGeometry(s, elementId, (el) => el)),

      movePartSection: (partId, sectionId, dir) =>
        set((s) => patchPart(s, partId, (p) => ({ ...p, sections: secMove(p.sections, sectionId, dir) }))),
      flipPartSection: (partId, sectionId) =>
        set((s) => patchPart(s, partId, (p) => ({ ...p, sections: secFlip(p.sections, sectionId) }))),
      deletePartSection: (partId, sectionId) =>
        set((s) => patchPart(s, partId, (p) => ({ ...p, sections: secDelete(p.sections, sectionId) }))),
      splitPartSection: (partId, sectionId) =>
        set((s) => patchPart(s, partId, (p) => ({ ...p, sections: secSplit(p.sections, sectionId) }))),
      mergePartSections: (partId, idA, idB) =>
        set((s) => patchPart(s, partId, (p) => ({ ...p, sections: secMerge(p.sections, idA, idB) }))),
      reorderPartSections: (partId, orderedIds) =>
        set((s) => patchPart(s, partId, (p) => ({ ...p, sections: secReorder(p.sections, orderedIds) }))),

      setName: (name) =>
        set((s) => (s.manifest ? bump(s, { ...s.manifest, metadata: { ...s.manifest.metadata, name } }) : s)),

      markSaved: () =>
        set((s) => {
          autosaveClear('drawing')
          return { savedRev: s.editRev }
        }),
      clear: () => set({ manifest: null, parsed: null, svgText: null, editRev: 0, savedRev: 0, error: null }),
    }),
    { limit: 80, partialize: (s) => ({ manifest: s.manifest, editRev: s.editRev }) },
  ),
)

// Autosave the working copy while dirty (debounced, single slot; cleared on save).
// Undoing back to the clean state drops the slot — otherwise a refresh would
// resurrect the undone edit.
useDrawingStore.subscribe((s, prev) => {
  if (!s.manifest || s.manifest === prev.manifest) return
  if (s.editRev !== s.savedRev) autosaveWrite('drawing', s.manifest.metadata.drawingId, s.manifest)
  else if (prev.editRev !== prev.savedRev) autosaveClear('drawing')
})

/** Param tweak (kinds unchanged): re-derive the element and swap each matching
 *  part's sections, preserving every part's name/colour/visibility/timing/order. */
function replaceElementGeometry(
  s: DrawingState,
  elementId: string,
  patch: (el: DrawingElement) => DrawingElement,
): Partial<DrawingState> {
  if (!s.manifest) return s
  const ei = s.manifest.elements.findIndex((e) => e.id === elementId)
  if (ei < 0) return s
  const el = patch(s.manifest.elements[ei])
  const pe = parsedForElement(s.parsed, el)
  if (!pe) return s
  const { outline, fill, derivedSig } = rederiveElement(el, pe)
  const groups = { outline, fill }
  const elements = [...s.manifest.elements]
  elements[ei] = { ...el, derivedSig }
  const parts = s.manifest.parts.map((p) => {
    if (p.elementId !== elementId) return p
    const next = groups[p.kind]
    return next.length ? { ...p, sections: next } : p
  })
  return bump(s, { ...s.manifest, elements, parts })
}

/** Structural change (outlineFill toggled adds/removes the outline part): rebuild
 *  this element's parts in place where its block currently sits — but PRESERVE the
 *  edits on any part whose kind survives the toggle (its name/colour/alpha/timing/
 *  visibility/z), swapping in only the re-derived geometry. Only a newly-appearing
 *  kind (e.g. the boundary the toggle just added) gets a fresh default part. */
function rebuildElementParts(
  s: DrawingState,
  elementId: string,
  patch: (el: DrawingElement) => DrawingElement,
): Partial<DrawingState> {
  if (!s.manifest) return s
  const ei = s.manifest.elements.findIndex((e) => e.id === elementId)
  if (ei < 0) return s
  const el = patch(s.manifest.elements[ei])
  const pe = parsedForElement(s.parsed, el)
  if (!pe) return s
  const { outline, fill, derivedSig } = rederiveElement(el, pe)
  const fresh = buildElementParts(el, { outline, fill })
  // Preserve the edits on any part whose kind survives the toggle; only a newly
  // appearing kind (the boundary just added) gets a fresh default part.
  const prevParts = s.manifest.parts.filter((p) => p.elementId === elementId)
  const rebuilt = reconcileElementParts(prevParts, fresh)
  const elements = [...s.manifest.elements]
  elements[ei] = { ...el, derivedSig }
  // Splice the rebuilt parts where this element's first existing part is (else append).
  const firstIdx = s.manifest.parts.findIndex((p) => p.elementId === elementId)
  const kept = s.manifest.parts.filter((p) => p.elementId !== elementId)
  const at = firstIdx < 0 ? kept.length : Math.min(firstIdx, kept.length)
  const parts = withContiguousZ([...kept.slice(0, at), ...rebuilt, ...kept.slice(at)])
  return bump(s, { ...s.manifest, elements, parts })
}

export const drawingHistory = {
  undo: () => useDrawingStore.temporal.getState().undo(),
  redo: () => useDrawingStore.temporal.getState().redo(),
  clear: () => useDrawingStore.temporal.getState().clear(),
}

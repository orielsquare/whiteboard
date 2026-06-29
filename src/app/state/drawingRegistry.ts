import { create } from 'zustand'
import { prepareDrawing } from '@lib/drawing/timeline'
import { drawingHttpStore } from '@lib/persistence/DrawingStore'
import type { PreparedDrawingEntry } from '@lib/drawing/render'
import type { DrawingManifest } from '@lib/drawing/schema'

/**
 * Cache of prepared placed-drawing geometry for every SAVED drawing the Video
 * tool renders with, keyed by drawingId — the drawing analogue of
 * `fontRegistry.ts`. Each entry is `prepareDrawing(manifest.parts)` plus the
 * manifest's viewBox (needed to place it). Derived cache, NOT project state → its
 * own non-temporal store (outside zundo). The map itself IS a `DrawingSet`.
 */
export interface DrawingRegistryState {
  drawings: Map<string, PreparedDrawingEntry>
  /** Load + prepare each missing drawing id (idempotent; dedupes in-flight loads). */
  ensureDrawings: (ids: string[]) => Promise<void>
  /** Drop a cached drawing so the next ensure re-loads it (e.g. after a re-save). */
  invalidate: (id: string) => void
  /** Replace a cached entry directly from an (in-memory) manifest — called when a
   *  drawing is saved, so any Video view already showing it re-renders the new
   *  version without a round-trip. The drawingId is stable across part edits (it's
   *  the SVG-source hash), so the slide's reference stays valid. */
  refreshFromManifest: (manifest: DrawingManifest) => void
}

const inFlight = new Set<string>()

export const useDrawingRegistry = create<DrawingRegistryState>((set, get) => ({
  drawings: new Map(),
  ensureDrawings: async (ids) => {
    await Promise.all(
      [...new Set(ids)].map(async (id) => {
        if (!id || get().drawings.has(id) || inFlight.has(id)) return
        inFlight.add(id)
        try {
          const manifest = await drawingHttpStore.load(id)
          if (manifest) {
            const entry: PreparedDrawingEntry = {
              prepared: prepareDrawing(manifest.parts),
              viewBox: manifest.metadata.viewBox,
            }
            set((s) => ({ drawings: new Map(s.drawings).set(id, entry) }))
          }
        } catch {
          /* not found / load failed — the drawing renders as missing */
        } finally {
          inFlight.delete(id)
        }
      }),
    )
  },
  invalidate: (id) =>
    set((s) => {
      if (!s.drawings.has(id)) return s
      const next = new Map(s.drawings)
      next.delete(id)
      return { drawings: next }
    }),
  refreshFromManifest: (manifest) =>
    set((s) => {
      let entry: PreparedDrawingEntry
      try {
        entry = { prepared: prepareDrawing(manifest.parts), viewBox: manifest.metadata.viewBox }
      } catch {
        return s
      }
      // New Map ⇒ the DrawingSet reference changes ⇒ buildRenderContext re-runs.
      return { drawings: new Map(s.drawings).set(manifest.metadata.drawingId, entry) }
    }),
}))

import { create } from 'zustand'
import { temporal } from 'zundo'
import type { LoadedFont } from '@lib/font/load'
import { httpStore } from '@lib/persistence/FontStore'
import { seedFontManifest, seedGlyphAnimation } from '@lib/manifest/seed'
import { DEFAULT_PARAMS, extractionSig, type ExtractionParams, type GlyphExtractor } from '@lib/extraction'
import type { FontManifest, GlyphAnimation } from '@lib/manifest/schema'
import { autosaveClear, autosaveWrite } from './autosave'

const nowIso = () => new Date().toISOString()

interface EditorState {
  manifest: FontManifest | null
  loaded: boolean
  loadedFromDisk: boolean
  /** Monotonic counter bumped on every real (user) edit. It's part of the
   *  zundo-tracked slice, so undo/redo carry it with the manifest — making
   *  `dirty = editRev !== savedRev` a collision-free content-identity check
   *  (unlike a wall-clock timestamp, which same-millisecond edits can alias). */
  editRev: number
  /** `editRev` as of the last save / load-from-disk — the dirty baseline. */
  savedRev: number
  setManifest: (m: FontManifest | null) => void
  upsertGlyph: (g: GlyphAnimation) => void
  /** Replace a glyph WITHOUT bumping editRev/updatedAt (so background auto-derivations
   *  never mark the manifest dirty). Paired with paused history in commitDerivedGlyph. */
  setGlyphSilent: (g: GlyphAnimation) => void
  updateGlyph: (unicode: number, fn: (g: GlyphAnimation) => GlyphAnimation) => void
  /** Set a glyph's per-glyph extraction settings (re-derivation is triggered by the App). */
  setGlyphParams: (unicode: number, params: ExtractionParams) => void
  markReviewed: (unicode: number, reviewed: boolean) => void
  /** Set the font's cosmetic name (rename); marks the manifest dirty. */
  setFontName: (name: string) => void
  markSaved: () => void
  loadFontManifest: (font: LoadedFont) => Promise<void>
  /** Replace the manifest with an autosaved working copy — like a load, but the
   *  document starts DIRTY (it differs from what's on disk until saved). */
  restoreManifest: (m: FontManifest) => void
}

/** The extraction settings a glyph is (or would be) derived with. */
export function glyphParams(g: GlyphAnimation | undefined): ExtractionParams {
  return g?.extractionParams ?? DEFAULT_PARAMS
}

export const useEditorStore = create<EditorState>()(
  temporal(
    (set) => ({
      manifest: null,
      loaded: false,
      loadedFromDisk: false,
      editRev: 0,
      savedRev: 0,

      setManifest: (m) => set({ manifest: m }),

      upsertGlyph: (g) =>
        set((s) =>
          s.manifest
            ? {
                manifest: {
                  ...s.manifest,
                  glyphs: { ...s.manifest.glyphs, [String(g.unicode)]: g },
                  updatedAt: nowIso(),
                },
                editRev: s.editRev + 1,
              }
            : s,
        ),

      setGlyphSilent: (g) =>
        set((s) =>
          s.manifest
            ? { manifest: { ...s.manifest, glyphs: { ...s.manifest.glyphs, [String(g.unicode)]: g } } }
            : s,
        ),

      setGlyphParams: (unicode, params) =>
        set((s) => {
          if (!s.manifest) return s
          const key = String(unicode)
          const g = s.manifest.glyphs[key]
          if (!g) return s // not seeded yet — the sliders are disabled until it is
          return {
            manifest: {
              ...s.manifest,
              glyphs: { ...s.manifest.glyphs, [key]: { ...g, extractionParams: params } },
              updatedAt: nowIso(),
            },
            editRev: s.editRev + 1,
          }
        }),

      // Manual edits mark the glyph `edited`, which protects it from automatic
      // re-derivation when extraction params change.
      updateGlyph: (unicode, fn) =>
        set((s) => {
          if (!s.manifest) return s
          const key = String(unicode)
          const g = s.manifest.glyphs[key]
          if (!g) return s
          return {
            manifest: {
              ...s.manifest,
              glyphs: { ...s.manifest.glyphs, [key]: { ...fn(g), edited: true } },
              updatedAt: nowIso(),
            },
            editRev: s.editRev + 1,
          }
        }),

      markReviewed: (unicode, reviewed) =>
        set((s) => {
          if (!s.manifest) return s
          const key = String(unicode)
          const g = s.manifest.glyphs[key]
          if (!g) return s
          return {
            manifest: {
              ...s.manifest,
              glyphs: { ...s.manifest.glyphs, [key]: { ...g, reviewed, edited: true } },
              updatedAt: nowIso(),
            },
            editRev: s.editRev + 1,
          }
        }),

      setFontName: (name) =>
        set((s) =>
          s.manifest
            ? {
                manifest: { ...s.manifest, metadata: { ...s.manifest.metadata, name }, updatedAt: nowIso() },
                editRev: s.editRev + 1,
              }
            : s,
        ),

      // Record that the live manifest has been persisted (clears the dirty flag
      // and drops the autosave slot — disk is now the truth).
      markSaved: () =>
        set((s) => {
          autosaveClear('font')
          return { savedRev: s.editRev }
        }),

      restoreManifest: (m) => set({ manifest: m, loaded: true, loadedFromDisk: true, editRev: 1, savedRev: 0 }),

      loadFontManifest: async (font) => {
        let m: FontManifest | null = null
        let fromDisk = false
        try {
          m = await httpStore.load(font.hash)
          fromDisk = !!m
        } catch {
          m = null
        }
        if (!m) {
          m = seedFontManifest(font, nowIso())
        } else {
          // Migrate legacy manifests: drop the deprecated brushDefaults field
          // (brush is no longer glyph data) and protect pre-existing glyphs from
          // silent auto re-derivation by treating them as already edited.
          const mm = m as FontManifest & { brushDefaults?: unknown }
          delete mm.brushDefaults
          const glyphs = mm.glyphs ?? {}
          for (const k of Object.keys(glyphs)) {
            const gg = { ...glyphs[k] } as GlyphAnimation & { brushOverride?: unknown }
            delete gg.brushOverride // brush is no longer glyph data
            if (gg.edited === undefined) gg.edited = true // protect prior work
            glyphs[k] = gg
          }
          m = mm
        }
        set({ manifest: m, loaded: true, loadedFromDisk: fromDisk, editRev: 0, savedRev: 0 })
      },
    }),
    // editRev rides along with the manifest in history so undo/redo restore both,
    // keeping `dirty = editRev !== savedRev` accurate across undo.
    { limit: 60, partialize: (s) => ({ manifest: s.manifest, editRev: s.editRev }) },
  ),
)

// Autosave the working copy while dirty (debounced, single slot). Skips silent
// background derivations (they don't change editRev/dirty). Undoing back to the
// clean state drops the slot — otherwise a refresh would resurrect the undone edit.
useEditorStore.subscribe((s, prev) => {
  if (!s.manifest || s.manifest === prev.manifest) return
  if (s.editRev !== s.savedRev) autosaveWrite('font', s.manifest.metadata.fontId, s.manifest)
  else if (prev.editRev !== prev.savedRev) autosaveClear('font')
})

/** Imperative undo/redo handles (zundo temporal store). */
export const editorHistory = {
  undo: () => useEditorStore.temporal.getState().undo(),
  redo: () => useEditorStore.temporal.getState().redo(),
  clear: () => useEditorStore.temporal.getState().clear(),
  pause: () => useEditorStore.temporal.getState().pause(),
  resume: () => useEditorStore.temporal.getState().resume(),
}

/** Commit an auto-derived glyph WITHOUT creating an undo entry or marking dirty.
 *  (Background derivations are reproducible from the glyph's params, so they
 *  neither belong in the undo history nor count as unsaved work.) */
export function commitDerivedGlyph(glyph: GlyphAnimation) {
  editorHistory.pause()
  useEditorStore.getState().setGlyphSilent(glyph)
  editorHistory.resume()
}

/**
 * Ensure a glyph in the manifest is current w.r.t. ITS OWN extraction settings:
 * seed it if missing (using DEFAULT_PARAMS), or re-derive it if its params
 * signature is stale — but NEVER overwrite a glyph the user has manually edited.
 * Each glyph carries the params it should be derived with (`extractionParams`),
 * so this needs no caller-supplied params. Idempotent; commits stay out of undo.
 */
export async function ensureGlyphDerived(extractor: GlyphExtractor, char: string): Promise<void> {
  const cp = char.codePointAt(0)
  if (cp == null) return
  const key = String(cp)
  const before = useEditorStore.getState().manifest?.glyphs[key]
  const params = glyphParams(before)
  const sig = extractionSig(params)
  if (before && (before.edited || before.derivedSig === sig)) return // current or protected

  let strokes
  try {
    strokes = await extractor.extract(char, params)
  } catch {
    return // extractor disposed (font switch) or extraction failed — nothing to commit
  }
  // Re-check after the async gap: the user may have edited this glyph, changed its
  // params (making our result obsolete), or another request may have produced it.
  const after = useEditorStore.getState().manifest?.glyphs[key]
  if (after?.edited) return
  if (extractionSig(glyphParams(after)) !== sig) return // params changed mid-flight — newer derive wins
  if (after?.derivedSig === sig) return
  const timing = useEditorStore.getState().manifest?.defaultTiming
  commitDerivedGlyph(seedGlyphAnimation(strokes, timing, sig, params))
}

import { create } from 'zustand'
import { temporal } from 'zundo'
import type { LoadedFont } from '@lib/font/load'
import { httpStore } from '@lib/persistence/FontStore'
import { seedFontManifest, seedGlyphAnimation } from '@lib/manifest/seed'
import { extractionSig, type ExtractionParams, type GlyphExtractor } from '@lib/extraction'
import type { FontManifest, GlyphAnimation } from '@lib/manifest/schema'

const nowIso = () => new Date().toISOString()

interface EditorState {
  manifest: FontManifest | null
  loaded: boolean
  loadedFromDisk: boolean
  setManifest: (m: FontManifest | null) => void
  upsertGlyph: (g: GlyphAnimation) => void
  updateGlyph: (unicode: number, fn: (g: GlyphAnimation) => GlyphAnimation) => void
  markReviewed: (unicode: number, reviewed: boolean) => void
  loadFontManifest: (font: LoadedFont) => Promise<void>
}

export const useEditorStore = create<EditorState>()(
  temporal(
    (set) => ({
      manifest: null,
      loaded: false,
      loadedFromDisk: false,

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
              }
            : s,
        ),

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
          }
        }),

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
        set({ manifest: m, loaded: true, loadedFromDisk: fromDisk })
      },
    }),
    { limit: 60, partialize: (s) => ({ manifest: s.manifest }) },
  ),
)

/** Imperative undo/redo handles (zundo temporal store). */
export const editorHistory = {
  undo: () => useEditorStore.temporal.getState().undo(),
  redo: () => useEditorStore.temporal.getState().redo(),
  clear: () => useEditorStore.temporal.getState().clear(),
  pause: () => useEditorStore.temporal.getState().pause(),
  resume: () => useEditorStore.temporal.getState().resume(),
}

/** Commit an auto-derived glyph WITHOUT creating an undo entry. */
export function commitDerivedGlyph(glyph: GlyphAnimation) {
  editorHistory.pause()
  useEditorStore.getState().upsertGlyph(glyph)
  editorHistory.resume()
}

/**
 * Ensure a glyph in the manifest is current w.r.t. the given extraction params:
 * seed it if missing, or re-derive it if its params signature is stale — but
 * NEVER overwrite a glyph the user has manually edited. Idempotent; safe to call
 * repeatedly. Commits are kept out of the undo history.
 */
export async function ensureGlyphDerived(
  extractor: GlyphExtractor,
  char: string,
  params: ExtractionParams,
): Promise<void> {
  const cp = char.codePointAt(0)
  if (cp == null) return
  const key = String(cp)
  const sig = extractionSig(params)
  const before = useEditorStore.getState().manifest?.glyphs[key]
  if (before && (before.edited || before.derivedSig === sig)) return // current or protected

  let strokes
  try {
    strokes = await extractor.extract(char, params)
  } catch {
    return // extractor disposed (font switch) or extraction failed — nothing to commit
  }
  // Re-check after the async gap: the user may have edited this glyph, or another
  // request may have already produced the current version, meanwhile.
  const after = useEditorStore.getState().manifest?.glyphs[key]
  if (after?.edited || after?.derivedSig === sig) return
  const timing = useEditorStore.getState().manifest?.defaultTiming
  commitDerivedGlyph(seedGlyphAnimation(strokes, timing, sig))
}

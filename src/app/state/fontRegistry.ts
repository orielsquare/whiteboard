import { create } from 'zustand'
import { prepareGlyph, type PreparedGlyph } from '@lib/animation/timeline'
import { httpStore } from '@lib/persistence/FontStore'
import { seedGlyphAnimation } from '@lib/manifest/seed'
import { DEFAULT_PARAMS, GlyphExtractor, extractionSig } from '@lib/extraction'
import type { SectionTiming } from '@lib/manifest/schema'
import type { FontMetrics } from '@lib/project/layout'

/**
 * Cache of prepared glyphs + metrics for every SAVED font the Video tool renders
 * with, keyed by fontId. Saved manifests are usually incomplete (only the glyphs
 * the user happened to extract), so the Video tool **derives missing glyphs on
 * demand** here — by building a GlyphExtractor from the font's bytes — exactly
 * like the Font tool does for its open font. The font open in the Font tab is
 * supplied live by VideoView and is never passed here (the shared App extractor
 * already covers it).
 *
 * Derived cache, NOT project state → its own non-temporal store (outside zundo).
 */
export interface RegistryEntry {
  glyphs: Map<string, PreparedGlyph>
  metrics: FontMetrics
  family: string
  timing: SectionTiming
}

/** Which characters a referenced font needs available. */
export interface FontCharSpec {
  id: string
  chars: string[]
}

interface FontRegistryState {
  fonts: Map<string, RegistryEntry>
  /** Ensure each font's manifest is loaded and the listed chars are derived. */
  ensureFonts: (specs: FontCharSpec[]) => Promise<void>
}

const inFlightLoad = new Set<string>()
const inFlightDerive = new Set<string>() // `${id}|${char}`
const extractors = new Map<string, GlyphExtractor>()

async function getExtractor(id: string): Promise<GlyphExtractor | null> {
  const cached = extractors.get(id)
  if (cached) return cached
  let bytes: ArrayBuffer | null
  try {
    bytes = await httpStore.loadFontBytes(id)
  } catch {
    return null
  }
  if (!bytes) return null
  // Re-check the cache after the async gap.
  const again = extractors.get(id)
  if (again) return again
  const ex = new GlyphExtractor(bytes)
  extractors.set(id, ex)
  return ex
}

export const useFontRegistry = create<FontRegistryState>((set, get) => ({
  fonts: new Map(),
  ensureFonts: async (specs) => {
    await Promise.all(
      specs.map(async ({ id, chars }) => {
        if (!id) return

        // 1) Load the manifest into an entry (prepared glyphs + metrics + timing).
        if (!get().fonts.has(id) && !inFlightLoad.has(id)) {
          inFlightLoad.add(id)
          try {
            const manifest = await httpStore.load(id)
            if (manifest) {
              const glyphs = new Map<string, PreparedGlyph>()
              for (const key of Object.keys(manifest.glyphs)) {
                try {
                  glyphs.set(manifest.glyphs[key].char, prepareGlyph(manifest.glyphs[key]))
                } catch {
                  /* malformed glyph — skip */
                }
              }
              const m = manifest.metadata
              const entry: RegistryEntry = {
                glyphs,
                metrics: { unitsPerEm: m.unitsPerEm, ascender: m.ascender, descender: m.descender, spaceAdvance: m.spaceAdvance },
                family: m.family,
                timing: manifest.defaultTiming,
              }
              set((s) => ({ fonts: new Map(s.fonts).set(id, entry) }))
            }
          } finally {
            inFlightLoad.delete(id)
          }
        }

        const entry = get().fonts.get(id)
        if (!entry) return // no manifest on disk → can't render this font (renders as missing)

        // 2) Derive any still-missing chars via this font's own extractor.
        const missing = chars.filter(
          (ch) => ch.trim().length > 0 && !entry.glyphs.has(ch) && !inFlightDerive.has(`${id}|${ch}`),
        )
        if (missing.length === 0) return
        const ex = await getExtractor(id)
        if (!ex) return
        for (const ch of missing) inFlightDerive.add(`${id}|${ch}`)
        const sig = extractionSig(DEFAULT_PARAMS)
        const derived: Array<[string, PreparedGlyph]> = []
        await Promise.all(
          missing.map(async (ch) => {
            try {
              const strokes = await ex.extract(ch, DEFAULT_PARAMS)
              derived.push([ch, prepareGlyph(seedGlyphAnimation(strokes, entry.timing, sig, DEFAULT_PARAMS))])
            } catch {
              /* extraction failed for this char — leave it missing */
            } finally {
              inFlightDerive.delete(`${id}|${ch}`)
            }
          }),
        )
        if (derived.length > 0) {
          set((s) => {
            const cur = s.fonts.get(id)
            if (!cur) return s
            const glyphs = new Map(cur.glyphs)
            for (const [ch, pg] of derived) glyphs.set(ch, pg)
            return { fonts: new Map(s.fonts).set(id, { ...cur, glyphs }) }
          })
        }
      }),
    )
  },
}))

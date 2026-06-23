import type { GlyphStrokes } from '@lib/extraction'
import type { LoadedFont } from '@lib/font/load'
import {
  DEFAULT_TIMING,
  MANIFEST_VERSION,
  type FontManifest,
  type GlyphAnimation,
  type SectionTiming,
  type StrokeSection,
} from './schema'

/** Build an editable GlyphAnimation from raw extraction output. */
export function seedGlyphAnimation(
  g: GlyphStrokes,
  timing: SectionTiming = DEFAULT_TIMING,
  derivedSig?: string,
): GlyphAnimation {
  const orderPos = new Map<number, number>()
  g.order.forEach((sectionIdx, pos) => orderPos.set(sectionIdx, pos))

  const sections: StrokeSection[] = g.sections.map((s, i) => ({
    id: s.id,
    points: s.points.map((p, k) => ({ x: p.x, y: p.y, width: s.widths[k] ?? 0 })),
    kind: s.kind,
    orderIndex: orderPos.get(i) ?? i,
    reversed: g.reversed[i] ?? false,
    penLiftAfter: false,
    timing: { ...timing, pauses: [] },
  }))

  return {
    unicode: g.unicode,
    char: g.char,
    advanceWidth: g.advanceWidth,
    bbox: g.bbox,
    sections,
    reviewed: false,
    edited: false,
    derivedSig,
  }
}

/** Create an empty manifest for a font (glyphs filled in as they're extracted). */
export function seedFontManifest(font: LoadedFont, isoNow: string): FontManifest {
  const f = font.font
  return {
    version: MANIFEST_VERSION,
    metadata: {
      fontId: font.hash,
      family: font.family,
      fileName: font.fileName,
      hash: font.hash,
      unitsPerEm: font.unitsPerEm,
      ascender: f.ascender ?? font.unitsPerEm * 0.8,
      descender: f.descender ?? -font.unitsPerEm * 0.2,
    },
    defaultTiming: { ...DEFAULT_TIMING },
    glyphs: {},
    createdAt: isoNow,
    updatedAt: isoNow,
  }
}

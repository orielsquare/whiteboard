import type opentype from 'opentype.js'

/**
 * All Unicode-mapped characters in a font, ordered by code point. Drives the
 * Glyphs overview grid and the prev/next browse arrows (so "next glyph" walks
 * the same sequence the grid shows). Control characters are skipped.
 */
export function listFontChars(font: opentype.Font): string[] {
  const codePoints = new Set<number>()

  // The cmap is the authoritative code-point → glyph map.
  const cmap = (font.tables?.cmap as { glyphIndexMap?: Record<string, number> } | undefined)?.glyphIndexMap
  if (cmap) {
    for (const k of Object.keys(cmap)) {
      const cp = Number(k)
      if (Number.isFinite(cp)) codePoints.add(cp)
    }
  }

  // Fallback for fonts without a parsed cmap: walk the glyph set's unicodes.
  if (codePoints.size === 0) {
    for (let i = 0; i < font.glyphs.length; i++) {
      const g = font.glyphs.get(i)
      const us = g?.unicodes?.length ? g.unicodes : g?.unicode != null ? [g.unicode] : []
      for (const cp of us) codePoints.add(cp)
    }
  }

  return [...codePoints]
    .filter((cp) => cp >= 0x20 && cp !== 0x7f) // drop C0/C1 control chars
    .sort((a, b) => a - b)
    .map((cp) => String.fromCodePoint(cp))
}

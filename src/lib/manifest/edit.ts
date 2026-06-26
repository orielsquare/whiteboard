import { dist } from '@lib/geometry/vec'
import type { GlyphAnimation, StrokeSection } from './schema'

/** Stable id for a newly created section. */
function makeId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 's-' + Math.random().toString(36).slice(2, 10)
  }
}

/** Reassign orderIndex 0..n-1 from the array's current order. */
function reindex(sections: StrokeSection[]): StrokeSection[] {
  return sections.map((s, i) => ({ ...s, orderIndex: i }))
}

/** Sections in draw order. */
export function orderedSections(glyph: GlyphAnimation): StrokeSection[] {
  return [...glyph.sections].sort((a, b) => a.orderIndex - b.orderIndex)
}

/** Reorder by an explicit list of section ids (e.g. from the section list UI). */
export function setSectionOrder(glyph: GlyphAnimation, orderedIds: string[]): GlyphAnimation {
  const byId = new Map(glyph.sections.map((s) => [s.id, s]))
  const ordered = orderedIds.map((id) => byId.get(id)).filter((s): s is StrokeSection => !!s)
  // append any sections not named (safety)
  for (const s of glyph.sections) if (!orderedIds.includes(s.id)) ordered.push(s)
  return { ...glyph, sections: reindex(ordered) }
}

/** Move a section one slot earlier/later in the draw order. */
export function moveSection(glyph: GlyphAnimation, id: string, dir: -1 | 1): GlyphAnimation {
  const ordered = orderedSections(glyph)
  const i = ordered.findIndex((s) => s.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= ordered.length) return glyph
  ;[ordered[i], ordered[j]] = [ordered[j], ordered[i]]
  return { ...glyph, sections: reindex(ordered) }
}

export function toggleReversed(glyph: GlyphAnimation, id: string): GlyphAnimation {
  return {
    ...glyph,
    sections: glyph.sections.map((s) => (s.id === id ? { ...s, reversed: !s.reversed } : s)),
  }
}

export function deleteSection(glyph: GlyphAnimation, id: string): GlyphAnimation {
  return { ...glyph, sections: reindex(orderedSections(glyph).filter((s) => s.id !== id)) }
}

export function updateSectionTiming(
  glyph: GlyphAnimation,
  id: string,
  patch: Partial<StrokeSection['timing']>,
): GlyphAnimation {
  return {
    ...glyph,
    sections: glyph.sections.map((s) =>
      s.id === id ? { ...s, timing: { ...s.timing, ...patch } } : s,
    ),
  }
}

/**
 * Split a section in two at point index `at` (the cut point is shared by both
 * halves). Used to separate, e.g., an 'r' that came out as one stroke into a
 * vertical and an arch.
 */
export function splitSection(glyph: GlyphAnimation, id: string, at: number): GlyphAnimation {
  const ordered = orderedSections(glyph)
  const pos = ordered.findIndex((s) => s.id === id)
  if (pos < 0) return glyph
  const s = ordered[pos]
  if (s.points.length < 3) return glyph
  const i = Math.max(1, Math.min(s.points.length - 2, at))
  const a: StrokeSection = {
    id: makeId(),
    points: s.points.slice(0, i + 1),
    kind: 'curve',
    orderIndex: 0,
    reversed: s.reversed,
    timing: { ...s.timing, pauses: [] },
  }
  const b: StrokeSection = {
    id: makeId(),
    points: s.points.slice(i),
    kind: 'curve',
    orderIndex: 0,
    reversed: s.reversed,
    timing: { ...s.timing, pauses: [] },
  }
  ordered.splice(pos, 1, a, b)
  return { ...glyph, sections: reindex(ordered) }
}

/**
 * Merge two sections end-to-end into one. The nearest pair of endpoints is
 * connected (sections auto-oriented), so order of selection doesn't matter.
 * Used to rejoin, e.g., two halves of an 'r' vertical into one stroke.
 */
export function mergeSections(glyph: GlyphAnimation, idA: string, idB: string): GlyphAnimation {
  if (idA === idB) return glyph
  const a = glyph.sections.find((s) => s.id === idA)
  const b = glyph.sections.find((s) => s.id === idB)
  if (!a || !b) return glyph

  const aS = a.points[0]
  const aE = a.points[a.points.length - 1]
  const bS = b.points[0]
  const bE = b.points[b.points.length - 1]
  const opts = [
    { d: dist(aE, bS), aRev: false, bRev: false },
    { d: dist(aE, bE), aRev: false, bRev: true },
    { d: dist(aS, bS), aRev: true, bRev: false },
    { d: dist(aS, bE), aRev: true, bRev: true },
  ].sort((x, y) => x.d - y.d)
  const best = opts[0]

  const aPts = best.aRev ? [...a.points].reverse() : a.points
  const bPts = best.bRev ? [...b.points].reverse() : b.points
  const merged = [...aPts, ...bPts.slice(1)] // drop the shared/near join point

  const newSec: StrokeSection = {
    id: makeId(),
    points: merged,
    kind: 'curve',
    orderIndex: 0,
    reversed: false,
    timing: { ...a.timing },
  }

  const result: StrokeSection[] = []
  for (const s of orderedSections(glyph)) {
    if (s.id === idA) result.push(newSec)
    else if (s.id === idB) continue
    else result.push(s)
  }
  return { ...glyph, sections: reindex(result) }
}

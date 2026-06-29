import { dist } from '@lib/geometry/vec'
import type { PartSection } from './schema'

/**
 * Pure split/merge/reorder/flip/delete on a drawing PART's stroke sections — the
 * Drawing analogue of `manifest/edit.ts` (which edits a glyph's sections). Unlike
 * glyph sections, a `PartSection` carries no per-section order/reverse/timing (the
 * PART owns those), so draw order is just the array order, and "flip" reverses the
 * point list in place. All helpers return a NEW array (immutable). Used so a user
 * can break a stroke that came out as one piece into two, or rejoin fragments.
 */

function makeId(prefix = 'sec'): string {
  try {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
  } catch {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/** Reorder by an explicit id list (e.g. from a drag); unnamed sections kept at end. */
export function reorderSections(sections: PartSection[], orderedIds: string[]): PartSection[] {
  const byId = new Map(sections.map((s) => [s.id, s]))
  const out = orderedIds.map((id) => byId.get(id)).filter((s): s is PartSection => !!s)
  for (const s of sections) if (!orderedIds.includes(s.id)) out.push(s)
  return out
}

/** Move a section one slot earlier/later in the draw order. */
export function moveSection(sections: PartSection[], id: string, dir: -1 | 1): PartSection[] {
  const i = sections.findIndex((s) => s.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= sections.length) return sections
  const out = [...sections]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

/** Reverse a section's drawing direction (its point order). */
export function flipSection(sections: PartSection[], id: string): PartSection[] {
  return sections.map((s) => (s.id === id ? { ...s, points: [...s.points].reverse() } : s))
}

export function deleteSection(sections: PartSection[], id: string): PartSection[] {
  return sections.filter((s) => s.id !== id)
}

/**
 * Split a section in two. The cut point (defaults to the midpoint) is shared by
 * both halves, which become open `curve`s. Used to separate a stroke that the
 * extractor produced as a single piece.
 */
export function splitSection(sections: PartSection[], id: string, at?: number): PartSection[] {
  const pos = sections.findIndex((s) => s.id === id)
  if (pos < 0) return sections
  const s = sections[pos]
  if (s.points.length < 2) return sections
  // A straight 2-point stroke has no interior vertex to cut at — insert a midpoint
  // so even the simplest stroke can be broken in two.
  let pts = s.points
  let cut = at
  if (pts.length === 2) {
    const A = s.points[0]
    const B = s.points[1]
    pts = [A, { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, width: (A.width + B.width) / 2 }, B]
    cut = 1
  }
  const i = Math.max(1, Math.min(pts.length - 2, cut == null ? Math.floor(pts.length / 2) : cut))
  const a: PartSection = { id: makeId(), points: pts.slice(0, i + 1), kind: 'curve' }
  const b: PartSection = { id: makeId(), points: pts.slice(i), kind: 'curve' }
  const out = [...sections]
  out.splice(pos, 1, a, b)
  return out
}

/**
 * Merge two sections end-to-end into one. The nearest pair of endpoints is joined
 * (sections auto-oriented), so selection order doesn't matter. The merged section
 * takes the array slot of the first; the second is removed.
 */
export function mergeSections(sections: PartSection[], idA: string, idB: string): PartSection[] {
  if (idA === idB) return sections
  const a = sections.find((s) => s.id === idA)
  const b = sections.find((s) => s.id === idB)
  if (!a || !b || a.points.length < 2 || b.points.length < 2) return sections

  const aS = a.points[0]
  const aE = a.points[a.points.length - 1]
  const bS = b.points[0]
  const bE = b.points[b.points.length - 1]
  const best = [
    { d: dist(aE, bS), aRev: false, bRev: false },
    { d: dist(aE, bE), aRev: false, bRev: true },
    { d: dist(aS, bS), aRev: true, bRev: false },
    { d: dist(aS, bE), aRev: true, bRev: true },
  ].sort((x, y) => x.d - y.d)[0]

  const aPts = best.aRev ? [...a.points].reverse() : a.points
  const bPts = best.bRev ? [...b.points].reverse() : b.points
  const merged: PartSection = {
    id: makeId(),
    points: [...aPts, ...bPts.slice(1)], // drop the shared/near join point
    kind: 'curve',
  }

  const out: PartSection[] = []
  for (const s of sections) {
    if (s.id === idA) out.push(merged)
    else if (s.id === idB) continue
    else out.push(s)
  }
  return out
}

import { polylineLength, type Vec2 } from '@lib/geometry/vec'
import type { SectionKind } from './types'

interface OrderableSection {
  points: Vec2[]
  componentId: number
  kind: SectionKind
}

/**
 * Default natural-handwriting order + direction. These are only starting points;
 * the editor lets a human override every choice.
 *  - vertical strokes draw top→bottom, horizontal strokes left→right
 *  - sections sorted top-to-bottom then left-to-right by their start point
 *  - components drawn largest-first (body before the i/j dot or an accent)
 */
export function computeOrder(sections: OrderableSection[]): {
  order: number[]
  reversed: boolean[]
} {
  const n = sections.length
  const reversed = sections.map((s) => defaultReversed(s))

  // total centerline length per component → larger components drawn first
  const compLen = new Map<number, number>()
  for (const s of sections) {
    compLen.set(s.componentId, (compLen.get(s.componentId) ?? 0) + polylineLength(s.points))
  }

  const startOf = (i: number): Vec2 => {
    const s = sections[i]
    return reversed[i] ? s.points[s.points.length - 1] : s.points[0]
  }

  // tolerance band so near-equal heights tie-break by x rather than by noise
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const y = startOf(i).y
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const tolY = Math.max(1e-6, (maxY - minY) * 0.12)

  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => {
    const ca = sections[a].componentId
    const cb = sections[b].componentId
    if (ca !== cb) {
      const la = compLen.get(ca) as number
      const lb = compLen.get(cb) as number
      if (la !== lb) return lb - la // bigger component first
      return ca - cb
    }
    const sa = startOf(a)
    const sb = startOf(b)
    if (Math.abs(sa.y - sb.y) > tolY) return sa.y - sb.y // smaller y = higher up (y-down)
    return sa.x - sb.x
  })

  return { order, reversed }
}

function defaultReversed(s: OrderableSection): boolean {
  if (s.kind === 'loop' || s.points.length < 2) return false
  const p0 = s.points[0]
  const p1 = s.points[s.points.length - 1]
  const dx = Math.abs(p1.x - p0.x)
  const dy = Math.abs(p1.y - p0.y)
  if (dy >= dx) {
    return p0.y > p1.y // vertical: ensure top→bottom (start at smaller y)
  }
  return p0.x > p1.x // horizontal: ensure left→right
}

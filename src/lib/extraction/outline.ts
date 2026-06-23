import opentype from 'opentype.js'
import type { Vec2 } from '@lib/geometry/vec'
import type { Contour } from './types'

export interface GlyphOutline {
  contours: Contour[]
  advanceWidth: number
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
  unicode: number
  empty: boolean
}

/** opentype path commands as a discriminated union (the bundled types are looser). */
type Cmd =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'Z' }

/**
 * Flatten a glyph's filled outline into polyline contours in glyph units (y-down).
 * `flattenTol` is the max chord deviation (glyph units) when subdividing beziers.
 */
export function getGlyphOutline(
  font: opentype.Font,
  char: string,
  flattenTol: number,
): GlyphOutline {
  const glyph = font.charToGlyph(char)
  const path = glyph.getPath(0, 0, font.unitsPerEm)
  const commands = path.commands as unknown as Cmd[]

  const contours: Contour[] = []
  let cur: Vec2[] = []
  let start: Vec2 | null = null
  let prev: Vec2 | null = null

  const flush = (closed: boolean) => {
    if (cur.length > 1) contours.push({ points: cur, closed })
    cur = []
  }

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        flush(false)
        cur = [{ x: cmd.x, y: cmd.y }]
        start = { x: cmd.x, y: cmd.y }
        prev = start
        break
      case 'L':
        cur.push({ x: cmd.x, y: cmd.y })
        prev = { x: cmd.x, y: cmd.y }
        break
      case 'C':
        flattenCubic(
          prev!,
          { x: cmd.x1, y: cmd.y1 },
          { x: cmd.x2, y: cmd.y2 },
          { x: cmd.x, y: cmd.y },
          flattenTol,
          cur,
          0,
        )
        prev = { x: cmd.x, y: cmd.y }
        break
      case 'Q':
        flattenQuad(prev!, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x, y: cmd.y }, flattenTol, cur, 0)
        prev = { x: cmd.x, y: cmd.y }
        break
      case 'Z':
        flush(true)
        prev = start
        break
    }
  }
  flush(false)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of contours) {
    for (const p of c.points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  const empty = contours.length === 0 || !isFinite(minX)

  return {
    contours,
    advanceWidth: glyph.advanceWidth ?? 0,
    bbox: empty ? { minX: 0, minY: 0, maxX: 0, maxY: 0 } : { minX, minY, maxX, maxY },
    unicode: char.codePointAt(0) ?? 0,
    empty,
  }
}

const MAX_DEPTH = 18

function flattenCubic(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  tol: number,
  out: Vec2[],
  depth: number,
) {
  if (depth >= MAX_DEPTH || cubicFlatEnough(p0, p1, p2, p3, tol)) {
    out.push(p3)
    return
  }
  // de Casteljau subdivide at t = 0.5
  const p01 = mid(p0, p1)
  const p12 = mid(p1, p2)
  const p23 = mid(p2, p3)
  const p012 = mid(p01, p12)
  const p123 = mid(p12, p23)
  const p0123 = mid(p012, p123)
  flattenCubic(p0, p01, p012, p0123, tol, out, depth + 1)
  flattenCubic(p0123, p123, p23, p3, tol, out, depth + 1)
}

function flattenQuad(p0: Vec2, p1: Vec2, p2: Vec2, tol: number, out: Vec2[], depth: number) {
  if (depth >= MAX_DEPTH || quadFlatEnough(p0, p1, p2, tol)) {
    out.push(p2)
    return
  }
  const p01 = mid(p0, p1)
  const p12 = mid(p1, p2)
  const p012 = mid(p01, p12)
  flattenQuad(p0, p01, p012, tol, out, depth + 1)
  flattenQuad(p012, p12, p2, tol, out, depth + 1)
}

const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

function cubicFlatEnough(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tol: number): boolean {
  return distPointLine(p1, p0, p3) <= tol && distPointLine(p2, p0, p3) <= tol
}
function quadFlatEnough(p0: Vec2, p1: Vec2, p2: Vec2, tol: number): boolean {
  return distPointLine(p1, p0, p2) <= tol
}

/** Perpendicular distance from p to the infinite line through a,b. */
function distPointLine(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l = Math.hypot(dx, dy)
  if (l === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / l
}

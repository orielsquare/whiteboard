import opentype from 'opentype.js'
import { dist, polylineLength, type Vec2 } from '@lib/geometry/vec'
import { cleanupSection } from './cleanup'
import { distanceTransform } from './distanceTransform'
import { extractSections, linkSectionsAtJunctions, pruneLeafSections } from './graph'
import { computeOrder } from './order'
import { getGlyphOutline } from './outline'
import { rasterize, rasterToGlyph } from './raster'
import { thinGuoHall } from './skeletonize'
import type {
  DebugNode,
  ExtractedSection,
  ExtractionParams,
  GlyphStrokes,
  SectionKind,
} from './types'

/** Run the full raster-thinning extraction pipeline for one glyph. */
export function extractGlyph(
  font: opentype.Font,
  char: string,
  params: ExtractionParams,
  debug = false,
): GlyphStrokes {
  const ch = [...char][0] ?? ' '
  const flattenTol = font.unitsPerEm / 2000
  const outline = getGlyphOutline(font, ch, flattenTol)

  const base: GlyphStrokes = {
    char: ch,
    unicode: ch.codePointAt(0) ?? 0,
    unitsPerEm: font.unitsPerEm,
    advanceWidth: outline.advanceWidth,
    bbox: {
      x: outline.bbox.minX,
      y: outline.bbox.minY,
      w: outline.bbox.maxX - outline.bbox.minX,
      h: outline.bbox.maxY - outline.bbox.minY,
    },
    sections: [],
    order: [],
    reversed: [],
    warnings: [],
  }

  if (outline.empty) {
    base.warnings.push('no-outline')
    return base
  }

  const mask = rasterize(outline.contours, outline.bbox, params.targetInkPx, params.pad)
  const dt = distanceTransform(mask.data, mask.width, mask.height)
  const skel = thinGuoHall(mask.data, mask.width, mask.height)

  const graph = extractSections(skel, mask.width, mask.height)
  const { nodes, deg } = graph
  const linked = linkSectionsAtJunctions(graph.sections, deg, mask.width)
  const finalSecs = pruneLeafSections(linked, deg, dt, mask.width, params.pruneK)

  const sections: ExtractedSection[] = []
  for (const ps of finalSecs) {
    const a = ps.pixels[0]
    const b = ps.pixels[ps.pixels.length - 1]
    const freeStart = deg[a] === 1
    const freeEnd = deg[b] === 1
    const clean = cleanupSection(ps.pixels, ps.kind, mask, dt, params, freeStart, freeEnd)
    if (clean.points.length === 0) continue
    sections.push({
      id: makeId(),
      points: clean.points,
      widths: clean.widths,
      kind: classifyKind(clean.points, ps.kind),
      componentId: ps.componentId,
      degA: ps.degA,
      degB: ps.degB,
    })
  }

  const { order, reversed } = computeOrder(sections)
  base.sections = sections
  base.order = order
  base.reversed = reversed

  // warnings
  if (sections.length === 0) base.warnings.push('no-strokes')
  const avgW = averageWidth(sections)
  const minDim = Math.min(base.bbox.w, base.bbox.h)
  if (minDim > 0 && avgW > 0.4 * minDim) {
    base.warnings.push('thick-font: centerline may be unreliable')
  }

  if (debug) {
    const debugNodes: DebugNode[] = nodes.map((n) => {
      const g = rasterToGlyph(mask, n.index % mask.width, Math.floor(n.index / mask.width))
      return { x: g.x, y: g.y, degree: n.degree }
    })
    base.debug = {
      maskWidth: mask.width,
      maskHeight: mask.height,
      scale: mask.scale,
      pad: mask.pad,
      originX: mask.originX,
      originY: mask.originY,
      skeleton: skel,
      outline: outline.contours,
      nodes: debugNodes,
    }
  }

  return base
}

function classifyKind(points: Vec2[], rawKind: SectionKind): SectionKind {
  if (rawKind === 'loop') return 'loop'
  if (points.length < 3) return 'line'
  const chord = dist(points[0], points[points.length - 1])
  const path = polylineLength(points)
  return path > 0 && chord / path > 0.97 ? 'line' : 'curve'
}

function averageWidth(sections: ExtractedSection[]): number {
  let sum = 0
  let count = 0
  for (const s of sections) {
    for (const w of s.widths) {
      sum += w
      count++
    }
  }
  return count > 0 ? sum / count : 0
}

function makeId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 's-' + Math.floor(Math.random() * 1e9).toString(36)
  }
}

import type { Vec2 } from '@lib/geometry/vec'

export type { Vec2 }

/**
 * Coordinate convention used throughout extraction:
 * "glyph units" = font design units as returned by opentype `getPath(0,0,unitsPerEm)`,
 * i.e. y-DOWN with the baseline at y=0 (ascenders are negative y).
 */

/** A flattened outline contour in glyph units. */
export interface Contour {
  points: Vec2[]
  closed: boolean
}

/** Tunable parameters for the extraction pipeline. */
export interface ExtractionParams {
  /** Target size (px) of the glyph's larger dimension when rasterized. */
  targetInkPx: number
  /** Empty border (px) around the rasterized glyph. */
  pad: number
  /** Spur pruning aggressiveness: leaf strokes shorter than k·localWidth are removed. */
  pruneK: number
  /** Ramer–Douglas–Peucker simplification tolerance (px). */
  rdpEpsilonPx: number
  /** Turn angle (deg) above which a vertex is treated as a hard corner (never smoothed). */
  cornerAngleDeg: number
  /** Even-resampling spacing (px) for the smoothed centerline. */
  resampleSpacingPx: number
  /** Apply Catmull-Rom smoothing (vs. raw simplified polyline). */
  smooth: boolean
}

/**
 * Stable signature of the extraction-relevant params, used to detect when a
 * glyph is stale w.r.t. the current params (debug is intentionally not a param).
 */
export function extractionSig(p: ExtractionParams): string {
  return [
    p.targetInkPx,
    p.pad,
    p.pruneK,
    p.rdpEpsilonPx,
    p.cornerAngleDeg,
    p.resampleSpacingPx,
    p.smooth,
  ].join('|')
}

export type SectionKind = 'line' | 'curve' | 'loop'

/** One pen-stroke section: a centerline polyline + per-point width, in glyph units. */
export interface ExtractedSection {
  id: string
  points: Vec2[]
  widths: number[]
  kind: SectionKind
  componentId: number
  /** Graph degrees of the two ends (1 = free endpoint, ≥3 = junction, 0 = loop/dot). */
  degA: number
  degB: number
}

export interface DebugNode {
  x: number
  y: number
  degree: number
}

/** Optional payload for the visual debug overlay (all in glyph units unless noted). */
export interface GlyphDebug {
  maskWidth: number
  maskHeight: number
  scale: number
  pad: number
  originX: number
  originY: number
  /** Final (pruned) 1px skeleton bitmap, row-major, length maskWidth*maskHeight. */
  skeleton: Uint8Array
  outline: Contour[]
  nodes: DebugNode[]
}

/** The full extracted-strokes record for a single glyph. */
export interface GlyphStrokes {
  char: string
  unicode: number
  unitsPerEm: number
  advanceWidth: number
  bbox: { x: number; y: number; w: number; h: number }
  sections: ExtractedSection[]
  /** Default draw order: indices into `sections`. */
  order: number[]
  /** Default per-section direction (parallel to `sections`). */
  reversed: boolean[]
  warnings: string[]
  debug?: GlyphDebug
}

export const DEFAULT_PARAMS: ExtractionParams = {
  targetInkPx: 256,
  pad: 12,
  pruneK: 1.25,
  rdpEpsilonPx: 1.0,
  cornerAngleDeg: 55,
  resampleSpacingPx: 3,
  smooth: true,
}

import type { SectionKind, StrokePoint } from '@lib/manifest/schema'

/**
 * Shared types for the SVG → pen-stroke pipeline. Mirrors the font extraction
 * layer: parsing/sampling produces raw geometry sections here, and the drawing
 * `seed` assembles them into editable `DrawingElement`s (ids + timing + order),
 * exactly as `seedGlyphAnimation` does for fonts. All coordinates are SVG
 * **viewBox units** (y-down), matching the glyph convention (y-down) so the same
 * ribbon/reveal renderer drives both.
 */

export type { StrokePoint, SectionKind }

/** Parameters for converting an SVG fill region into hand-shading hatch strokes. */
export interface FillParams {
  /** Hatch angle in degrees; positive slopes up-to-the-right (a right-hander). */
  angleDeg: number
  /** Perpendicular gap between successive hatch lines (viewBox units). */
  spacingPx: number
  /** Pen width of each hatch stroke (viewBox units). */
  lineWidthPx: number
  /** 0..1 deterministic hand-wobble applied to each line's perpendicular OFFSET
   *  (varies the spacing between lines). */
  jitter?: number
  /** Per-stroke irregularity: max turn (degrees, ~0..2) added at sub-vertices along
   *  each hatch line, kept within a band of the ideal straight line. 0 ⇒ straight. */
  lineWobbleDeg?: number
}

/** Parameters for sampling an SVG outline into a pen-stroke centerline. */
export interface StrokeParams {
  /** Even-resampling spacing along the path (viewBox units). */
  resampleSpacingPx: number
  /** Floor on pen width (viewBox units). */
  minWidthPx?: number
  /** Multiplier on the outline pen width (the SVG stroke-width). Absent ⇒ 1. */
  widthScale?: number
}

export type SectionRole = 'outline' | 'fill'

/** A generated pen-stroke section: geometry only; ids/timing/order are assigned
 *  later by the drawing seed (cf. `ExtractedSection` → `StrokeSection`). */
export interface GenSection {
  points: StrokePoint[]
  kind: SectionKind
  role: SectionRole
}

export const DEFAULT_FILL_PARAMS: FillParams = {
  angleDeg: 45,
  spacingPx: 6,
  lineWidthPx: 2.5,
  jitter: 0.15,
  lineWobbleDeg: 0,
}

export const DEFAULT_STROKE_PARAMS: StrokeParams = {
  resampleSpacingPx: 3,
  minWidthPx: 1,
  widthScale: 1,
}

/** Stable signature of the fill params (staleness detection, like `extractionSig`). */
export function fillSig(p: FillParams): string {
  return [p.angleDeg, p.spacingPx, p.lineWidthPx, p.jitter ?? 0, p.lineWobbleDeg ?? 0].join('|')
}

/** Stable signature of the stroke-sampling params. */
export function strokeSig(p: StrokeParams): string {
  return [p.resampleSpacingPx, p.minWidthPx ?? 0, p.widthScale ?? 1].join('|')
}

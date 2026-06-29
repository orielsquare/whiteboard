import type { Bbox, SectionKind, StrokePoint } from '@lib/manifest/schema'
import type { EasingName } from '@lib/geometry/easing'
import type { FillParams, StrokeParams } from '@lib/svg/types'

/**
 * The editable "drawing" manifest — the SVG analogue of `FontManifest`. An SVG
 * file becomes drawable **elements** (the geometry/derivation unit, one per SVG
 * node) whose pen strokes are grouped into **parts** (the animation/display unit:
 * an `outline` part and/or a `fill` part). Parts are what the user manages — they
 * are renamed, hidden, individually coloured, timed (own speed + easing), and
 * drag-reordered, mirroring how the Font editor manages a glyph's sections.
 *
 * Geometry is immutable extraction output (re-derivable from the element's params
 * + the source SVG); editorial intent (order, timing, colour, visibility) lives
 * on the parts. All coordinates are SVG **viewBox units** (y-down), matching the
 * glyph convention so the ribbon renderer drives both.
 */

export const DRAWING_VERSION = 2 as const

export type PartKind = 'outline' | 'fill'

/** A baked stroke (outline subpath or one hatch run); geometry only. */
export interface PartSection {
  id: string
  points: StrokePoint[]
  kind: SectionKind
}

/** How a whole part draws: one constant-speed motion across all its sections,
 *  eased once over `durationMs` (so a fill shades evenly — natural hand-shading).
 *  Mirrors the Font editor's per-section timing controls, applied per part. */
export interface PartTiming {
  /** total time to draw the entire part (ms). */
  durationMs: number
  /** gap before the part begins, measured from the previous part's end (ms). */
  delayBeforeMs: number
  easing: EasingName
}

export interface DrawingPart {
  id: string
  /** the geometry element this part is derived from (for re-derivation). */
  elementId: string
  kind: PartKind
  /** user-editable label shown in the list. */
  name: string
  /** stacking/paint order (1-indexed; higher = drawn on top). INDEPENDENT of the
   *  array position, which is the DRAW (animation) order — the two are decoupled. */
  zOrder: number
  /** hidden parts are skipped by the render AND contribute no time to the timeline. */
  visible: boolean
  /** per-part colour; null/undefined ⇒ use the brush colour. */
  color?: string | null
  /** per-part alpha (0..1); undefined ⇒ use the brush opacity. Below 1, overlapping
   *  strokes build up — a "colouring-in" effect, best with the ink brush. */
  opacity?: number
  sections: PartSection[]
  timing: PartTiming
}

/** The geometry/derivation source for an SVG node. Not animated directly — its
 *  strokes live on the parts that reference it. */
export interface DrawingElement {
  id: string
  sourceId: string
  label: string
  bbox: Bbox
  hasOutline: boolean
  hasFill: boolean
  /** when true, a fill-only shape also traces its boundary (adds an outline part). */
  outlineFill?: boolean
  /** signature of the params the parts were derived from (`elementSig`). */
  derivedSig?: string
  strokeParams?: StrokeParams
  fillParams?: FillParams
}

export interface DrawingMetadata {
  drawingId: string
  name: string
  fileName?: string
  viewBox: Bbox
  hash: string
}

/** Top-level editable artifact: one JSON file = one SVG's animation treatment. */
export interface DrawingManifest {
  version: number
  metadata: DrawingMetadata
  /** the original SVG source text — kept so a re-opened drawing can still
   *  re-derive geometry when params change (cf. fonts storing their .ttf bytes). */
  source?: string
  /** geometry sources (one per SVG node). */
  elements: DrawingElement[]
  /** ordered animation/display units — THIS array is the draw order. */
  parts: DrawingPart[]
  createdAt: string
  updatedAt: string
}

/** Combined staleness signature for an element's stroke + fill params. */
export function elementSig(strokeSig: string, fillSig: string): string {
  return `${strokeSig}#${fillSig}`
}

import type { EasingName } from '@lib/geometry/easing'
import { deriveSections } from '@lib/svg/derive'
import type { ParsedElement, ParsedSvg } from '@lib/svg/parse'
import {
  DEFAULT_FILL_PARAMS,
  DEFAULT_STROKE_PARAMS,
  fillSig,
  strokeSig,
  type GenSection,
} from '@lib/svg/types'
import {
  DRAWING_VERSION,
  elementSig,
  type DrawingElement,
  type DrawingManifest,
  type DrawingPart,
  type PartKind,
  type PartSection,
  type PartTiming,
} from './schema'

function uid(prefix: string): string {
  try {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
  } catch {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
  }
}

// Default pen cadence, in viewBox units per ms. Fill is faster + linear so it
// reads as a quick even scribble; an outline accelerates/decelerates naturally.
const OUTLINE_SPEED = 0.7
const FILL_SPEED = 2.4

function polylineLen(points: { x: number; y: number }[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  return total
}

function totalLen(sections: PartSection[]): number {
  return sections.reduce((a, s) => a + polylineLen(s.points), 0)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Natural default timing for a freshly-derived part, scaled by its ink length. */
export function defaultPartTiming(kind: PartKind, len: number): PartTiming {
  if (kind === 'outline') {
    return { durationMs: clamp(Math.round(len / OUTLINE_SPEED), 250, 2500), delayBeforeMs: 120, easing: 'cubicInOut' as EasingName }
  }
  return { durationMs: clamp(Math.round(len / FILL_SPEED), 250, 3500), delayBeforeMs: 60, easing: 'linear' as EasingName }
}

/** Bake generated geometry of one role into part sections (stable ids). */
export function sectionsForKind(elementId: string, kind: PartKind, gen: GenSection[]): PartSection[] {
  return gen
    .filter((g) => g.role === kind)
    .map((g, i) => ({ id: `${elementId}-${kind}-s${i}`, points: g.points, kind: g.kind }))
}

function makePart(elementId: string, kind: PartKind, name: string, sections: PartSection[]): DrawingPart {
  return {
    id: uid('part'),
    elementId,
    kind,
    name,
    zOrder: 0, // assigned by withContiguousZ once the full set is known
    visible: true,
    color: null,
    sections,
    timing: defaultPartTiming(kind, totalLen(sections)),
  }
}

/** Reassign `zOrder` to a contiguous 1..N, preserving the existing relative z
 *  order; freshly-created parts (zOrder 0) are stacked on top (highest z). */
export function withContiguousZ(parts: DrawingPart[]): DrawingPart[] {
  const ranked = parts.map((p, i) => ({ i, z: p.zOrder && p.zOrder > 0 ? p.zOrder : Number.POSITIVE_INFINITY }))
  ranked.sort((a, b) => a.z - b.z || a.i - b.i)
  const rank = new Map<number, number>()
  ranked.forEach((e, idx) => rank.set(e.i, idx + 1))
  return parts.map((p, i) => (p.zOrder === rank.get(i) ? p : { ...p, zOrder: rank.get(i)! }))
}

/** Build a geometry element + its (outline / fill) parts from a parsed SVG node. */
export function seedDrawingElement(pe: ParsedElement): { element: DrawingElement; parts: DrawingPart[] } {
  const strokeParams = { ...DEFAULT_STROKE_PARAMS }
  const fillParams = { ...DEFAULT_FILL_PARAMS }
  const id = uid('el')
  const element: DrawingElement = {
    id,
    sourceId: pe.sourceId,
    label: pe.label,
    bbox: pe.bbox,
    hasOutline: pe.hasStroke,
    hasFill: pe.hasFill,
    derivedSig: elementSig(strokeSig(strokeParams), fillSig(fillParams)),
    strokeParams,
    fillParams,
  }
  const gen = deriveSections(pe, { strokeParams, fillParams })
  const parts: DrawingPart[] = []
  const outline = sectionsForKind(id, 'outline', gen)
  const fill = sectionsForKind(id, 'fill', gen)
  if (outline.length) parts.push(makePart(id, 'outline', `${pe.label} · outline`, outline))
  if (fill.length) parts.push(makePart(id, 'fill', `${pe.label} · shading`, fill))
  return { element, parts }
}

/** Re-derive an element's geometry from its CURRENT params → section groups by
 *  kind. The store reconciles these into the existing parts (preserving their
 *  name/colour/visibility/timing/order). */
export function rederiveElement(
  el: DrawingElement,
  pe: ParsedElement,
): { outline: PartSection[]; fill: PartSection[]; derivedSig: string } {
  const sp = el.strokeParams ?? DEFAULT_STROKE_PARAMS
  const fp = el.fillParams ?? DEFAULT_FILL_PARAMS
  const gen = deriveSections(pe, { strokeParams: sp, fillParams: fp, outlineFill: el.outlineFill })
  return {
    outline: sectionsForKind(el.id, 'outline', gen),
    fill: sectionsForKind(el.id, 'fill', gen),
    derivedSig: elementSig(strokeSig(sp), fillSig(fp)),
  }
}

/** Build a fresh outline/fill part pair for an element (used when toggling
 *  outlineFill, which structurally adds/removes the outline part). */
export function buildElementParts(el: DrawingElement, sections: { outline: PartSection[]; fill: PartSection[] }): DrawingPart[] {
  const parts: DrawingPart[] = []
  if (sections.outline.length) parts.push(makePart(el.id, 'outline', `${el.label} · outline`, sections.outline))
  if (sections.fill.length) parts.push(makePart(el.id, 'fill', `${el.label} · shading`, sections.fill))
  return parts
}

/** Reconcile freshly-built parts for an element against its EXISTING parts: a kind
 *  that still exists keeps ALL of its editorial state (id, name, colour, alpha,
 *  visibility, timing, z) and takes only the re-derived geometry; a newly-appearing
 *  kind keeps its fresh default. Used when toggling `outlineFill`, which structurally
 *  adds or removes the outline part but must NEVER reset the surviving shading part
 *  (its name, colour, timing, … stay exactly as the user left them). */
export function reconcileElementParts(prev: DrawingPart[], fresh: DrawingPart[]): DrawingPart[] {
  const prevByKind = new Map<PartKind, DrawingPart>()
  for (const p of prev) if (!prevByKind.has(p.kind)) prevByKind.set(p.kind, p)
  return fresh.map((fp) => {
    const keep = prevByKind.get(fp.kind)
    return keep ? { ...keep, sections: fp.sections } : fp
  })
}

export function seedDrawingManifest(
  parsed: ParsedSvg,
  name: string,
  hash: string,
  isoNow: string,
  fileName?: string,
  source?: string,
): DrawingManifest {
  const elements: DrawingElement[] = []
  const parts: DrawingPart[] = []
  for (const pe of parsed.elements) {
    const seeded = seedDrawingElement(pe)
    elements.push(seeded.element)
    parts.push(...seeded.parts)
  }
  return {
    version: DRAWING_VERSION,
    metadata: { drawingId: hash, name, fileName, viewBox: parsed.viewBox, hash },
    source,
    elements,
    parts: withContiguousZ(parts),
    createdAt: isoNow,
    updatedAt: isoNow,
  }
}

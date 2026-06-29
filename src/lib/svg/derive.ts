import { strokeFromPolyline } from './centerline'
import { generateHatch } from './hatch'
import type { ParsedElement } from './parse'
import {
  DEFAULT_FILL_PARAMS,
  DEFAULT_STROKE_PARAMS,
  type FillParams,
  type GenSection,
  type StrokeParams,
} from './types'

export interface DeriveOptions {
  strokeParams?: StrokeParams
  fillParams?: FillParams
  /** also trace the boundary of a fill-only shape (a person sketches the edge first). */
  outlineFill?: boolean
  /** draw a fill's BOUNDARY as pen strokes INSTEAD of hatch shading — "coerce the
   *  fill into a path". The traced strokes take role 'fill' so they replace the
   *  shading in the element's existing fill part (keeping its name/colour/timing). */
  asOutline?: boolean
}

/**
 * Turn a parsed SVG element into ordered pen-stroke sections in natural drawing
 * order: outline strokes first, then the hatch shading. Pure — the same engine
 * runs in the editor and on re-derivation when params change. SVG fill semantics
 * implicitly close every subpath, so all subpaths feed the even-odd hatch (holes
 * fall out for free).
 */
export function deriveSections(el: ParsedElement, opts: DeriveOptions = {}): GenSection[] {
  const sp = opts.strokeParams ?? DEFAULT_STROKE_PARAMS
  const fp = opts.fillParams ?? DEFAULT_FILL_PARAMS
  const out: GenSection[] = []

  // "Coerce a fill into a path": draw its boundary subpaths as pen strokes instead
  // of hatch shading. The strokes take role 'fill' so they slot into the element's
  // existing shading part (preserving its edits) and animate as one sweep per
  // subpath. (Offered only on fill-only shapes, so it never collides with a stroke.)
  const fillAsPath = el.hasFill && !!opts.asOutline
  const drawOutline = el.hasStroke || (el.hasFill && !!opts.outlineFill && !fillAsPath)
  if (drawOutline || fillAsPath) {
    const baseWidth = el.hasStroke ? el.strokeWidth : Math.max(sp.minWidthPx ?? 1, fp.lineWidthPx)
    const width = baseWidth * (sp.widthScale ?? 1)
    for (const subpath of el.subpaths) {
      const sec = strokeFromPolyline(subpath.points, width, sp, subpath.closed)
      if (sec) out.push(fillAsPath ? { ...sec, role: 'fill' } : sec)
    }
  }

  if (el.hasFill && !fillAsPath) {
    out.push(...generateHatch(el.subpaths.map((s) => s.points), fp))
  }
  return out
}

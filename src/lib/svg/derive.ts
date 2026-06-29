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

  const drawOutline = el.hasStroke || (el.hasFill && !!opts.outlineFill)
  if (drawOutline) {
    const baseWidth = el.hasStroke ? el.strokeWidth : Math.max(sp.minWidthPx ?? 1, fp.lineWidthPx)
    const width = baseWidth * (sp.widthScale ?? 1)
    for (const subpath of el.subpaths) {
      const sec = strokeFromPolyline(subpath.points, width, sp, subpath.closed)
      if (sec) out.push(sec)
    }
  }

  if (el.hasFill) {
    out.push(...generateHatch(el.subpaths.map((s) => s.points), fp))
  }
  return out
}

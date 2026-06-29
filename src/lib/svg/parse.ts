import type { Vec2 } from '@lib/geometry/vec'
import type { Bbox } from '@lib/manifest/schema'

/**
 * SVG → flattened geometry, in viewBox units (y-down). Browser-only (like the
 * font extraction worker): the DOM does the heavy lifting — `getPointAtLength`
 * flattens every curve/arc (all shape primitives implement `SVGGeometryElement`)
 * and each element's CTM bakes nested group/element transforms. Subpaths (for
 * fill holes and disjoint strokes) are recovered by splitting the sampled
 * polyline at the largest move-jumps. The OUTPUT is pure data the `derive`/
 * `hatch`/`centerline` engines consume identically in the editor and headless.
 *
 * Scope (v1): shapes + paths + transforms, single colour per element. Gradients,
 * filters, clip-paths, text and images are ignored.
 */

const SHAPE_SEL = 'path, rect, circle, ellipse, line, polyline, polygon'

export interface ParsedSubpath {
  points: Vec2[]
  closed: boolean
}

export interface ParsedElement {
  /** stable key back to the SVG node: its id, else `<tag>-<index>`. */
  sourceId: string
  label: string
  subpaths: ParsedSubpath[]
  hasStroke: boolean
  /** pen width in viewBox units (presentation stroke-width × CTM scale). */
  strokeWidth: number
  strokeColor: string | null
  hasFill: boolean
  fillColor: string | null
  bbox: Bbox
}

export interface ParsedSvg {
  viewBox: Bbox
  elements: ParsedElement[]
}

/** Parse an SVG document string into flattened, transform-baked elements. */
export function parseSvg(svgText: string): ParsedSvg {
  if (typeof document === 'undefined') throw new Error('parseSvg requires a DOM')
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  if (doc.querySelector('parsererror')) throw new Error('Invalid SVG file')
  const srcRoot = doc.documentElement
  if (!srcRoot || srcRoot.tagName.toLowerCase() !== 'svg') throw new Error('Not an SVG document')

  // Sandbox an offscreen clone so geometry/style APIs resolve.
  const svg = srcRoot.cloneNode(true) as SVGSVGElement
  const holder = document.createElement('div')
  holder.setAttribute('aria-hidden', 'true')
  holder.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden'
  holder.appendChild(svg)
  document.body.appendChild(holder)
  try {
    const viewBox = resolveViewBox(svg)
    // Force a 1:1 viewport so each element's CTM maps local → viewBox units.
    svg.setAttribute('width', String(viewBox.w))
    svg.setAttribute('height', String(viewBox.h))
    const shapes = Array.from(svg.querySelectorAll(SHAPE_SEL)) as unknown as SVGGeometryElement[]
    const elements: ParsedElement[] = []
    shapes.forEach((el, i) => {
      const pe = parseElement(el, i)
      if (pe) elements.push(pe)
    })
    return { viewBox, elements }
  } finally {
    document.body.removeChild(holder)
  }
}

function resolveViewBox(svg: SVGSVGElement): Bbox {
  const vb = svg.viewBox?.baseVal
  if (vb && (vb.width || vb.height)) return { x: vb.x, y: vb.y, w: vb.width, h: vb.height }
  const w = parseFloat(svg.getAttribute('width') || '')
  const h = parseFloat(svg.getAttribute('height') || '')
  if (w > 0 && h > 0) return { x: 0, y: 0, w, h }
  try {
    const b = svg.getBBox()
    if (b.width || b.height) return { x: b.x, y: b.y, w: b.width || 1, h: b.height || 1 }
  } catch {
    /* getBBox can throw if not rendered */
  }
  return { x: 0, y: 0, w: 100, h: 100 }
}

function parseElement(el: SVGGeometryElement, index: number): ParsedElement | null {
  const cs = getComputedStyle(el as unknown as Element)
  const fill = cs.fill
  const stroke = cs.stroke
  const hasFill = !!fill && fill !== 'none' && cs.fillOpacity !== '0'
  const swRaw = parseFloat(cs.strokeWidth || '0')
  const hasStroke = !!stroke && stroke !== 'none' && swRaw > 0 && cs.strokeOpacity !== '0'
  if (!hasFill && !hasStroke) return null

  const ctm = el.getCTM()
  const scale = ctm ? Math.sqrt(Math.abs(ctm.a * ctm.d - ctm.b * ctm.c)) || 1 : 1

  const subpaths = flattenElement(el, ctm)
  if (subpaths.length === 0) return null
  const bbox = boundsOf(subpaths)
  if (!bbox) return null

  const tag = el.tagName.toLowerCase()
  const id = el.getAttribute('id')
  return {
    sourceId: id || `${tag}-${index}`,
    label: id ? `${tag} · ${id}` : `${tag} ${index + 1}`,
    subpaths,
    hasStroke,
    strokeWidth: Math.max(0.2, swRaw * scale),
    strokeColor: hasStroke ? stroke : null,
    hasFill,
    fillColor: hasFill ? fill : null,
    bbox,
  }
}

/** Flatten any shape element to viewBox-space subpaths via DOM length sampling. */
function flattenElement(el: SVGGeometryElement, ctm: DOMMatrix | null): ParsedSubpath[] {
  let total = 0
  try {
    total = el.getTotalLength()
  } catch {
    return []
  }
  if (!isFinite(total) || total <= 0) return []

  const SAMPLE_STEP = 2 // local units between samples (curves are re-spaced later)
  const n = Math.min(4000, Math.max(2, Math.ceil(total / SAMPLE_STEP)))
  const pts: Vec2[] = []
  for (let i = 0; i <= n; i++) {
    const p = el.getPointAtLength((i / n) * total)
    pts.push(ctm ? applyMatrix(ctm, p.x, p.y) : { x: p.x, y: p.y })
  }

  const tag = el.tagName.toLowerCase()
  const flags = closedFlags(el, tag) // per-subpath closed flag, in document order
  return splitSubpaths(pts, flags)
}

/** Closed-ness per subpath. Primitives are single closed/open shapes; a <path>'s
 *  subpaths are classified by whether each `M…` chunk contains a Z. */
function closedFlags(el: SVGGeometryElement, tag: string): boolean[] {
  if (tag === 'path') {
    const d = el.getAttribute('d') || ''
    const chunks = d.split(/(?=[Mm])/).filter((c) => /[a-z]/i.test(c))
    const flags = chunks.map((c) => /[Zz]/.test(c))
    return flags.length ? flags : [false]
  }
  const closed = tag === 'rect' || tag === 'circle' || tag === 'ellipse' || tag === 'polygon'
  return [closed]
}

/** Split a continuous sampled polyline into `flags.length` subpaths at the
 *  largest positional jumps (each `M` move shows up as a near-zero-length jump). */
function splitSubpaths(pts: Vec2[], flags: boolean[]): ParsedSubpath[] {
  const k = Math.max(1, flags.length)
  if (k === 1 || pts.length < 4) {
    return pts.length >= 2 ? [{ points: pts, closed: flags[0] ?? false }] : []
  }
  const gaps: { i: number; d: number }[] = []
  for (let i = 1; i < pts.length; i++) {
    gaps.push({ i, d: Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) })
  }
  const cuts = gaps
    .sort((a, b) => b.d - a.d)
    .slice(0, k - 1)
    .map((g) => g.i)
    .sort((a, b) => a - b)
  const out: ParsedSubpath[] = []
  let start = 0
  for (let c = 0; c <= cuts.length; c++) {
    const end = c < cuts.length ? cuts[c] : pts.length
    const seg = pts.slice(start, end)
    if (seg.length >= 2) out.push({ points: seg, closed: flags[out.length] ?? false })
    start = end
  }
  return out
}

function applyMatrix(m: DOMMatrix, x: number, y: number): Vec2 {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
}

function boundsOf(subpaths: ParsedSubpath[]): Bbox | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const sp of subpaths) {
    for (const p of sp.points) {
      if (p.x < x0) x0 = p.x
      if (p.y < y0) y0 = p.y
      if (p.x > x1) x1 = p.x
      if (p.y > y1) y1 = p.y
    }
  }
  if (!isFinite(x0)) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

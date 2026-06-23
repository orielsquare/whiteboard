import type { Vec2 } from './vec'

/** Arc-length lookup table for a stroke centerline + its width profile. */
export interface StrokeLUT {
  pts: Vec2[]
  widths: number[]
  cum: number[] // cumulative arc length at each point
  total: number
}

export function buildLUT(points: { x: number; y: number; width: number }[]): StrokeLUT {
  const pts: Vec2[] = points.map((p) => ({ x: p.x, y: p.y }))
  const widths = points.map((p) => p.width)
  const cum = new Array<number>(pts.length)
  cum[0] = 0
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  }
  return { pts, widths, cum, total: pts.length ? cum[pts.length - 1] : 0 }
}

export interface RevealVertex {
  pos: Vec2
  width: number
}

/** The centerline vertices revealed up to arc length `len`, with a precise end vertex. */
export function revealVertices(lut: StrokeLUT, len: number): RevealVertex[] {
  const out: RevealVertex[] = []
  if (lut.pts.length === 0) return out
  if (len <= 0) return [{ pos: lut.pts[0], width: lut.widths[0] }]
  for (let i = 0; i < lut.pts.length; i++) {
    if (lut.cum[i] <= len) {
      out.push({ pos: lut.pts[i], width: lut.widths[i] })
    } else {
      const span = lut.cum[i] - lut.cum[i - 1] || 1
      const t = (len - lut.cum[i - 1]) / span
      out.push({
        pos: {
          x: lut.pts[i - 1].x + (lut.pts[i].x - lut.pts[i - 1].x) * t,
          y: lut.pts[i - 1].y + (lut.pts[i].y - lut.pts[i - 1].y) * t,
        },
        width: lut.widths[i - 1] + (lut.widths[i] - lut.widths[i - 1]) * t,
      })
      break
    }
  }
  return out
}

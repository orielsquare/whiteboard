import type { Contour } from './types'

/** A binary ink mask plus the transform back to glyph units. */
export interface RasterMask {
  data: Uint8Array // 1 = ink, row-major
  width: number
  height: number
  scale: number // px per glyph unit
  pad: number
  originX: number // glyph-units x at raster x=pad
  originY: number // glyph-units y at raster y=pad
}

/**
 * Fill the outline contours into a binary mask, sized so the glyph's larger
 * dimension is ~targetInkPx, with `pad` px of empty border.
 */
export function rasterize(
  contours: Contour[],
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  targetInkPx: number,
  pad: number,
): RasterMask {
  const bw = bbox.maxX - bbox.minX
  const bh = bbox.maxY - bbox.minY
  const scale = targetInkPx / Math.max(bw, bh, 1e-6)
  const width = Math.max(1, Math.ceil(bw * scale)) + pad * 2
  const height = Math.max(1, Math.ceil(bh * scale)) + pad * 2

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable')

  const toX = (x: number) => (x - bbox.minX) * scale + pad
  const toY = (y: number) => (y - bbox.minY) * scale + pad

  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  for (const c of contours) {
    const pts = c.points
    if (pts.length < 2) continue
    ctx.moveTo(toX(pts[0].x), toY(pts[0].y))
    for (let i = 1; i < pts.length; i++) ctx.lineTo(toX(pts[i].x), toY(pts[i].y))
    ctx.closePath()
  }
  ctx.fill('nonzero')

  const img = ctx.getImageData(0, 0, width, height).data
  const data = new Uint8Array(width * height)
  for (let i = 0, p = 3; i < data.length; i++, p += 4) {
    data[i] = img[p] >= 128 ? 1 : 0 // threshold on alpha
  }

  return { data, width, height, scale, pad, originX: bbox.minX, originY: bbox.minY }
}

/** Map a raster-space point back to glyph units. */
export function rasterToGlyph(m: RasterMask, x: number, y: number): { x: number; y: number } {
  return {
    x: (x - m.pad) / m.scale + m.originX,
    y: (y - m.pad) / m.scale + m.originY,
  }
}

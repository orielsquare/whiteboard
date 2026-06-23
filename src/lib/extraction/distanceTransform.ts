/**
 * Two-pass chamfer (3,4) distance transform of the ink mask.
 * Returns, per pixel, the approximate Euclidean distance (in px) from that ink
 * pixel to the nearest background pixel — i.e. the inscribed-circle radius, which
 * is half the local stroke width. Background pixels are 0.
 */
export function distanceTransform(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9
  const dt = new Float32Array(w * h)
  for (let i = 0; i < dt.length; i++) dt[i] = mask[i] ? INF : 0

  const D1 = 3
  const D2 = 4

  // forward pass (top-left → bottom-right)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (dt[i] === 0) continue
      let m = dt[i]
      if (x > 0) m = Math.min(m, dt[i - 1] + D1)
      if (y > 0) m = Math.min(m, dt[i - w] + D1)
      if (x > 0 && y > 0) m = Math.min(m, dt[i - w - 1] + D2)
      if (x < w - 1 && y > 0) m = Math.min(m, dt[i - w + 1] + D2)
      dt[i] = m
    }
  }

  // backward pass (bottom-right → top-left)
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (dt[i] === 0) continue
      let m = dt[i]
      if (x < w - 1) m = Math.min(m, dt[i + 1] + D1)
      if (y < h - 1) m = Math.min(m, dt[i + w] + D1)
      if (x < w - 1 && y < h - 1) m = Math.min(m, dt[i + w + 1] + D2)
      if (x > 0 && y < h - 1) m = Math.min(m, dt[i + w - 1] + D2)
      dt[i] = m
    }
  }

  // (3,4) chamfer distances are ~3× Euclidean; normalize back to px.
  for (let i = 0; i < dt.length; i++) dt[i] /= 3
  return dt
}

/** Bilinear sample of the distance field at a continuous raster coordinate. */
export function sampleField(dt: Float32Array, w: number, h: number, x: number, y: number): number {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)))
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)))
  const x1 = Math.min(w - 1, x0 + 1)
  const y1 = Math.min(h - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const a = dt[y0 * w + x0]
  const b = dt[y0 * w + x1]
  const c = dt[y1 * w + x0]
  const d = dt[y1 * w + x1]
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
}

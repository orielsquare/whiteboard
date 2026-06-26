import type { Aspect } from './schema'

/** Canvas height as a fraction of width, for each aspect. */
export function aspectHeightUnits(aspect: Aspect): number {
  return aspect === '16:9' ? 9 / 16 : 16 / 9
}

/**
 * Canvas WIDTH as a fraction of the 16:9 (landscape) width, for each aspect. The
 * two cuts share a pixel area: 16:9 → W×(9/16·W), 9:16 → (9/16·W)×W, so the
 * portrait cut is 9/16 as wide as the landscape one. This is the factor that
 * makes a 90%-wide box physically narrower in portrait (→ more lines), while a
 * font sized against the 16:9-equivalent width (`canvasW / aspectWidthFraction`)
 * stays the SAME pixel size in both cuts.
 */
export function aspectWidthFraction(aspect: Aspect): number {
  return aspect === '16:9' ? 1 : 9 / 16
}

/** Pixel size of the canvas for a chosen width and aspect. */
export function canvasSize(aspect: Aspect, canvasW: number): { w: number; h: number } {
  return { w: Math.round(canvasW), h: Math.round(canvasW * aspectHeightUnits(aspect)) }
}

/** Default export width (px) per aspect — 16:9 → 1920×1080, 9:16 → 1080×1920. */
export function exportCanvasW(aspect: Aspect): number {
  return aspect === '16:9' ? 1920 : 1080
}

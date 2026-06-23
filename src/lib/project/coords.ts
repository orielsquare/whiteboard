import type { Aspect } from './schema'

/** Canvas height as a fraction of width, for each aspect. */
export function aspectHeightUnits(aspect: Aspect): number {
  return aspect === '16:9' ? 9 / 16 : 16 / 9
}

/** Pixel size of the canvas for a chosen width and aspect. */
export function canvasSize(aspect: Aspect, canvasW: number): { w: number; h: number } {
  return { w: Math.round(canvasW), h: Math.round(canvasW * aspectHeightUnits(aspect)) }
}

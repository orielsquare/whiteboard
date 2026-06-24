import type { TransitionKind } from './schema'

/**
 * Closing-transition compositing, parameterized by `p = clamp((tLocal - holdEndMs)
 * / transitionMs, 0..1)`. Pure Canvas 2D: the caller supplies draw callbacks that
 * render each slide (it owns the layouts); this module only arranges alpha /
 * translation so an OUTGOING slide gives way to an INCOMING one (or to the
 * background, when there is no next slide — the caller passes a bg-fill as the
 * incoming draw). Deterministic — nothing reads time or randomness.
 */
export interface TransitionDraws {
  /** Draw the incoming slide fully (background + content). */
  drawIncomingFull: () => void
  /** Draw the outgoing slide fully (background + content). */
  drawOutgoingFull: () => void
  /** Fill the whole canvas with the outgoing slide's background (the "board"). */
  fillOutgoingBg: () => void
  /** Draw the incoming slide's content only (no background) — for rubout. */
  drawIncomingContent: () => void
  /** Draw the outgoing slide's remaining ink at this `p` (reverse-reveal) — for rubout. */
  drawOutgoingInk: () => void
}

/** Compose one frame of a closing transition at progress `p`. */
export function composeTransition(
  kind: TransitionKind,
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: number,
  d: TransitionDraws,
): void {
  switch (kind) {
    case 'fade': {
      // incoming underneath; outgoing fades out on top
      d.drawIncomingFull()
      ctx.save()
      ctx.globalAlpha = 1 - p
      d.drawOutgoingFull()
      ctx.restore()
      break
    }
    case 'rubout': {
      // shared board: incoming writes on while the outgoing ink retracts on top
      d.fillOutgoingBg()
      d.drawIncomingContent()
      d.drawOutgoingInk()
      break
    }
    case 'scroll-up': {
      // coupled vertical push: outgoing exits upward, incoming follows from below
      ctx.save()
      ctx.translate(0, -p * h)
      d.drawOutgoingFull()
      ctx.restore()
      ctx.save()
      ctx.translate(0, (1 - p) * h)
      d.drawIncomingFull()
      ctx.restore()
      break
    }
    case 'scroll-left': {
      // coupled horizontal push: outgoing exits left, incoming follows from the right
      ctx.save()
      ctx.translate(-p * w, 0)
      d.drawOutgoingFull()
      ctx.restore()
      ctx.save()
      ctx.translate((1 - p) * w, 0)
      d.drawIncomingFull()
      ctx.restore()
      break
    }
    case 'none':
    default:
      // hard cut: there is no overlap window for `none`, but be safe.
      d.drawIncomingFull()
      break
  }
}

/** Progress 0..1 of a closing transition at slide-local time `tLocalMs`. */
export function transitionProgress(tLocalMs: number, holdEndMs: number, transitionMs: number): number {
  if (transitionMs <= 0) return tLocalMs >= holdEndMs ? 1 : 0
  const p = (tLocalMs - holdEndMs) / transitionMs
  return p < 0 ? 0 : p > 1 ? 1 : p
}

import { sampleGlyph } from '@lib/animation/timeline'
import type { BrushSettings } from '@lib/manifest/schema'
import { paintStroke } from '@lib/render/brush'
import type { Transform } from '@lib/render/ribbon'
import { layoutTextBox, type FontSet, type TextBoxLayout } from './layout'
import type { Slide, VideoProject } from './schema'
import { computeProjectTiming, type ProjectTiming, type SlideTiming } from './timing'
import { composeTransition, transitionProgress } from './transitions'

/**
 * Render a laid-out textbox at local time `tLocalMs` (ms since the box began
 * drawing). Pure w.r.t. inputs — the only side effect is drawing on `ctx`. This
 * is the seam shared by the live layout view, thumbnails, per-slide playback and
 * a future headless exporter.
 *
 * `originPx` is the box's top-left in canvas px. Underlines grow with the writing
 * and are drawn under the ink. A **static** (fully-drawn) render is just
 * `tLocalMs = Infinity`.
 */
export function renderTextBox(
  ctx: CanvasRenderingContext2D,
  layout: TextBoxLayout,
  originPx: { x: number; y: number },
  brush: BrushSettings,
  tLocalMs: number,
): void {
  // underlines first, so the ink sits on top
  for (const u of layout.underlines) {
    const span = u.revealAtMs - u.startMs
    const frac = span > 0 ? clamp01((tLocalMs - u.startMs) / span) : tLocalMs >= u.startMs ? 1 : 0
    if (frac <= 0) continue
    const x0 = originPx.x + u.x0Px
    const x1 = originPx.x + u.x0Px + frac * (u.x1Px - u.x0Px)
    const y = originPx.y + u.yPx
    fillRoundedBar(ctx, x0, y, x1 - x0, u.thicknessPx, u.color ?? brush.color, brush.opacity)
  }

  for (const inst of layout.instances) {
    const tr: Transform = {
      scale: inst.scale,
      ox: originPx.x + inst.xPx,
      oy: originPx.y + inst.baselineYPx,
    }
    const { reveals } = sampleGlyph(inst.prepared, tLocalMs - inst.startMs)
    const b = inst.color ? { ...brush, color: inst.color } : brush
    for (const r of reveals) {
      if (r.revealedLen <= 0 && !r.active) continue
      paintStroke(ctx, r.lut, r.revealedLen, tr, b, inst.minHalfWidth, inst.seedSalt + r.id)
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** A horizontal rounded bar centred vertically on `cy`, width `w`, thickness `h`. */
function fillRoundedBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  cy: number,
  w: number,
  h: number,
  color: string,
  opacity: number,
): void {
  if (w <= 0 || h <= 0) return
  const r = Math.min(h / 2, w / 2)
  const top = cy - h / 2
  ctx.save()
  ctx.globalAlpha = opacity
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x + r, top)
  ctx.lineTo(x + w - r, top)
  ctx.arc(x + w - r, top + r, r, -Math.PI / 2, Math.PI / 2)
  ctx.lineTo(x + r, top + h)
  ctx.arc(x + r, top + r, r, Math.PI / 2, -Math.PI / 2)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

// --- slide / project rendering -------------------------------------------

const boxOrigin = (box: { frame: { x: number; y: number } }, w: number) => ({
  x: box.frame.x * w,
  y: box.frame.y * w,
})

/**
 * Draw every box of a slide at the given slide-local (real) time. `tLocalMs` and
 * each box's `startMs` are in real time; `speed` scales each box's internal
 * glyph-reveal clock so the writing plays back faster/slower while the box's
 * real-time window (`contentMs / speed`) and its start (incl. invariant delays)
 * come from the timing. So a box that began at `boxStart` is sampled at writing
 * time `(tLocalMs - boxStart) × speed`.
 */
export function renderSlideContent(
  ctx: CanvasRenderingContext2D,
  slide: Slide,
  layouts: Map<string, TextBoxLayout>,
  timing: SlideTiming,
  tLocalMs: number,
  w: number,
  brush: BrushSettings,
  speed = 1,
): void {
  const starts = new Map(timing.boxes.map((b) => [b.boxId, b.startMs]))
  for (const box of slide.textBoxes) {
    const layout = layouts.get(box.id)
    if (!layout) continue
    const writingMs = (tLocalMs - (starts.get(box.id) ?? 0)) * speed
    renderTextBox(ctx, layout, boxOrigin(box, w), box.brush ?? brush, writingMs)
  }
}

/** Fill the slide background, then draw its content at `tLocalMs` (real time). */
function drawSlideFull(
  ctx: CanvasRenderingContext2D,
  slide: Slide,
  layouts: Map<string, TextBoxLayout>,
  timing: SlideTiming,
  tLocalMs: number,
  w: number,
  h: number,
  brush: BrushSettings,
  speed: number,
): void {
  ctx.fillStyle = slide.background
  ctx.fillRect(0, 0, w, h)
  renderSlideContent(ctx, slide, layouts, timing, tLocalMs, w, brush, speed)
}

/** A slide's ink with the last `p` fraction of every stroke retracted (rubout). */
function renderSlideInkRubout(
  ctx: CanvasRenderingContext2D,
  slide: Slide,
  layouts: Map<string, TextBoxLayout>,
  brush: BrushSettings,
  w: number,
  p: number,
): void {
  const frac = 1 - p
  if (frac <= 0) return
  for (const box of slide.textBoxes) {
    const layout = layouts.get(box.id)
    if (!layout) continue
    const boxBrush = box.brush ?? brush
    const origin = boxOrigin(box, w)
    for (const u of layout.underlines) {
      fillRoundedBar(ctx, origin.x + u.x0Px, origin.y + u.yPx, (u.x1Px - u.x0Px) * frac, u.thicknessPx, u.color ?? boxBrush.color, boxBrush.opacity)
    }
    for (const inst of layout.instances) {
      const tr: Transform = { scale: inst.scale, ox: origin.x + inst.xPx, oy: origin.y + inst.baselineYPx }
      const { reveals } = sampleGlyph(inst.prepared, Infinity)
      const b = inst.color ? { ...boxBrush, color: inst.color } : boxBrush
      for (const r of reveals) {
        const len = r.revealedLen * frac
        if (len <= 0) continue
        paintStroke(ctx, r.lut, len, tr, b, inst.minHalfWidth, inst.seedSalt + r.id)
      }
    }
  }
}

/** Pre-computed layouts + timing for a project. Build once; sample every frame. */
export interface RenderContext {
  layoutsBySlide: Map<string, Map<string, TextBoxLayout>>
  timing: ProjectTiming
  /** writing-animation speed multiplier (scales the per-box glyph-reveal clock). */
  speed: number
}

/**
 * Lay out every slide and compute timing. `speed` scales the animation (writing)
 * time only — holds + transitions stay invariant. `fonts` resolves each run's
 * font. Memoize on (project, fonts, canvasW, speed).
 */
export function buildRenderContext(
  project: VideoProject,
  fonts: FontSet,
  canvasW: number,
  speed = 1,
): RenderContext {
  const layoutsBySlide = new Map<string, Map<string, TextBoxLayout>>()
  for (const slide of project.slides) {
    const m = new Map<string, TextBoxLayout>()
    for (const box of slide.textBoxes) {
      m.set(box.id, layoutTextBox(box, fonts, project.baseEmFraction, canvasW))
    }
    layoutsBySlide.set(slide.id, m)
  }
  return {
    layoutsBySlide,
    timing: computeProjectTiming(project, layoutsBySlide, speed),
    speed: speed > 0 ? speed : 1,
  }
}

export const projectDurationMs = (rc: RenderContext): number => rc.timing.totalMs

/**
 * Render the whole project at absolute time `tMs`. During a slide's closing
 * transition the next slide is already visible underneath; the two are composed
 * by the transition. **Pure** (only draws on ctx) — the headless-export seam.
 */
export function renderProject(
  ctx: CanvasRenderingContext2D,
  project: VideoProject,
  rc: RenderContext,
  tMs: number,
  w: number,
  h: number,
): void {
  ctx.clearRect(0, 0, w, h)
  const vis: { i: number; st: ProjectTiming['slides'][number]; tLocal: number }[] = []
  rc.timing.slides.forEach((st, i) => {
    const tLocal = tMs - st.startMs
    if (tLocal >= 0 && tLocal < st.timing.totalMs) vis.push({ i, st, tLocal })
  })

  if (vis.length === 0) {
    const fallback = tMs < 0 ? project.slides[0] : project.slides[project.slides.length - 1]
    if (fallback) {
      ctx.fillStyle = fallback.background
      ctx.fillRect(0, 0, w, h)
    }
    return
  }

  if (vis.length === 1) {
    const v = vis[0]
    const slide = project.slides[v.i]
    drawSlideFull(ctx, slide, rc.layoutsBySlide.get(slide.id) ?? new Map(), v.st.timing, v.tLocal, w, h, project.brush, rc.speed)
    return
  }

  // Overlap: earliest start = outgoing (in its closing transition), latest = incoming.
  vis.sort((a, b) => a.st.startMs - b.st.startMs)
  const out = vis[0]
  const inc = vis[vis.length - 1]
  const outSlide = project.slides[out.i]
  const incSlide = project.slides[inc.i]
  const outLayouts = rc.layoutsBySlide.get(outSlide.id) ?? new Map()
  const incLayouts = rc.layoutsBySlide.get(incSlide.id) ?? new Map()
  const p = transitionProgress(out.tLocal, out.st.timing.holdEndMs, out.st.timing.transitionMs)

  composeTransition(outSlide.transition.kind, ctx, w, h, p, {
    drawIncomingFull: () => drawSlideFull(ctx, incSlide, incLayouts, inc.st.timing, inc.tLocal, w, h, project.brush, rc.speed),
    drawOutgoingFull: () => drawSlideFull(ctx, outSlide, outLayouts, out.st.timing, out.tLocal, w, h, project.brush, rc.speed),
    fillOutgoingBg: () => {
      ctx.fillStyle = outSlide.background
      ctx.fillRect(0, 0, w, h)
    },
    drawIncomingContent: () => renderSlideContent(ctx, incSlide, incLayouts, inc.st.timing, inc.tLocal, w, project.brush, rc.speed),
    drawOutgoingInk: () => renderSlideInkRubout(ctx, outSlide, outLayouts, project.brush, w, p),
  })
}

/**
 * Render a single slide at slide-local time `tLocalMs`, including its own closing
 * transition (which dissolves to the background, since there is no next slide in
 * isolation). Drives the per-slide preview.
 */
export function renderSlide(
  ctx: CanvasRenderingContext2D,
  project: VideoProject,
  rc: RenderContext,
  slideIndex: number,
  tLocalMs: number,
  w: number,
  h: number,
): void {
  const slide = project.slides[slideIndex]
  if (!slide) return
  const layouts = rc.layoutsBySlide.get(slide.id) ?? new Map()
  const st = rc.timing.slides[slideIndex].timing
  ctx.clearRect(0, 0, w, h)

  if (st.transitionMs <= 0 || tLocalMs < st.holdEndMs) {
    drawSlideFull(ctx, slide, layouts, st, tLocalMs, w, h, project.brush, rc.speed)
    return
  }

  const p = transitionProgress(tLocalMs, st.holdEndMs, st.transitionMs)
  const kind = slide.transition.kind
  // No incoming slide: dissolve to the slide's own background (board) / scroll off it.
  composeTransition(kind, ctx, w, h, p, {
    drawIncomingFull: () => {
      ctx.fillStyle = slide.background
      ctx.fillRect(0, 0, w, h)
    },
    drawOutgoingFull: () => drawSlideFull(ctx, slide, layouts, st, tLocalMs, w, h, project.brush, rc.speed),
    fillOutgoingBg: () => {
      ctx.fillStyle = slide.background
      ctx.fillRect(0, 0, w, h)
    },
    drawIncomingContent: () => {},
    drawOutgoingInk: () => renderSlideInkRubout(ctx, slide, layouts, project.brush, w, p),
  })
}

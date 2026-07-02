import { buildLUT, type StrokeLUT } from '@lib/geometry/polyline'
import { ease, type EasingName } from '@lib/geometry/easing'
import type { DrawingPart } from './schema'

/**
 * Compose a drawing's PARTS into one sequential timeline. A part draws in one of
 * two modes:
 *  - `envelope` (outlines): a single constant-speed motion across all the part's
 *    sections, eased ONCE over its duration — the pen accelerates/decelerates
 *    naturally across the whole stroke.
 *  - `perStroke` (fills/shading): each hatch line is drawn over its own slice of
 *    the duration with the SAME easing applied per line — so a single easing
 *    setting gives every shading stroke its own pen feel (the requested behaviour).
 *
 * A section carrying a per-stroke `timing` override (explicit durationMs and/or a
 * pen-lift delayBeforeMs) switches its part to per-stroke sequencing: overridden
 * sections take exactly their set time, the rest keep their length-proportional
 * share of the part's duration, and the part's span stretches to the actual sum.
 *
 * Hidden parts are skipped entirely (no time, no ink). All parts share the SVG
 * viewBox space, so one transform places them. Pure — runs identically in the
 * editor and a future headless exporter.
 */

export type PartMode = 'envelope' | 'perStroke'

interface PreparedSeg {
  lut: StrokeLUT
  len: number
  /** envelope: cumulative arc length where this section begins within the part. */
  startLen: number
  /** perStroke: absolute start time + this section's own duration. */
  startMs: number
  durationMs: number
}

export interface PreparedPart {
  id: string
  mode: PartMode
  segs: PreparedSeg[]
  totalLen: number
  startMs: number
  durationMs: number
  easing: EasingName
  color: string | null
  opacity: number | null
  /** paint/stacking order (higher = on top); the returned parts are sorted by it. */
  zOrder: number
}

export function prepareDrawing(parts: DrawingPart[]): PreparedDrawing {
  const prepared: PreparedPart[] = []
  let cursor = 0
  for (const part of parts) {
    if (!part.visible) continue
    // build LUTs + lengths (keeping each section's optional timing override)
    const raw: { lut: StrokeLUT; len: number; timing?: { durationMs?: number; delayBeforeMs?: number } }[] = []
    let totalLen = 0
    for (const s of part.sections) {
      const lut = buildLUT(s.points)
      if (lut.total <= 0) continue
      raw.push({ lut, len: lut.total, timing: s.timing })
      totalLen += lut.total
    }
    if (raw.length === 0 || totalLen <= 0) continue

    const durationMs = Math.max(1, part.timing.durationMs)
    const overridden = raw.some((r) => r.timing && (r.timing.durationMs != null || r.timing.delayBeforeMs != null))
    // Any per-stroke override sequences the part stroke-by-stroke (each section
    // eased on its own) — the continuous envelope can't honour exact per-stroke times.
    const mode: PartMode = part.kind === 'fill' || overridden ? 'perStroke' : 'envelope'
    cursor += part.timing.delayBeforeMs
    const startMs = cursor

    const segs: PreparedSeg[] = []
    let accLen = 0
    let segCursor = startMs
    for (const r of raw) {
      const segDur = r.timing?.durationMs != null ? Math.max(1, r.timing.durationMs) : durationMs * (r.len / totalLen)
      segCursor += Math.max(0, r.timing?.delayBeforeMs ?? 0)
      segs.push({ lut: r.lut, len: r.len, startLen: accLen, startMs: segCursor, durationMs: segDur })
      accLen += r.len
      segCursor += segDur
    }

    prepared.push({
      id: part.id,
      mode,
      segs,
      totalLen,
      startMs,
      durationMs,
      easing: part.timing.easing,
      color: part.color ?? null,
      opacity: part.opacity ?? null,
      zOrder: part.zOrder ?? 0,
    })
    // Overrides stretch/shrink the part to the actual per-stroke sum; without
    // any, keep the exact configured duration (no float drift from the shares).
    cursor = overridden ? segCursor : startMs + durationMs
  }
  // Timing was sequenced in DRAW order (array); paint in Z order (each prepared
  // part keeps its own absolute startMs, so the two orders stay independent).
  prepared.sort((a, b) => a.zOrder - b.zOrder)
  return { parts: prepared, totalMs: cursor }
}

export interface PreparedDrawing {
  parts: PreparedPart[]
  totalMs: number
}

export interface PartReveal {
  id: string
  segs: { lut: StrokeLUT; revealedLen: number }[]
}

/** Evaluate a prepared part at absolute time `t` → revealed length per section. */
export function samplePart(p: PreparedPart, t: number): PartReveal {
  if (p.mode === 'perStroke') {
    const segs = p.segs.map((s) => {
      const local = t - s.startMs
      const prog = local <= 0 ? 0 : local >= s.durationMs ? 1 : ease(p.easing, local / s.durationMs)
      return { lut: s.lut, revealedLen: prog * s.len }
    })
    return { id: p.id, segs }
  }
  // envelope
  const local = t - p.startMs
  const prog = local <= 0 ? 0 : local >= p.durationMs ? 1 : ease(p.easing, local / p.durationMs)
  const revealedTotal = prog * p.totalLen
  const segs = p.segs.map((s) => ({ lut: s.lut, revealedLen: clamp(revealedTotal - s.startLen, 0, s.len) }))
  return { id: p.id, segs }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

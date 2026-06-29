import { ease, type EasingName } from '@lib/geometry/easing'
import { buildLUT, type StrokeLUT } from '@lib/geometry/polyline'
import type { Bbox, GlyphAnimation, MidPause, StrokeSection } from '@lib/manifest/schema'

/** A section with its arc-length LUT and resolved (absolute) timing. */
interface PreparedSection {
  id: string
  lut: StrokeLUT
  drawStartMs: number
  durationMs: number
  pauses: MidPause[]
  easing: EasingName
  spanMs: number
}

export interface PreparedGlyph {
  sections: PreparedSection[]
  totalMs: number
  advanceWidth: number
  bbox: Bbox
}

/**
 * Resolve a list of stroke sections' editorial intent into a flat timeline +
 * arc-length LUTs. Reversed sections are baked into the LUT direction here, so
 * downstream code just reveals 0 → length. Pure; do it once, reuse every frame.
 * This is the shared seam: glyphs (`prepareGlyph`) and SVG drawing elements both
 * resolve to a `PreparedGlyph` so the same `sampleGlyph`/ribbon path animates both.
 */
export function prepareSections(
  sections: StrokeSection[],
  bbox: Bbox,
  advanceWidth: number = bbox.w,
): PreparedGlyph {
  const ordered = [...sections].sort((a, b) => a.orderIndex - b.orderIndex)
  let cursor = 0
  const prepared: PreparedSection[] = []
  for (const s of ordered) {
    const pts = s.reversed ? [...s.points].reverse() : s.points
    const lut = buildLUT(pts)
    cursor += s.timing.delayBeforeMs
    const drawStartMs = cursor
    const holdSum = s.timing.pauses.reduce((a, p) => a + p.holdMs, 0)
    const spanMs = s.timing.durationMs + holdSum
    prepared.push({
      id: s.id,
      lut,
      drawStartMs,
      durationMs: s.timing.durationMs,
      pauses: [...s.timing.pauses].sort((a, b) => a.atProgress - b.atProgress),
      easing: s.timing.easing,
      spanMs,
    })
    cursor = drawStartMs + spanMs
  }
  return { sections: prepared, totalMs: cursor, advanceWidth, bbox }
}

/** Resolve a glyph's editorial intent into a flat timeline + arc-length LUTs. */
export function prepareGlyph(glyph: GlyphAnimation): PreparedGlyph {
  return prepareSections(glyph.sections, glyph.bbox, glyph.advanceWidth)
}

export interface SectionReveal {
  id: string
  lut: StrokeLUT
  revealedLen: number
  active: boolean // currently being drawn at this instant
}

/** Evaluate a prepared glyph at time `tMs` → revealed length per section. Pure. */
export function sampleGlyph(g: PreparedGlyph, tMs: number): {
  reveals: SectionReveal[]
  done: boolean
} {
  const reveals = g.sections.map((sec) => {
    const f = revealFraction(sec, tMs)
    const local = tMs - sec.drawStartMs
    return {
      id: sec.id,
      lut: sec.lut,
      revealedLen: f * sec.lut.total,
      active: local > 0 && local < sec.spanMs,
    }
  })
  return { reveals, done: tMs >= g.totalMs }
}

/** Eased 0..1 progress of a section at time t, honouring its mid-section pauses. */
function revealFraction(sec: PreparedSection, t: number): number {
  const local = t - sec.drawStartMs
  if (local <= 0) return 0
  if (local >= sec.spanMs) return 1
  let acc = 0
  let prev = 0
  for (const pause of sec.pauses) {
    const seg = (pause.atProgress - prev) * sec.durationMs
    if (local <= acc + seg) return ease(sec.easing, prev + (local - acc) / sec.durationMs)
    acc += seg
    if (local <= acc + pause.holdMs) return ease(sec.easing, pause.atProgress)
    acc += pause.holdMs
    prev = pause.atProgress
  }
  const seg = (1 - prev) * sec.durationMs
  if (local <= acc + seg) return ease(sec.easing, prev + (local - acc) / sec.durationMs)
  return 1
}

export interface TextItem {
  glyph: PreparedGlyph
  xOffset: number // glyph units (pen advance)
  startMs: number
}

export interface TextTimeline {
  items: TextItem[]
  totalMs: number
  bbox: Bbox // union, glyph units (word space)
}

/**
 * Lay a string out left-to-right by advance width and concatenate per-glyph
 * timelines with an inter-character delay. Missing glyphs (e.g. space) advance
 * the pen without drawing.
 */
export function layoutText(
  chars: string,
  glyphs: Map<string, PreparedGlyph>,
  interCharDelayMs: number,
  spaceWidth: number,
): TextTimeline {
  const items: TextItem[] = []
  let x = 0
  let t = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const ch of chars) {
    const pg = glyphs.get(ch)
    if (!pg) {
      x += spaceWidth
      continue
    }
    items.push({ glyph: pg, xOffset: x, startMs: t })
    minX = Math.min(minX, x + pg.bbox.x)
    maxX = Math.max(maxX, x + pg.bbox.x + pg.bbox.w)
    minY = Math.min(minY, pg.bbox.y)
    maxY = Math.max(maxY, pg.bbox.y + pg.bbox.h)
    x += pg.advanceWidth
    t += pg.totalMs + interCharDelayMs
  }

  const bbox: Bbox = isFinite(minX)
    ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    : { x: 0, y: 0, w: 1, h: 1 }
  return { items, totalMs: t, bbox }
}

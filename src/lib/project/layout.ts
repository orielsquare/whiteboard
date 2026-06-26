import type { PreparedGlyph } from '@lib/animation/timeline'
import type { Bbox } from '@lib/manifest/schema'
import type { FlatBox } from './aspect'

/**
 * Pure text-box layout. Resolves a textbox's runs into positioned, timed glyph
 * instances + underline segments, in **pixels** (relative to the box origin),
 * given the prepared glyphs and the current canvas width. No React/DOM. Drives
 * both the live layout view and a future headless exporter.
 *
 * Geometry contract (matches the animation/render pipeline):
 *   - glyph design units, y-down, baseline at y=0;
 *   - `scale` maps design units → px;
 *   - a glyph instance is drawn at Transform { scale, ox: origin.x + xPx,
 *     oy: origin.y + baselineYPx }.
 */

export interface FontMetrics {
  unitsPerEm: number
  ascender: number
  /** negative (design units below baseline). */
  descender: number
  /** the font's space-glyph advance (design units). Used so the canvas wraps text
   *  with the SAME spacing the on-canvas editor (real font) does — otherwise a
   *  hardcoded space width reflows the text on entering edit. Falls back to
   *  `SPACE_EM` ems when absent (older manifests). */
  spaceAdvance?: number
}

/** One font's render inputs: prepared glyphs (by char) + metrics. */
export interface FontEntry {
  glyphs: Map<string, PreparedGlyph>
  metrics: FontMetrics
}

/** All fonts a project may render with, keyed by fontId, plus the project
 *  default that an unset `run.fontId` resolves to. A single-font project is just
 *  a one-entry set. */
export interface FontSet {
  byId: Map<string, FontEntry>
  defaultId: string
}

/** Resolve the font for a run: its own fontId, else the project default, else
 *  the first available entry, else an empty fallback so layout never throws. */
export function fontFor(fonts: FontSet, fontId?: string): FontEntry {
  const e = (fontId && fonts.byId.get(fontId)) || fonts.byId.get(fonts.defaultId)
  if (e) return e
  const first = fonts.byId.values().next().value
  return first ?? { glyphs: new Map(), metrics: { unitsPerEm: 1000, ascender: 800, descender: -200 } }
}

export interface GlyphInstance {
  prepared: PreparedGlyph
  /** design units → px. */
  scale: number
  /** pen origin x within the box content (px). */
  xPx: number
  /** baseline y within the box content (px). */
  baselineYPx: number
  /** run colour override, or null = use the brush colour. */
  color: string | null
  /** start time of this glyph within the box's local timeline (ms). */
  startMs: number
  /** stable per-box+glyph salt → deterministic chalk grain. */
  seedSalt: string
  /** minimum stroke half-width (px), derived from this glyph's font unitsPerEm
   *  (fonts may differ, so it is baked per instance rather than globally). */
  minHalfWidth: number
}

export interface UnderlineSegment {
  x0Px: number
  x1Px: number
  /** vertical centre of the bar within the box content (px). */
  yPx: number
  thicknessPx: number
  color: string | null
  /** when the underline starts growing (= its first glyph's startMs). */
  startMs: number
  /** when the underline is fully drawn (= its last glyph's end). */
  revealAtMs: number
}

export interface TextBoxLayout {
  instances: GlyphInstance[]
  underlines: UnderlineSegment[]
  /** time at which the whole box has finished drawing (ms). */
  contentMs: number
  /** width of the laid-out content (alignment basis), px. */
  widthPx: number
  /** height of the laid-out content (last baseline + last descent), px. */
  heightPx: number
  /** union of the transformed glyph bboxes, px (relative to box origin). */
  bbox: Bbox
}

type SlotKind = 'glyph' | 'space' | 'missing' | 'newline'

interface Slot {
  kind: SlotKind
  prepared: PreparedGlyph | null
  scale: number
  advancePx: number
  ascentPx: number
  descentPx: number
  color: string | null
  underline: boolean
  /** this slot's font unitsPerEm (for mixed-font underline em sizing). */
  upm: number
  /** this slot's font-derived minimum stroke half-width (px). */
  minHalfWidth: number
  /** stable index among drawn glyphs in reading order (glyph slots only). */
  glyphIndex: number
  // assigned during wrap / timing:
  xPx: number
  startMs: number
  endMs: number
}

type Token =
  | { type: 'word'; slots: Slot[]; width: number }
  | { type: 'space'; slot: Slot }
  | { type: 'newline' }

const SPACE_EM = 0.3
const MISSING_EM = 0.5
const UNDERLINE_OFFSET_EM = 0.06
const UNDERLINE_THICK_EM = 0.04
/** Pause after the underlined word is written before the pen goes back to underline (ms). */
const UNDERLINE_DELAY_MS = 130
/** How long the underline sweep itself takes, scaled by its length in ems. */
function underlineDrawMs(spanEm: number): number {
  return Math.min(700, Math.max(200, 120 + spanEm * 180))
}

/** Lay out one textbox. Pure; safe to memoize on (box, fonts, baseEmFraction, canvasW, emBasisW).
 *  Each run resolves its own font from `fonts` (per-run `fontId`), so a box — even
 *  a single line — may mix fonts; metrics are taken per run/slot.
 *
 *  `canvasW` sizes GEOMETRY (box x/y/w, wrap width) — per aspect, so a portrait box
 *  is physically narrower. `emBasisW` sizes the FONT (em px) — the aspect-invariant
 *  16:9-equivalent width, so type stays the same pixel size across cuts and a
 *  narrower portrait box wraps onto more lines. Defaults to `canvasW` (single-aspect
 *  callers + tests are unaffected). */
export function layoutTextBox(
  box: FlatBox,
  fonts: FontSet,
  baseEmFraction: number,
  canvasW: number,
  emBasisW: number = canvasW,
): TextBoxLayout {
  const defMetrics = fontFor(fonts, fonts.defaultId).metrics

  // 1) flatten runs → slots --------------------------------------------------
  const slots: Slot[] = []
  let drawn = 0
  for (const run of box.runs) {
    const fe = fontFor(fonts, run.fontId)
    const upm = fe.metrics.unitsPerEm
    const sizeScale = run.sizeScale ?? 1
    const scale = (baseEmFraction * sizeScale * emBasisW) / upm
    const emPx = baseEmFraction * sizeScale * emBasisW
    // Kerning: extra trailing advance after each glyph/space, in ems → px.
    const kernPx = (run.letterSpacing ?? 0) * emPx
    const ascentPx = fe.metrics.ascender * scale
    const descentPx = Math.abs(fe.metrics.descender) * scale
    const color = run.color ?? null
    const underline = !!run.underline
    const minHalfWidth = upm * 0.004
    // Space width = the font's real space advance (matches the editor overlay +
    // the actual font), falling back to SPACE_EM ems for older fonts.
    const spaceEm = fe.metrics.spaceAdvance != null ? fe.metrics.spaceAdvance / upm : SPACE_EM
    for (const ch of run.text) {
      const base = { scale, ascentPx, descentPx, color, underline, upm, minHalfWidth, xPx: 0, startMs: 0, endMs: 0 }
      if (ch === '\n') {
        slots.push({ ...base, kind: 'newline', prepared: null, advancePx: 0, glyphIndex: -1 })
      } else if (/\s/.test(ch)) {
        slots.push({ ...base, kind: 'space', prepared: null, advancePx: spaceEm * emPx + kernPx, glyphIndex: -1 })
      } else {
        const pg = fe.glyphs.get(ch)
        if (pg) {
          slots.push({ ...base, kind: 'glyph', prepared: pg, advancePx: pg.advanceWidth * scale + kernPx, glyphIndex: drawn++ })
        } else {
          slots.push({ ...base, kind: 'missing', prepared: null, advancePx: MISSING_EM * emPx + kernPx, glyphIndex: -1 })
        }
      }
    }
  }

  // 2) tokenise → words / spaces / newlines ----------------------------------
  const tokens: Token[] = []
  for (let i = 0; i < slots.length; ) {
    const s = slots[i]
    if (s.kind === 'newline') {
      tokens.push({ type: 'newline' })
      i++
    } else if (s.kind === 'space') {
      tokens.push({ type: 'space', slot: s })
      i++
    } else {
      const word: Slot[] = []
      let width = 0
      while (i < slots.length && (slots[i].kind === 'glyph' || slots[i].kind === 'missing')) {
        word.push(slots[i])
        width += slots[i].advancePx
        i++
      }
      tokens.push({ type: 'word', slots: word, width })
    }
  }

  // 3) greedy word-wrap → lines (each line = placed slots with xPx) ----------
  const wrapW = box.frame.w == null ? Infinity : box.frame.w * canvasW
  const lines: Slot[][] = []
  let line: Slot[] = []
  let cx = 0
  let pending: Slot[] = []
  const place = (s: Slot) => {
    s.xPx = cx
    line.push(s)
    cx += s.advancePx
  }
  const flushPending = () => {
    for (const s of pending) place(s)
    pending = []
  }
  const newLine = () => {
    lines.push(line)
    line = []
    cx = 0
  }
  for (const tk of tokens) {
    if (tk.type === 'newline') {
      flushPending()
      newLine()
    } else if (tk.type === 'space') {
      pending.push(tk.slot)
    } else {
      const pendW = pending.reduce((a, s) => a + s.advancePx, 0)
      if (line.length > 0 && cx + pendW + tk.width > wrapW) {
        pending = [] // spaces collapse at a soft wrap
        newLine()
      } else {
        flushPending()
      }
      for (const s of tk.slots) place(s)
    }
  }
  flushPending()
  if (line.length > 0 || lines.length === 0) lines.push(line)

  // 4) per-line vertical metrics + baselines ---------------------------------
  const defaultScale = (baseEmFraction * emBasisW) / defMetrics.unitsPerEm
  const lineAsc: number[] = []
  const lineDesc: number[] = []
  for (const ln of lines) {
    let a = 0
    let d = 0
    for (const s of ln) {
      a = Math.max(a, s.ascentPx)
      d = Math.max(d, s.descentPx)
    }
    if (ln.length === 0) {
      a = defMetrics.ascender * defaultScale
      d = Math.abs(defMetrics.descender) * defaultScale
    }
    lineAsc.push(a)
    lineDesc.push(d)
  }
  const baselines: number[] = []
  for (let k = 0; k < lines.length; k++) {
    baselines.push(k === 0 ? lineAsc[0] : baselines[k - 1] + (lineDesc[k - 1] + lineAsc[k]) * box.lineHeightScale)
  }

  // 5) alignment -------------------------------------------------------------
  const lineInk = lines.map((ln) => {
    let w = 0
    for (const s of ln) if (s.kind !== 'space') w = Math.max(w, s.xPx + s.advancePx)
    return w
  })
  const maxInk = lineInk.reduce((a, b) => Math.max(a, b), 0)
  const contentWidth = box.frame.w == null ? maxInk : box.frame.w * canvasW
  const lineOffset = lines.map((_, k) => {
    const ink = lineInk[k]
    if (box.align === 'center') return (contentWidth - ink) / 2
    if (box.align === 'right') return contentWidth - ink
    return 0
  })

  // 6) instances + timing + underlines + bbox --------------------------------
  const instances: GlyphInstance[] = []
  const underlines: UnderlineSegment[] = []
  let t = 0
  let contentMs = 0
  let bx0 = Infinity
  let by0 = Infinity
  let bx1 = -Infinity
  let by1 = -Infinity

  for (let k = 0; k < lines.length; k++) {
    const ln = lines[k]
    const off = lineOffset[k]
    const baseY = baselines[k]
    for (const s of ln) s.xPx += off

    // glyph instances, in reading order (timing accumulates across the box)
    for (const s of ln) {
      if (s.kind !== 'glyph' || !s.prepared) continue
      s.startMs = t
      s.endMs = t + s.prepared.totalMs
      instances.push({
        prepared: s.prepared,
        scale: s.scale,
        xPx: s.xPx,
        baselineYPx: baseY,
        color: s.color,
        startMs: s.startMs,
        seedSalt: `${box.id}:${s.glyphIndex}`,
        minHalfWidth: s.minHalfWidth,
      })
      contentMs = Math.max(contentMs, s.endMs)
      t = s.endMs + box.interCharDelayMs
      const gx0 = s.xPx + s.prepared.bbox.x * s.scale
      const gy0 = baseY + s.prepared.bbox.y * s.scale
      bx0 = Math.min(bx0, gx0)
      by0 = Math.min(by0, gy0)
      bx1 = Math.max(bx1, gx0 + s.prepared.bbox.w * s.scale)
      by1 = Math.max(by1, gy0 + s.prepared.bbox.h * s.scale)
    }

    // underline segments: one per maximal underlined run on this line
    for (let r = 0; r < ln.length; ) {
      if (!ln[r].underline) {
        r++
        continue
      }
      let e = r
      while (e < ln.length && ln[e].underline) e++
      const seg = ln.slice(r, e)
      const drawnInSeg = seg.filter((s) => s.kind === 'glyph' && s.prepared)
      if (drawnInSeg.length > 0) {
        // em size from the largest slot — and that slot's own font upm, since a
        // segment may mix fonts.
        let maxScale = 0
        let maxUpm = defMetrics.unitsPerEm
        for (const s of seg) if (s.scale > maxScale) { maxScale = s.scale; maxUpm = s.upm }
        const emPx = maxUpm * maxScale
        const x0Px = seg[0].xPx
        const x1Px = seg[seg.length - 1].xPx + seg[seg.length - 1].advancePx
        // Human behaviour: underline the word AFTER it's fully written — wait for
        // the last glyph to finish, a brief pen-lift, then a quick left→right sweep.
        const wordEndMs = drawnInSeg[drawnInSeg.length - 1].endMs
        const startMs = wordEndMs + UNDERLINE_DELAY_MS
        const spanEm = emPx > 0 ? (x1Px - x0Px) / emPx : 1
        const revealAtMs = startMs + underlineDrawMs(spanEm)
        underlines.push({
          x0Px,
          x1Px,
          yPx: baseY + UNDERLINE_OFFSET_EM * emPx,
          thicknessPx: UNDERLINE_THICK_EM * emPx,
          color: drawnInSeg[0].color,
          startMs,
          revealAtMs,
        })
        contentMs = Math.max(contentMs, revealAtMs)
      }
      r = e
    }
  }

  const heightPx = lines.length ? baselines[lines.length - 1] + lineDesc[lines.length - 1] : 0
  const bbox: Bbox = isFinite(bx0) ? { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 } : { x: 0, y: 0, w: 0, h: 0 }

  return { instances, underlines, contentMs, widthPx: contentWidth, heightPx, bbox }
}

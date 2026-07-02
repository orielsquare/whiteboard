/**
 * Pure math for editing an element's timing partition (the three values
 * under the envelope lozenge: initial padding · animation length · final
 * padding). Framework-free so the matrix is unit-testable:
 *
 *  - `applyTimingEdit` (the keyboard-edit modal) —
 *    mode 'envelope':   the edit's delta lands on the envelope's absolute
 *    length; the other two internal values keep their absolute times.
 *    mode 'compensate': the envelope stays fixed; the CHOSEN compensator value
 *    absorbs the delta. If it can't (it would drop below its floor — i.e. the
 *    envelope would be exceeded), the edit fails with the envelope length that
 *    change would need.
 *  - `applyEnvelopeResize` (the envelope-length slider / ms field) — see its
 *    doc: the animation keeps its absolute length (padding absorbs the change)
 *    unless "scale with envelope" is on, which scales the whole partition.
 *
 * All times ms at rate ×1. The returned patch always pins `envelopeMs` (any
 * timing edit turns "resize with content" off) and is a single store write.
 */

export interface EnvPartition {
  /** the envelope's current (effective) length. */
  env: number
  /** initial padding (the schema's delayBeforeMs, clamped into the envelope). */
  startPad: number
  /** the animation block's current length (post-compression, as rendered). */
  bubble: number
  /** final padding (derived: env − startPad − bubble). */
  endPad: number
  /** the element's natural content time (0 = nothing to animate yet). */
  contentMs: number
  /** the block's natural (speed-scaled) length — only envelope-resize recovery
   *  previews read it (when the shown block was clamped away by delay ≥ env). */
  naturalMs?: number
}

export type EnvField = 'initial' | 'animation' | 'final'
export type EnvEditMode = 'envelope' | 'compensate'

export interface EnvPatch {
  envelopeMs: number
  delayBeforeMs?: number
  speed?: number
}

export type EnvEditResult = { ok: true; patch: EnvPatch } | { ok: false; neededEnvMs: number }

/** The smallest editable animation block (also ≈ the 2px drag floor). */
export const MIN_ANIM_MS = 10
/** The smallest pinnable envelope (the slider/field/drag floor). */
export const MIN_ENV_MS = 100
/** Defensive bounds on the stored speed (animation-length is the real control). */
const clampSpeed = (v: number) => Math.min(2000, Math.max(0.01, v))

const r = Math.round

/** The default compensator for an edited field: initial padding, unless that is
 *  the field being edited — then final padding. */
export function defaultCompensator(field: EnvField): EnvField {
  return field === 'initial' ? 'final' : 'initial'
}

// --- the lozenge drags (shared by the Inspector's EnvelopeBar and the Timeline) --

export type LozengeDragKind = 'body' | 'left' | 'right'

/** A lozenge drag's anchor: the partition at pointer-down (all ms at ×1). */
export interface LozengeDragBase {
  /** the (pinned-or-effective) envelope length — the drag never leaves it. */
  env: number
  startPad0: number
  bubble0: number
  /** smallest allowed block during an edge drag (≈2px on screen). */
  minBubble: number
}

/**
 * The drag's live partition at `deltaMs` from the anchor:
 *  - 'body'  slides the block inside the envelope (trades start↔end padding);
 *  - 'left'  stretches the block's left edge (block + start pad; end pad fixed);
 *  - 'right' stretches the right edge (block + end pad; start pad fixed).
 * Always clamped into the envelope.
 */
export function lozengeDrag(kind: LozengeDragKind, d: LozengeDragBase, deltaMs: number): { startPad: number; bubble: number } {
  if (kind === 'body') {
    return { startPad: Math.max(0, Math.min(d.env - d.bubble0, d.startPad0 + deltaMs)), bubble: d.bubble0 }
  }
  if (kind === 'left') {
    const rightEdge = d.startPad0 + d.bubble0
    const sp = Math.max(0, Math.min(rightEdge - d.minBubble, d.startPad0 + deltaMs))
    return { startPad: sp, bubble: rightEdge - sp }
  }
  return { startPad: d.startPad0, bubble: Math.max(d.minBubble, Math.min(d.env - d.startPad0, d.bubble0 + deltaMs)) }
}

/**
 * The store patch for a finished lozenge drag: always pins the envelope; writes
 * `delayBeforeMs`/`speed` only for the values the gesture actually changed
 * (a body drag never re-times the block, so it never writes speed).
 */
export function lozengeDragPatch(
  kind: LozengeDragKind,
  env: number,
  base: { startPad: number; bubble: number },
  v: { startPad: number; bubble: number },
  contentMs: number,
): EnvPatch {
  const patch: EnvPatch = { envelopeMs: r(env) }
  if (r(v.startPad) !== r(base.startPad)) patch.delayBeforeMs = Math.max(0, r(v.startPad))
  if (kind !== 'body' && contentMs > 0 && r(v.bubble) !== r(base.bubble)) {
    patch.speed = clampSpeed(contentMs / Math.max(1, v.bubble))
  }
  return patch
}

/**
 * Resize the envelope itself (the length slider / ms field).
 *
 *  - `scaleWithEnvelope` OFF (default): the animation block keeps its ABSOLUTE
 *    length; the two paddings share the leftover span in their current ratio.
 *    Only once all padding is consumed (envelope < block) does the block
 *    shrink with the envelope.
 *  - `scaleWithEnvelope` ON: the whole partition scales by env1/env0 — padding
 *    and animation alike — so the lozenge's proportions don't visibly change.
 *
 * The patch also writes `speed` (content ÷ new block), so the stored natural
 * length equals the visible block and any prior envelope compression is
 * canonicalized away — without this, a compressed block would keep tracking
 * the envelope. EXCEPTION: with no content, or a block clamped away entirely
 * (delay ≥ envelope), only `envelopeMs` is written — see the guard below.
 * Returns the new partition too, for the live preview while the slider drags.
 */
export function applyEnvelopeResize(
  p: EnvPartition,
  newEnvMs: number,
  scaleWithEnvelope: boolean,
): { patch: EnvPatch; startPad: number; bubble: number } {
  const env = Math.max(1, newEnvMs)
  // Degenerate block — no content, or the block clamped away (delay ≥ envelope):
  // there is no meaningful length to preserve or scale, and repartitioning would
  // bake the degenerate state in (delay = whole envelope, speed = content/10ms).
  // Change ONLY the envelope: the delay stays absolute and any content
  // re-expands toward its natural length in the new room.
  if (p.contentMs <= 0 || p.bubble < MIN_ANIM_MS) {
    const startPad = Math.min(p.startPad, env)
    const natural = p.contentMs > 0 ? (p.naturalMs ?? p.bubble) : 0
    return { patch: { envelopeMs: r(env) }, startPad, bubble: Math.max(0, Math.min(natural, env - startPad)) }
  }
  let startPad: number
  let bubble: number
  if (scaleWithEnvelope && p.env > 0) {
    const k = env / p.env
    startPad = p.startPad * k
    bubble = p.bubble * k
  } else {
    bubble = Math.min(p.bubble, env)
    const padTotal = p.startPad + p.endPad
    startPad = padTotal > 0 ? (env - bubble) * (p.startPad / padTotal) : 0
  }
  return {
    patch: {
      envelopeMs: r(env),
      delayBeforeMs: r(startPad),
      speed: clampSpeed(p.contentMs / Math.max(MIN_ANIM_MS, bubble)),
    },
    startPad,
    bubble,
  }
}

export function applyTimingEdit(
  p: EnvPartition,
  field: EnvField,
  rawValue: number,
  mode: EnvEditMode,
  compensator: EnvField,
): EnvEditResult {
  // sanitize the entered value against its own floor
  const value =
    field === 'animation' ? Math.max(MIN_ANIM_MS, rawValue) : Math.max(0, rawValue)
  if (field === 'animation' && p.contentMs <= 0) return { ok: true, patch: { envelopeMs: r(p.env) } } // nothing to time

  const speedFor = (bubbleMs: number) => clampSpeed(p.contentMs / Math.max(MIN_ANIM_MS, bubbleMs))

  if (mode === 'envelope') {
    // the other two internal values keep their absolute times
    if (field === 'initial') {
      return { ok: true, patch: { envelopeMs: r(value + p.bubble + p.endPad), delayBeforeMs: r(value) } }
    }
    if (field === 'animation') {
      return { ok: true, patch: { envelopeMs: r(p.startPad + value + p.endPad), speed: speedFor(value) } }
    }
    return { ok: true, patch: { envelopeMs: r(p.startPad + p.bubble + value) } }
  }

  // mode 'compensate' — envelope fixed; the chosen compensator absorbs the delta.
  const delta =
    field === 'initial' ? value - p.startPad : field === 'animation' ? value - p.bubble : value - p.endPad
  const floorOf = (f: EnvField) => (f === 'animation' ? MIN_ANIM_MS : 0)
  const currentOf = (f: EnvField) => (f === 'initial' ? p.startPad : f === 'animation' ? p.bubble : p.endPad)
  const compAfter = currentOf(compensator) - delta
  if (compAfter < floorOf(compensator) - 1e-6) {
    // doesn't fit: the envelope this change would need (compensator at its floor)
    const fixed: EnvField = (['initial', 'animation', 'final'] as EnvField[]).find(
      (f) => f !== field && f !== compensator,
    )!
    return { ok: false, neededEnvMs: r(value + currentOf(fixed) + floorOf(compensator)) }
  }

  const patch: EnvPatch = { envelopeMs: r(p.env) }
  const setField = (f: EnvField, v: number) => {
    if (f === 'initial') patch.delayBeforeMs = r(Math.max(0, v))
    else if (f === 'animation') patch.speed = speedFor(v)
    // 'final' is derived — env + the other two determine it, nothing to write
  }
  setField(field, value)
  setField(compensator, compAfter)
  return { ok: true, patch }
}

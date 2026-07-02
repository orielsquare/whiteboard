/**
 * Pure math for text-editing an element's timing partition (the three values
 * under the envelope lozenge: initial padding · animation length · final
 * padding). Framework-free so the modal's matrix is unit-testable:
 *
 *  - mode 'envelope':   the edit's delta lands on the envelope's absolute
 *    length; the other two internal values keep their absolute times.
 *  - mode 'compensate': the envelope stays fixed; the CHOSEN compensator value
 *    absorbs the delta. If it can't (it would drop below its floor — i.e. the
 *    envelope would be exceeded), the edit fails with the envelope length that
 *    change would need.
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
/** Defensive bounds on the stored speed (animation-length is the real control). */
const clampSpeed = (v: number) => Math.min(2000, Math.max(0.01, v))

const r = Math.round

/** The default compensator for an edited field: initial padding, unless that is
 *  the field being edited — then final padding. */
export function defaultCompensator(field: EnvField): EnvField {
  return field === 'initial' ? 'final' : 'initial'
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

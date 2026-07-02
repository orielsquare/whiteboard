import { useRef, useState, type PointerEvent } from 'react'
import { elementSlot } from '@lib/project/timing'

const MIN_ENV_MS = 100
const MIN_ANIM_MS = 50
/** speed bounds when the block is stretched (wider than the slider's 0.25–4). */
const MIN_SPEED = 0.1
const MAX_SPEED = 10

/**
 * The element's time envelope as a full-width lozenge: the lozenge IS the
 * envelope (100% of the element's slot on the timeline, whatever its length —
 * shown in the fields below), and the solid block inside is the animation.
 * **Slide the block** left/right to re-time it within its slot (padding-before =
 * the schema's `delayBeforeMs`); **stretch the block's left/right edges** to
 * change how much of the envelope the animation takes — resizing writes the
 * element's `speed` (`contentMs / blockMs`). The envelope's own length is set
 * with the fixed-length toggle + seconds field ("auto" hugs padding + block).
 *
 * Drags are deferred-write: pointermove updates local state only; the model is
 * written once on release (= one undo step).
 */
export function EnvelopeBar({
  contentMs,
  speed,
  envelopeMs,
  offsetMs,
  onChange,
}: {
  /** the element's natural content time (unscaled, ms). */
  contentMs: number
  speed: number | undefined
  envelopeMs: number | undefined
  /** padding-before (the schema's `delayBeforeMs`). */
  offsetMs: number
  onChange: (patch: { envelopeMs?: number | undefined; delayBeforeMs?: number; speed?: number }) => void
}) {
  const barRef = useRef<HTMLDivElement | null>(null)
  // live drag override (null = not dragging); committed once on pointerup
  const [live, setLive] = useState<{ off: number; anim: number } | null>(null)
  const dragRef = useRef<{
    kind: 'body' | 'left' | 'right'
    x0: number
    off0: number
    anim0: number
    env0: number
    pxPerMs: number
  } | null>(null)

  const fixed = envelopeMs != null && envelopeMs > 0
  const base = elementSlot(contentMs, speed, envelopeMs, offsetMs)
  // display geometry: the live drag values, else the model's slot
  const off = live?.off ?? base.animOffMs
  const anim = live?.anim ?? base.animMs
  const envMs = fixed ? (envelopeMs as number) : off + anim
  const naturalAnimMs = contentMs / (speed && speed > 0 ? speed : 1)
  const compressed = !live && base.animMs < naturalAnimMs - 0.5
  const effectiveSpeed = anim > 0 ? contentMs / anim : null
  const resizable = contentMs > 0

  const pct = (ms: number) => (envMs > 0 ? `${Math.max(0, Math.min(100, (ms / envMs) * 100))}%` : '0%')

  const startDrag = (kind: 'body' | 'left' | 'right') => (e: PointerEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const bar = barRef.current
    if (!bar) return
    if (kind !== 'body' && !resizable) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture unavailable — window-relative move still tracks */
    }
    const pxPerMs = envMs > 0 ? bar.getBoundingClientRect().width / envMs : 1
    dragRef.current = { kind, x0: e.clientX, off0: off, anim0: anim, env0: envMs, pxPerMs }
    setLive({ off, anim })
  }
  const applyDelta = (d: NonNullable<typeof dragRef.current>, clientX: number): { off: number; anim: number } => {
    const deltaMs = (clientX - d.x0) / d.pxPerMs
    if (d.kind === 'body') {
      // slide within the envelope (fixed) or against its start (auto)
      const maxOff = fixed ? Math.max(0, d.env0 - d.anim0) : Infinity
      return { off: Math.max(0, Math.min(maxOff, d.off0 + deltaMs)), anim: d.anim0 }
    }
    if (d.kind === 'left') {
      // left edge: the block's END stays put — offset grows as the block shrinks
      const delta = Math.max(-d.off0, Math.min(d.anim0 - MIN_ANIM_MS, deltaMs))
      return { off: d.off0 + delta, anim: d.anim0 - delta }
    }
    // right edge: stretch the animation (the envelope caps it when fixed)
    const maxAnim = fixed ? Math.max(MIN_ANIM_MS, d.env0 - d.off0) : Infinity
    return { off: d.off0, anim: Math.max(MIN_ANIM_MS, Math.min(maxAnim, d.anim0 + deltaMs)) }
  }
  const onMove = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    if (!d) return
    setLive(applyDelta(d, e.clientX))
  }
  const endDrag = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    const v = applyDelta(d, e.clientX)
    setLive(null)
    const patch: { delayBeforeMs?: number; speed?: number } = {}
    if (Math.round(v.off) !== Math.round(d.off0)) patch.delayBeforeMs = Math.max(0, Math.round(v.off / 10) * 10)
    if (d.kind !== 'body' && contentMs > 0 && Math.round(v.anim) !== Math.round(d.anim0)) {
      patch.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, contentMs / Math.max(MIN_ANIM_MS, v.anim)))
    }
    if (Object.keys(patch).length) onChange(patch)
  }
  const cancelDrag = () => {
    dragRef.current = null
    setLive(null)
  }
  const dragHandlers = { onPointerMove: onMove, onPointerUp: endDrag, onPointerCancel: cancelDrag }

  return (
    <div className="envwrap">
      <span className="env-label">
        time envelope
        {compressed && effectiveSpeed != null && (
          <b className="env-compressed" title="the animation overflows its envelope, so it speeds up to fit">
            {' '}· compressed — effective ×{effectiveSpeed.toFixed(2)}
          </b>
        )}
      </span>
      <div className={fixed ? 'envbar fixed' : 'envbar auto'} ref={barRef} title={fixed ? undefined : 'auto envelope — hugs the padding + animation'}>
        <div className="envbar-pad" style={{ left: 0, width: pct(off) }} />
        <div className="envbar-pad after" style={{ left: pct(off + anim), right: 0 }} />
        <div
          className="envbar-anim"
          style={{ left: pct(off), width: pct(anim) }}
          title="the animation — drag to slide it within the envelope; stretch its edges to retime it"
          onPointerDown={startDrag('body')}
          {...dragHandlers}
        >
          {resizable && (
            <>
              <span
                className="envbar-grip left"
                title="stretch — the block's end stays put"
                onPointerDown={startDrag('left')}
                {...dragHandlers}
              />
              <span
                className="envbar-grip right"
                title="stretch — sets the animation's speed"
                onPointerDown={startDrag('right')}
                {...dragHandlers}
              />
            </>
          )}
        </div>
      </div>
      <div className="env-fields">
        <label className="toggle" title="Pin this element's slot to a fixed length — content edits keep the video's pace (the animation compresses to fit)">
          <input
            type="checkbox"
            checked={fixed}
            onChange={(e) =>
              onChange({ envelopeMs: e.target.checked ? Math.max(MIN_ENV_MS, Math.round((off + anim) / 100) * 100) : undefined })
            }
          />
          fixed length
        </label>
        {fixed && (
          <span className="num-row" title="envelope length (seconds)">
            <input
              type="number"
              className="num-input"
              min={MIN_ENV_MS / 1000}
              step={0.1}
              value={Number((envMs / 1000).toFixed(1))}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v)) onChange({ envelopeMs: Math.max(MIN_ENV_MS, Math.round(v * 1000)) })
              }}
            />
            <span className="num-unit">s</span>
          </span>
        )}
        <span className="num-row" title="padding before the animation starts (ms)">
          <span className="num-pre">pad</span>
          <input
            type="number"
            className="num-input"
            min={0}
            step={50}
            value={Math.round(off)}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) onChange({ delayBeforeMs: Math.max(0, Math.round(v)) })
            }}
          />
          <span className="num-unit">ms</span>
        </span>
        <span className="muted env-summary">
          {(anim / 1000).toFixed(1)}s writing in a {(envMs / 1000).toFixed(1)}s slot
        </span>
      </div>
    </div>
  )
}

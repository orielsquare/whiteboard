import { useRef, useState, type PointerEvent } from 'react'

const MIN_ENV_MS = 100
const MIN_SPEED = 0.1
const MAX_SPEED = 20

/**
 * The element's time envelope as a full-width lozenge. The lozenge IS the
 * envelope — it always spans the panel and represents 100% of the fixed time the
 * element occupies on the timeline. Inside it: **start padding**, the solid
 * **animation block**, and **end padding**, which always sum to the envelope.
 *
 * Three gestures, all of which keep the envelope length FIXED (only the seconds
 * field / fixed-length toggle change that):
 *  - **slide the block body**: moves it from start-padding 0 to end-padding 0,
 *    keeping the block's size (and so the animation's share of the envelope) fixed.
 *  - **drag the left edge**: resizes the block + start padding, end padding fixed.
 *  - **drag the right edge**: resizes the block + end padding, start padding fixed.
 * Resizing the block writes the element's `speed` (`content ÷ block`). The block
 * can shrink to ~2px and grow to fill the whole envelope.
 *
 * Drags are deferred-write: pointermove updates local state; the model is written
 * once on release (= one undo step), always pinning `envelopeMs` so the slot stays.
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
  const [live, setLive] = useState<{ startPad: number; bubble: number } | null>(null)
  const dragRef = useRef<{
    kind: 'body' | 'left' | 'right'
    x0: number
    startPad0: number
    bubble0: number
    pxPerMs: number
    minBubble: number
  } | null>(null)

  const fixed = envelopeMs != null && envelopeMs > 0
  const naturalBubble = contentMs / (speed && speed > 0 ? speed : 1)
  // The concrete envelope: pinned length if fixed, else it hugs pad + block.
  const env = Math.max(MIN_ENV_MS, fixed ? (envelopeMs as number) : Math.max(MIN_ENV_MS, offsetMs + naturalBubble))
  // Base partition from the model (clamped so the block fits the envelope).
  const baseStartPad = Math.max(0, Math.min(offsetMs, env))
  const baseBubble = Math.max(0, Math.min(naturalBubble, env - baseStartPad))

  const startPad = live?.startPad ?? baseStartPad
  const bubble = live?.bubble ?? baseBubble
  const endPad = Math.max(0, env - startPad - bubble)
  const resizable = contentMs > 0

  const compressed = !live && baseBubble < naturalBubble - 0.5
  const effectiveSpeed = bubble > 0 ? contentMs / bubble : null
  const pct = (ms: number) => (env > 0 ? `${Math.max(0, Math.min(100, (ms / env) * 100))}%` : '0%')

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
    const barW = bar.getBoundingClientRect().width
    const pxPerMs = env > 0 ? barW / env : 1
    // the block can shrink to ~2px on screen
    const minBubble = pxPerMs > 0 ? 2 / pxPerMs : 20
    dragRef.current = { kind, x0: e.clientX, startPad0: startPad, bubble0: bubble, pxPerMs, minBubble }
    setLive({ startPad, bubble })
  }
  const applyDelta = (d: NonNullable<typeof dragRef.current>, clientX: number): { startPad: number; bubble: number } => {
    const deltaMs = (clientX - d.x0) / d.pxPerMs
    if (d.kind === 'body') {
      // slide within the envelope: start-pad 0 … (env − block); block size fixed
      return { startPad: Math.max(0, Math.min(env - d.bubble0, d.startPad0 + deltaMs)), bubble: d.bubble0 }
    }
    if (d.kind === 'left') {
      // the block's RIGHT edge (start-pad + block) stays put → end padding fixed
      const rightEdge = d.startPad0 + d.bubble0
      const startPad = Math.max(0, Math.min(rightEdge - d.minBubble, d.startPad0 + deltaMs))
      return { startPad, bubble: rightEdge - startPad }
    }
    // right edge: the block's LEFT edge (start-pad) stays put → start padding fixed
    const bubble = Math.max(d.minBubble, Math.min(env - d.startPad0, d.bubble0 + deltaMs))
    return { startPad: d.startPad0, bubble }
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
    // Every drag pins the envelope (so its length stays fixed thereafter).
    const patch: { envelopeMs: number; delayBeforeMs?: number; speed?: number } = { envelopeMs: Math.round(env) }
    if (Math.round(v.startPad) !== Math.round(baseStartPad)) patch.delayBeforeMs = Math.max(0, Math.round(v.startPad))
    if (d.kind !== 'body' && contentMs > 0 && Math.round(v.bubble) !== Math.round(baseBubble)) {
      patch.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, contentMs / Math.max(1, v.bubble)))
    }
    onChange(patch)
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
      <div className={fixed ? 'envbar fixed' : 'envbar auto'} ref={barRef} title={fixed ? undefined : 'auto envelope — hugs the padding + animation until you pin a length'}>
        <div className="envbar-pad" style={{ left: 0, width: pct(startPad) }} />
        <div className="envbar-pad after" style={{ left: pct(startPad + bubble), right: 0 }} />
        <div
          className="envbar-anim"
          style={{ left: pct(startPad), width: pct(bubble) }}
          title="the animation — drag to slide it; stretch either edge to change how long it takes"
          onPointerDown={startDrag('body')}
          {...dragHandlers}
        >
          {resizable && (
            <>
              <span className="envbar-grip left" title="stretch — keeps the end padding" onPointerDown={startDrag('left')} {...dragHandlers} />
              <span className="envbar-grip right" title="stretch — keeps the start padding" onPointerDown={startDrag('right')} {...dragHandlers} />
            </>
          )}
        </div>
      </div>
      <div className="env-fields">
        <label className="toggle" title="Pin this element's slot to a fixed length — content edits keep the video's pace (the animation compresses to fit)">
          <input
            type="checkbox"
            checked={fixed}
            onChange={(e) => onChange({ envelopeMs: e.target.checked ? Math.max(MIN_ENV_MS, Math.round(env / 100) * 100) : undefined })}
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
              value={Number((env / 1000).toFixed(1))}
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
            value={Math.round(startPad)}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) onChange({ delayBeforeMs: Math.max(0, Math.round(v)) })
            }}
          />
          <span className="num-unit">ms</span>
        </span>
        <span className="muted env-summary">
          {(bubble / 1000).toFixed(1)}s writing · {(startPad / 1000).toFixed(1)}s before · {(endPad / 1000).toFixed(1)}s after
        </span>
      </div>
    </div>
  )
}

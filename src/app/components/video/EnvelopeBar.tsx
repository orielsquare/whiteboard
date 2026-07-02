import { useRef, useState, type PointerEvent } from 'react'
import { useVideoStore } from '../../state/videoStore'
import {
  MIN_ENV_MS,
  applyEnvelopeResize,
  applyTimingEdit,
  defaultCompensator,
  lozengeDrag,
  lozengeDragPatch,
  type EnvField,
  type LozengeDragKind,
} from './envelopeEdit'

const SLIDER_MIN = 500
const SLIDER_MAX = 10000

const FIELD_LABEL: Record<EnvField, string> = {
  initial: 'initial padding',
  animation: 'animation length',
  final: 'final padding',
}

/**
 * The element's ONE timing control. Top to bottom:
 *  - **envelope length**: an absolute-ms slider (500–10,000) + a keyboard field
 *    (which may exceed the slider's range), plus **resize with content** — when
 *    checked the envelope is auto (it hugs padding + animation and follows
 *    content edits); any timing edit pins it (unchecks), re-checking un-pins.
 *    Resizing the envelope keeps the animation's ABSOLUTE length (padding
 *    absorbs the change; the block only shrinks once all padding is consumed) —
 *    unless **scale with envelope** is ticked, which scales padding + animation
 *    together so the lozenge's proportions hold (see `applyEnvelopeResize`).
 *  - **the lozenge**: the envelope as a full-width bar of start padding · the
 *    animation block · end padding. Slide the block (trades start↔end padding,
 *    block fixed); stretch its left edge (block + start padding, end fixed) or
 *    right edge (block + end padding, start fixed). Resizing writes the
 *    element's `speed` (content ÷ block); block min ≈2px, max = the envelope.
 *  - **three editable values**: initial padding · animation length · final
 *    padding (ms). They live-track drags; a keyboard edit opens a modal asking
 *    whether the delta should **change the envelope** (other two hold) or be
 *    **compensated internally** (envelope holds; a chosen sibling absorbs it —
 *    failing with advice if it doesn't fit).
 *
 * Drags and edits are deferred-write: the model is written once per gesture
 * (= one undo step), always pinning `envelopeMs`.
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
  // live lozenge drag (null = not dragging); committed once on pointerup
  const [live, setLive] = useState<{ startPad: number; bubble: number } | null>(null)
  const dragRef = useRef<{
    kind: 'body' | 'left' | 'right'
    x0: number
    startPad0: number
    bubble0: number
    pxPerMs: number
    minBubble: number
  } | null>(null)
  // live envelope-slider drag (ms; null = not dragging)
  const [envDraft, setEnvDraft] = useState<number | null>(null)
  // keyboard drafts (committed on blur/Enter)
  const [envText, setEnvText] = useState<string | null>(null)
  const [fieldDraft, setFieldDraft] = useState<{ field: EnvField; text: string } | null>(null)
  // the pending keyboard edit awaiting the modal's decision
  const [pending, setPending] = useState<{ field: EnvField; value: number } | null>(null)
  const [compensator, setCompensator] = useState<EnvField>('initial')
  const [failure, setFailure] = useState<number | null>(null)
  // envelope-resize mode: scale the whole partition, or (default) keep the block
  // absolute. GLOBAL (shared with the Timeline view's checkbox).
  const scaleWithEnv = useVideoStore((s) => s.scaleWithEnvelope)
  const setScaleWithEnv = useVideoStore((s) => s.setScaleWithEnvelope)

  const auto = !(envelopeMs != null && envelopeMs > 0)
  const naturalBubble = contentMs / (speed && speed > 0 ? speed : 1)
  // The committed envelope: the pinned length, or (auto) pad + block.
  const baseEnv = Math.max(MIN_ENV_MS, auto ? offsetMs + naturalBubble : (envelopeMs as number))
  // Committed partition (clamped so the block fits): start pad · bubble · end pad.
  const baseStartPad = Math.max(0, Math.min(offsetMs, baseEnv))
  const baseBubble = Math.max(0, Math.min(naturalBubble, baseEnv - baseStartPad))
  const basePartition = {
    env: baseEnv,
    startPad: baseStartPad,
    bubble: baseBubble,
    endPad: Math.max(0, baseEnv - baseStartPad - baseBubble),
    contentMs,
    naturalMs: naturalBubble,
  }
  // A live envelope-slider draft repartitions per the resize mode (matches the commit).
  const env = envDraft != null ? Math.max(MIN_ENV_MS, envDraft) : baseEnv
  const envPreview = envDraft != null ? applyEnvelopeResize(basePartition, env, scaleWithEnv) : null
  const startPad = live?.startPad ?? envPreview?.startPad ?? baseStartPad
  const bubble = live?.bubble ?? envPreview?.bubble ?? baseBubble
  const endPad = Math.max(0, env - startPad - bubble)
  const resizable = contentMs > 0

  const compressed = !live && envDraft == null && baseBubble < naturalBubble - 0.5
  const effectiveSpeed = bubble > 0 ? contentMs / bubble : null
  const pct = (ms: number) => (env > 0 ? `${Math.max(0, Math.min(100, (ms / env) * 100))}%` : '0%')

  // --- lozenge drags (slide the block; stretch either edge) ------------------
  const startDrag = (kind: LozengeDragKind) => (e: PointerEvent<HTMLElement>) => {
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
    const minBubble = pxPerMs > 0 ? 2 / pxPerMs : 20 // the block can shrink to ~2px on screen
    dragRef.current = { kind, x0: e.clientX, startPad0: startPad, bubble0: bubble, pxPerMs, minBubble }
    setLive({ startPad, bubble })
  }
  const applyDelta = (d: NonNullable<typeof dragRef.current>, clientX: number): { startPad: number; bubble: number } =>
    lozengeDrag(d.kind, { env, startPad0: d.startPad0, bubble0: d.bubble0, minBubble: d.minBubble }, (clientX - d.x0) / d.pxPerMs)
  const onMove = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    if (d) setLive(applyDelta(d, e.clientX))
  }
  const endDrag = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    const v = applyDelta(d, e.clientX)
    setLive(null)
    // Every drag pins the envelope (so its length stays fixed thereafter).
    onChange(lozengeDragPatch(d.kind, env, { startPad: baseStartPad, bubble: baseBubble }, v, contentMs))
  }
  const cancelDrag = () => {
    dragRef.current = null
    setLive(null)
  }
  const dragHandlers = { onPointerMove: onMove, onPointerUp: endDrag, onPointerCancel: cancelDrag }

  // --- envelope slider / field / resize-with-content -------------------------
  const commitEnv = (v: number) =>
    onChange(applyEnvelopeResize(basePartition, Math.max(MIN_ENV_MS, Math.round(v)), scaleWithEnv).patch)
  const commitEnvDraft = () => {
    if (envDraft != null) {
      commitEnv(envDraft)
      setEnvDraft(null)
    }
  }
  const commitEnvText = () => {
    if (envText == null) return
    const v = Number(envText)
    setEnvText(null)
    if (Number.isFinite(v) && Math.round(v) !== Math.round(env)) commitEnv(v)
  }

  // --- the three-value keyboard edits → modal ---------------------------------
  const fieldValue = (f: EnvField) => (f === 'initial' ? startPad : f === 'animation' ? bubble : endPad)
  const commitField = (f: EnvField) => {
    if (fieldDraft?.field !== f) return
    const v = Number(fieldDraft.text)
    if (!Number.isFinite(v) || Math.round(v) === Math.round(fieldValue(f))) {
      setFieldDraft(null)
      return
    }
    setPending({ field: f, value: v })
    setCompensator(defaultCompensator(f))
  }
  const closeModal = () => {
    setPending(null)
    setFieldDraft(null) // revert the field to the model value
  }
  const decide = (mode: 'envelope' | 'compensate') => {
    if (!pending) return
    const result = applyTimingEdit(
      { env, startPad, bubble, endPad, contentMs },
      pending.field,
      pending.value,
      mode,
      compensator,
    )
    if (result.ok) {
      onChange(result.patch)
      closeModal()
    } else {
      setPending(null)
      setFieldDraft(null)
      setFailure(result.neededEnvMs)
    }
  }

  const sliderVal = Math.max(SLIDER_MIN, Math.min(SLIDER_MAX, Math.round(env)))

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

      <div className="env-lenrow">
        <input
          type="range"
          min={SLIDER_MIN}
          max={SLIDER_MAX}
          step={50}
          value={sliderVal}
          title="envelope length (ms) — dragging pins it"
          onChange={(e) => setEnvDraft(Number(e.target.value))}
          onPointerUp={commitEnvDraft}
          onKeyUp={commitEnvDraft}
          onBlur={commitEnvDraft}
        />
        <span className="num-row" title="envelope length (ms) — typing pins it">
          <input
            type="number"
            className="num-input"
            min={MIN_ENV_MS}
            step={50}
            value={envText ?? Math.round(env)}
            onFocus={(e) => setEnvText(e.target.value)}
            onChange={(e) => setEnvText(e.target.value)}
            onBlur={commitEnvText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEnvText(null)
            }}
          />
          <span className="num-unit">ms</span>
        </span>
        <label className="toggle" title="Auto envelope: it hugs padding + animation and follows content edits. Any timing edit pins it; re-tick to fit again.">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => onChange({ envelopeMs: e.target.checked ? undefined : Math.max(MIN_ENV_MS, Math.round(env)) })}
          />
          resize with content
        </label>
        <label className="toggle" title="Ticked: resizing the envelope scales padding AND animation together (the lozenge's proportions hold). Unticked: the animation keeps its absolute length and padding absorbs the change — the animation only shrinks once all padding is used up.">
          <input type="checkbox" checked={scaleWithEnv} onChange={(e) => setScaleWithEnv(e.target.checked)} />
          scale with envelope
        </label>
      </div>

      <div className={auto ? 'envbar auto' : 'envbar fixed'} ref={barRef} title={auto ? 'auto envelope — resizes with content until pinned' : undefined}>
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
        {(['initial', 'animation', 'final'] as EnvField[]).map((f) => (
          <span className="num-row env-field" key={f} title={`${FIELD_LABEL[f]} (ms) — editing asks whether to change the envelope or compensate inside it`}>
            <span className="num-pre">{f === 'initial' ? 'initial' : f === 'animation' ? 'animation' : 'final'}</span>
            <input
              type="number"
              className="num-input"
              min={0}
              step={50}
              disabled={f === 'animation' && !resizable}
              value={fieldDraft?.field === f ? fieldDraft.text : Math.round(fieldValue(f))}
              onFocus={(e) => setFieldDraft({ field: f, text: e.target.value })}
              onChange={(e) => setFieldDraft({ field: f, text: e.target.value })}
              onBlur={() => commitField(f)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setFieldDraft(null)
              }}
            />
            <span className="num-unit">ms</span>
          </span>
        ))}
      </div>

      {pending && (
        <div className="confirm-overlay" onClick={closeModal}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-msg">
              <b>{FIELD_LABEL[pending.field]}</b> → {Math.round(Math.max(0, pending.value))}ms. Change the
              envelope's length, or keep it and compensate with another value?
            </p>
            <div className="env-modal-checks">
              {(['initial', 'animation', 'final'] as EnvField[]).map((f) => {
                const isEdited = f === pending.field
                const disabled = isEdited || (f === 'animation' && !resizable)
                return (
                  <label key={f} className={'toggle' + (isEdited ? ' env-check-edited' : '')}>
                    <input
                      type="checkbox"
                      checked={isEdited || f === compensator}
                      disabled={disabled}
                      onChange={() => setCompensator(f)}
                    />
                    {FIELD_LABEL[f]}
                    {isEdited && <span className="muted"> (changing)</span>}
                  </label>
                )
              })}
            </div>
            <div className="confirm-actions">
              <button className="tool" onClick={closeModal}>Cancel</button>
              <button className="tool" onClick={() => decide('compensate')} title="Keep the envelope; the ticked value absorbs the difference">
                Compensate internally
              </button>
              <button className="tool primary" onClick={() => decide('envelope')} title="Apply the difference to the envelope's length; the other two values hold">
                Change envelope
              </button>
            </div>
          </div>
        </div>
      )}

      {failure != null && (
        <div className="confirm-overlay" onClick={() => setFailure(null)}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-msg">
              That change doesn't fit inside the current envelope. Increase the envelope to at least{' '}
              <b>{Math.round(failure)}ms</b> first, or let the change resize the envelope.
            </p>
            <div className="confirm-actions">
              <button className="tool primary" onClick={() => setFailure(null)}>OK</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

import { useMemo } from 'react'
import type { TransitionKind } from '@lib/project/schema'
import { boxForAspect, frameOf, inkForAspect } from '@lib/project/aspect'
import { layoutTextBox, type FontSet } from '@lib/project/layout'
import { aspectWidthFraction } from '@lib/project/coords'
import { prepareInk } from '@lib/project/ink'
import type { DrawingSet } from '@lib/drawing/render'
import { useVideoStore } from '../../state/videoStore'
import { previewCanvasW } from './layoutCanvas'
import { EnvelopeBar } from './EnvelopeBar'

const TRANSITIONS: TransitionKind[] = ['none', 'fade', 'rubout', 'scroll-up', 'scroll-down', 'scroll-left', 'scroll-right']
const DEFAULT_WRAP_W = 0.7

/** Right-hand properties panel. Mirrors the navigator tab: the **Textboxes** tab
 *  shows the selected textbox's frame + timing; the **Slides** tab shows the
 *  slide's background + transition. */
export function Inspector({ fonts, drawings: drawingSet }: { fonts: FontSet; drawings: DrawingSet }) {
  const project = useVideoStore((s) => s.project)
  const activeAspect = useVideoStore((s) => s.activeAspect)
  const navTab = useVideoStore((s) => s.navTab)
  const selectedSlideId = useVideoStore((s) => s.selectedSlideId)
  const selectedTextBoxId = useVideoStore((s) => s.selectedTextBoxId)
  const updateTextBox = useVideoStore((s) => s.updateTextBox)
  const updateTextBoxFrame = useVideoStore((s) => s.updateTextBoxFrame)
  const deleteTextBox = useVideoStore((s) => s.deleteTextBox)
  const selectTextBox = useVideoStore((s) => s.selectTextBox)
  const setSlideTransition = useVideoStore((s) => s.setSlideTransition)
  const updateSlide = useVideoStore((s) => s.updateSlide)
  const selectedDrawingId = useVideoStore((s) => s.selectedDrawingId)
  const updateDrawing = useVideoStore((s) => s.updateDrawing)
  const updateDrawingFrame = useVideoStore((s) => s.updateDrawingFrame)
  const removeDrawing = useVideoStore((s) => s.removeDrawing)
  const selectDrawing = useVideoStore((s) => s.selectDrawing)
  const selectedInkId = useVideoStore((s) => s.selectedInkId)
  const updateInk = useVideoStore((s) => s.updateInk)
  const removeInk = useVideoStore((s) => s.removeInk)
  const selectInk = useVideoStore((s) => s.selectInk)
  const selectedElementIds = useVideoStore((s) => s.selectedElementIds)
  const removeElements = useVideoStore((s) => s.removeElements)

  const slide = project ? project.slides.find((s) => s.id === selectedSlideId) ?? project.slides[0] : undefined
  const box = slide?.textBoxes.find((b) => b.id === selectedTextBoxId)
  const wrapW = box ? frameOf(box, activeAspect).w : null
  const drawing = selectedDrawingId ? (slide?.drawings ?? []).find((d) => d.id === selectedDrawingId) : undefined
  const ink = selectedInkId ? (slide?.inks ?? []).find((k) => k.id === selectedInkId) : undefined

  // The selected ink's natural drawing time (cheap: one small polyline prepared).
  const inkNaturalMs = useMemo(() => {
    if (!ink) return 0
    try {
      return prepareInk(inkForAspect(ink, activeAspect)).totalMs
    } catch {
      return 0
    }
  }, [ink, activeAspect])

  // The selected box's natural (unscaled) writing time — for the envelope hints.
  // Cheap: one box laid out, memoized on its content + the fonts.
  const boxNaturalMs = useMemo(() => {
    if (!box || !project) return 0
    try {
      const cw = previewCanvasW(activeAspect)
      const layout = layoutTextBox(boxForAspect(box, activeAspect), fonts, project.baseEmFraction, cw, cw / aspectWidthFraction(activeAspect))
      return layout.contentMs
    } catch {
      return 0
    }
  }, [box, project, fonts, activeAspect])

  if (!project || !slide) return null

  // --- Multi-selection (marquee / shift-click) ------------------------------
  if (selectedElementIds.length > 1) {
    return (
      <aside className="inspector">
        <div className="insp-head">
          <h3>{selectedElementIds.length} elements</h3>
          <button
            className="tool danger"
            title="delete every selected element (also: Delete key)"
            onClick={() => removeElements(slide.id, selectedElementIds)}
          >
            × Delete all
          </button>
        </div>
        <p className="insp-tip muted">
          Drag any selected element to move them together. The format bar above styles every selected
          textbox at once. <b>Cmd/Ctrl-C / X / V</b> copies, cuts and pastes the selection — including
          onto another slide.
        </p>
      </aside>
    )
  }

  // --- Direct-drawing (ink) properties (an ink is selected) ----------------
  if (ink && slide) {
    const toolNames: Record<string, string> = { freehand: 'Freehand', line: 'Line', curve: 'Curve', arrow: 'Arrow' }
    return (
      <aside className="inspector">
        <div className="insp-head">
          <h3>{toolNames[ink.tool] ?? 'Ink'}</h3>
          <button
            className="tool danger"
            title="delete this drawing (also: Delete key)"
            onClick={() => {
              removeInk(slide.id, ink.id)
              selectInk(null)
            }}
          >
            × Delete
          </button>
        </div>
        <p className="insp-tip muted">A direct drawing — drag it on the slide to move it; it animates in turn with everything else.</p>
        <label className="slider">
          <span>colour</span>
          <div className="bg-row">
            <input
              type="color"
              value={ink.color ?? project.brush.color}
              onChange={(e) => updateInk(slide.id, ink.id, { color: e.target.value })}
            />
            <button className="tool" disabled={ink.color == null} onClick={() => updateInk(slide.id, ink.id, { color: undefined })}>
              ↺ pen colour
            </button>
          </div>
        </label>
        <label className="slider">
          <span>stroke width <b>×{(ink.widthScale ?? 1).toFixed(2)}</b></span>
          <input
            type="range"
            min={0.25}
            max={4}
            step={0.05}
            value={ink.widthScale ?? 1}
            onChange={(e) => updateInk(slide.id, ink.id, { widthScale: Number(e.target.value) })}
          />
        </label>
        <label className="slider">
          <span>draw speed <b>×{(ink.speed ?? 1).toFixed(2)}</b></span>
          <input
            type="range"
            min={0.25}
            max={4}
            step={0.05}
            value={ink.speed ?? 1}
            onChange={(e) => updateInk(slide.id, ink.id, { speed: Number(e.target.value) })}
          />
        </label>
        <EnvelopeBar
          contentMs={inkNaturalMs}
          speed={ink.speed}
          envelopeMs={ink.envelopeMs}
          offsetMs={ink.delayBeforeMs}
          onChange={(patch) => updateInk(slide.id, ink.id, patch)}
        />
      </aside>
    )
  }

  // --- Placed-drawing properties (a drawing is selected) ------------------
  if (drawing) {
    const dw = drawing.frame[activeAspect].w ?? 0.3
    const dspeed = drawing.speed ?? 1
    const dNaturalMs = drawingSet.get(drawing.drawingId)?.prepared.totalMs ?? 0
    return (
      <aside className="inspector">
        <div className="insp-head">
          <h3>Drawing</h3>
          <button className="tool danger" title="remove drawing from slide" onClick={() => { removeDrawing(slide.id, drawing.id); selectDrawing(null) }}>
            × Delete
          </button>
        </div>
        <p className="insp-tip muted">{drawing.name ?? 'drawing'} — drag it on the slide to position; drag it in the Elements list to set when it draws.</p>
        <label className="slider">
          <span>width <b>{Math.round(dw * 100)}%</b></span>
          <input type="range" min={0.05} max={1} step={0.01} value={dw}
            onChange={(e) => updateDrawingFrame(slide.id, drawing.id, { w: Number(e.target.value) })} />
        </label>
        <label className="slider">
          <span>draw speed <b>×{dspeed.toFixed(2)}</b></span>
          <input type="range" min={0.25} max={4} step={0.05} value={dspeed}
            onChange={(e) => updateDrawing(slide.id, drawing.id, { speed: Number(e.target.value) })} />
        </label>
        <EnvelopeBar
          contentMs={dNaturalMs}
          speed={drawing.speed}
          envelopeMs={drawing.envelopeMs}
          offsetMs={drawing.delayBeforeMs}
          onChange={(patch) => updateDrawing(slide.id, drawing.id, patch)}
        />
      </aside>
    )
  }

  // --- Textbox properties (navigator on "Textboxes") ----------------------
  if (navTab === 'boxes') {
    if (!box) {
      return (
        <aside className="inspector">
          <div className="muted insp-empty">Select a textbox in the list or on the slide to edit it.</div>
        </aside>
      )
    }
    return (
      <aside className="inspector">
        <div className="insp-head">
          <h3>Textbox</h3>
          <button
            className="tool danger"
            title="delete textbox"
            onClick={() => {
              deleteTextBox(slide.id, box.id)
              selectTextBox(null)
            }}
          >
            × Delete
          </button>
        </div>

        <p className="insp-tip muted">Double-click the textbox on the slide to edit its text; use the format bar above to style it.</p>

        <label className="slider">
          <span>width <b>{Math.round((wrapW ?? DEFAULT_WRAP_W) * 100)}%</b></span>
          <input
            type="range"
            min={0.15}
            max={1}
            step={0.01}
            value={wrapW ?? DEFAULT_WRAP_W}
            onChange={(e) => updateTextBoxFrame(slide.id, box.id, { w: Number(e.target.value) })}
          />
        </label>

        <label className="slider">
          <span>handwriting cadence <b>{box.interCharDelayMs}ms</b></span>
          <input
            type="range"
            min={0}
            max={300}
            step={5}
            value={box.interCharDelayMs}
            onChange={(e) => updateTextBox(slide.id, box.id, { interCharDelayMs: Number(e.target.value) })}
          />
        </label>

        <label className="slider">
          <span>writing speed <b>×{(box.speed ?? 1).toFixed(2)}</b></span>
          <input
            type="range"
            min={0.25}
            max={4}
            step={0.05}
            value={box.speed ?? 1}
            onChange={(e) => updateTextBox(slide.id, box.id, { speed: Number(e.target.value) })}
          />
        </label>
        <EnvelopeBar
          contentMs={boxNaturalMs}
          speed={box.speed}
          envelopeMs={box.envelopeMs}
          offsetMs={box.delayBeforeMs}
          onChange={(patch) => updateTextBox(slide.id, box.id, patch)}
        />
      </aside>
    )
  }

  // --- Slide properties (navigator on "Slides") ---------------------------
  return (
    <aside className="inspector">
      <h3>Slide</h3>
      <label className="slider">
        <span>background</span>
        <div className="bg-row">
          <input
            type="color"
            value={slide.background}
            onChange={(e) => updateSlide(slide.id, { background: e.target.value })}
          />
          <input
            type="text"
            className="bg-hex"
            value={slide.background}
            spellCheck={false}
            onChange={(e) => updateSlide(slide.id, { background: e.target.value })}
          />
        </div>
      </label>
      <label className="slider">
        <span>closing transition</span>
        <select
          value={slide.transition.kind}
          onChange={(e) => setSlideTransition(slide.id, { kind: e.target.value as TransitionKind })}
        >
          {TRANSITIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="slider">
        <span>transition <b>{slide.transition.durationMs}ms</b></span>
        <input
          type="range"
          min={100}
          max={2000}
          step={50}
          value={slide.transition.durationMs}
          onChange={(e) => setSlideTransition(slide.id, { durationMs: Number(e.target.value) })}
        />
      </label>
      <label className="slider">
        <span>hold before transition</span>
        <div className="num-row">
          <input
            type="number"
            className="num-input"
            min={0}
            step={500}
            value={slide.holdBeforeTransitionMs}
            onChange={(e) =>
              updateSlide(slide.id, { holdBeforeTransitionMs: Math.max(0, Math.round(Number(e.target.value) || 0)) })
            }
          />
          <span className="num-unit">ms</span>
        </div>
      </label>
    </aside>
  )
}

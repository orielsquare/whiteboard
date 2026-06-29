import type { TransitionKind } from '@lib/project/schema'
import { frameOf } from '@lib/project/aspect'
import { useVideoStore } from '../../state/videoStore'

const TRANSITIONS: TransitionKind[] = ['none', 'fade', 'rubout', 'scroll-up', 'scroll-down', 'scroll-left', 'scroll-right']
const DEFAULT_WRAP_W = 0.7

/** Right-hand properties panel. Mirrors the navigator tab: the **Textboxes** tab
 *  shows the selected textbox's frame + timing; the **Slides** tab shows the
 *  slide's background + transition. */
export function Inspector() {
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

  if (!project) return null
  const slide = project.slides.find((s) => s.id === selectedSlideId) ?? project.slides[0]
  const box = slide.textBoxes.find((b) => b.id === selectedTextBoxId)
  const wrapW = box ? frameOf(box, activeAspect).w : null
  const drawing = selectedDrawingId ? (slide.drawings ?? []).find((d) => d.id === selectedDrawingId) : undefined

  // --- Placed-drawing properties (a drawing is selected) ------------------
  if (drawing) {
    const dw = drawing.frame[activeAspect].w ?? 0.3
    // Move this drawing earlier/later in the slide's shared animation order by
    // swapping its animOrder with the adjacent item (box or drawing).
    const moveOrder = (dir: -1 | 1) => {
      const items = [
        ...slide.textBoxes.map((b) => ({ kind: 'box' as const, id: b.id, animOrder: b.animOrder })),
        ...(slide.drawings ?? []).map((d) => ({ kind: 'draw' as const, id: d.id, animOrder: d.animOrder })),
      ].sort((a, b) => a.animOrder - b.animOrder)
      const i = items.findIndex((it) => it.kind === 'draw' && it.id === drawing.id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= items.length) return
      const a = items[i]
      const b = items[j]
      const setOrder = (it: (typeof items)[number], order: number) =>
        it.kind === 'box' ? updateTextBox(slide.id, it.id, { animOrder: order }) : updateDrawing(slide.id, it.id, { animOrder: order })
      setOrder(a, b.animOrder)
      setOrder(b, a.animOrder)
    }
    return (
      <aside className="inspector">
        <div className="insp-head">
          <h3>Drawing</h3>
          <button className="tool danger" title="remove drawing from slide" onClick={() => { removeDrawing(slide.id, drawing.id); selectDrawing(null) }}>
            × Delete
          </button>
        </div>
        <p className="insp-tip muted">{drawing.name ?? 'drawing'} — drag it on the slide to position. It draws in turn with the text by its animation order.</p>
        <label className="slider">
          <span>width <b>{Math.round(dw * 100)}%</b></span>
          <input type="range" min={0.05} max={1} step={0.01} value={dw}
            onChange={(e) => updateDrawingFrame(slide.id, drawing.id, { w: Number(e.target.value) })} />
        </label>
        <label className="slider">
          <span>time before drawing <b>{drawing.delayBeforeMs}ms</b></span>
          <input type="range" min={0} max={3000} step={50} value={drawing.delayBeforeMs}
            onChange={(e) => updateDrawing(slide.id, drawing.id, { delayBeforeMs: Number(e.target.value) })} />
        </label>
        <label className="slider">
          <span>animation order</span>
          <div className="toolrow">
            <button className="tool" title="draw earlier" onClick={() => moveOrder(-1)}>↑ earlier</button>
            <button className="tool" title="draw later" onClick={() => moveOrder(1)}>↓ later</button>
          </div>
        </label>
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
          <span>time before display <b>{box.delayBeforeMs}ms</b></span>
          <input
            type="range"
            min={0}
            max={3000}
            step={50}
            value={box.delayBeforeMs}
            onChange={(e) => updateTextBox(slide.id, box.id, { delayBeforeMs: Number(e.target.value) })}
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

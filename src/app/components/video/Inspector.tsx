import type { BrushSettings, BrushStyle } from '@lib/manifest/schema'
import type { TextAlign, TransitionKind } from '@lib/project/schema'
import { useVideoStore } from '../../state/videoStore'
import { RunEditor } from './RunEditor'

const ALIGNS: TextAlign[] = ['left', 'center', 'right']
const BRUSH_STYLES: BrushStyle[] = ['chalk', 'ink', 'marker']
const TRANSITIONS: TransitionKind[] = ['none', 'fade', 'rubout', 'scroll-up', 'scroll-down', 'scroll-left', 'scroll-right']
const DEFAULT_WRAP_W = 0.7

/** Right-hand panel: edits the selected textbox (text + style + frame + timing) and the slide. */
export function Inspector() {
  const project = useVideoStore((s) => s.project)
  const selectedSlideId = useVideoStore((s) => s.selectedSlideId)
  const selectedTextBoxId = useVideoStore((s) => s.selectedTextBoxId)
  const updateTextBox = useVideoStore((s) => s.updateTextBox)
  const updateTextBoxFrame = useVideoStore((s) => s.updateTextBoxFrame)
  const deleteTextBox = useVideoStore((s) => s.deleteTextBox)
  const selectTextBox = useVideoStore((s) => s.selectTextBox)
  const setSlideTransition = useVideoStore((s) => s.setSlideTransition)
  const updateSlide = useVideoStore((s) => s.updateSlide)

  if (!project) return null
  const slide = project.slides.find((s) => s.id === selectedSlideId) ?? project.slides[0]
  const box = slide.textBoxes.find((b) => b.id === selectedTextBoxId)
  const boxBrush = box?.brush

  const toggleCustomBrush = (on: boolean) => {
    if (!box) return
    updateTextBox(slide.id, box.id, { brush: on ? { ...project.brush } : undefined })
  }
  const patchBoxBrush = (patch: Partial<BrushSettings>) => {
    if (!box || !box.brush) return
    updateTextBox(slide.id, box.id, { brush: { ...box.brush, ...patch } })
  }

  return (
    <aside className="inspector">
      {box ? (
        <>
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

          <RunEditor box={box} slideId={slide.id} brushColor={project.brush.color} />

          <label className="slider">
            <span>align</span>
            <div className="seg">
              {ALIGNS.map((a) => (
                <button
                  key={a}
                  className={box.align === a ? 'tool tool-on' : 'tool'}
                  onClick={() => updateTextBox(slide.id, box.id, { align: a })}
                >
                  {a}
                </button>
              ))}
            </div>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={box.frame.w != null}
              onChange={(e) => updateTextBoxFrame(slide.id, box.id, { w: e.target.checked ? DEFAULT_WRAP_W : null })}
            />
            wrap to width
          </label>
          {box.frame.w != null && (
            <label className="slider">
              <span>width <b>{Math.round(box.frame.w * 100)}%</b></span>
              <input
                type="range"
                min={0.15}
                max={1}
                step={0.01}
                value={box.frame.w}
                onChange={(e) => updateTextBoxFrame(slide.id, box.id, { w: Number(e.target.value) })}
              />
            </label>
          )}

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

          <label className="toggle">
            <input type="checkbox" checked={!!boxBrush} onChange={(e) => toggleCustomBrush(e.target.checked)} />
            custom brush (override project brush)
          </label>
          {boxBrush && (
            <>
              <label className="slider">
                <span>brush style</span>
                <div className="seg">
                  {BRUSH_STYLES.map((st) => (
                    <button
                      key={st}
                      className={boxBrush.style === st ? 'tool tool-on' : 'tool'}
                      onClick={() => patchBoxBrush({ style: st })}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </label>
              <label className="slider">
                <span>brush colour</span>
                <div className="bg-row">
                  <input type="color" value={boxBrush.color} onChange={(e) => patchBoxBrush({ color: e.target.value })} />
                  <input
                    type="text"
                    className="bg-hex"
                    value={boxBrush.color}
                    spellCheck={false}
                    onChange={(e) => patchBoxBrush({ color: e.target.value })}
                  />
                </div>
              </label>
              <label className="slider">
                <span>brush size <b>×{boxBrush.sizeScale.toFixed(2)}</b></span>
                <input
                  type="range"
                  min={0.3}
                  max={3}
                  step={0.05}
                  value={boxBrush.sizeScale}
                  onChange={(e) => patchBoxBrush({ sizeScale: Number(e.target.value) })}
                />
              </label>
              <label className="slider">
                <span>brush opacity <b>{Math.round(boxBrush.opacity * 100)}%</b></span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={boxBrush.opacity}
                  onChange={(e) => patchBoxBrush({ opacity: Number(e.target.value) })}
                />
              </label>
            </>
          )}
        </>
      ) : (
        <div className="muted insp-empty">
          Select a textbox to edit its text &amp; style, or click empty space on the slide to add one.
        </div>
      )}

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

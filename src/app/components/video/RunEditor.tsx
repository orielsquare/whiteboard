import { useRef, useState, type MouseEvent } from 'react'
import type { TextBox } from '@lib/project/schema'
import {
  applyStyleToRange,
  runStyleAt,
  runsToPlainText,
  setPlainTextPreservingStyles,
  type StylePatch,
} from '@lib/project/runs'
import { useVideoStore } from '../../state/videoStore'

const SIZE_MIN = 0.3
const SIZE_MAX = 5
const clampSize = (v: number) => Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(v * 10) / 10))

/**
 * Edit a textbox's styled text. The `<textarea>` is bound to the flattened plain
 * text; typing diffs the text and preserves styles. Size / colour / underline
 * apply to the live selection range (offsets read fresh from the textarea).
 */
export function RunEditor({ box, slideId, brushColor }: { box: TextBox; slideId: string; brushColor: string }) {
  const updateTextBoxRuns = useVideoStore((s) => s.updateTextBoxRuns)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const [sel, setSel] = useState({ start: 0, end: 0 })

  const text = runsToPlainText(box.runs)
  const hasSel = sel.end > sel.start
  const active = runStyleAt(box.runs, sel.start)

  const syncSel = () => {
    const ta = taRef.current
    if (ta) setSel({ start: ta.selectionStart, end: ta.selectionEnd })
  }

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateTextBoxRuns(slideId, box.id, setPlainTextPreservingStyles(box.runs, e.target.value))
    // selection is updated by the subsequent onSelect the browser fires
  }

  const apply = (patch: StylePatch) => {
    const ta = taRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    if (end <= start) return
    updateTextBoxRuns(slideId, box.id, applyStyleToRange(box.runs, start, end, patch))
    // keep the same range selected so multiple styles can be stacked
    requestAnimationFrame(() => {
      const t = taRef.current
      if (t) {
        t.focus()
        t.setSelectionRange(start, end)
      }
    })
  }

  const keepFocus = (e: MouseEvent) => e.preventDefault()

  return (
    <div className="runeditor">
      <textarea
        ref={taRef}
        className="run-textarea"
        rows={3}
        value={text}
        onChange={onChange}
        onSelect={syncSel}
        spellCheck={false}
        placeholder="Type the slide text…"
      />

      <div className="run-style-row">
        <span className="run-style-label">size</span>
        <button className="tool" disabled={!hasSel} onMouseDown={keepFocus} onClick={() => apply({ sizeScale: clampSize(active.sizeScale - 0.1) })}>
          A−
        </button>
        <span className="run-size-val">{active.sizeScale.toFixed(1)}×</span>
        <button className="tool" disabled={!hasSel} onMouseDown={keepFocus} onClick={() => apply({ sizeScale: clampSize(active.sizeScale + 0.1) })}>
          A+
        </button>
        <button
          className={hasSel && active.underline ? 'tool tool-on' : 'tool'}
          disabled={!hasSel}
          onMouseDown={keepFocus}
          onClick={() => apply({ underline: !active.underline })}
          title="underline"
        >
          U̲
        </button>
        <input
          type="color"
          disabled={!hasSel}
          value={active.color ?? brushColor}
          onChange={(e) => apply({ color: e.target.value })}
          title="text colour"
        />
        <button className="tool" disabled={!hasSel || active.color == null} onMouseDown={keepFocus} onClick={() => apply({ color: null })} title="use brush colour">
          ⊘
        </button>
      </div>
      <div className="run-style-hint">{hasSel ? 'styling applies to the selected text' : 'select text to style it'}</div>

      <div className="run-preview" aria-hidden>
        {box.runs.map((r, i) => (
          <span
            key={i}
            style={{
              fontSize: `${(r.sizeScale ?? 1) * 100}%`,
              color: r.color ?? brushColor,
              textDecoration: r.underline ? 'underline' : 'none',
            }}
          >
            {r.text}
          </span>
        ))}
      </div>
    </div>
  )
}

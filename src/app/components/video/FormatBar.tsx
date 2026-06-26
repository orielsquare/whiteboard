import { useEffect, useState, type MouseEvent } from 'react'
import type { BrushStyle } from '@lib/manifest/schema'
import type { ProjectDefaults, TextAlign, TextBox } from '@lib/project/schema'
import { MIXED, runsToPlainText, selectionStyle, type Maybe, type SelectionStyle, type StylePatch } from '@lib/project/runs'
import { contentOf } from '@lib/project/aspect'
import { httpStore, type FontSummary } from '@lib/persistence/FontStore'
import { useVideoStore } from '../../state/videoStore'
import { restoreOverlaySelection } from './TextBoxOverlay'

const ALIGNS: TextAlign[] = ['left', 'center', 'right']
const PEN_STYLES: BrushStyle[] = ['chalk', 'ink', 'marker']
const SIZE_MIN = 0.3
const SIZE_MAX = 5
const clampSize = (v: number) => Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(v * 10) / 10))

/**
 * The single horizontal text-formatting bar. It targets, in order of preference:
 * the active sub-range selection, else the whole selected textbox, else (nothing
 * selected) the new-textbox defaults. Per-run controls (size / colour /
 * underline / kerning) route through `applyTextStyle`; per-box controls
 * (line-height / align) through `updateTextBox`. Mixed fields show as
 * indeterminate and applying one field never touches the others.
 */
export function FormatBar() {
  const project = useVideoStore((s) => s.project)
  const activeAspect = useVideoStore((s) => s.activeAspect)
  const selectedSlideId = useVideoStore((s) => s.selectedSlideId)
  const selectedTextBoxId = useVideoStore((s) => s.selectedTextBoxId)
  const selection = useVideoStore((s) => s.selection)
  const applyTextStyle = useVideoStore((s) => s.applyTextStyle)
  const setBoxContent = useVideoStore((s) => s.setBoxContent)
  const setDefaults = useVideoStore((s) => s.setDefaults)
  const setProjectFont = useVideoStore((s) => s.setProjectFont)
  const setBrush = useVideoStore((s) => s.setBrush)
  const applyNamedStyle = useVideoStore((s) => s.applyNamedStyle)
  const addNamedStyle = useVideoStore((s) => s.addNamedStyle)
  const updateNamedStyle = useVideoStore((s) => s.updateNamedStyle)

  // Saved fonts populate the font dropdown (font as a per-selection format option).
  const [savedFonts, setSavedFonts] = useState<FontSummary[]>([])
  useEffect(() => {
    httpStore.list().then(setSavedFonts).catch(() => {})
  }, [])

  if (!project) return null
  const slide = project.slides.find((s) => s.id === selectedSlideId) ?? project.slides[0]
  const box: TextBox | undefined = slide?.textBoxes.find((b) => b.id === selectedTextBoxId)
  const brushColor = project.brush.color

  // Resolve the target range + the displayed (possibly-mixed) style — against the
  // ACTIVE aspect's content (which may differ from the shared base when unlinked).
  const content = box ? contentOf(box, activeAspect) : null
  const len = content ? runsToPlainText(content.runs).length : 0
  const hasRange = !!box && !!selection && selection.boxId === box.id && selection.anchor !== selection.focus
  const start = hasRange ? Math.min(selection!.anchor, selection!.focus) : 0
  const end = hasRange ? Math.max(selection!.anchor, selection!.focus) : len

  const d = project.defaults
  const style = content ? selectionStyle(content.runs, start, end) : null
  const sizeVal: Maybe<number> = style ? style.sizeScale : d.sizeScale
  const colorVal: Maybe<string | null> = style ? style.color : d.runColor
  const underlineVal: Maybe<boolean> = style ? style.underline : d.runUnderline
  const kernVal: Maybe<number> = style ? style.letterSpacing : d.runLetterSpacing
  const lineHeight = content ? content.lineHeightScale : d.lineHeightScale
  const align = content ? content.align : d.align
  const fontVal: Maybe<string | null> = style ? style.fontId : project.fontId
  // The dropdown always shows a concrete font: a run with no explicit fontId
  // resolves to the project default. (No "Default" pseudo-entry.)
  const fontSelectValue = box
    ? fontVal === MIXED
      ? '__mixed__'
      : ((fontVal as string | null) || project.fontId)
    : project.fontId
  const savedFontIds = new Set(savedFonts.map((f) => f.id))

  // Dispatch a run-style patch to the selection/box, or to the new-box defaults.
  const applyRun = (patch: StylePatch) => {
    if (box) applyTextStyle(slide.id, box.id, start, end, patch)
    else setDefaults(patchToDefaults(patch))
  }
  const setAlign = (a: TextAlign) => (box ? setBoxContent(slide.id, box.id, { align: a }) : setDefaults({ align: a }))
  const setLineHeight = (v: number) =>
    box ? setBoxContent(slide.id, box.id, { lineHeightScale: v }) : setDefaults({ lineHeightScale: v })
  // Font: per-run on a box/selection ('' = inherit project default); the project
  // default font when nothing is selected.
  const onFont = (v: string) => {
    if (v === '__mixed__') return
    if (box) {
      applyRun({ fontId: v })
      restoreOverlaySelection() // <select> stole focus — return it + the selection
    } else setProjectFont(v)
  }
  // Save the current selection as a named style. Only the non-mixed fields are
  // captured, so a style saved from mixed text won't overwrite those fields when
  // applied. Reusing an existing name updates that style.
  const onSaveStyle = () => {
    if (!box || !style) return
    const name = window.prompt('Style name (an existing name updates that style):', '')
    if (!name || !name.trim()) return
    const patch = patchFromSelection(style)
    const match = (project.namedStyles ?? []).find((s) => s.name.toLowerCase() === name.trim().toLowerCase())
    if (match) updateNamedStyle(match.id, { style: patch })
    else addNamedStyle(name.trim(), patch)
  }

  const keepFocus = (e: MouseEvent) => e.preventDefault()
  const sizeBase = sizeVal === MIXED ? 1 : (sizeVal as number)
  const underlineOn = underlineVal === true
  // With a selection: per-run text colour (falling back to the brush colour).
  // With nothing selected: the global pen/brush colour itself.
  const colorInput = box ? (colorVal === MIXED || colorVal == null ? brushColor : (colorVal as string)) : brushColor
  const onColor = (v: string) => {
    if (box) {
      applyRun({ color: v })
      restoreOverlaySelection() // <input> stole focus — return it + the selection
    } else setBrush({ ...project.brush, color: v })
  }

  return (
    <div className="formatbar">
      <div className="fmt-group">
        <span className="fmt-label">font</span>
        <select className="fmt-font" value={fontSelectValue} onChange={(e) => onFont(e.target.value)} title="font">
          {fontSelectValue === '__mixed__' && <option value="__mixed__">— mixed —</option>}
          {fontSelectValue !== '__mixed__' && !savedFontIds.has(fontSelectValue) && (
            <option value={fontSelectValue}>current font</option>
          )}
          {savedFonts.map((f) => (
            <option key={f.id} value={f.id}>
              {f.family}
            </option>
          ))}
        </select>
      </div>

      <div className="fmt-group seg">
        {ALIGNS.map((a) => (
          <button key={a} className={align === a ? 'tool tool-on' : 'tool'} onMouseDown={keepFocus} onClick={() => setAlign(a)} title={`align ${a}`}>
            <AlignIcon a={a} />
          </button>
        ))}
      </div>

      <div className="fmt-group">
        <span className="fmt-label">size</span>
        <button className="tool" onMouseDown={keepFocus} onClick={() => applyRun({ sizeScale: clampSize(sizeBase - 0.1) })}>A−</button>
        <span className="fmt-val">{sizeVal === MIXED ? '—' : `${sizeBase.toFixed(1)}×`}</span>
        <button className="tool" onMouseDown={keepFocus} onClick={() => applyRun({ sizeScale: clampSize(sizeBase + 0.1) })}>A+</button>
      </div>

      <button
        className={underlineOn ? 'tool tool-on' : 'tool'}
        onMouseDown={keepFocus}
        onClick={() => applyRun({ underline: !underlineOn })}
        title="underline"
      >
        U̲
      </button>

      <div className="fmt-group seg" title="pen / brush style">
        {PEN_STYLES.map((st) => (
          <button
            key={st}
            className={project.brush.style === st ? 'tool tool-on' : 'tool'}
            onMouseDown={keepFocus}
            onClick={() => setBrush({ ...project.brush, style: st })}
          >
            {st}
          </button>
        ))}
      </div>

      <div className="fmt-group">
        <span className="fmt-label">colour</span>
        <input type="color" value={colorInput} onChange={(e) => onColor(e.target.value)} title={colorVal === MIXED ? 'mixed colours' : box ? 'text colour' : 'pen colour'} />
        <button className="tool" disabled={!box} onMouseDown={keepFocus} onClick={() => applyRun({ color: null })} title="use pen colour">
          ⊘
        </button>
      </div>

      <div className="fmt-group">
        <span className="fmt-label">line</span>
        <input
          type="number"
          className="fmt-num"
          min={0.6}
          max={3}
          step={0.05}
          value={Number(lineHeight.toFixed(2))}
          onChange={(e) => setLineHeight(Math.max(0.6, Math.min(3, Number(e.target.value) || 1)))}
          title="line height"
        />
      </div>

      <div className="fmt-group">
        <span className="fmt-label">kern</span>
        <input
          type="number"
          className="fmt-num"
          min={-0.1}
          max={0.5}
          step={0.01}
          value={kernVal === MIXED ? '' : Number((kernVal as number).toFixed(2))}
          placeholder="—"
          onChange={(e) => applyRun({ letterSpacing: Math.max(-0.1, Math.min(0.5, Number(e.target.value) || 0)) })}
          title="kerning (letter spacing, ems)"
        />
      </div>

      <div className="fmt-group">
        <span className="fmt-label">style</span>
        <select
          className="fmt-style"
          value=""
          disabled={!box}
          onChange={(e) => {
            if (box && e.target.value) {
              applyNamedStyle(slide.id, box.id, start, end, e.target.value)
              restoreOverlaySelection()
            }
          }}
          title="apply a saved style to the selection"
        >
          <option value="">Apply…</option>
          {(project.namedStyles ?? []).map((ns) => (
            <option key={ns.id} value={ns.id}>
              {ns.name}
            </option>
          ))}
        </select>
        <button className="tool" disabled={!box} onMouseDown={keepFocus} onClick={onSaveStyle} title="save the selection as a named style">
          ＋ Save
        </button>
      </div>
    </div>
  )
}

/** Capture a StylePatch from a selection, omitting fields that are MIXED so the
 *  saved style only carries the uniform parts (won't clobber the rest on apply). */
function patchFromSelection(s: SelectionStyle): StylePatch {
  const p: StylePatch = {}
  if (s.sizeScale !== MIXED) p.sizeScale = s.sizeScale
  if (s.color !== MIXED) p.color = s.color
  if (s.underline !== MIXED) p.underline = s.underline
  if (s.letterSpacing !== MIXED) p.letterSpacing = s.letterSpacing
  if (s.fontId !== MIXED) p.fontId = s.fontId ?? '' // null (default font) → '' clears to default
  return p
}

/** Map a run-style patch onto the new-textbox default fields. */
function patchToDefaults(p: StylePatch): Partial<ProjectDefaults> {
  const out: Partial<ProjectDefaults> = {}
  if (p.sizeScale !== undefined) out.sizeScale = p.sizeScale
  if (p.color !== undefined) out.runColor = p.color
  if (p.underline !== undefined) out.runUnderline = p.underline
  if (p.letterSpacing !== undefined) out.runLetterSpacing = p.letterSpacing
  return out
}

/** Standard text-alignment glyph: 4 lines ranged left / centred / right. */
function AlignIcon({ a }: { a: TextAlign }) {
  const widths = [11, 7, 11, 8]
  const xFor = (w: number) => (a === 'left' ? 1.5 : a === 'right' ? 14.5 - w : (16 - w) / 2)
  return (
    <svg viewBox="0 0 16 13" width="14" height="11" aria-hidden="true" focusable="false">
      {widths.map((w, i) => (
        <rect key={i} x={xFor(w)} y={1.4 + i * 3} width={w} height="1.4" rx="0.7" fill="currentColor" />
      ))}
    </svg>
  )
}

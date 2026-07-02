import { useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { DEFAULT_PARAMS, extractionSig, type GlyphExtractor } from '@lib/extraction'
import type { LoadedFont } from '@lib/font/load'
import { EASING_NAMES, type EasingName } from '@lib/geometry/easing'
import { seedGlyphAnimation } from '@lib/manifest/seed'
import type { BrushSettings, StrokeSection } from '@lib/manifest/schema'
import {
  deleteSection,
  mergeSections,
  moveSection,
  orderedSections,
  setSectionOrder,
  splitSection,
  toggleReversed,
  updateSectionTiming,
} from '@lib/manifest/edit'
import { prepareGlyph, sampleGlyph } from '@lib/animation/timeline'
import type { Transform } from '@lib/render/ribbon'
import { paintStroke } from '@lib/render/brush'
import { computeGlyphTransform, drawEditable, pickNearest, strokeColor } from './editorCanvas'
import { CharStepper } from './CharStepper'
import { useEditorStore } from '../state/store'

// The editor's play preview uses a neutral pen — geometry, not applied style.
// (Brush styling lives in the Animation tab.)
const NEUTRAL_PEN: BrushSettings = {
  style: 'ink',
  color: '#f4f4f5',
  sizeScale: 1,
  opacity: 1,
  jitter: 0,
  nibModel: 'round',
  cap: 'round',
  seed: 1,
}

export function EditorView({
  font,
  extractor,
  selectedChar,
  onSelectChar,
  chars,
}: {
  font: LoadedFont
  extractor: GlyphExtractor | null
  selectedChar: string
  onSelectChar: (c: string) => void
  chars: string[]
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [mode, setMode] = useState<'select' | 'split'>('select')
  const [isPlaying, setIsPlaying] = useState(false)
  // Transient preview speed — a playback aid only, never written to the manifest.
  const [speed, setSpeed] = useState(1)
  const speedRef = useRef(1)
  speedRef.current = speed

  const unicode = selectedChar.codePointAt(0) ?? 0
  const key = String(unicode)

  const manifest = useEditorStore((s) => s.manifest)
  const glyph = useEditorStore((s) => s.manifest?.glyphs[key])
  const updateGlyph = useEditorStore((s) => s.updateGlyph)
  const upsertGlyph = useEditorStore((s) => s.upsertGlyph)
  const markReviewed = useEditorStore((s) => s.markReviewed)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const glyphRef = useRef(glyph)
  const selectedRef = useRef<Set<string>>(new Set())
  const transformRef = useRef<Transform>({ scale: 1, ox: 0, oy: 0 })
  const playingRef = useRef(false)
  const preparedRef = useRef<ReturnType<typeof prepareGlyph> | null>(null)
  const tRef = useRef(0)

  glyphRef.current = glyph
  selectedRef.current = new Set(selectedIds)
  playingRef.current = isPlaying

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  // clear transient editor state when switching glyphs
  useEffect(() => {
    setSelectedIds([])
    setMode('select')
    setIsPlaying(false)
  }, [selectedChar])

  // rebuild the animation timeline whenever the glyph changes
  useEffect(() => {
    preparedRef.current = glyph ? prepareGlyph(glyph) : null
    tRef.current = 0
  }, [glyph])

  // single rAF: animate (neutral pen) when playing, else draw the editable view
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = now - last
      last = now
      const canvas = canvasRef.current
      const g = glyphRef.current
      if (canvas && g) {
        const tr = computeGlyphTransform(g.bbox, canvas.width, canvas.height)
        transformRef.current = tr
        if (playingRef.current && preparedRef.current) {
          drawAnimated(canvas, preparedRef.current, tr, tRef.current, font.unitsPerEm)
          tRef.current += dt * speedRef.current
          if (tRef.current > preparedRef.current.totalMs + 600) tRef.current = 0
        } else {
          drawEditable(canvas, g, tr, selectedRef.current)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [font])

  const onCanvasClick = (e: MouseEvent<HTMLCanvasElement>) => {
    if (playingRef.current) return
    const canvas = canvasRef.current
    const g = glyphRef.current
    if (!canvas || !g) return
    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) * canvas.width) / rect.width
    const y = ((e.clientY - rect.top) * canvas.height) / rect.height
    const pick = pickNearest(g, transformRef.current, { x, y })
    if (!pick) {
      if (!e.shiftKey) setSelectedIds([])
      return
    }
    if (mode === 'split') {
      updateGlyph(unicode, (gg) => splitSection(gg, pick.sectionId, pick.pointIndex))
      setMode('select')
      setSelectedIds([])
      return
    }
    if (e.shiftKey) {
      setSelectedIds((ids) =>
        ids.includes(pick.sectionId) ? ids.filter((i) => i !== pick.sectionId) : [...ids, pick.sectionId],
      )
    } else {
      setSelectedIds([pick.sectionId])
    }
  }

  const ordered = glyph ? orderedSections(glyph) : []
  const selectedSection = selectedIds.length === 1 ? glyph?.sections.find((s) => s.id === selectedIds[0]) : undefined

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = ordered.map((s) => s.id)
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    updateGlyph(unicode, (g) => setSectionOrder(g, arrayMove(ids, oldIndex, newIndex)))
  }

  // Re-derive from scratch using THIS glyph's stored extraction settings (or
  // defaults), discarding manual edits. upsertGlyph marks it dirty + undoable.
  const onReset = () => {
    if (!extractor) return
    const p = glyph?.extractionParams ?? DEFAULT_PARAMS
    extractor.extract(selectedChar, p).then((strokes) =>
      upsertGlyph(seedGlyphAnimation(strokes, useEditorStore.getState().manifest?.defaultTiming, extractionSig(p), p)),
    )
    setSelectedIds([])
  }

  return (
    <div className="editor">
      <div className="editor-top">
        <CharStepper label="Glyph" value={selectedChar} onChange={onSelectChar} chars={chars} width={60} />
      </div>

      <div className="editor-body">
        <div className="stage stage-overlay">
          <canvas
            ref={canvasRef}
            width={680}
            height={520}
            onClick={onCanvasClick}
            style={{ cursor: mode === 'split' ? 'crosshair' : 'pointer' }}
          />
          <div className="transport">
            <button onClick={() => { tRef.current = 0; setIsPlaying((p) => !p) }}>
              {isPlaying ? '❚❚ Stop' : '▶ Play glyph'}
            </button>
            <label className="field" title="preview speed — playback aid only, not saved with the font">
              <span>speed ×{speed.toFixed(2)}</span>
              <input type="range" min={0.25} max={3} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
            </label>
            <span className="time">
              {mode === 'split'
                ? 'click a point on a stroke to split it'
                : 'click a stroke to select · shift-click to multi-select'}
            </span>
          </div>
        </div>

        <aside className="inspector">
          <h3>Tools</h3>
          <div className="toolrow">
            <button className={mode === 'select' ? 'tool tool-on' : 'tool'} onClick={() => setMode('select')}>
              Select
            </button>
            <button className={mode === 'split' ? 'tool tool-on' : 'tool'} onClick={() => setMode('split')} disabled={!glyph}>
              ✂ Split
            </button>
            <button
              className="tool"
              disabled={selectedIds.length < 2}
              onClick={() => {
                updateGlyph(unicode, (gg) => mergeSections(gg, selectedIds[0], selectedIds[1]))
                setSelectedIds([])
              }}
            >
              ⤙ Merge
            </button>
            <button className="tool" disabled={!glyph || !extractor} onClick={onReset}>
              ↺ Reset glyph
            </button>
          </div>

          <h3>Strokes{glyph ? ` (${ordered.length})` : ''}</h3>
          {!glyph && <div className="muted">extracting…</div>}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ordered.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <ol className="sectionlist editlist">
                {ordered.map((s, pos) => (
                  <SortableRow
                    key={s.id}
                    s={s}
                    pos={pos}
                    selected={selectedIds.includes(s.id)}
                    onSelect={(id) => setSelectedIds([id])}
                    onMove={(id, dir) => updateGlyph(unicode, (g) => moveSection(g, id, dir))}
                    onFlip={(id) => updateGlyph(unicode, (g) => toggleReversed(g, id))}
                    onDelete={(id) => {
                      updateGlyph(unicode, (g) => deleteSection(g, id))
                      setSelectedIds([])
                    }}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>

          <h3>Timing</h3>
          {selectedSection ? (
            <div className="timing">
              <label className="slider">
                <span>duration <b>{selectedSection.timing.durationMs}ms</b></span>
                <div className="sliderow">
                  <input type="range" min={100} max={2000} step={20} value={Math.min(2000, Math.max(100, selectedSection.timing.durationMs))}
                    onChange={(e) => updateGlyph(unicode, (g) => updateSectionTiming(g, selectedSection.id, { durationMs: Number(e.target.value) }))} />
                  <input type="number" className="num-input" min={20} step={10} value={selectedSection.timing.durationMs}
                    onChange={(e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v) && v >= 1) updateGlyph(unicode, (g) => updateSectionTiming(g, selectedSection.id, { durationMs: v })) }} />
                </div>
              </label>
              <label className="slider">
                <span>delay before <b>{selectedSection.timing.delayBeforeMs}ms</b></span>
                <div className="sliderow">
                  <input type="range" min={0} max={1200} step={20} value={Math.min(1200, Math.max(0, selectedSection.timing.delayBeforeMs))}
                    onChange={(e) => updateGlyph(unicode, (g) => updateSectionTiming(g, selectedSection.id, { delayBeforeMs: Number(e.target.value) }))} />
                  <input type="number" className="num-input" min={0} step={10} value={selectedSection.timing.delayBeforeMs}
                    onChange={(e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v) && v >= 0) updateGlyph(unicode, (g) => updateSectionTiming(g, selectedSection.id, { delayBeforeMs: v })) }} />
                </div>
              </label>
              <label className="slider">
                <span>easing</span>
                <select value={selectedSection.timing.easing}
                  onChange={(e) => updateGlyph(unicode, (g) => updateSectionTiming(g, selectedSection.id, { easing: e.target.value as EasingName }))}>
                  {EASING_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
          ) : (
            <div className="muted">select a single stroke to edit its timing (exact ms in the number fields)</div>
          )}

          <h3>Glyph</h3>
          <label className="toggle">
            <input type="checkbox" checked={!!glyph?.reviewed} onChange={(e) => markReviewed(unicode, e.target.checked)} disabled={!glyph} />
            Mark reviewed
          </label>
        </aside>
      </div>

      <p className="hint">
        Drag <span className="mono">⠿</span> to reorder, flip direction (⇄), Split a stroke (✂ then
        click a point), Merge two selected strokes (⤙). Brush styling is in the Animation tab. Save
        writes the config to <code>fonts/{manifest?.metadata.fontId ?? '…'}/manifest.json</code>.
      </p>
    </div>
  )
}

function SortableRow({
  s,
  pos,
  selected,
  onSelect,
  onMove,
  onFlip,
  onDelete,
}: {
  s: StrokeSection
  pos: number
  selected: boolean
  onSelect: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
  onFlip: (id: string) => void
  onDelete: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }
  const stop = (e: MouseEvent) => e.stopPropagation()
  return (
    <li ref={setNodeRef} style={style} className={selected ? 'sel' : ''} onClick={() => onSelect(s.id)}>
      <span className="drag" title="drag to reorder" {...attributes} {...listeners}>
        ⠿
      </span>
      <span className="swatch" style={{ background: strokeColor(s.id) }} />
      <span className="ord">{pos + 1}</span>
      <span className="sk">{s.kind}</span>
      <span className="rowbtns">
        <button title="move earlier" onClick={(e) => { stop(e); onMove(s.id, -1) }}>↑</button>
        <button title="move later" onClick={(e) => { stop(e); onMove(s.id, 1) }}>↓</button>
        <button title="flip direction" className={s.reversed ? 'on' : ''} onClick={(e) => { stop(e); onFlip(s.id) }}>⇄</button>
        <button title="delete" onClick={(e) => { stop(e); onDelete(s.id) }}>×</button>
      </span>
    </li>
  )
}

function drawAnimated(
  canvas: HTMLCanvasElement,
  prep: ReturnType<typeof prepareGlyph>,
  tr: Transform,
  t: number,
  unitsPerEm: number,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#0b0d11'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(20, tr.oy)
  ctx.lineTo(canvas.width - 20, tr.oy)
  ctx.stroke()

  const minHalfWidth = unitsPerEm * 0.004
  const { reveals } = sampleGlyph(prep, t)
  for (const r of reveals) {
    if (r.revealedLen <= 0 && !r.active) continue
    paintStroke(ctx, r.lut, r.revealedLen, tr, NEUTRAL_PEN, minHalfWidth, r.id)
  }
}

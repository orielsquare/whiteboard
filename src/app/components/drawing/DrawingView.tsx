import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type MouseEvent } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { type BrushSettings, type BrushStyle, type Bbox } from '@lib/manifest/schema'
import { EASING_NAMES, type EasingName } from '@lib/geometry/easing'
import { type Transform } from '@lib/render/ribbon'
import { prepareDrawing, type PreparedDrawing } from '@lib/drawing/timeline'
import { renderPreparedDrawing } from '@lib/drawing/render'
import type { DrawingPart } from '@lib/drawing/schema'
import { DEFAULT_FILL_PARAMS, DEFAULT_STROKE_PARAMS, type FillParams, type StrokeParams } from '@lib/svg/types'
import { drawingHttpStore, type DrawingSummary } from '@lib/persistence/DrawingStore'
import { drawingHistory, useDrawingStore, type OrderDim } from '../../state/drawingStore'

const BRUSH_STYLES: BrushStyle[] = ['chalk', 'ink', 'marker']
const END_HOLD_MS = 700

const SAMPLE_SVG = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <circle cx="100" cy="100" r="80" fill="#ffd54a" stroke="#333" stroke-width="4"/>
  <circle cx="72" cy="84" r="12" fill="#333"/>
  <circle cx="128" cy="84" r="12" fill="#333"/>
  <path d="M62 128 Q100 166 138 128" fill="none" stroke="#333" stroke-width="7"/>
</svg>`

export function DrawingView({
  brush,
  onBrushChange,
}: {
  brush: BrushSettings
  onBrushChange: (b: BrushSettings) => void
}) {
  const manifest = useDrawingStore((s) => s.manifest)
  const error = useDrawingStore((s) => s.error)
  const importSvg = useDrawingStore((s) => s.importSvg)
  const renamePart = useDrawingStore((s) => s.renamePart)
  const togglePartVisible = useDrawingStore((s) => s.togglePartVisible)
  const setPartColor = useDrawingStore((s) => s.setPartColor)
  const setPartOpacity = useDrawingStore((s) => s.setPartOpacity)
  const setPartTiming = useDrawingStore((s) => s.setPartTiming)
  const reorderParts = useDrawingStore((s) => s.reorderParts)
  const reorderZ = useDrawingStore((s) => s.reorderZ)
  const copyPartStyle = useDrawingStore((s) => s.copyPartStyle)
  const pastePartStyle = useDrawingStore((s) => s.pastePartStyle)
  const styleClipboard = useDrawingStore((s) => s.styleClipboard)
  const setFillParams = useDrawingStore((s) => s.setElementFillParams)
  const setStrokeParams = useDrawingStore((s) => s.setElementStrokeParams)
  const setOutlineFill = useDrawingStore((s) => s.setElementOutlineFill)
  const loadManifest = useDrawingStore((s) => s.loadManifest)
  const markSaved = useDrawingStore((s) => s.markSaved)
  const setName = useDrawingStore((s) => s.setName)
  const dirty = useDrawingStore((s) => (s.manifest ? s.editRev !== s.savedRev : false))

  const [selId, setSelId] = useState<string | null>(null)
  const [sortDim, setSortDim] = useState<OrderDim>('draw')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [saved, setSaved] = useState<DrawingSummary[]>([])
  const [saveStatus, setSaveStatus] = useState<string | null>(null)

  // Refresh the saved-drawings list (on mount + after each save).
  const refreshSaved = () => { void drawingHttpStore.list().then(setSaved).catch(() => {}) }
  useEffect(refreshSaved, [])

  const doSave = async () => {
    const m = useDrawingStore.getState().manifest
    if (!m) return
    setSaveStatus('saving…')
    try {
      await drawingHttpStore.save(m)
      markSaved()
      setSaveStatus(null)
      refreshSaved()
    } catch (e) {
      setSaveStatus(`save failed: ${e}`)
    }
  }
  const doOpen = async (id: string) => {
    if (!id) return
    try {
      const m = await drawingHttpStore.load(id)
      if (m) { loadManifest(m); setSelId(null); drawingHistory.clear() }
    } catch (e) {
      setSaveStatus(`open failed: ${e}`)
    }
  }

  const parts = manifest?.parts
  const viewBox = manifest?.metadata.viewBox
  const selected = parts?.find((p) => p.id === selId) ?? null
  const selectedEl = selected ? manifest?.elements.find((e) => e.id === selected.elementId) ?? null : null

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const timeline = useMemo<PreparedDrawing | null>(
    () => (parts && parts.length ? prepareDrawing(parts) : null),
    [parts],
  )

  const [speed, setSpeed] = useState(1)
  const [loop, setLoop] = useState(true)
  const [isPlaying, setIsPlaying] = useState(true)
  const [progress, setProgress] = useState(0)
  const totalMs = Math.max(1, timeline?.totalMs ?? 1)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const timelineRef = useRef<PreparedDrawing | null>(null)
  const transformRef = useRef<Transform>({ scale: 1, ox: 0, oy: 0 })
  const minHalfRef = useRef(0.5)
  const tRef = useRef(0)
  const playingRef = useRef(true)
  const speedRef = useRef(1)
  const loopRef = useRef(true)
  const brushRef = useRef(brush)

  playingRef.current = isPlaying
  speedRef.current = speed
  loopRef.current = loop
  brushRef.current = brush

  useEffect(() => {
    timelineRef.current = timeline
    if (viewBox && canvasRef.current) {
      transformRef.current = fitTransform(viewBox, canvasRef.current)
      minHalfRef.current = Math.max(0.4, viewBox.w * 0.0015)
    }
  }, [timeline, viewBox])

  // restart playback when a new drawing is loaded (viewBox identity changes).
  useEffect(() => {
    tRef.current = 0
    setIsPlaying(true)
  }, [viewBox])

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let lastProgress = 0
    const tick = (now: number) => {
      const dt = now - last
      last = now
      const tl = timelineRef.current
      if (tl) {
        if (playingRef.current) {
          tRef.current += dt * speedRef.current
          const end = tl.totalMs + END_HOLD_MS
          if (tRef.current >= end) {
            if (loopRef.current) tRef.current = 0
            else {
              tRef.current = tl.totalMs
              playingRef.current = false
              setIsPlaying(false)
            }
          }
        }
        drawFrame(canvasRef.current, tl, transformRef.current, tRef.current, brushRef.current, minHalfRef.current)
        if (now - lastProgress > 80) {
          lastProgress = now
          setProgress(tRef.current)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    importSvg(text, file.name.replace(/\.svg$/i, ''), file.name)
    setSelId(null)
    e.target.value = ''
  }

  // The list is displayed in the active order dimension; dragging/↑↓ reorder THAT
  // dimension only. Draw order = the parts array (top = first to draw); z order =
  // the `zOrder` field, shown HIGHEST-first (top of the list is drawn on top).
  const displayParts = useMemo(() => {
    if (!parts) return []
    return sortDim === 'z' ? [...parts].sort((a, b) => b.zOrder - a.zOrder) : parts
  }, [parts, sortDim])
  const drawIndex = useMemo(() => new Map((parts ?? []).map((p, i) => [p.id, i + 1])), [parts])

  // Both drag and ↑↓ produce a new top-to-bottom order and persist it in the
  // active dimension (the other dimension is left untouched).
  const applyOrder = (topToBottomIds: string[]) => {
    if (sortDim === 'z') reorderZ(topToBottomIds)
    else reorderParts(topToBottomIds)
  }
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = displayParts.map((p) => p.id)
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    applyOrder(arrayMove(ids, oldIndex, newIndex))
  }
  const moveInDisplay = (id: string, dir: -1 | 1) => {
    const ids = displayParts.map((p) => p.id)
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    applyOrder(arrayMove(ids, i, j))
  }

  return (
    <div className="drawing-tool">
      <div className="font-actions">
        <button onClick={() => drawingHistory.undo()}>↶ Undo</button>
        <button onClick={() => drawingHistory.redo()}>↷ Redo</button>
        {manifest && (
          <label className="field font-name-field">
            <span>Name</span>
            <input
              className="font-name-input"
              value={manifest.metadata.name}
              onChange={(e) => setName(e.target.value)}
              placeholder="drawing name"
              title="Rename this drawing (used as the Drive file name on save)"
            />
          </label>
        )}
        <button className="primary" onClick={doSave} disabled={!dirty} title={dirty ? 'Save drawing to Drive' : 'No unsaved changes'}>
          💾 Save
        </button>
        <label className="field">
          <span>Open</span>
          <select value="" onChange={(e) => { void doOpen(e.target.value); e.target.value = '' }}>
            <option value="">saved drawings…</option>
            {saved.map((d) => (
              <option key={d.id} value={d.id}>{d.name} · {d.partCount} parts</option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <label className="field">
          <span>Load SVG</span>
          <input type="file" accept=".svg,image/svg+xml" onChange={onFile} />
        </label>
        <button onClick={() => setPasteOpen((o) => !o)}>{pasteOpen ? 'Close paste' : 'Paste SVG…'}</button>
        <button onClick={() => { importSvg(SAMPLE_SVG, 'Sample smiley'); setSelId(null) }}>Load sample</button>
        {saveStatus && <span className="savestatus-inline">{saveStatus}</span>}
      </div>

      {pasteOpen && (
        <div className="toolbar" style={{ alignItems: 'stretch' }}>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste SVG markup here…"
            style={{ flex: 1, minHeight: 80, fontFamily: 'monospace', fontSize: 12 }}
          />
          <button
            className="primary"
            onClick={() => {
              if (pasteText.trim()) { importSvg(pasteText, 'Pasted drawing'); setSelId(null); setPasteOpen(false) }
            }}
          >
            Import
          </button>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {!manifest ? (
        <div className="stage">Load or paste an SVG to begin — or click <em>Load sample</em>.</div>
      ) : (
        <div className="editor-body">
          <div className="stage stage-overlay">
            <canvas ref={canvasRef} width={680} height={520} />
            <div className="transport">
              <button onClick={() => setIsPlaying((p) => !p)}>{isPlaying ? '❚❚ Pause' : '▶ Play'}</button>
              <button onClick={() => { tRef.current = 0; setProgress(0); setIsPlaying(true) }}>↺ Restart</button>
              <input
                type="range"
                className="scrubber"
                min={0}
                max={totalMs}
                step={1}
                value={Math.min(progress, totalMs)}
                onChange={(e) => { tRef.current = Number(e.target.value); setProgress(Number(e.target.value)); setIsPlaying(false) }}
              />
              <span className="time">{(Math.min(progress, totalMs) / 1000).toFixed(1)}s / {(totalMs / 1000).toFixed(1)}s</span>
            </div>
          </div>

          <aside className="inspector">
            <h3>Brush</h3>
            <div className="toolrow">
              {BRUSH_STYLES.map((st) => (
                <button key={st} className={brush.style === st ? 'tool tool-on' : 'tool'} onClick={() => onBrushChange({ ...brush, style: st })}>
                  {st}
                </button>
              ))}
              <input type="color" value={brush.color} onChange={(e) => onBrushChange({ ...brush, color: e.target.value })} />
              <label className="field" style={{ marginLeft: 8 }}>
                <span>Speed ×{speed.toFixed(2)}</span>
                <input type="range" min={0.25} max={3} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
              </label>
              <label className="toggle"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop</label>
            </div>

            <div className="parts-head" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <h3 style={{ margin: 0 }}>Parts ({manifest.parts.length})</h3>
              <span className="spacer" />
              <span className="muted" style={{ fontSize: 11 }}>order:</span>
              <button className={sortDim === 'draw' ? 'tool tool-on' : 'tool'} title="sort/drag by draw (animation) order" onClick={() => setSortDim('draw')}>n ↕</button>
              <button className={sortDim === 'z' ? 'tool tool-on' : 'tool'} title="sort/drag by z (stacking) order" onClick={() => setSortDim('z')}>z ↕</button>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={displayParts.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                <ol className="sectionlist editlist">
                  {displayParts.map((p, pos) => (
                    <PartRow
                      key={p.id}
                      p={p}
                      n={drawIndex.get(p.id) ?? pos + 1}
                      z={p.zOrder}
                      sortDim={sortDim}
                      selected={p.id === selId}
                      swatch={p.color ?? brush.color}
                      onSelect={() => setSelId(p.id)}
                      onRename={(name) => renamePart(p.id, name)}
                      onToggleVisible={() => togglePartVisible(p.id)}
                      onMove={(dir) => moveInDisplay(p.id, dir)}
                      first={pos === 0}
                      last={pos === displayParts.length - 1}
                    />
                  ))}
                </ol>
              </SortableContext>
            </DndContext>

            {selected && selectedEl ? (
              <div className="part-panel">
                <div className="parts-head" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <h3 style={{ margin: 0 }}>{selected.name}</h3>
                  <span className="spacer" />
                  <button className="tool" title="copy this part's colour, alpha, timing & geometry" onClick={() => copyPartStyle(selected.id)}>⧉ Copy</button>
                  <button className="tool" disabled={!styleClipboard} title="paste copied settings onto this part" onClick={() => pastePartStyle(selected.id)}>⤓ Paste</button>
                </div>
                {styleClipboard && <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>clipboard: {styleClipboard.sourceKind} settings</div>}
                <h3>{selected.kind === 'fill' ? 'Shading' : 'Outline'} — timing</h3>
                <div className="timing">
                  <label className="slider">
                    <span>duration <b>{selected.timing.durationMs}ms</b></span>
                    <input type="range" min={100} max={4000} step={20} value={selected.timing.durationMs}
                      onChange={(e) => setPartTiming(selected.id, { durationMs: Number(e.target.value) })} />
                  </label>
                  <label className="slider">
                    <span>delay before <b>{selected.timing.delayBeforeMs}ms</b></span>
                    <input type="range" min={0} max={1500} step={20} value={selected.timing.delayBeforeMs}
                      onChange={(e) => setPartTiming(selected.id, { delayBeforeMs: Number(e.target.value) })} />
                  </label>
                  <label className="slider">
                    <span>easing</span>
                    <select value={selected.timing.easing}
                      onChange={(e) => setPartTiming(selected.id, { easing: e.target.value as EasingName })}>
                      {EASING_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                </div>

                <h3>Colour</h3>
                <div className="toolrow">
                  <input type="color" value={selected.color ?? brush.color} onChange={(e) => setPartColor(selected.id, e.target.value)} />
                  <button className="tool" disabled={selected.color == null} onClick={() => setPartColor(selected.id, null)}>↺ brush colour</button>
                </div>
                <div className="timing">
                  <Slider label="alpha" min={5} max={100} step={5} value={Math.round((selected.opacity ?? brush.opacity) * 100)} suffix="%"
                    onChange={(v) => setPartOpacity(selected.id, v / 100)} />
                </div>

                <h3>{selected.kind === 'fill' ? 'Hatch geometry' : 'Outline geometry'}</h3>
                {selected.kind === 'fill' ? (
                  <FillEditor value={selectedEl.fillParams ?? DEFAULT_FILL_PARAMS} onChange={(p) => setFillParams(selectedEl.id, p)} />
                ) : (
                  <StrokeEditor value={selectedEl.strokeParams ?? DEFAULT_STROKE_PARAMS} onChange={(p) => setStrokeParams(selectedEl.id, p)} />
                )}

                {selected.kind === 'fill' && !selectedEl.hasOutline && (
                  <label className="toggle" style={{ marginTop: 8 }}>
                    <input type="checkbox" checked={!!selectedEl.outlineFill} onChange={(e) => setOutlineFill(selectedEl.id, e.target.checked)} />
                    Sketch boundary before shading
                  </label>
                )}
              </div>
            ) : (
              <div className="muted">select a part to edit its timing, colour and geometry</div>
            )}
          </aside>
        </div>
      )}

      <p className="hint">
        Each SVG shape becomes an <b>outline</b> and/or a <b>shading</b> part. Drag <span className="mono">⠿</span> to
        reorder the drawing sequence, double-click a name to rename, 👁 to hide (skipped, takes no time), and set
        per-part colour, speed and easing. Outlines draw as pen strokes; fills shade with diagonal hatching.
      </p>
    </div>
  )
}

function PartRow({
  p,
  n,
  z,
  sortDim,
  selected,
  swatch,
  onSelect,
  onRename,
  onToggleVisible,
  onMove,
  first,
  last,
}: {
  p: DrawingPart
  n: number
  z: number
  sortDim: OrderDim
  selected: boolean
  swatch: string
  onSelect: () => void
  onRename: (name: string) => void
  onToggleVisible: () => void
  onMove: (dir: -1 | 1) => void
  first: boolean
  last: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: p.id })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(p.name)
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : p.visible ? 1 : 0.45 }
  const stop = (e: MouseEvent) => e.stopPropagation()
  const badge = (active: boolean): CSSProperties => ({
    minWidth: 16,
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
    fontWeight: active ? 700 : 400,
    color: active ? 'var(--accent, #7aa2ff)' : 'rgba(255,255,255,0.4)',
  })
  return (
    <li ref={setNodeRef} style={style} className={selected ? 'sel' : ''} onClick={onSelect}>
      <span className="drag" title={`drag to reorder ${sortDim === 'z' ? 'stacking' : 'draw'} order`} {...attributes} {...listeners}>⠿</span>
      <span className="swatch" style={{ background: swatch }} />
      <span style={badge(sortDim === 'draw')} title="draw (animation) order">{n}</span>
      <span style={badge(sortDim === 'z')} title="z (stacking) order">{z}</span>
      {editing ? (
        <input
          className="part-name-input"
          autoFocus
          value={draft}
          onClick={stop}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { onRename(draft.trim() || p.name); setEditing(false) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') { setDraft(p.name); setEditing(false) }
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
      ) : (
        <span className="part-name" style={{ flex: 1 }} title="double-click to rename"
          onDoubleClick={(e) => { stop(e); setDraft(p.name); setEditing(true) }}>
          {p.name}
        </span>
      )}
      <span className="sk">{p.kind}</span>
      <span className="rowbtns">
        <button title={p.visible ? 'hide (skipped + takes no time)' : 'show'} className={p.visible ? '' : 'on'}
          onClick={(e) => { stop(e); onToggleVisible() }}>{p.visible ? '👁' : '🚫'}</button>
        <button title="move earlier" disabled={first} onClick={(e) => { stop(e); onMove(-1) }}>↑</button>
        <button title="move later" disabled={last} onClick={(e) => { stop(e); onMove(1) }}>↓</button>
      </span>
    </li>
  )
}

function FillEditor({ value, onChange }: { value: FillParams; onChange: (p: FillParams) => void }) {
  return (
    <div className="timing">
      <Slider label="angle" min={-90} max={90} step={5} value={value.angleDeg} suffix="°" onChange={(v) => onChange({ ...value, angleDeg: v })} />
      <Slider label="spacing" min={2} max={20} step={0.5} value={value.spacingPx} onChange={(v) => onChange({ ...value, spacingPx: v })} />
      <Slider label="line width" min={0.5} max={8} step={0.5} value={value.lineWidthPx} onChange={(v) => onChange({ ...value, lineWidthPx: v })} />
      <Slider label="spacing wobble" min={0} max={1} step={0.05} value={value.jitter ?? 0} onChange={(v) => onChange({ ...value, jitter: v })} />
      <Slider label="line wobble" min={0} max={2} step={0.1} value={value.lineWobbleDeg ?? 0} suffix="°" onChange={(v) => onChange({ ...value, lineWobbleDeg: v })} />
    </div>
  )
}

function StrokeEditor({ value, onChange }: { value: StrokeParams; onChange: (p: StrokeParams) => void }) {
  return (
    <div className="timing">
      <Slider label="sampling" min={1} max={10} step={0.5} value={value.resampleSpacingPx} onChange={(v) => onChange({ ...value, resampleSpacingPx: v })} />
      <Slider label="min width" min={0.2} max={6} step={0.2} value={value.minWidthPx ?? 1} onChange={(v) => onChange({ ...value, minWidthPx: v })} />
    </div>
  )
}

function Slider({ label, min, max, step, value, suffix, onChange }: {
  label: string; min: number; max: number; step: number; value: number; suffix?: string; onChange: (v: number) => void
}) {
  return (
    <label className="slider">
      <span>{label} <b>{value}{suffix ?? ''}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

function fitTransform(vb: Bbox, canvas: HTMLCanvasElement): Transform {
  const W = canvas.width
  const H = canvas.height
  const m = 48
  const bw = Math.max(vb.w, 1)
  const bh = Math.max(vb.h, 1)
  const scale = Math.min((W - m * 2) / bw, (H - m * 2) / bh)
  const ox = (W - bw * scale) / 2 - vb.x * scale
  const oy = (H - bh * scale) / 2 - vb.y * scale
  return { scale, ox, oy }
}

function drawFrame(
  canvas: HTMLCanvasElement | null,
  tl: PreparedDrawing,
  tr: Transform,
  t: number,
  brush: BrushSettings,
  minHalfWidth: number,
) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#0b0d11'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  renderPreparedDrawing(ctx, tl, tr, brush, minHalfWidth, t)
}

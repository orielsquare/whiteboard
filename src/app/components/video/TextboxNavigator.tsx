import { type MouseEvent } from 'react'
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
import { contentsDiverge, effLock, framesDiverge } from '@lib/project/aspect'
import { runsToPlainText } from '@lib/project/runs'
import type { Slide, SlideDrawing, TextBox } from '@lib/project/schema'
import { useVideoStore } from '../../state/videoStore'
import { useConfirm } from './ConfirmDialog'
import { useDrawingPicker } from './DrawingPicker'
import { LockButton, LockColHeader, aggregateLock } from './LockControls'

/**
 * The "Elements" tab of the Editor navigator: lists the current slide's textboxes
 * AND placed drawings in their shared animation order (drag to reorder either).
 * Textboxes are made by clicking the canvas; drawings are added via the "+ Drawing"
 * button (a modal saved-drawing picker). Boxes keep their position/format padlocks.
 */
export function TextboxNavigator() {
  const project = useVideoStore((s) => s.project)
  const selectedSlideId = useVideoStore((s) => s.selectedSlideId)
  const reorderItems = useVideoStore((s) => s.reorderSlideItems)
  const select = useVideoStore((s) => s.selectTextBox)
  const selectedId = useVideoStore((s) => s.selectedTextBoxId)
  const selectDrawing = useVideoStore((s) => s.selectDrawing)
  const selectedDrawingId = useVideoStore((s) => s.selectedDrawingId)
  const addDrawing = useVideoStore((s) => s.addDrawing)
  const removeDrawing = useVideoStore((s) => s.removeDrawing)
  const setBoxPositionLink = useVideoStore((s) => s.setBoxPositionLink)
  const setSlidePositionLink = useVideoStore((s) => s.setSlidePositionLink)
  const setBoxFormatLink = useVideoStore((s) => s.setBoxFormatLink)
  const setSlideFormatLink = useVideoStore((s) => s.setSlideFormatLink)
  const playback = useVideoStore((s) => s.playback)
  const setPlayback = useVideoStore((s) => s.setPlayback)
  const { confirm, modal } = useConfirm()
  const { pick, modal: pickerModal } = useDrawingPicker()

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const slide: Slide | undefined = project
    ? project.slides.find((s) => s.id === selectedSlideId) ?? project.slides[0]
    : undefined

  if (!project || !slide) return <div className="muted order-empty">No slide.</div>

  const boxes = [...slide.textBoxes].sort((a, b) => a.animOrder - b.animOrder)
  // The combined animation sequence: boxes + drawings interleaved by animOrder.
  type Item =
    | { kind: 'box'; id: string; animOrder: number; box: TextBox }
    | { kind: 'draw'; id: string; animOrder: number; drawing: SlideDrawing }
  const items: Item[] = [
    ...slide.textBoxes.map((b) => ({ kind: 'box' as const, id: b.id, animOrder: b.animOrder, box: b })),
    ...(slide.drawings ?? []).map((d) => ({ kind: 'draw' as const, id: d.id, animOrder: d.animOrder, drawing: d })),
  ].sort((a, b) => a.animOrder - b.animOrder)

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = items.map((it) => it.id)
    const oi = ids.indexOf(String(active.id))
    const ni = ids.indexOf(String(over.id))
    if (oi < 0 || ni < 0) return
    reorderItems(slide.id, arrayMove(ids, oi, ni))
  }

  const onAddDrawing = async () => {
    const d = await pick()
    // y is width-units (editor space); the store converts to a height fraction.
    if (d) addDrawing(slide.id, d.id, d.name, 0.35, 0.12, 0.3)
  }

  const posHeader = aggregateLock(boxes.map((b) => effLock(project, slide, b).position))
  const fmtHeader = aggregateLock(boxes.map((b) => effLock(project, slide, b).content))

  const togglePosHeader = async () => {
    if (posHeader === 'on') return setSlidePositionLink(slide.id, false)
    const reverts = boxes.filter(framesDiverge).length
    if (reverts > 0 && !(await confirm(linkWarning(reverts, 'position')))) return
    setSlidePositionLink(slide.id, true)
  }
  const toggleFmtHeader = async () => {
    if (fmtHeader === 'on') return setSlideFormatLink(slide.id, false)
    const reverts = boxes.filter(contentsDiverge).length
    if (reverts > 0 && !(await confirm(linkWarning(reverts, 'format')))) return
    setSlideFormatLink(slide.id, true)
  }
  const toggleBoxPos = async (b: TextBox) => {
    if (effLock(project, slide, b).position) return setBoxPositionLink(slide.id, b.id, false)
    if (framesDiverge(b) && !(await confirm(linkWarning(1, 'position')))) return
    setBoxPositionLink(slide.id, b.id, true)
  }
  const toggleBoxFmt = async (b: TextBox) => {
    if (effLock(project, slide, b).content) return setBoxFormatLink(slide.id, b.id, false)
    if (contentsDiverge(b) && !(await confirm(linkWarning(1, 'format')))) return
    setBoxFormatLink(slide.id, b.id, true)
  }

  return (
    <div className="navlist-wrap">
      <div className="slidepanel-head">
        <span>Elements ({items.length})</span>
        <button onClick={onAddDrawing} title="Add a saved drawing to this slide">+ Drawing</button>
      </div>
      <div className="navhead navhead-rowinset">
        <span className="navhead-title muted">click the slide to add a textbox</span>
        <span className="lockcols">
          <LockColHeader label="p" state={posHeader} title="Position — lock/unlink all textboxes on this slide" onClick={togglePosHeader} />
          <LockColHeader label="f" state={fmtHeader} title="Format — lock/unlink all textboxes on this slide" onClick={toggleFmtHeader} />
        </span>
      </div>
      {items.length === 0 ? (
        <div className="muted order-empty">No elements — click empty space on the slide to add a textbox, or “+ Drawing”.</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((it) => it.id)} strategy={verticalListSortingStrategy}>
            <ol className="orderlist">
              {items.map((it, i) =>
                it.kind === 'box' ? (
                  <OrderRow
                    key={it.id}
                    box={it.box}
                    index={i}
                    selected={it.id === selectedId}
                    posLinked={effLock(project, slide, it.box).position}
                    fmtLinked={effLock(project, slide, it.box).content}
                    diverged={framesDiverge(it.box) || contentsDiverge(it.box)}
                    playing={playback?.kind === 'box' && playback.slideId === slide.id && playback.boxId === it.id}
                    onSelect={() => select(it.id)}
                    onTogglePlay={() =>
                      setPlayback(
                        playback?.kind === 'box' && playback.slideId === slide.id && playback.boxId === it.id
                          ? null
                          : { kind: 'box', slideId: slide.id, boxId: it.id },
                      )
                    }
                    onTogglePos={() => toggleBoxPos(it.box)}
                    onToggleFmt={() => toggleBoxFmt(it.box)}
                  />
                ) : (
                  <DrawingRow
                    key={it.id}
                    drawing={it.drawing}
                    index={i}
                    selected={it.id === selectedDrawingId}
                    onSelect={() => selectDrawing(it.id)}
                    onDelete={() => removeDrawing(slide.id, it.id)}
                  />
                ),
              )}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      {modal}
      {pickerModal}
    </div>
  )
}

function linkWarning(count: number, kind: 'position' | 'format'): string {
  const n = count === 1 ? 'this textbox’s' : `${count} textbox(es)’`
  return `Re-linking will change the other aspect ratio’s ${kind} to match this one for ${n} layout. This can’t be undone separately per aspect. Continue?`
}

function OrderRow({
  box,
  index,
  selected,
  posLinked,
  fmtLinked,
  diverged,
  playing,
  onSelect,
  onTogglePlay,
  onTogglePos,
  onToggleFmt,
}: {
  box: TextBox
  index: number
  selected: boolean
  posLinked: boolean
  fmtLinked: boolean
  diverged: boolean
  playing: boolean
  onSelect: () => void
  onTogglePlay: () => void
  onTogglePos: () => void
  onToggleFmt: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: box.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }
  const label = runsToPlainText(box.runs).replace(/\n/g, ' ').slice(0, 22) || '(empty)'

  return (
    <li ref={setNodeRef} style={style} className={selected ? 'order-row sel' : 'order-row'} onClick={onSelect}>
      <span className="drag" title="drag to reorder" {...attributes} {...listeners}>⠿</span>
      <span className="order-no">{index + 1}</span>
      <span className={diverged ? 'order-label diverged' : 'order-label'} title={diverged ? 'Differs between the two aspect ratios' : undefined}>
        {label}
      </span>
      <span className="rowbtns">
        <button className={playing ? 'on' : ''} title={playing ? 'stop' : 'play this textbox (loops)'} onClick={(e) => { e.stopPropagation(); onTogglePlay() }}>
          {playing ? '■' : '▶'}
        </button>
      </span>
      <span className="lockcols">
        <LockButton kind="p" state={posLinked ? 'on' : 'off'} title={posLinked ? 'Position — linked across aspect ratios (click to unlink)' : 'Position — separate per aspect ratio (click to re-link)'} onClick={onTogglePos} />
        <LockButton kind="f" state={fmtLinked ? 'on' : 'off'} title={fmtLinked ? 'Format — linked across aspect ratios (click to unlink)' : 'Format — separate per aspect ratio (click to re-link)'} onClick={onToggleFmt} />
      </span>
    </li>
  )
}

/** A placed-drawing row in the Elements list (no per-aspect locks; a ▦ marks it). */
function DrawingRow({
  drawing,
  index,
  selected,
  onSelect,
  onDelete,
}: {
  drawing: SlideDrawing
  index: number
  selected: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: drawing.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }
  const stop = (e: MouseEvent) => e.stopPropagation()
  return (
    <li ref={setNodeRef} style={style} className={selected ? 'order-row sel' : 'order-row'} onClick={onSelect}>
      <span className="drag" title="drag to reorder" {...attributes} {...listeners}>⠿</span>
      <span className="order-no">{index + 1}</span>
      <span className="order-label" title="drawing">▦ {drawing.name ?? 'drawing'}</span>
      <span className="rowbtns">
        <button title="remove drawing from slide" onClick={(e) => { stop(e); onDelete() }}>×</button>
      </span>
      <span className="lockcols" />
    </li>
  )
}

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
import type { Slide, TextBox } from '@lib/project/schema'
import { useVideoStore } from '../../state/videoStore'
import { useConfirm } from './ConfirmDialog'
import { LockButton, LockColHeader, aggregateLock } from './LockControls'

/**
 * The "Textboxes" tab of the Editor navigator: lists the current slide's boxes in
 * animation order (drag to reorder, per-box "time before display"), plus the
 * per-box position/format padlocks and column-header bulk toggles. Linking a
 * diverged box reverts the other aspect (active wins) — guarded by a confirm.
 */
export function TextboxNavigator() {
  const project = useVideoStore((s) => s.project)
  const selectedSlideId = useVideoStore((s) => s.selectedSlideId)
  const reorder = useVideoStore((s) => s.reorderTextBoxes)
  const select = useVideoStore((s) => s.selectTextBox)
  const selectedId = useVideoStore((s) => s.selectedTextBoxId)
  const setBoxPositionLink = useVideoStore((s) => s.setBoxPositionLink)
  const setSlidePositionLink = useVideoStore((s) => s.setSlidePositionLink)
  const setBoxFormatLink = useVideoStore((s) => s.setBoxFormatLink)
  const setSlideFormatLink = useVideoStore((s) => s.setSlideFormatLink)
  const playback = useVideoStore((s) => s.playback)
  const setPlayback = useVideoStore((s) => s.setPlayback)
  const { confirm, modal } = useConfirm()

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const slide: Slide | undefined = project
    ? project.slides.find((s) => s.id === selectedSlideId) ?? project.slides[0]
    : undefined

  if (!project || !slide) return <div className="muted order-empty">No slide.</div>
  const ordered = [...slide.textBoxes].sort((a, b) => a.animOrder - b.animOrder)

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = ordered.map((b) => b.id)
    const oi = ids.indexOf(String(active.id))
    const ni = ids.indexOf(String(over.id))
    if (oi < 0 || ni < 0) return
    reorder(slide.id, arrayMove(ids, oi, ni))
  }

  const posHeader = aggregateLock(ordered.map((b) => effLock(project, slide, b).position))
  const fmtHeader = aggregateLock(ordered.map((b) => effLock(project, slide, b).content))

  // Header 'p'/'f': link all (warn if any box would be reverted) / unlink all.
  const togglePosHeader = async () => {
    if (posHeader === 'on') return setSlidePositionLink(slide.id, false)
    const reverts = ordered.filter(framesDiverge).length
    if (reverts > 0 && !(await confirm(linkWarning(reverts, 'position')))) return
    setSlidePositionLink(slide.id, true)
  }
  const toggleFmtHeader = async () => {
    if (fmtHeader === 'on') return setSlideFormatLink(slide.id, false)
    const reverts = ordered.filter(contentsDiverge).length
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
      <div className="navhead navhead-rowinset">
        <span className="navhead-title">{ordered.length} textbox(es)</span>
        <span className="lockcols">
          <LockColHeader label="p" state={posHeader} title="Position — lock/unlink all textboxes on this slide" onClick={togglePosHeader} />
          <LockColHeader label="f" state={fmtHeader} title="Format — lock/unlink all textboxes on this slide" onClick={toggleFmtHeader} />
        </span>
      </div>
      {ordered.length === 0 ? (
        <div className="muted order-empty">No textboxes — click empty space on the slide to add one.</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ordered.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            <ol className="orderlist">
              {ordered.map((b, i) => (
                <OrderRow
                  key={b.id}
                  box={b}
                  index={i}
                  selected={b.id === selectedId}
                  posLinked={effLock(project, slide, b).position}
                  fmtLinked={effLock(project, slide, b).content}
                  diverged={framesDiverge(b) || contentsDiverge(b)}
                  playing={playback?.kind === 'box' && playback.slideId === slide.id && playback.boxId === b.id}
                  onSelect={() => select(b.id)}
                  onTogglePlay={() =>
                    setPlayback(
                      playback?.kind === 'box' && playback.slideId === slide.id && playback.boxId === b.id
                        ? null
                        : { kind: 'box', slideId: slide.id, boxId: b.id },
                    )
                  }
                  onTogglePos={() => toggleBoxPos(b)}
                  onToggleFmt={() => toggleBoxFmt(b)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      {modal}
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
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }
  const label = runsToPlainText(box.runs).replace(/\n/g, ' ').slice(0, 22) || '(empty)'

  return (
    <li ref={setNodeRef} style={style} className={selected ? 'order-row sel' : 'order-row'} onClick={onSelect}>
      <span className="drag" title="drag to reorder" {...attributes} {...listeners}>
        ⠿
      </span>
      <span className="order-no">{index + 1}</span>
      <span className={diverged ? 'order-label diverged' : 'order-label'} title={diverged ? 'Differs between the two aspect ratios' : undefined}>
        {label}
      </span>
      <span className="rowbtns">
        <button
          className={playing ? 'on' : ''}
          title={playing ? 'stop' : 'play this textbox (loops)'}
          onClick={(e) => {
            e.stopPropagation()
            onTogglePlay()
          }}
        >
          {playing ? '■' : '▶'}
        </button>
      </span>
      <span className="lockcols">
        <LockButton
          kind="p"
          state={posLinked ? 'on' : 'off'}
          title={posLinked ? 'Position — linked across aspect ratios (click to unlink)' : 'Position — separate per aspect ratio (click to re-link)'}
          onClick={onTogglePos}
        />
        <LockButton
          kind="f"
          state={fmtLinked ? 'on' : 'off'}
          title={fmtLinked ? 'Format — linked across aspect ratios (click to unlink)' : 'Format — separate per aspect ratio (click to re-link)'}
          onClick={onToggleFmt}
        />
      </span>
    </li>
  )
}

import { type MouseEvent } from 'react'
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
import { contentsDiverge, effLock, framesDiverge } from '@lib/project/aspect'
import type { FontSet } from '@lib/project/layout'
import type { Slide } from '@lib/project/schema'
import { useVideoStore } from '../../state/videoStore'
import { SlideThumbnail } from './SlideThumbnail'
import { useConfirm } from './ConfirmDialog'
import { LockButton, LockColHeader, aggregateLock, type LockState } from './LockControls'

const EMPTY: Slide[] = []

export function SlidePanel({ fonts }: { fonts: FontSet }) {
  const project = useVideoStore((s) => s.project)
  const slides = useVideoStore((s) => s.project?.slides ?? EMPTY)
  const selectedId = useVideoStore((s) => s.selectedSlideId)
  const select = useVideoStore((s) => s.selectSlide)
  const add = useVideoStore((s) => s.addSlide)
  const copy = useVideoStore((s) => s.copySlide)
  const del = useVideoStore((s) => s.deleteSlide)
  const reorder = useVideoStore((s) => s.reorderSlides)
  const setSlidePositionLink = useVideoStore((s) => s.setSlidePositionLink)
  const setProjectPositionLink = useVideoStore((s) => s.setProjectPositionLink)
  const setSlideFormatLink = useVideoStore((s) => s.setSlideFormatLink)
  const setProjectFormatLink = useVideoStore((s) => s.setProjectFormatLink)
  const playback = useVideoStore((s) => s.playback)
  const setPlayback = useVideoStore((s) => s.setPlayback)
  const { confirm, modal } = useConfirm()

  // A slide's aggregate position-lock state (across its boxes), and a toggle that
  // links/unlinks every box on that slide (linking a diverged box reverts the
  // other aspect — confirm first).
  const slidePosState = (slide: Slide): LockState =>
    project ? aggregateLock(slide.textBoxes.map((b) => effLock(project, slide, b).position)) : 'on'
  const toggleSlidePos = async (slide: Slide) => {
    if (slidePosState(slide) === 'on') {
      setSlidePositionLink(slide.id, false)
      return
    }
    const reverts = slide.textBoxes.filter(framesDiverge).length
    if (reverts > 0 && !(await confirm(`Re-linking will change the other aspect ratio’s position to match this one for ${reverts} textbox(es). Continue?`)))
      return
    setSlidePositionLink(slide.id, true)
  }

  const slideFmtState = (slide: Slide): LockState =>
    project ? aggregateLock(slide.textBoxes.map((b) => effLock(project, slide, b).content)) : 'on'
  const toggleSlideFmt = async (slide: Slide) => {
    if (slideFmtState(slide) === 'on') {
      setSlideFormatLink(slide.id, false)
      return
    }
    const reverts = slide.textBoxes.filter(contentsDiverge).length
    if (reverts > 0 && !(await confirm(`Re-linking will change the other aspect ratio’s formatting to match this one for ${reverts} textbox(es). Continue?`)))
      return
    setSlideFormatLink(slide.id, true)
  }

  // Column-header scope: every box in the project.
  const projPosState: LockState = project
    ? aggregateLock(slides.flatMap((sl) => sl.textBoxes.map((b) => effLock(project, sl, b).position)))
    : 'on'
  const toggleProjPos = async () => {
    if (projPosState === 'on') {
      setProjectPositionLink(false)
      return
    }
    const reverts = slides.reduce((n, sl) => n + sl.textBoxes.filter(framesDiverge).length, 0)
    if (reverts > 0 && !(await confirm(`Re-linking will change the other aspect ratio’s position to match this one for ${reverts} textbox(es) across all slides. Continue?`)))
      return
    setProjectPositionLink(true)
  }
  const projFmtState: LockState = project
    ? aggregateLock(slides.flatMap((sl) => sl.textBoxes.map((b) => effLock(project, sl, b).content)))
    : 'on'
  const toggleProjFmt = async () => {
    if (projFmtState === 'on') {
      setProjectFormatLink(false)
      return
    }
    const reverts = slides.reduce((n, sl) => n + sl.textBoxes.filter(contentsDiverge).length, 0)
    if (reverts > 0 && !(await confirm(`Re-linking will change the other aspect ratio’s formatting to match this one for ${reverts} textbox(es) across all slides. Continue?`)))
      return
    setProjectFormatLink(true)
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = slides.map((s) => s.id)
    const oi = ids.indexOf(String(active.id))
    const ni = ids.indexOf(String(over.id))
    if (oi < 0 || ni < 0) return
    reorder(arrayMove(ids, oi, ni))
  }

  return (
    <div className="slidepanel">
      <div className="slidepanel-head">
        <span>Slides ({slides.length})</span>
        <button onClick={add}>+ Slide</button>
      </div>
      <div className="navhead slidehead">
        <span className="navhead-title" />
        <span className="lockcols">
          <LockColHeader label="p" state={projPosState} title="Position — lock/unlink every textbox in the project" onClick={toggleProjPos} />
          <LockColHeader label="f" state={projFmtState} title="Format — lock/unlink every textbox in the project" onClick={toggleProjFmt} />
        </span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={slides.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ol className="slidelist">
            {slides.map((s, i) => (
              <SlideRow
                key={s.id}
                slide={s}
                index={i}
                selected={s.id === selectedId}
                canDelete={slides.length > 1}
                fonts={fonts}
                posState={slidePosState(s)}
                fmtState={slideFmtState(s)}
                playing={playback?.kind === 'slide' && playback.slideId === s.id}
                onTogglePlay={() =>
                  setPlayback(playback?.kind === 'slide' && playback.slideId === s.id ? null : { kind: 'slide', slideId: s.id })
                }
                onTogglePos={() => toggleSlidePos(s)}
                onToggleFmt={() => toggleSlideFmt(s)}
                onSelect={() => select(s.id)}
                onCopy={() => copy(s.id)}
                onDelete={() => del(s.id)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {modal}
    </div>
  )
}

function SlideRow({
  slide,
  index,
  selected,
  canDelete,
  fonts,
  posState,
  fmtState,
  playing,
  onTogglePlay,
  onTogglePos,
  onToggleFmt,
  onSelect,
  onCopy,
  onDelete,
}: {
  slide: Slide
  index: number
  selected: boolean
  canDelete: boolean
  fonts: FontSet
  posState: LockState
  fmtState: LockState
  playing: boolean
  onTogglePlay: () => void
  onTogglePos: () => void
  onToggleFmt: () => void
  onSelect: () => void
  onCopy: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slide.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }
  const stop = (e: MouseEvent) => e.stopPropagation()

  return (
    <li ref={setNodeRef} style={style} className={selected ? 'slide-row sel' : 'slide-row'} onClick={onSelect}>
      <span className="drag" title="drag to reorder" {...attributes} {...listeners}>
        ⠿
      </span>
      <span className="slide-no">{index + 1}</span>
      <SlideThumbnail slide={slide} fonts={fonts} />
      <span className="rowbtns">
        <button className={playing ? 'on' : ''} title={playing ? 'stop' : 'play this slide (loops)'} onClick={(e) => { stop(e); onTogglePlay() }}>
          {playing ? '■' : '▶'}
        </button>
        <button title="duplicate" onClick={(e) => { stop(e); onCopy() }}>⧉</button>
        <button title="delete" disabled={!canDelete} onClick={(e) => { stop(e); onDelete() }}>×</button>
      </span>
      <span className="lockcols">
        <LockButton kind="p" state={posState} title="Position — lock/unlink all textboxes on this slide" onClick={onTogglePos} />
        <LockButton kind="f" state={fmtState} title="Format — lock/unlink all textboxes on this slide" onClick={onToggleFmt} />
      </span>
    </li>
  )
}

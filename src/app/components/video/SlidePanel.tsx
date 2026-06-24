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
import type { PreparedGlyph } from '@lib/animation/timeline'
import type { FontMetrics } from '@lib/project/layout'
import type { Slide } from '@lib/project/schema'
import { useVideoStore } from '../../state/videoStore'
import { SlideThumbnail } from './SlideThumbnail'

const EMPTY: Slide[] = []

export function SlidePanel({
  glyphs,
  metrics,
}: {
  glyphs: Map<string, PreparedGlyph>
  metrics: FontMetrics | null
}) {
  const slides = useVideoStore((s) => s.project?.slides ?? EMPTY)
  const selectedId = useVideoStore((s) => s.selectedSlideId)
  const select = useVideoStore((s) => s.selectSlide)
  const add = useVideoStore((s) => s.addSlide)
  const copy = useVideoStore((s) => s.copySlide)
  const del = useVideoStore((s) => s.deleteSlide)
  const reorder = useVideoStore((s) => s.reorderSlides)
  // In Play mode, rows show a checkbox that picks the slides to play.
  const playMode = useVideoStore((s) => s.slideView === 'play')
  const playSelectedIds = useVideoStore((s) => s.playSelectedIds)
  const togglePlaySelected = useVideoStore((s) => s.togglePlaySelected)

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
                glyphs={glyphs}
                metrics={metrics}
                playMode={playMode}
                playChecked={playSelectedIds.includes(s.id)}
                onTogglePlay={() => togglePlaySelected(s.id)}
                onSelect={() => select(s.id)}
                onCopy={() => copy(s.id)}
                onDelete={() => del(s.id)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  )
}

function SlideRow({
  slide,
  index,
  selected,
  canDelete,
  glyphs,
  metrics,
  playMode,
  playChecked,
  onTogglePlay,
  onSelect,
  onCopy,
  onDelete,
}: {
  slide: Slide
  index: number
  selected: boolean
  canDelete: boolean
  glyphs: Map<string, PreparedGlyph>
  metrics: FontMetrics | null
  playMode: boolean
  playChecked: boolean
  onTogglePlay: () => void
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
      {playMode && (
        <input
          type="checkbox"
          className="slide-play-check"
          title="include in scoped play"
          checked={playChecked}
          onClick={stop}
          onChange={onTogglePlay}
        />
      )}
      <span className="drag" title="drag to reorder" {...attributes} {...listeners}>
        ⠿
      </span>
      <span className="slide-no">{index + 1}</span>
      <SlideThumbnail slide={slide} glyphs={glyphs} metrics={metrics} />
      <span className="rowbtns">
        <button title="duplicate" onClick={(e) => { stop(e); onCopy() }}>⧉</button>
        <button title="delete" disabled={!canDelete} onClick={(e) => { stop(e); onDelete() }}>×</button>
      </span>
    </li>
  )
}

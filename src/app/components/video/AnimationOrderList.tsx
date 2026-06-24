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
import { runsToPlainText } from '@lib/project/runs'
import type { TextBox } from '@lib/project/schema'
import { useVideoStore } from '../../state/videoStore'

/** Reorder a slide's textboxes (drag) and tune each box's "time before display". */
export function AnimationOrderList({ slideId, boxes }: { slideId: string; boxes: TextBox[] }) {
  const reorder = useVideoStore((s) => s.reorderTextBoxes)
  const updateTextBox = useVideoStore((s) => s.updateTextBox)
  const select = useVideoStore((s) => s.selectTextBox)
  const selectedId = useVideoStore((s) => s.selectedTextBoxId)

  const ordered = [...boxes].sort((a, b) => a.animOrder - b.animOrder)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = ordered.map((b) => b.id)
    const oi = ids.indexOf(String(active.id))
    const ni = ids.indexOf(String(over.id))
    if (oi < 0 || ni < 0) return
    reorder(slideId, arrayMove(ids, oi, ni))
  }

  if (ordered.length === 0) return <div className="muted order-empty">No textboxes on this slide.</div>

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ordered.map((b) => b.id)} strategy={verticalListSortingStrategy}>
        <ol className="orderlist">
          {ordered.map((b, i) => (
            <OrderRow
              key={b.id}
              box={b}
              index={i}
              selected={b.id === selectedId}
              onSelect={() => select(b.id)}
              onDelay={(ms) => updateTextBox(slideId, b.id, { delayBeforeMs: ms })}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  )
}

function OrderRow({
  box,
  index,
  selected,
  onSelect,
  onDelay,
}: {
  box: TextBox
  index: number
  selected: boolean
  onSelect: () => void
  onDelay: (ms: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: box.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }
  const label = runsToPlainText(box.runs).replace(/\n/g, ' ').slice(0, 22) || '(empty)'
  const stop = (e: MouseEvent) => e.stopPropagation()

  return (
    <li ref={setNodeRef} style={style} className={selected ? 'order-row sel' : 'order-row'} onClick={onSelect}>
      <span className="drag" title="drag to reorder" {...attributes} {...listeners}>
        ⠿
      </span>
      <span className="order-no">{index + 1}</span>
      <span className="order-label">{label}</span>
      <label className="order-delay" onClick={stop}>
        <span>+</span>
        <input
          type="number"
          min={0}
          step={50}
          value={box.delayBeforeMs}
          onChange={(e) => onDelay(Math.max(0, Number(e.target.value) || 0))}
        />
        <span>ms</span>
      </label>
    </li>
  )
}

import { useState } from 'react'
import { drawingHttpStore, type DrawingSummary } from '@lib/persistence/DrawingStore'

/**
 * Promise-based "pick a saved drawing" modal (mirrors useConfirm). `pick()` opens
 * the dialog, loads the saved drawings, and resolves to the chosen { id, name }
 * (or null if cancelled). Render `modal` somewhere in the component.
 */
export function useDrawingPicker() {
  const [open, setOpen] = useState(false)
  const [resolver, setResolver] = useState<{ fn: (d: { id: string; name: string } | null) => void } | null>(null)
  const [saved, setSaved] = useState<DrawingSummary[]>([])
  const [loading, setLoading] = useState(false)

  const pick = () =>
    new Promise<{ id: string; name: string } | null>((resolve) => {
      setResolver({ fn: resolve })
      setOpen(true)
      setLoading(true)
      drawingHttpStore
        .list()
        .then((d) => setSaved(d))
        .catch(() => setSaved([]))
        .finally(() => setLoading(false))
    })

  const close = (val: { id: string; name: string } | null) => {
    setOpen(false)
    resolver?.fn(val)
    setResolver(null)
  }

  const modal = open ? (
    <div className="confirm-overlay" onClick={() => close(null)}>
      <div className="confirm-box drawing-picker" onClick={(e) => e.stopPropagation()} style={{ minWidth: 300 }}>
        <h3 style={{ margin: '0 0 8px' }}>Add a drawing</h3>
        {loading ? (
          <p className="muted">loading saved drawings…</p>
        ) : saved.length === 0 ? (
          <p className="muted">No saved drawings yet — create and save one in the Drawing tab.</p>
        ) : (
          <ul className="picker-list" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 320, overflowY: 'auto' }}>
            {saved.map((d) => (
              <li key={d.id}>
                <button
                  className="picker-item tool"
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', marginBottom: 2 }}
                  onClick={() => close({ id: d.id, name: d.name })}
                >
                  {d.name} <span className="muted">· {d.partCount} parts</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="confirm-actions">
          <button className="tool" onClick={() => close(null)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  ) : null

  return { pick, modal }
}

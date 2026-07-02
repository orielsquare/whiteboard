import { useEffect, useRef, useState } from 'react'
import { useConfirm } from '../video/ConfirmDialog'
import { usePrompt } from './PromptDialog'

/** One saved artifact in the shared Files menu. */
export interface FileItem {
  id: string
  name: string
  /** short meta line, e.g. "12 slides" / "34 glyphs". */
  meta?: string
  updatedAt?: string
}

const fmtWhen = (iso?: string): string => {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/**
 * The shared "Files ▾" dropdown — ONE file-management surface for fonts,
 * drawings and videos. Lists the saved artifacts (current one marked ●) with
 * per-row **Open / Rename / Duplicate / Delete**; the list refreshes each time
 * the menu opens. Rename edits inline; Duplicate prompts for the copy's name;
 * Delete confirms. The host supplies the storage operations — this component
 * owns only the interaction chrome, so all three tools behave identically.
 */
export function FilesMenu({
  items,
  currentId,
  emptyLabel = 'No saved files',
  onRefresh,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  renameHint,
}: {
  items: FileItem[]
  currentId?: string | null
  emptyLabel?: string
  onRefresh: () => void
  onOpen: (id: string) => void | Promise<void>
  onRename?: (id: string, name: string) => void | Promise<void>
  onDuplicate?: (id: string, name: string) => void | Promise<void>
  onDelete?: (id: string) => void | Promise<void>
  /** shown under the rename input when renaming the OPEN file (if its rename
   *  only persists on the next save). */
  renameHint?: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { prompt, modal: promptModal } = usePrompt()
  const { confirm, modal: confirmModal } = useConfirm()

  // Close on outside click (but not while a dialog is up — those overlay the page).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const run = async (fn: () => void | Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const startRename = (it: FileItem) => {
    setRenamingId(it.id)
    setRenameDraft(it.name)
  }
  const commitRename = (it: FileItem) => {
    const name = renameDraft.trim()
    setRenamingId(null)
    if (!onRename || !name || name === it.name) return
    void run(async () => {
      await onRename(it.id, name)
      onRefresh()
    })
  }

  return (
    <div className="files-menu" ref={rootRef}>
      <button
        onClick={() => {
          if (!open) onRefresh()
          setOpen((o) => !o)
          setRenamingId(null)
        }}
        title="Open, rename, duplicate or delete saved files"
      >
        Files ▾
      </button>
      {open && (
        <div className="files-panel">
          {items.length === 0 ? (
            <div className="files-empty">{emptyLabel}</div>
          ) : (
            items.map((it) => (
              <div key={it.id} className={it.id === currentId ? 'files-row current' : 'files-row'}>
                {renamingId === it.id ? (
                  <div className="files-rename">
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onFocus={(e) => e.target.select()}
                      onBlur={() => commitRename(it)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                    />
                    {it.id === currentId && renameHint && <div className="files-hint">{renameHint}</div>}
                  </div>
                ) : (
                  <button
                    className="files-open"
                    disabled={busy}
                    title={`Open ${it.name}${it.updatedAt ? ` — saved ${fmtWhen(it.updatedAt)}` : ''}`}
                    onClick={() =>
                      void run(async () => {
                        await onOpen(it.id)
                        setOpen(false)
                      })
                    }
                  >
                    <span className="files-name">
                      {it.id === currentId ? '● ' : ''}
                      {it.name}
                    </span>
                    {it.meta && <span className="files-meta">{it.meta}</span>}
                  </button>
                )}
                <span className="files-actions">
                  {onRename && (
                    <button disabled={busy} title="Rename" onClick={() => startRename(it)}>
                      ✏️
                    </button>
                  )}
                  {onDuplicate && (
                    <button
                      disabled={busy}
                      title="Duplicate"
                      onClick={() =>
                        void run(async () => {
                          const name = await prompt(`Duplicate “${it.name}” as:`, `${it.name} copy`)
                          if (!name) return
                          await onDuplicate(it.id, name)
                          onRefresh()
                        })
                      }
                    >
                      ⎘
                    </button>
                  )}
                  {onDelete && (
                    <button
                      disabled={busy}
                      title="Delete (moves to Drive trash)"
                      onClick={() =>
                        void run(async () => {
                          if (!(await confirm(`Delete “${it.name}”? This moves it to Drive trash.`))) return
                          await onDelete(it.id)
                          onRefresh()
                        })
                      }
                    >
                      🗑
                    </button>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      )}
      {promptModal}
      {confirmModal}
    </div>
  )
}

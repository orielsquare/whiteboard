/**
 * Crash/refresh safety net: a single-slot, debounced working-copy snapshot per
 * tool (`wb.autosave.font|drawing|video`) in localStorage. Written on every edit
 * burst while a document is dirty, cleared on save. On reopen, a slot NEWER than
 * the server copy is restored (and the document marked dirty) — see each view's
 * mount flow. Size-capped so a huge manifest can't blow the localStorage quota;
 * an over-size document simply stops autosaving (the slot is dropped so a stale
 * older snapshot can't shadow newer disk state).
 */

export type AutosaveKind = 'font' | 'drawing' | 'video'

export interface AutosaveSlot<T> {
  /** the document's id (font hash / drawing id / project id). */
  id: string
  /** wall-clock ms when the snapshot was taken (compare vs the server updatedAt). */
  at: number
  doc: T
}

const KEY = (kind: AutosaveKind) => `wb.autosave.${kind}`
const MAX_BYTES = 2_500_000
const DEBOUNCE_MS = 800
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Debounced snapshot write (one write per edit burst). */
export function autosaveWrite(kind: AutosaveKind, id: string, doc: unknown): void {
  const key = KEY(kind)
  const prev = timers.get(key)
  if (prev) clearTimeout(prev)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      try {
        const raw = JSON.stringify({ id, at: Date.now(), doc })
        if (raw.length > MAX_BYTES) {
          // Too big to snapshot — keep the LAST slot that fit (an older copy of the
          // unsaved work still beats nothing after a crash; the newer-than-disk
          // check gates restores, and saving clears the slot anyway).
          return
        }
        localStorage.setItem(key, raw)
      } catch {
        /* quota/unavailable — autosave is best-effort */
      }
    }, DEBOUNCE_MS),
  )
}

export function autosaveRead<T>(kind: AutosaveKind): AutosaveSlot<T> | null {
  try {
    const raw = localStorage.getItem(KEY(kind))
    if (!raw) return null
    const slot = JSON.parse(raw) as AutosaveSlot<T>
    return slot && typeof slot.id === 'string' && typeof slot.at === 'number' && slot.doc != null ? slot : null
  } catch {
    return null
  }
}

/** Is a slot strictly newer than a server document's `updatedAt`? Unknown or
 *  unparseable server timestamps count as NOT older — prefer the server copy
 *  (never let a possibly-stale slot shadow disk state we can't date). */
export function slotIsNewer(slotAt: number, serverUpdatedAt: string | undefined): boolean {
  const t = Date.parse(serverUpdatedAt ?? '')
  return Number.isFinite(t) ? slotAt > t : false
}

/** Drop the slot AND cancel any pending debounced write (call after a save). */
export function autosaveClear(kind: AutosaveKind): void {
  const key = KEY(kind)
  const t = timers.get(key)
  if (t) {
    clearTimeout(t)
    timers.delete(key)
  }
  try {
    localStorage.removeItem(key)
  } catch {
    /* unavailable */
  }
}

/**
 * Tiny typed localStorage helpers for session/view preferences — the state that
 * should survive a browser refresh but is NOT part of any document (open file
 * ids, tab choices, zoom levels, brush, …). All keys live under `wb.`; values
 * are JSON. Every call is try/caught so a blocked/full localStorage can never
 * break the app — prefs just silently stop persisting.
 */

export function prefGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function prefSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota/unavailable — skip */
  }
}

export function prefDel(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* unavailable — skip */
  }
}

/** Debounced prefSet — one write per burst of changes (zoom drags, scrolls…). */
export function prefSetDebounced(key: string, value: unknown, ms = 300): void {
  const prev = pending.get(key)
  if (prev) clearTimeout(prev)
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      prefSet(key, value)
    }, ms),
  )
}
const pending = new Map<string, ReturnType<typeof setTimeout>>()

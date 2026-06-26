import { httpStore } from '@lib/persistence/FontStore'

/**
 * Register loaded fonts as real CSS @font-faces so the on-canvas text-edit
 * overlay can render each run in (roughly) the right glyph shapes — per run,
 * keyed by fontId. The handwriting *animation* is produced elsewhere from
 * extracted centerlines; this is purely the editing surface.
 *
 * The editor (Font-tab) font is registered from its in-memory bytes; other
 * referenced saved fonts are fetched once by id. When a face finishes loading,
 * the browser re-renders any text using its family automatically.
 */

const registered = new Set<string>()

/** The CSS font-family for a fontId (whether or not it has loaded yet). */
export function fontFamilyFor(fontId: string): string {
  return `fa-font-${fontId}`
}

function addFace(fontId: string, buffer: ArrayBuffer) {
  try {
    const face = new FontFace(fontFamilyFor(fontId), buffer.slice(0))
    face
      .load()
      .then((f) => document.fonts.add(f))
      .catch(() => {
        /* overlay falls back to a generic family */
      })
  } catch {
    /* FontFace unsupported */
  }
}

/** Register a face from known bytes (the live editor font). Idempotent. */
export function registerFontFace(fontId: string, buffer: ArrayBuffer): string {
  if (fontId && !registered.has(fontId)) {
    registered.add(fontId)
    addFace(fontId, buffer)
  }
  return fontFamilyFor(fontId)
}

/** Ensure a saved font's face is registered, fetching its bytes once. */
export async function ensureFontFaceById(fontId: string): Promise<void> {
  if (!fontId || registered.has(fontId)) return
  registered.add(fontId)
  try {
    const bytes = await httpStore.loadFontBytes(fontId)
    if (bytes) addFace(fontId, bytes)
    else registered.delete(fontId) // allow a later retry
  } catch {
    registered.delete(fontId)
  }
}

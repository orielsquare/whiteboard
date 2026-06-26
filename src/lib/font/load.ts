import opentype from 'opentype.js'

/** A parsed font plus the metadata we need to identify and persist it. */
export interface LoadedFont {
  font: opentype.Font
  /** Raw font bytes, retained so the extraction worker can re-parse off-thread. */
  buffer: ArrayBuffer
  fileName: string
  family: string
  unitsPerEm: number
  /** The font's space-glyph advance (design units) — so text wraps with the font's
   *  real spacing in both the canvas and the on-canvas editor. */
  spaceAdvance: number
  /** Short stable hash of the font bytes — used as the manifest fontId later. */
  hash: string
}

/** The font's space advance in design units (0 if it has no usable space glyph). */
export function spaceAdvanceUnits(font: opentype.Font): number {
  try {
    const adv = font.getAdvanceWidth(' ', font.unitsPerEm)
    return Number.isFinite(adv) && adv > 0 ? adv : 0
  } catch {
    return 0
  }
}

export async function loadFontFromArrayBuffer(
  buf: ArrayBuffer,
  fileName: string,
): Promise<LoadedFont> {
  const font = opentype.parse(buf)
  const family =
    font.names.fontFamily?.en ?? font.names.fullName?.en ?? fileName.replace(/\.[^.]+$/, '')
  const hash = await hashBuffer(buf)
  return {
    font,
    buffer: buf,
    fileName,
    family,
    unitsPerEm: font.unitsPerEm,
    spaceAdvance: spaceAdvanceUnits(font),
    hash,
  }
}

export async function loadFontFromUrl(url: string): Promise<LoadedFont> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch font ${url} (${res.status})`)
  const buf = await res.arrayBuffer()
  const fileName = url.split('/').pop() ?? 'font'
  return loadFontFromArrayBuffer(buf, fileName)
}

/** First 8 bytes of SHA-256, hex — enough to key a manifest in this tool. */
async function hashBuffer(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

import opentype from 'opentype.js'
import { extractGlyph } from './pipeline'
import type { ExtractionParams } from './types'

// Cast the worker global so we don't need the WebWorker lib (which clashes with DOM).
const ctx = self as unknown as {
  postMessage: (msg: unknown) => void
  onmessage: ((e: MessageEvent) => void) | null
}

type InMsg =
  | { type: 'init'; buffer: ArrayBuffer }
  | { type: 'extract'; id: number; char: string; params: ExtractionParams; debug: boolean }

let font: opentype.Font | null = null

ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data as InMsg
  if (msg.type === 'init') {
    try {
      font = opentype.parse(msg.buffer)
      ctx.postMessage({ type: 'ready' })
    } catch (err) {
      ctx.postMessage({ type: 'fatal', error: String(err) })
    }
    return
  }
  if (msg.type === 'extract') {
    if (!font) {
      ctx.postMessage({ type: 'error', id: msg.id, error: 'font not initialized' })
      return
    }
    try {
      const glyph = extractGlyph(font, msg.char, msg.params, msg.debug)
      ctx.postMessage({ type: 'result', id: msg.id, glyph })
    } catch (err) {
      ctx.postMessage({ type: 'error', id: msg.id, error: String(err) })
    }
  }
}

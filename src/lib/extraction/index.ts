import { DEFAULT_PARAMS, type ExtractionParams, type GlyphStrokes } from './types'

export * from './types'

/**
 * Main-thread client for the extraction worker. Parse a font once with `init`,
 * then call `extract(char)` per glyph; the heavy CV runs off the UI thread.
 */
export class GlyphExtractor {
  private worker: Worker
  private ready: Promise<void>
  private pending = new Map<
    number,
    { resolve: (g: GlyphStrokes) => void; reject: (e: unknown) => void }
  >()
  private nextId = 1

  constructor(buffer: ArrayBuffer) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (e: MessageEvent) => {
        const d = e.data
        if (d?.type === 'ready') {
          this.worker.removeEventListener('message', onReady)
          resolve()
        } else if (d?.type === 'fatal') {
          this.worker.removeEventListener('message', onReady)
          reject(new Error(d.error))
        }
      }
      this.worker.addEventListener('message', onReady)
    })

    this.worker.addEventListener('message', (e: MessageEvent) => {
      const d = e.data
      if (d?.type === 'result') {
        const p = this.pending.get(d.id)
        if (p) {
          this.pending.delete(d.id)
          p.resolve(d.glyph as GlyphStrokes)
        }
      } else if (d?.type === 'error') {
        const p = this.pending.get(d.id)
        if (p) {
          this.pending.delete(d.id)
          p.reject(new Error(d.error))
        }
      }
    })

    // Structured-clone copy (no transfer) so the caller keeps its ArrayBuffer.
    this.worker.postMessage({ type: 'init', buffer })
  }

  async extract(
    char: string,
    params: ExtractionParams = DEFAULT_PARAMS,
    debug = false,
  ): Promise<GlyphStrokes> {
    await this.ready
    const id = this.nextId++
    return new Promise<GlyphStrokes>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ type: 'extract', id, char, params, debug })
    })
  }

  dispose() {
    // Reject in-flight requests so awaiting callers unwind (and can be GC'd).
    for (const p of this.pending.values()) p.reject(new Error('extractor disposed'))
    this.pending.clear()
    this.worker.terminate()
  }
}

import type { DrawingManifest } from '@lib/drawing/schema'
import { apiUrl, apiFetch } from './apiBase'

export interface DrawingSummary {
  id: string
  name: string
  partCount: number
  updatedAt: string
}

/** Storage backend for SVG-drawing manifests (shared builder server → Google
 *  Drive), mirroring FontStore/ProjectStore. */
export interface DrawingStore {
  list(): Promise<DrawingSummary[]>
  load(id: string): Promise<DrawingManifest | null>
  save(manifest: DrawingManifest): Promise<void>
  remove(id: string): Promise<void>
}

const BASE = apiUrl('/api/drawings')

export const drawingHttpStore: DrawingStore = {
  async list() {
    const res = await apiFetch(BASE)
    if (!res.ok) throw new Error(`list failed (${res.status})`)
    return (await res.json()) as DrawingSummary[]
  },
  async load(id) {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(id)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`load failed (${res.status})`)
    return (await res.json()) as DrawingManifest
  },
  async save(manifest) {
    // text/plain so the builder's global 1 MB JSON parser skips it; the route
    // reads the raw body (manifests carry baked geometry + the SVG source).
    const res = await apiFetch(`${BASE}/${encodeURIComponent(manifest.metadata.drawingId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(manifest, null, 2),
    })
    if (!res.ok) throw new Error(`save failed (${res.status})`)
  },
  async remove(id) {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`delete failed (${res.status})`)
  },
}

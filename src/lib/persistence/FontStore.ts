import type { FontManifest } from '@lib/manifest/schema'
import { apiUrl, apiFetch } from './apiBase'

export interface FontSummary {
  id: string
  family: string
  glyphCount: number
  updatedAt: string
  /** Cosmetic user-facing name (decoupled from the content-hash id). */
  name?: string
}

/** Storage backend for font manifests. The default talks to the Vite dev server. */
export interface FontStore {
  list(): Promise<FontSummary[]>
  load(id: string): Promise<FontManifest | null>
  save(manifest: FontManifest): Promise<void>
  /** Persist the raw font bytes alongside the manifest so the config is portable. */
  saveFont(id: string, buffer: ArrayBuffer): Promise<void>
  /** Fetch the raw font bytes (to build an extractor for deriving glyphs). */
  loadFontBytes(id: string): Promise<ArrayBuffer | null>
  /** Trash the saved font (manifest + bytes). */
  remove(id: string): Promise<void>
}

const BASE = apiUrl('/api/fonts')

export const httpStore: FontStore = {
  async list() {
    const res = await apiFetch(BASE)
    if (!res.ok) throw new Error(`list failed (${res.status})`)
    return (await res.json()) as FontSummary[]
  },

  async load(id) {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(id)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`load failed (${res.status})`)
    return (await res.json()) as FontManifest
  },

  async save(manifest) {
    // Sent as text/plain so the builder's global 1 MB JSON body parser skips it
    // (manifests with glyph outlines exceed it); the route reads the raw body.
    const res = await apiFetch(`${BASE}/${encodeURIComponent(manifest.metadata.fontId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(manifest, null, 2),
    })
    if (!res.ok) throw new Error(`save failed (${res.status})`)
  },

  async saveFont(id, buffer) {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(id)}/font`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: buffer,
    })
    if (!res.ok) throw new Error(`saveFont failed (${res.status})`)
  },

  async loadFontBytes(id) {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(id)}/font`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`loadFontBytes failed (${res.status})`)
    return await res.arrayBuffer()
  },

  async remove(id) {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`delete failed (${res.status})`)
  },
}

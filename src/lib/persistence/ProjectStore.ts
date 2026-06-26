import type { VideoProject } from '@lib/project/schema'
import { apiUrl, apiFetch } from './apiBase'

export interface ProjectSummary {
  id: string
  name: string
  fontId: string
  slideCount: number
  updatedAt: string
}

/** Storage backend for video projects (shared builder server → Google Drive). */
export interface ProjectStore {
  list(): Promise<ProjectSummary[]>
  load(id: string): Promise<VideoProject | null>
  save(project: VideoProject): Promise<void>
  remove(id: string): Promise<void>
  /** Server-side "save a copy": duplicates the stored project (+ its voiceover
   * clips) under a new id/name. Requires the source to already be saved. */
  copy(sourceId: string, newId: string, name: string): Promise<ProjectSummary>
}

const BASE = apiUrl('/api/projects')

export const projectStore: ProjectStore = {
  async list() {
    const res = await apiFetch(BASE)
    if (!res.ok) throw new Error(`list failed (${res.status})`)
    return (await res.json()) as ProjectSummary[]
  },
  async load(id) {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(id)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`load failed (${res.status})`)
    return (await res.json()) as VideoProject
  },
  async save(project) {
    // text/plain so the builder's global 1 MB JSON parser skips it; the route
    // reads the raw body (projects can carry many slides + voiceover refs).
    const res = await apiFetch(`${BASE}/${encodeURIComponent(project.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(project, null, 2),
    })
    if (!res.ok) throw new Error(`save failed (${res.status})`)
  },
  async remove(id) {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`delete failed (${res.status})`)
  },
  async copy(sourceId, newId, name) {
    const res = await apiFetch(`${BASE}/${encodeURIComponent(sourceId)}/copy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newId, name }),
    })
    if (!res.ok) throw new Error(`copy failed (${res.status})`)
    return (await res.json()) as ProjectSummary
  },
}

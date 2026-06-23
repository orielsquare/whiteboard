import type { VideoProject } from '@lib/project/schema'

export interface ProjectSummary {
  id: string
  name: string
  fontId: string
  slideCount: number
  updatedAt: string
}

/** Storage backend for video projects (Vite dev-server /api/projects). */
export interface ProjectStore {
  list(): Promise<ProjectSummary[]>
  load(id: string): Promise<VideoProject | null>
  save(project: VideoProject): Promise<void>
  remove(id: string): Promise<void>
}

const BASE = '/api/projects'

export const projectStore: ProjectStore = {
  async list() {
    const res = await fetch(BASE)
    if (!res.ok) throw new Error(`list failed (${res.status})`)
    return (await res.json()) as ProjectSummary[]
  },
  async load(id) {
    const res = await fetch(`${BASE}/${encodeURIComponent(id)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`load failed (${res.status})`)
    return (await res.json()) as VideoProject
  },
  async save(project) {
    const res = await fetch(`${BASE}/${encodeURIComponent(project.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(project, null, 2),
    })
    if (!res.ok) throw new Error(`save failed (${res.status})`)
  },
  async remove(id) {
    const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`delete failed (${res.status})`)
  },
}

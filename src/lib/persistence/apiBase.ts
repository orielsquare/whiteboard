// Central API base + fetch wrapper for talking to the shared spreadsheet-builder
// server (which stores whiteboard files in Google Drive and owns the Google
// login). The whiteboard SPA is mounted under a path (Vite `base`), e.g.
// `/whiteboard/` locally or `/builder/whiteboard/` behind the deployed reverse
// proxy. import.meta.env.BASE_URL carries that, so prod/dev stay in sync.

const BASE = import.meta.env.BASE_URL || '/'
// Storage/render API lives under the mount, e.g. `/whiteboard` -> `/whiteboard/api/...`.
const API_PREFIX = BASE.replace(/\/$/, '')
// Auth routes are a SIBLING of the whiteboard mount (served at the builder root,
// e.g. `/builder/auth/login`), so strip the trailing `/whiteboard` segment.
const MOUNT_ROOT = API_PREFIX.replace(/\/whiteboard$/, '')

const withSlash = (p: string) => (p.startsWith('/') ? p : `/${p}`)

/** URL for a whiteboard storage/render endpoint, e.g. apiUrl('/api/fonts'). */
export const apiUrl = (p: string) => `${API_PREFIX}${withSlash(p)}`

/** URL for a builder auth endpoint (sibling of the mount), e.g. authUrl('/auth/login'). */
export const authUrl = (p: string) => `${MOUNT_ROOT}${withSlash(p)}`

/**
 * fetch() that carries the session cookie and, on a 401 (session expired),
 * sends the browser to the Google login preserving where to return. Returns a
 * never-resolving promise in that case so callers don't render an error mid-redirect.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { credentials: 'include', ...init })
  if (res.status === 401) {
    const next = encodeURIComponent(window.location.href)
    window.location.assign(`${authUrl('/auth/login')}?next=${next}`)
    return new Promise<Response>(() => {})
  }
  return res
}

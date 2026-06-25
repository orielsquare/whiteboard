import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

// Load a gitignored .env into process.env (only filling unset vars) so server-side
// keys like ELEVENLABS_API_KEY reach the dev-server plugins without a shell export.
function loadDotEnv(file: string) {
  if (!existsSync(file)) return
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (!m) continue
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (process.env[m[1]] === undefined) process.env[m[1]] = v
    }
  } catch {
    /* ignore malformed .env */
  }
}
loadDotEnv(path.join(rootDir, '.env'))
const fontsDir = path.join(rootDir, 'fonts')
const projectsDir = path.join(rootDir, 'projects')
const exportsDir = path.join(rootDir, 'exports')
const voiceoverDir = path.join(rootDir, 'voiceover')

const safeSeg = (s: string) => String(s).replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80)

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

/**
 * Persists font manifests to disk under ./fonts/<id>/ via /api/fonts, so the
 * full configuration (and the font file) survives reloads and is consumable by
 * future tools (slide editor, ffmpeg export).
 */
function fontStorePlugin(): Plugin {
  return {
    name: 'font-store',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/api/fonts')) return next()
        const pathname = url.split('?')[0]
        const rest = pathname.slice('/api/fonts'.length).replace(/^\/+/, '') // "", "<id>", "<id>/font"
        const [idRaw, sub] = rest.split('/')
        const id = idRaw ? decodeURIComponent(idRaw) : ''

        try {
          if (req.method === 'GET' && !id) {
            return sendJson(res, 200, await listManifests())
          }
          if (req.method === 'GET' && id && !sub) {
            const file = path.join(fontsDir, id, 'manifest.json')
            try {
              const data = await fs.readFile(file, 'utf8')
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              return res.end(data)
            } catch {
              return sendJson(res, 404, { error: 'not found' })
            }
          }
          if (req.method === 'PUT' && id && !sub) {
            const body = await readBody(req)
            const dir = path.join(fontsDir, id)
            await fs.mkdir(dir, { recursive: true })
            await fs.writeFile(path.join(dir, 'manifest.json'), body)
            return sendJson(res, 200, { ok: true })
          }
          if (req.method === 'PUT' && id && sub === 'font') {
            const body = await readBody(req)
            const dir = path.join(fontsDir, id)
            await fs.mkdir(dir, { recursive: true })
            await fs.writeFile(path.join(dir, 'font.ttf'), body)
            return sendJson(res, 200, { ok: true })
          }
          return sendJson(res, 405, { error: 'method not allowed' })
        } catch (err) {
          return sendJson(res, 500, { error: String(err) })
        }
      })
    },
  }
}

async function listManifests() {
  try {
    const entries = await fs.readdir(fontsDir, { withFileTypes: true })
    const out = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      try {
        const data = await fs.readFile(path.join(fontsDir, e.name, 'manifest.json'), 'utf8')
        const m = JSON.parse(data)
        out.push({
          id: m.metadata?.fontId ?? e.name,
          family: m.metadata?.family ?? e.name,
          glyphCount: Object.keys(m.glyphs ?? {}).length,
          updatedAt: m.updatedAt ?? '',
        })
      } catch {
        // skip dirs without a valid manifest
      }
    }
    return out
  } catch {
    return []
  }
}

/** Persists video projects to disk under ./projects/<id>.json via /api/projects. */
function projectStorePlugin(): Plugin {
  return {
    name: 'project-store',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/api/projects')) return next()
        const pathname = url.split('?')[0]
        const rest = pathname.slice('/api/projects'.length).replace(/^\/+/, '')
        const id = rest ? decodeURIComponent(rest.split('/')[0]) : ''
        try {
          if (req.method === 'GET' && !id) return sendJson(res, 200, await listProjects())
          if (req.method === 'GET' && id) {
            try {
              const data = await fs.readFile(path.join(projectsDir, id + '.json'), 'utf8')
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              return res.end(data)
            } catch {
              return sendJson(res, 404, { error: 'not found' })
            }
          }
          if (req.method === 'PUT' && id) {
            const body = await readBody(req)
            await fs.mkdir(projectsDir, { recursive: true })
            await fs.writeFile(path.join(projectsDir, id + '.json'), body)
            return sendJson(res, 200, { ok: true })
          }
          if (req.method === 'DELETE' && id) {
            try {
              await fs.unlink(path.join(projectsDir, id + '.json'))
            } catch {
              // already gone
            }
            return sendJson(res, 200, { ok: true })
          }
          return sendJson(res, 405, { error: 'method not allowed' })
        } catch (err) {
          return sendJson(res, 500, { error: String(err) })
        }
      })
    },
  }
}

async function listProjects() {
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true })
    const out = []
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue
      try {
        const m = JSON.parse(await fs.readFile(path.join(projectsDir, e.name), 'utf8'))
        out.push({
          id: m.id ?? e.name.replace(/\.json$/, ''),
          name: m.name ?? '(untitled)',
          fontId: m.fontId ?? '',
          slideCount: (m.slides ?? []).length,
          updatedAt: m.updatedAt ?? '',
        })
      } catch {
        // skip invalid project file
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * MP4 export: POST /api/export renders the posted project (with its glyphs) to
 * ./exports/<name>.mp4 via the headless renderer + ffmpeg; GET /api/export/<file>
 * streams the result (range-aware) for in-app preview / download.
 */
function exportPlugin(): Plugin {
  return {
    name: 'video-export',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/api/export')) return next()
        const pathname = url.split('?')[0]
        const rest = pathname.slice('/api/export'.length).replace(/^\/+/, '')

        try {
          if (req.method === 'POST' && !rest) {
            const body = JSON.parse((await readBody(req)).toString('utf8'))
            const { project, glyphs, metrics, fps, width, speed, slideIds, name, includeAudio } = body
            const safe =
              (String(name || project?.name || 'video')
                .replace(/[^a-z0-9-_]+/gi, '_')
                .slice(0, 60) || 'video')
            await fs.mkdir(exportsDir, { recursive: true })
            const outPath = path.join(exportsDir, safe + '.mp4')
            // Cache-bust so edits to the exporter are picked up without a restart.
            const spec = pathToFileURL(path.join(rootDir, 'tools/videoExport.mjs')).href + '?v=' + Date.now()
            const mod = await import(spec)
            const info = await mod.renderProjectToMp4({ project, glyphs, metrics, fps, width, speed, slideIds, includeAudio, outPath })
            const bytes = (await fs.stat(outPath)).size
            return sendJson(res, 200, { ok: true, file: safe + '.mp4', bytes, ...info })
          }
          if (req.method === 'GET' && rest) {
            const file = path.join(exportsDir, path.basename(rest))
            let stat
            try {
              stat = await fs.stat(file)
            } catch {
              return sendJson(res, 404, { error: 'not found' })
            }
            res.setHeader('content-type', 'video/mp4')
            res.setHeader('accept-ranges', 'bytes')
            const range = req.headers.range
            const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
            if (m) {
              const start = m[1] ? parseInt(m[1], 10) : 0
              const end = m[2] ? parseInt(m[2], 10) : stat.size - 1
              res.statusCode = 206
              res.setHeader('content-range', `bytes ${start}-${end}/${stat.size}`)
              res.setHeader('content-length', String(end - start + 1))
              return createReadStream(file, { start, end }).pipe(res)
            }
            res.statusCode = 200
            res.setHeader('content-length', String(stat.size))
            return createReadStream(file).pipe(res)
          }
          return sendJson(res, 405, { error: 'method not allowed' })
        } catch (err) {
          return sendJson(res, 500, { error: String((err as Error)?.stack ?? err) })
        }
      })
    },
  }
}

/**
 * Voiceover TTS: POST /api/tts {projectId, cueId, text, voice?} generates a clip
 * with macOS `say` + ffmpeg into ./voiceover/<projectId>/<cueId>.m4a and returns
 * {file, durationMs}; GET /api/voiceover/<projectId>/<file> streams it (range-aware).
 */
function ttsPlugin(): Plugin {
  return {
    name: 'voiceover-tts',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = req.url ?? ''
        try {
          if (req.method === 'GET' && url.split('?')[0] === '/api/voices') {
            const spec = pathToFileURL(path.join(rootDir, 'tools/tts.mjs')).href + '?v=' + Date.now()
            const mod = await import(spec)
            try {
              const voices = await mod.listVoices()
              return sendJson(res, 200, { ok: true, voices })
            } catch (e) {
              // surface a clean message (e.g. missing key) the UI can show inline
              return sendJson(res, 200, { ok: false, error: (e as Error)?.message ?? String(e) })
            }
          }
          if (req.method === 'POST' && url.split('?')[0] === '/api/tts') {
            const body = JSON.parse((await readBody(req)).toString('utf8'))
            const { projectId, cueId, text, voiceId, model, direction, settings } = body
            if (!projectId || !cueId) return sendJson(res, 400, { error: 'projectId and cueId required' })
            const dir = path.join(voiceoverDir, safeSeg(projectId))
            await fs.mkdir(dir, { recursive: true })
            const file = `${safeSeg(cueId)}.m4a`
            const outPath = path.join(dir, file)
            const spec = pathToFileURL(path.join(rootDir, 'tools/tts.mjs')).href + '?v=' + Date.now()
            const mod = await import(spec)
            const info = await mod.generateTts({ text, voiceId, model, direction, settings, outPath })
            return sendJson(res, 200, { ok: true, file, ...info })
          }
          if (req.method === 'GET' && url.startsWith('/api/voiceover/')) {
            const rel = url.split('?')[0].slice('/api/voiceover/'.length).split('/')
            const file = path.join(voiceoverDir, safeSeg(decodeURIComponent(rel[0] ?? '')), path.basename(decodeURIComponent(rel[1] ?? '')))
            let stat
            try {
              stat = await fs.stat(file)
            } catch {
              return sendJson(res, 404, { error: 'not found' })
            }
            res.setHeader('content-type', 'audio/mp4')
            res.setHeader('accept-ranges', 'bytes')
            const range = req.headers.range
            const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
            if (m) {
              const start = m[1] ? parseInt(m[1], 10) : 0
              const end = m[2] ? parseInt(m[2], 10) : stat.size - 1
              res.statusCode = 206
              res.setHeader('content-range', `bytes ${start}-${end}/${stat.size}`)
              res.setHeader('content-length', String(end - start + 1))
              return createReadStream(file, { start, end }).pipe(res)
            }
            res.statusCode = 200
            res.setHeader('content-length', String(stat.size))
            return createReadStream(file).pipe(res)
          }
          return next()
        } catch (err) {
          // surface the clean message (shown inline in the VTT view), not a stack
          return sendJson(res, 500, { error: (err as Error)?.message ?? String(err) })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), fontStorePlugin(), projectStorePlugin(), exportPlugin(), ttsPlugin()],
  resolve: {
    alias: {
      '@lib': fileURLToPath(new URL('./src/lib', import.meta.url)),
      '@app': fileURLToPath(new URL('./src/app', import.meta.url)),
    },
  },
})

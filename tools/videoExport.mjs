// Headless MP4 export. Bundles the framework-free render seam (src/lib/project)
// with esbuild, renders every frame with a skia-backed Node canvas, and pipes
// PNGs straight into ffmpeg (libx264). Used by the dev-server /api/export route
// and runnable directly: `node tools/videoExport.mjs <projectFile> [out.mp4]`.
import esbuild from 'esbuild'
import { createCanvas } from '@napi-rs/canvas'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdtempSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

/**
 * Bundle the pure render seam so it runs under Node (all imports are framework-
 * free; `@lib` aliases are resolved here). Re-bundled per call so it always
 * reflects the current source during dev.
 */
async function loadSeam() {
  const res = await esbuild.build({
    stdin: {
      contents: `
        export { buildRenderContext, renderProject, projectDurationMs } from '@lib/project/render'
        export { prepareGlyph } from '@lib/animation/timeline'
        export { canvasSize } from '@lib/project/coords'
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    alias: { '@lib': join(ROOT, 'src/lib'), '@app': join(ROOT, 'src/app') },
  })
  const dir = mkdtempSync(join(tmpdir(), 'vexport-'))
  const out = join(dir, 'seam.mjs')
  writeFileSync(out, res.outputFiles[0].text)
  return import(pathToFileURL(out).href)
}

/** Build a char→PreparedGlyph map from a manifest's glyph record. */
function prepareGlyphMap(seam, glyphRecord) {
  const map = new Map()
  for (const key of Object.keys(glyphRecord || {})) {
    const g = glyphRecord[key]
    try {
      map.set(g.char, seam.prepareGlyph(g))
    } catch {
      /* skip malformed glyph */
    }
  }
  return map
}

/**
 * Render a project (optionally scoped to `slideIds`) to an MP4 at `outPath`.
 * `glyphs` is the manifest glyph record; `metrics` = {unitsPerEm,ascender,descender}.
 */
export async function renderProjectToMp4({
  project,
  glyphs,
  metrics,
  fps = 30,
  width = 1280,
  speed = 1,
  slideIds = null,
  tailMs = 600,
  outPath,
  onProgress,
}) {
  if (!project || !project.slides?.length) throw new Error('project has no slides')
  if (!outPath) throw new Error('outPath required')

  const seam = await loadSeam()
  const glyphMap = prepareGlyphMap(seam, glyphs)

  const sub = slideIds
    ? { ...project, slides: project.slides.filter((s) => slideIds.includes(s.id)) }
    : project
  if (!sub.slides.length) throw new Error('no slides selected')

  // even dimensions for yuv420p / libx264
  let w = Math.round(width)
  if (w % 2) w -= 1
  let h = seam.canvasSize(sub.aspect, w).h
  if (h % 2) h -= 1

  // Speed is baked into the timeline (writing scaled, holds/transitions invariant),
  // so we render the resulting timeline at real time.
  const rate = speed > 0 ? speed : 1
  const rc = seam.buildRenderContext(sub, glyphMap, w, metrics, rate)
  const animDurationMs = seam.projectDurationMs(rc)
  const videoDurationMs = animDurationMs + tailMs
  const totalFrames = Math.max(1, Math.ceil((videoDurationMs / 1000) * fps))
  const lastAnimMs = Math.max(0, animDurationMs - 1)

  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')

  let stderr = ''
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-f', 'image2pipe',
      '-framerate', String(fps),
      '-i', '-',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'medium',
      '-movflags', '+faststart',
      outPath,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  )
  ff.stderr.on('data', (d) => {
    stderr += d.toString()
    if (stderr.length > 8000) stderr = stderr.slice(-8000)
  })
  const ffDone = new Promise((resolve, reject) => {
    ff.on('error', reject)
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}:\n${stderr}`))))
  })

  for (let i = 0; i < totalFrames; i++) {
    const animT = Math.min((i / fps) * 1000, lastAnimMs)
    seam.renderProject(ctx, sub, rc, animT, w, h)
    const png = canvas.toBuffer('image/png')
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r))
    if (onProgress && (i % 10 === 0 || i === totalFrames - 1)) onProgress((i + 1) / totalFrames)
  }
  ff.stdin.end()
  await ffDone

  return { w, h, fps, frames: totalFrames, durationMs: videoDurationMs, speed: rate }
}

// --- CLI: node tools/videoExport.mjs <projectFile> [out.mp4] [width] [fps] ----
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  const [projectFile, outArg, widthArg, fpsArg] = process.argv.slice(2)
  if (!projectFile) {
    console.error('usage: node tools/videoExport.mjs <projectFile> [out.mp4] [width] [fps]')
    process.exit(1)
  }
  const project = JSON.parse(readFileSync(projectFile, 'utf8'))
  const manifestPath = join(ROOT, 'fonts', project.fontId, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const metrics = {
    unitsPerEm: manifest.metadata.unitsPerEm,
    ascender: manifest.metadata.ascender,
    descender: manifest.metadata.descender,
  }
  const outDir = join(ROOT, 'exports')
  mkdirSync(outDir, { recursive: true })
  const outPath = outArg || join(outDir, (project.name || 'video').replace(/[^a-z0-9-_]+/gi, '_') + '.mp4')
  const t0 = Date.now()
  const info = await renderProjectToMp4({
    project,
    glyphs: manifest.glyphs,
    metrics,
    width: widthArg ? Number(widthArg) : 1280,
    fps: fpsArg ? Number(fpsArg) : 30,
    speed: project.playbackRate ?? 1,
    outPath,
    onProgress: (p) => process.stdout.write(`\r  rendering ${(p * 100).toFixed(0)}%   `),
  })
  console.log(`\n✓ ${outPath}  (${info.frames} frames @ ${info.fps}fps, ${info.w}×${info.h}, ${(statSync(outPath).size / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
}

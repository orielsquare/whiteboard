// Headless MP4 export. Bundles the framework-free render seam (src/lib/project)
// with esbuild, renders every frame with a skia-backed Node canvas, and pipes
// PNGs straight into ffmpeg (libx264). Used by the dev-server /api/export route
// and runnable directly: `node tools/videoExport.mjs <projectFile> [out.mp4]`.
import esbuild from 'esbuild'
import { createCanvas } from '@napi-rs/canvas'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { writeFileSync, mkdtempSync, readFileSync, mkdirSync, statSync, existsSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

/** Mirror the dev server's path sanitiser so we resolve the same voiceover dir. */
const safeSeg = (s) => String(s).replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80)

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

/** Run ffmpeg with the given args, rejecting on a non-zero exit (with stderr tail). */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    ff.stderr.on('data', (d) => {
      stderr += d.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    ff.on('error', reject)
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}:\n${stderr}`))))
  })
}

/**
 * Mux voiceover clips into a (silent) video, each delayed to its absolute cue
 * time. Clips are summed without auto-normalising (cues rarely overlap, so we
 * keep their loudness), padded with trailing silence, and `-shortest` clamps the
 * result to the video length — so audio sits exactly where the cues are, with
 * silence in the gaps/tail and anything past the end trimmed. Video is copied (no
 * re-encode); audio is AAC. `cues` = [{ startMs, file }] under `audioDir`.
 */
function muxAudioIntoVideo({ silentPath, outPath, cues, audioDir }) {
  const inputs = []
  const delayed = []
  cues.forEach((c, i) => {
    inputs.push('-i', join(audioDir, basename(c.file)))
    const lbl = `a${i}`
    // input 0 is the video, so audio inputs start at index 1
    delayed.push(`[${i + 1}:a]adelay=${Math.max(0, Math.round(c.startMs))}:all=1[${lbl}]`)
  })
  const labels = cues.map((_, i) => `[a${i}]`).join('')
  const mix =
    cues.length === 1 ? `${labels}apad[aout]` : `${labels}amix=inputs=${cues.length}:normalize=0,apad[aout]`
  const filterComplex = `${delayed.join(';')};${mix}`
  return runFfmpeg([
    '-y',
    '-i', silentPath,
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    outPath,
  ])
}

/** Resolve a project's generated voiceover clips to {startMs, file} that exist on disk. */
function collectAudioCues(project, audioDir) {
  return (project.voiceover || [])
    .filter((c) => c?.audio?.file && existsSync(join(audioDir, basename(c.audio.file))))
    .map((c) => ({ startMs: Math.max(0, Math.round(c.startMs || 0)), file: c.audio.file }))
    .sort((a, b) => a.startMs - b.startMs)
}

/**
 * Render a project (optionally scoped to `slideIds`) to an MP4 at `outPath`.
 * `glyphs` is the manifest glyph record; `metrics` = {unitsPerEm,ascender,descender}.
 * Voiceover clips are muxed in at their absolute cue times unless `includeAudio`
 * is false or the export is scoped to a slide subset (cue times are project-wide,
 * so they only line up with a full-project render).
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
  includeAudio = true,
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

  // Render frames to a silent temp video (next to outPath, so the later rename
  // stays on one filesystem); audio is muxed into outPath in a second pass.
  const silentPath = outPath.replace(/\.mp4$/i, '') + '.silent.mp4'

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
      silentPath,
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

  // Second pass: mux voiceover. Cue times are absolute project-time, so only a
  // full-project render lines up — skip when scoped to a slide subset.
  let audioMuxed = false
  let audioCues = 0
  let audioWarning = null
  if (includeAudio && !slideIds) {
    const audioDir = join(ROOT, 'voiceover', safeSeg(project.id))
    const cues = collectAudioCues(project, audioDir)
    if (cues.length) {
      try {
        await muxAudioIntoVideo({ silentPath, outPath, cues, audioDir })
        rmSync(silentPath, { force: true })
        audioMuxed = true
        audioCues = cues.length
      } catch (e) {
        audioWarning = 'audio mux failed (kept silent video): ' + (e?.message ?? e)
        renameSync(silentPath, outPath)
      }
    } else {
      renameSync(silentPath, outPath)
    }
  } else {
    renameSync(silentPath, outPath)
  }

  return { w, h, fps, frames: totalFrames, durationMs: videoDurationMs, speed: rate, audioMuxed, audioCues, audioWarning }
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
  const audioNote = info.audioMuxed ? `, 🔊 ${info.audioCues} voiceover clip(s)` : info.audioWarning ? `, ⚠ ${info.audioWarning}` : ''
  console.log(`\n✓ ${outPath}  (${info.frames} frames @ ${info.fps}fps, ${info.w}×${info.h}, ${(statSync(outPath).size / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s${audioNote})`)
}

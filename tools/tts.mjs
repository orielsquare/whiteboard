// Text-to-speech for voiceover cues, via ElevenLabs.
//
// Auth is an API key from the ELEVENLABS_API_KEY env var (server-side only — never
// sent to the browser). The accent comes from the chosen voice; v2/Flash/Turbo
// models are steered with voice_settings, the v3 model with a free-text `direction`
// applied as an inline **audio tag** — a square-bracketed cue v3 interprets but does
// NOT speak (see buildTtsText). ElevenLabs returns mp3 (or pcm) which ffmpeg encodes
// to .m4a. Used by the dev-server /api/tts + /api/voices routes.
import { spawn } from 'node:child_process'

const BASE = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io'
const OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128'

function apiKey() {
  const k = process.env.ELEVENLABS_API_KEY
  if (!k) throw new Error('ELEVENLABS_API_KEY is not set — add it to the dev server’s environment.')
  return k
}

/** Read + parse an ElevenLabs error body into a short message. */
async function errorMessage(res) {
  let body = ''
  try {
    body = await res.text()
  } catch {
    /* ignore */
  }
  try {
    const j = JSON.parse(body)
    const d = j?.detail
    if (typeof d === 'string') return d
    if (d?.message) return d.message
    if (Array.isArray(d) && d[0]?.msg) return d[0].msg
  } catch {
    /* not json */
  }
  return body.slice(0, 200) || `HTTP ${res.status} ${res.statusText}`
}

function ffprobeDurationMs(file) {
  return new Promise((resolve) => {
    let out = ''
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file])
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => resolve(Math.round((parseFloat(out.trim()) || 0) * 1000)))
    p.on('error', () => resolve(0))
  })
}

/** Encode the returned audio (mp3 by default, or raw pcm) from stdin to .m4a. */
function encodeToM4a(audio, outPath) {
  const pcm = OUTPUT_FORMAT.startsWith('pcm_')
  const rate = pcm ? Number(OUTPUT_FORMAT.split('_')[1]) || 24000 : 0
  const inArgs = pcm ? ['-f', 's16le', '-ar', String(rate), '-ac', '1'] : []
  return new Promise((resolve, reject) => {
    let err = ''
    const p = spawn(
      'ffmpeg',
      ['-y', ...inArgs, '-i', 'pipe:0', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outPath],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    )
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))))
    p.stdin.end(audio)
  })
}

/**
 * Build the `text` sent to ElevenLabs. For v3, a delivery `direction` is applied as
 * an inline **audio tag**: a square-bracketed natural-language cue (e.g. `[warmly]`)
 * that v3 interprets but does NOT read aloud. A bare direction is wrapped in `[…]`
 * so it isn't spoken; a direction that already contains a `[` is passed through (the
 * user wrote their own tags). Non-v3 models have no audio tags, so the direction is
 * ignored (it would otherwise be read out). Pure — unit-tested in tools/tts.test.mjs.
 */
export function buildTtsText(text, isV3, direction) {
  const t = String(text ?? '')
  const dir = direction && String(direction).trim() ? String(direction).trim() : ''
  if (!isV3 || !dir) return t
  const tag = dir.includes('[') ? dir : `[${dir}]`
  return `${tag} ${t}`
}

/**
 * Synthesize `text` in the given ElevenLabs `voiceId` + `model` into `outPath`
 * (.m4a). v3 applies the `direction` as an inline audio tag (see buildTtsText);
 * other models use `settings` (voice_settings). Returns { durationMs, voiceId, model }.
 */
export async function generateTts({ text, voiceId, model, direction, settings, outPath }) {
  if (!text || !String(text).trim()) throw new Error('Cue has no text to synthesize.')
  if (!voiceId) throw new Error('No ElevenLabs voice selected.')
  const key = apiKey()
  const modelId = model || 'eleven_multilingual_v2'
  const isV3 = modelId === 'eleven_v3'

  const content = buildTtsText(text, isV3, direction)

  const body = { text: content, model_id: modelId }
  if (!isV3 && settings) {
    body.voice_settings = {
      stability: clamp01(settings.stability, 0.5),
      similarity_boost: clamp01(settings.similarityBoost, 0.75),
      style: clamp01(settings.style, 0),
      use_speaker_boost: true,
      speed: clampRange(settings.speed, 0.7, 1.2, 1),
    }
  }

  const url = `${BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(OUTPUT_FORMAT)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const hint = res.status === 401 ? ' (check ELEVENLABS_API_KEY)' : ''
    throw new Error(`ElevenLabs TTS failed: ${await errorMessage(res)}${hint}`)
  }
  const audio = Buffer.from(await res.arrayBuffer())
  if (!audio.length) throw new Error('ElevenLabs returned empty audio.')
  await encodeToM4a(audio, outPath)
  return { durationMs: await ffprobeDurationMs(outPath), voiceId, model: modelId }
}

/** List the account's voices: [{ voiceId, name, accent, description, category }]. */
export async function listVoices() {
  const key = apiKey()
  const res = await fetch(`${BASE}/v1/voices`, { headers: { 'xi-api-key': key, accept: 'application/json' } })
  if (!res.ok) {
    const hint = res.status === 401 ? ' (check ELEVENLABS_API_KEY)' : ''
    throw new Error(`ElevenLabs voice list failed: ${await errorMessage(res)}${hint}`)
  }
  const json = await res.json()
  return (json.voices || []).map((v) => ({
    voiceId: v.voice_id,
    name: v.name,
    accent: v.labels?.accent ?? '',
    description: v.labels?.description ?? '',
    category: v.category ?? '',
    // free, hosted sample of the voice (no TTS call / no extra cost)
    previewUrl: v.preview_url ?? '',
  }))
}

function clamp01(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback
}
function clampRange(v, lo, hi, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

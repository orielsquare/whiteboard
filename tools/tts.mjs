// Text-to-speech for voiceover cues, via Gemini 2.5 TTS on Vertex AI.
//
// Auth is Application Default Credentials (the user's `gcloud auth application-
// default login`) — we shell out for an access token, so no SDK/npm dep and no API
// key. The model returns 16-bit PCM (L16) which ffmpeg encodes to .m4a. A natural-
// language `prompt` (style instruction) is prepended to the spoken text. Used by the
// dev-server /api/tts route.
import { spawn } from 'node:child_process'

const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || process.env.VERTEX_LOCATION || 'us-central1'
const MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts'
const DEFAULT_VOICE = 'Kore'

// Survive the dev server's per-request module cache-busting (`?v=…` re-imports):
// keep the ADC token + project on globalThis so we don't spawn gcloud every call.
const cache = (globalThis.__vertexTtsCache ??= { token: null, exp: 0, project: null })

/** Run a command and resolve its trimmed stdout (rejects on non-zero exit). */
function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`))))
  })
}

/** A Vertex AI access token (env override, else ADC via gcloud), cached ~50 min. */
async function getAccessToken() {
  if (process.env.VERTEX_ACCESS_TOKEN) return process.env.VERTEX_ACCESS_TOKEN
  const now = Date.now()
  if (cache.token && now < cache.exp) return cache.token
  let token
  try {
    token = await sh('gcloud', ['auth', 'application-default', 'print-access-token'])
  } catch (e) {
    throw new Error(
      'Could not get a Vertex AI access token. Run `gcloud auth application-default login` ' +
        '(or set VERTEX_ACCESS_TOKEN). Underlying error: ' + (e?.message ?? e),
    )
  }
  cache.token = token
  cache.exp = now + 50 * 60 * 1000 // ADC tokens last ~1h
  return token
}

/** Drop the cached token so the next getAccessToken() fetches a fresh one. */
function clearTokenCache() {
  cache.token = null
  cache.exp = 0
}

/** The GCP project id (env override, else `gcloud config get-value project`). */
async function getProject() {
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT
  if (cache.project) return cache.project
  const proj = await sh('gcloud', ['config', 'get-value', 'project']).catch(() => '')
  if (!proj || proj === '(unset)') {
    throw new Error('No GCP project set. Set GOOGLE_CLOUD_PROJECT or run `gcloud config set project <id>`.')
  }
  cache.project = proj
  return proj
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

/** Encode raw little-endian 16-bit mono PCM (from stdin) to an .m4a file. */
function pcmToM4a(pcm, rate, outPath) {
  return new Promise((resolve, reject) => {
    let err = ''
    const p = spawn(
      'ffmpeg',
      ['-y', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outPath],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    )
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))))
    p.stdin.end(pcm)
  })
}

function postVertex(url, body, token) {
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  })
}

/**
 * Synthesize `text` (optionally prefixed with the style `prompt`) in the given
 * Gemini `voice` into `outPath` (.m4a). Returns { durationMs, voice }.
 */
export async function generateTts({ text, voice, accent, prompt, outPath }) {
  if (!text || !String(text).trim()) throw new Error('Cue has no text to synthesize.')
  const spoken = String(text)
  // Gemini interprets leading natural-language directives (accent, then style) as
  // delivery instructions rather than spoken content.
  const directives = []
  if (accent && String(accent).trim()) directives.push(`Speak with a ${String(accent).trim()} accent.`)
  if (prompt && String(prompt).trim()) directives.push(String(prompt).trim())
  const instruction = directives.join(' ')
  const content = instruction ? `${instruction}\n\n${spoken}` : spoken
  const voiceName = voice || DEFAULT_VOICE

  const project = await getProject()
  const host = LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`
  const url = `https://${host}/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: content }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  })

  // A cached ADC token can expire before our soft TTL — on an auth failure,
  // refresh the token once and retry before giving up.
  let res = await postVertex(url, body, await getAccessToken())
  if ((res.status === 401 || res.status === 403) && !process.env.VERTEX_ACCESS_TOKEN) {
    clearTokenCache()
    res = await postVertex(url, body, await getAccessToken())
  }

  let json = null
  try {
    json = await res.json()
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || !json) {
    const msg = json?.error?.message || `HTTP ${res.status} ${res.statusText}`
    const hint = res.status === 401 || res.status === 403 ? ' (try `gcloud auth application-default login`)' : ''
    throw new Error(`Vertex AI TTS request failed: ${msg}${hint}`)
  }
  const cand = json.candidates?.[0]
  const part = cand?.content?.parts?.find((pt) => pt.inlineData?.data)
  const b64 = part?.inlineData?.data
  if (!b64) {
    throw new Error(`Vertex AI TTS returned no audio (finishReason: ${cand?.finishReason ?? 'unknown'})`)
  }
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1]) || 24000
  await pcmToM4a(Buffer.from(b64, 'base64'), rate, outPath)
  return { durationMs: await ffprobeDurationMs(outPath), voice: voiceName }
}

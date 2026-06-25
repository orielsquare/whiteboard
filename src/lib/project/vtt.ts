import type { VoiceoverCue } from './schema'

/**
 * Pure WebVTT helpers for the project voiceover track. The cue list is the model;
 * this serializes it to editable WebVTT and parses edits back (preserving audio by
 * cue id). Timestamps are absolute project real-time ms. Type-only imports, so it
 * runs standalone (esbuild) for tests.
 */

/** A cue as parsed from raw VTT text (id may be absent for new cues). */
export interface ParsedCue {
  id?: string
  startMs: number
  endMs: number
  text: string
}

/** ms → "HH:MM:SS.mmm". */
export function formatTimestamp(ms: number): string {
  let t = Math.max(0, Math.round(ms))
  const h = Math.floor(t / 3600000)
  t -= h * 3600000
  const m = Math.floor(t / 60000)
  t -= m * 60000
  const s = Math.floor(t / 1000)
  const mm = t - s * 1000
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(h)}:${p2(m)}:${p2(s)}.${String(mm).padStart(3, '0')}`
}

/** "HH:MM:SS.mmm" or "MM:SS.mmm" (',' or '.' ok) → ms, or null if malformed. */
export function parseTimestamp(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(s.trim())
  if (!m) return null
  const h = m[1] ? parseInt(m[1], 10) : 0
  const mm = parseInt(m[2], 10)
  const ss = parseInt(m[3], 10)
  const frac = parseInt(m[4].padEnd(3, '0').slice(0, 3), 10)
  return ((h * 60 + mm) * 60 + ss) * 1000 + frac
}

/** Serialize cues to WebVTT (sorted by start; cue id kept as the cue identifier). */
export function serializeVtt(cues: VoiceoverCue[]): string {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  let out = 'WEBVTT\n'
  for (const c of sorted) {
    out += '\n'
    if (c.id) out += `${c.id}\n`
    out += `${formatTimestamp(c.startMs)} --> ${formatTimestamp(c.endMs)}\n`
    out += `${c.text ?? ''}\n`
  }
  return out
}

/** Tolerant WebVTT parse → cues + any per-block errors (does not throw). */
export function parseVtt(text: string): { cues: ParsedCue[]; errors: string[] } {
  const cues: ParsedCue[] = []
  const errors: string[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  if (lines[i] !== undefined && lines[i].trim().toUpperCase().startsWith('WEBVTT')) {
    while (i < lines.length && lines[i].trim() !== '') i++ // skip header block
  }
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === '') i++ // skip blanks
    if (i >= lines.length) break
    // optional id line: not itself a timing line, but the next line is
    let id: string | undefined
    if (i + 1 < lines.length && !lines[i].includes('-->') && lines[i + 1].includes('-->')) {
      id = lines[i].trim() || undefined
      i++
    }
    if (i >= lines.length || !lines[i].includes('-->')) {
      errors.push(`expected a "start --> end" line near line ${i + 1}`)
      i++
      continue
    }
    const m = /(\S+)\s*-->\s*(\S+)/.exec(lines[i])
    i++
    if (!m) {
      errors.push(`could not read the cue timing on line ${i}`)
      continue
    }
    const startMs = parseTimestamp(m[1])
    const endMs = parseTimestamp(m[2])
    if (startMs == null || endMs == null) {
      errors.push(`bad timestamp in "${m[0]}"`)
      continue
    }
    const textLines: string[] = []
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i])
      i++
    }
    cues.push({ id, startMs, endMs, text: textLines.join('\n') })
  }
  return { cues, errors }
}

/**
 * Turn freshly-parsed cues into the cue model, preserving each existing cue's
 * generated audio (matched by id) and assigning ids to new cues via `makeId`.
 */
export function reconcileParsed(
  prev: VoiceoverCue[],
  parsed: ParsedCue[],
  makeId: () => string,
): VoiceoverCue[] {
  const byId = new Map(prev.map((c) => [c.id, c]))
  return parsed.map((p) => {
    const existing = p.id ? byId.get(p.id) : undefined
    const cue: VoiceoverCue = {
      id: p.id && p.id.length ? p.id : makeId(),
      startMs: p.startMs,
      endMs: p.endMs,
      text: p.text,
    }
    if (existing?.audio) cue.audio = existing.audio
    return cue
  })
}

/** Rough spoken-length estimate (~165 wpm), for a cue's default end time. */
export function estimateDurationMs(text: string): number {
  const words = (text.trim().match(/\S+/g) || []).length
  return Math.max(600, Math.round(words * 360))
}

/** Cues whose START falls within [startMs, endMs), sorted. (slide-extract / ranges) */
export function cuesInRange(cues: VoiceoverCue[], startMs: number, endMs: number): VoiceoverCue[] {
  return cues.filter((c) => c.startMs >= startMs && c.startMs < endMs).sort((a, b) => a.startMs - b.startMs)
}

/** Small stable hash of a cue's text — used to flag audio as stale after edits. */
export function hashText(text: string): string {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/**
 * True if a cue has audio that no longer matches what it would generate now —
 * because its text changed, or (when `opts` is given) because the project's voice,
 * accent, or style prompt changed since the clip was made. Omitting `opts` checks
 * text only.
 */
export function isAudioStale(cue: VoiceoverCue, opts?: { voice?: string; accent?: string; prompt?: string }): boolean {
  if (!cue.audio) return false
  if (cue.audio.textHash !== undefined && cue.audio.textHash !== hashText(cue.text)) return true
  if (opts) {
    if ((cue.audio.voice ?? '') !== (opts.voice ?? '')) return true
    if ((cue.audio.accent ?? '') !== (opts.accent ?? '')) return true
    if ((cue.audio.prompt ?? '') !== (opts.prompt ?? '')) return true
  }
  return false
}

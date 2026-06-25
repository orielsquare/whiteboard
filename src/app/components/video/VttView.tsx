import { useEffect, useRef, useState } from 'react'
import { DEFAULT_TTS, makeId, type VoiceoverCue } from '@lib/project/schema'
import { formatTimestamp, hashText, isAudioStale, parseVtt, reconcileParsed, serializeVtt } from '@lib/project/vtt'
import { useVideoStore } from '../../state/videoStore'

const EMPTY: never[] = []

/** Suggested accents (free-text input — describe more specifically if you like). */
const ACCENTS = [
  'British', 'Received Pronunciation', 'Estuary English', 'Cockney', 'Scottish', 'Glaswegian', 'Irish',
  'Welsh', 'Northern English', 'Geordie', 'American', 'General American', 'Southern American', 'Australian',
  'New Zealand', 'Canadian', 'South African', 'Indian English',
]

/** Prebuilt Gemini 2.5 TTS voices (Vertex AI). */
const VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
]

/** URL for a cue's generated audio (served by the dev server). The `?v=` version
 * (bumped each regeneration) busts the browser + <audio>-element cache so a clip
 * regenerated with a new voice/prompt actually reloads. */
export function cueAudioUrl(projectId: string, cue: VoiceoverCue): string | null {
  if (!cue.audio) return null
  const v = cue.audio.version ? `?v=${cue.audio.version}` : ''
  return `/api/voiceover/${encodeURIComponent(projectId)}/${encodeURIComponent(cue.audio.file)}${v}`
}

/**
 * Editable WebVTT view of the project voiceover. The raw WebVTT text is the
 * editing surface (parsed live, reconciled into the cue model, preserving audio
 * by id). A Voice panel sets the project-wide Gemini voice + style prompt used to
 * synthesize cue audio (macOS-free: Gemini 2.5 TTS on Vertex AI). Below, a cue
 * list generates/plays the audio; cues are shaded and flagged stale when the
 * text, voice, or prompt no longer match the generated clip.
 */
export function VttView() {
  const project = useVideoStore((s) => s.project)
  const cues = useVideoStore((s) => s.project?.voiceover ?? EMPTY)
  const ttsRaw = useVideoStore((s) => s.project?.tts)
  // fill any missing fields (e.g. accent on projects saved before it existed)
  const tts = { ...DEFAULT_TTS, ...(ttsRaw ?? {}) }
  const setTts = useVideoStore((s) => s.setTts)
  const setVoiceover = useVideoStore((s) => s.setVoiceover)
  const updateCue = useVideoStore((s) => s.updateCue)
  const removeCue = useVideoStore((s) => s.removeCue)
  const addCue = useVideoStore((s) => s.addCue)

  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [draft, setDraft] = useState(() => serializeVtt(cues))
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [genError, setGenError] = useState<string | null>(null)

  const canonical = serializeVtt(cues)
  useEffect(() => {
    if (document.activeElement !== taRef.current) setDraft(canonical)
  }, [canonical])

  const onChange = (text: string) => {
    setDraft(text)
    const { cues: parsed, errors: errs } = parseVtt(text)
    setErrors(errs)
    setVoiceover(reconcileParsed(useVideoStore.getState().project?.voiceover ?? [], parsed, makeId))
  }

  const onAdd = () => {
    const last = [...cues].sort((a, b) => a.startMs - b.startMs).at(-1)
    addCue(last ? last.endMs + 200 : 0)
  }

  const generate = async (cue: VoiceoverCue): Promise<boolean> => {
    const p = useVideoStore.getState().project
    if (!p) return false
    if (!cue.text.trim()) {
      setGenError('This cue has no text to synthesize — add narration first.')
      return false
    }
    const cur = p.tts ?? DEFAULT_TTS
    setGenError(null)
    setBusy((b) => ({ ...b, [cue.id]: true }))
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: p.id, cueId: cue.id, text: cue.text, voice: cur.voice, accent: cur.accent, prompt: cur.prompt }),
      })
      const data = await res.json()
      if (data.ok) {
        updateCue(cue.id, {
          audio: {
            file: data.file,
            durationMs: data.durationMs,
            voice: data.voice ?? cur.voice,
            accent: cur.accent,
            prompt: cur.prompt,
            textHash: hashText(cue.text),
            version: Date.now(),
          },
          endMs: cue.startMs + data.durationMs,
        })
        return true
      }
      setGenError(`Couldn’t synthesize “${cue.text.slice(0, 40)}”: ${data.error ?? 'unknown error'}`)
      return false
    } catch (e) {
      setGenError('Voice synthesis request failed: ' + (e as Error)?.message)
      return false
    } finally {
      setBusy((b) => ({ ...b, [cue.id]: false }))
    }
  }

  const generateAll = async () => {
    // Skip blank cues silently; stop on a real failure rather than hammering it.
    for (const cue of [...cues].sort((a, b) => a.startMs - b.startMs)) {
      if (!cue.text.trim()) continue
      const ok = await generate(cue)
      if (!ok) break
    }
  }

  const play = (cue: VoiceoverCue) => {
    if (!project) return
    const url = cueAudioUrl(project.id, cue)
    if (!url) return
    if (!audioRef.current) audioRef.current = new Audio()
    audioRef.current.src = url
    audioRef.current.currentTime = 0
    audioRef.current.play().catch(() => {})
  }

  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs)
  const anyGenerating = Object.values(busy).some(Boolean)

  return (
    <div className="vttview">
      <div className="vtt-voice">
        <div className="vtt-voice-row">
          <label className="vtt-voice-field">
            <span>Voice</span>
            <select value={tts.voice} onChange={(e) => setTts({ voice: e.target.value })}>
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="vtt-voice-field vtt-voice-accent">
            <span>Accent</span>
            <input
              type="text"
              list="tts-accents"
              placeholder="British"
              value={tts.accent}
              onChange={(e) => setTts({ accent: e.target.value })}
            />
            <datalist id="tts-accents">
              {ACCENTS.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </label>
        </div>
        <label className="vtt-voice-field vtt-voice-prompt">
          <span>Style prompt</span>
          <textarea
            rows={2}
            spellCheck
            placeholder="e.g. Read in a warm, encouraging teacher’s voice — clear and unhurried."
            value={tts.prompt}
            onChange={(e) => setTts({ prompt: e.target.value })}
          />
        </label>
        <p className="vtt-voice-hint muted">
          Audio is synthesized with <b>Gemini</b> on Vertex AI. The accent and style prompt become
          natural-language instructions applied to every cue (the accent can be as specific as you like —
          e.g. <i>Received Pronunciation</i>, <i>Glaswegian</i>). Changing the voice, accent, or prompt
          flags existing clips as stale.
        </p>
      </div>

      <div className="vtt-head">
        <h3>Voiceover script (WebVTT)</h3>
        <div className="spacer" />
        <button onClick={onAdd}>+ Add cue</button>
        <button onClick={generateAll} disabled={anyGenerating || cues.length === 0}>
          {anyGenerating ? '⏳ Generating…' : '🔊 Generate all'}
        </button>
        <span className="muted">{cues.length} cue(s)</span>
      </div>

      <textarea
        ref={taRef}
        className="vtt-textarea"
        spellCheck={false}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nYour narration here.'}
      />

      {errors.length > 0 ? (
        <div className="vtt-errors">
          {errors.slice(0, 4).map((e, i) => (
            <div key={i}>⚠ {e}</div>
          ))}
        </div>
      ) : (
        <div className="vtt-ok">✓ parsed cleanly</div>
      )}

      {genError && <div className="vtt-errors vtt-gen-error">⚠ {genError}</div>}

      {sorted.length > 0 && (
        <ul className="cue-list">
          {sorted.map((c) => {
            const stale = isAudioStale(c, { voice: tts.voice, accent: tts.accent, prompt: tts.prompt })
            return (
              <li key={c.id} className={c.audio ? 'cue-row has-audio' : 'cue-row'}>
                <span className="cue-row-time">{formatTimestamp(c.startMs)}</span>
                <span className="cue-row-text" title={c.text}>
                  {c.text.replace(/\n/g, ' ') || '(empty)'}
                </span>
                <span className={stale ? 'cue-audio-state stale' : c.audio ? 'cue-audio-state ok' : 'cue-audio-state none'}>
                  {busy[c.id] ? '…' : stale ? '♪ stale' : c.audio ? `♪ ${(c.audio.durationMs / 1000).toFixed(1)}s` : 'no audio'}
                </span>
                <button className="tool" disabled={!c.audio || busy[c.id]} onClick={() => play(c)} title="play">
                  ▶
                </button>
                <button className="tool" disabled={busy[c.id]} onClick={() => generate(c)} title="generate / regenerate TTS">
                  {c.audio ? '↻' : '🔊'}
                </button>
                <button className="tool" onClick={() => removeCue(c.id)} title="delete cue">
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <p className="hint">
        Cues are absolute project-time. The line above each timestamp is the cue id — keep it to retain a
        cue's generated audio across edits. Generating sets the cue's end time to the spoken length.
      </p>
    </div>
  )
}

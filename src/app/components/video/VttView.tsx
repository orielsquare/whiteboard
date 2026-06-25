import { useEffect, useRef, useState } from 'react'
import { DEFAULT_TTS, makeId, type TtsSettings, type VoiceoverCue } from '@lib/project/schema'
import { formatTimestamp, hashText, isAudioStale, parseVtt, reconcileParsed, serializeVtt } from '@lib/project/vtt'
import { useVideoStore, videoHistory } from '../../state/videoStore'

const EMPTY: never[] = []

/** ElevenLabs models (v3 takes a free-text direction; the rest take voice settings). */
const MODELS = [
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 — high quality' },
  { id: 'eleven_v3', label: 'Eleven v3 — expressive (direction)' },
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5 — fast' },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 — fastest' },
]

interface Voice {
  voiceId: string
  name: string
  accent: string
  description: string
  category: string
  previewUrl: string
}

const isBritish = (v: Voice) => /british|england|english \(uk|^uk\b|\buk\b|received pronunciation/i.test(`${v.accent} ${v.description}`)

/** URL for a cue's generated audio (served by the dev server). The `?v=` version
 * (bumped each regeneration) busts the browser + <audio>-element cache so a clip
 * regenerated with new voice/settings actually reloads. */
export function cueAudioUrl(projectId: string, cue: VoiceoverCue): string | null {
  if (!cue.audio) return null
  const v = cue.audio.version ? `?v=${cue.audio.version}` : ''
  return `/api/voiceover/${encodeURIComponent(projectId)}/${encodeURIComponent(cue.audio.file)}${v}`
}

/**
 * Editable WebVTT view of the project voiceover. The raw WebVTT text is the editing
 * surface (parsed live, reconciled into the cue model, preserving audio by id). The
 * Voice panel (below the script) picks the **ElevenLabs** voice, model, and delivery
 * controls — and can preview a voice with its free hosted sample. Each cue chip shows
 * the voice used and is a button to reuse that clip's exact settings. A clip is flagged
 * **stale only when its text changed** (different voice/settings ≠ stale).
 */
export function VttView() {
  const project = useVideoStore((s) => s.project)
  const cues = useVideoStore((s) => s.project?.voiceover ?? EMPTY)
  const ttsRaw = useVideoStore((s) => s.project?.tts)
  const tts = { ...DEFAULT_TTS, ...(ttsRaw ?? {}), settings: { ...DEFAULT_TTS.settings, ...(ttsRaw?.settings ?? {}) } }
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

  const [voices, setVoices] = useState<Voice[]>([])
  const [voicesError, setVoicesError] = useState<string | null>(null)
  const [voicesLoading, setVoicesLoading] = useState(true)

  const isV3 = tts.model === 'eleven_v3'
  const selectedPreviewUrl = voices.find((v) => v.voiceId === tts.voiceId)?.previewUrl ?? ''

  // Load the account's voices once (carries the accents + preview samples).
  useEffect(() => {
    let alive = true
    setVoicesLoading(true)
    fetch('/api/voices')
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return
        if (data.ok) {
          setVoices(data.voices)
          setVoicesError(null)
        } else {
          setVoicesError(data.error || 'Could not load voices')
        }
      })
      .catch((e) => alive && setVoicesError(String(e?.message ?? e)))
      .finally(() => alive && setVoicesLoading(false))
    return () => {
      alive = false
    }
  }, [])

  // Default to a British voice (else the first) once voices load and none is chosen.
  useEffect(() => {
    if (!voices.length) return
    const cur = useVideoStore.getState().project?.tts?.voiceId
    if (cur && voices.some((v) => v.voiceId === cur)) return
    const pick = voices.find(isBritish) ?? voices[0]
    // Not a user edit — don't make the default selection an undoable step.
    videoHistory.pause()
    setTts({ voiceId: pick.voiceId, voiceName: pick.name })
    videoHistory.resume()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices])

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

  const setSetting = (patch: Partial<typeof tts.settings>) => setTts({ settings: { ...tts.settings, ...patch } })

  /** Play a free hosted sample of the given voice (no TTS call). */
  const previewVoice = (url: string) => {
    if (!url) return
    if (!audioRef.current) audioRef.current = new Audio()
    audioRef.current.src = url
    audioRef.current.currentTime = 0
    audioRef.current.play().catch(() => {})
  }

  /** Adopt the voice/model/settings a clip was generated with (after a confirm). */
  const useClipSettings = (cue: VoiceoverCue) => {
    const t = cue.audio?.tts
    if (!t) return
    const summary =
      t.model === 'eleven_v3'
        ? `Direction: ${t.direction || '—'}`
        : `Stability ${t.settings.stability}, Similarity ${t.settings.similarityBoost}, Style ${t.settings.style}, Speed ${t.settings.speed}`
    if (window.confirm(`Use these settings?\n\nVoice: ${t.voiceName || t.voiceId}\nModel: ${t.model}\n${summary}`)) {
      setTts(t)
    }
  }

  const generate = async (cue: VoiceoverCue): Promise<boolean> => {
    const p = useVideoStore.getState().project
    if (!p) return false
    if (!cue.text.trim()) {
      setGenError('This cue has no text to synthesize — add narration first.')
      return false
    }
    // the exact settings this clip is being made with (deep-merged, complete)
    const cur: TtsSettings = {
      ...DEFAULT_TTS,
      ...(p.tts ?? {}),
      settings: { ...DEFAULT_TTS.settings, ...(p.tts?.settings ?? {}) },
    }
    if (!cur.voiceId) {
      setGenError('Pick a voice first (set ELEVENLABS_API_KEY if the list is empty).')
      return false
    }
    setGenError(null)
    setBusy((b) => ({ ...b, [cue.id]: true }))
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: p.id,
          cueId: cue.id,
          text: cue.text,
          voiceId: cur.voiceId,
          model: cur.model,
          direction: cur.direction,
          settings: cur.settings,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        updateCue(cue.id, {
          audio: {
            file: data.file,
            durationMs: data.durationMs,
            tts: cur,
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
  const noVoice = !tts.voiceId

  const voicePanel = (
    <div className="vtt-voice">
      <div className="vtt-voice-row">
        <label className="vtt-voice-field">
          <span>Model</span>
          <select value={tts.model} onChange={(e) => setTts({ model: e.target.value })}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="vtt-voice-field vtt-voice-pick">
          <span>Voice {tts.voiceName && <span className="muted">· {tts.voiceName}</span>}</span>
          <div className="vtt-voice-pick-row">
            <select
              value={tts.voiceId}
              disabled={voices.length === 0}
              onChange={(e) => {
                const v = voices.find((x) => x.voiceId === e.target.value)
                if (v) setTts({ voiceId: v.voiceId, voiceName: v.name })
              }}
            >
              {voices.length === 0 && <option value="">{voicesLoading ? 'loading…' : 'no voices'}</option>}
              {voices.map((v) => (
                <option key={v.voiceId} value={v.voiceId}>
                  {v.name}
                  {v.accent ? ` · ${v.accent}` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="tool"
              title="preview this voice (free sample)"
              disabled={!selectedPreviewUrl}
              onClick={() => previewVoice(selectedPreviewUrl)}
            >
              ▶
            </button>
          </div>
        </label>
      </div>

      {isV3 ? (
        <label className="vtt-voice-field vtt-voice-prompt">
          <span>Direction</span>
          <textarea
            rows={2}
            spellCheck
            placeholder="e.g. [warmly] [slowly] — audio-tag delivery cues for the v3 model."
            value={tts.direction}
            onChange={(e) => setTts({ direction: e.target.value })}
          />
        </label>
      ) : (
        <div className="vtt-voice-sliders">
          <Slider label="Stability" value={tts.settings.stability} min={0} max={1} step={0.05} onChange={(v) => setSetting({ stability: v })} />
          <Slider label="Similarity" value={tts.settings.similarityBoost} min={0} max={1} step={0.05} onChange={(v) => setSetting({ similarityBoost: v })} />
          <Slider label="Style" value={tts.settings.style} min={0} max={1} step={0.05} onChange={(v) => setSetting({ style: v })} />
          <Slider label="Speed" value={tts.settings.speed} min={0.7} max={1.2} step={0.01} onChange={(v) => setSetting({ speed: v })} />
        </div>
      )}

      <p className="vtt-voice-hint muted">
        Synthesized with <b>ElevenLabs</b> — the accent comes from the voice (▶ previews it, free). {isV3
          ? 'v3 takes a free-text direction (audio-tag cues like [whispering]).'
          : 'Stability lower = more expressive; Style adds emphasis; Speed bakes in the pace.'}{' '}
        {voicesError && <span className="vtt-voice-warn">⚠ {voicesError}</span>}
      </p>
    </div>
  )

  return (
    <div className="vttview">
      <div className="vtt-head">
        <h3>Voiceover script (WebVTT)</h3>
        <div className="spacer" />
        <button onClick={onAdd}>+ Add cue</button>
        <button onClick={generateAll} disabled={anyGenerating || cues.length === 0 || noVoice}>
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

      {voicePanel}

      {sorted.length > 0 && (
        <ul className="cue-list">
          {sorted.map((c) => {
            const stale = isAudioStale(c)
            const voiceName = c.audio?.tts?.voiceName
            return (
              <li key={c.id} className={c.audio ? 'cue-row has-audio' : 'cue-row'}>
                <span className="cue-row-time">{formatTimestamp(c.startMs)}</span>
                <span className="cue-row-text" title={c.text}>
                  {c.text.replace(/\n/g, ' ') || '(empty)'}
                </span>
                {voiceName && (
                  <button
                    type="button"
                    className="tool cue-voice-btn"
                    title={`made with “${voiceName}” — click to use this clip's settings`}
                    onClick={() => useClipSettings(c)}
                  >
                    {voiceName.split(/\s[-–·]\s/)[0]}
                  </button>
                )}
                <span className={stale ? 'cue-audio-state stale' : c.audio ? 'cue-audio-state ok' : 'cue-audio-state none'}>
                  {busy[c.id] ? '…' : stale ? '♪ stale' : c.audio ? `♪ ${(c.audio.durationMs / 1000).toFixed(1)}s` : 'no audio'}
                </span>
                <button className="tool" disabled={!c.audio || busy[c.id]} onClick={() => play(c)} title="play">
                  ▶
                </button>
                <button className="tool" disabled={busy[c.id] || noVoice} onClick={() => generate(c)} title="generate / regenerate TTS">
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
        cue's generated audio across edits. Generating sets the cue's end time to the spoken length; the
        voice name on a clip is a button to reuse its exact settings.
      </p>
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label className="vtt-slider">
      <span className="vtt-slider-label">
        {label} <b>{value.toFixed(2)}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

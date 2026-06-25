import { formatTimestamp } from '@lib/project/vtt'
import type { VoiceoverCue } from '@lib/project/schema'

/**
 * Read-only voiceover extract shown beneath the slide in the Layout view. Cues
 * whose start falls within the slide's time window are highlighted; one cue of
 * context on each side is dimmed. (Editing happens in the VTT view.)
 */
export function SlideVttExtract({
  cues,
  startMs,
  endMs,
}: {
  cues: VoiceoverCue[]
  startMs: number
  endMs: number
}) {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs)
  const inRangeIdx = sorted.map((c, i) => ({ c, i })).filter(({ c }) => c.startMs >= startMs && c.startMs < endMs)

  let lo: number
  let hi: number
  if (inRangeIdx.length) {
    lo = inRangeIdx[0].i - 1
    hi = inRangeIdx[inRangeIdx.length - 1].i + 1
  } else {
    // no cues in range — show the nearest one before + after for context
    const before = sorted.filter((c) => c.startMs < startMs).length - 1
    lo = before
    hi = before + 1
  }
  const shown = sorted.map((c, i) => ({ c, i })).filter(({ i }) => i >= lo && i <= hi)

  return (
    <div className="vtt-extract">
      <div className="vtt-extract-head">
        Voiceover in range{' '}
        <span className="muted">
          {formatTimestamp(startMs)}–{formatTimestamp(endMs)}
        </span>
      </div>
      {shown.length === 0 ? (
        <div className="vtt-extract-empty">No voiceover yet — add cues in the VTT view.</div>
      ) : (
        <ul className="vtt-extract-list">
          {shown.map(({ c }) => {
            const active = c.startMs >= startMs && c.startMs < endMs
            return (
              <li key={c.id} className={active ? 'vtt-cue active' : 'vtt-cue dim'} title={c.text}>
                <span className="vtt-cue-time">{formatTimestamp(c.startMs)}</span>
                <span className="vtt-cue-text">{c.text.replace(/\n/g, ' ') || '(empty)'}</span>
                {c.audio && <span className="vtt-cue-audio" title="audio recorded">♪</span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

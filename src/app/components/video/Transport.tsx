import type { PlaybackEngine } from './usePlaybackEngine'

/**
 * The persistent playback transport, shown permanently under the editor canvas.
 * When idle (`active` false) the ▶ button starts project playback and the rest is
 * inert; while playing it drives the shared engine (pause/restart/scrub/loop) and
 * ■ Stop returns the canvas to the editing layout.
 */
export function Transport({
  engine,
  active,
  scopeLabel,
  speed,
  onSpeedChange,
  onPlayProject,
  onStop,
}: {
  engine: PlaybackEngine
  active: boolean
  scopeLabel?: string
  speed: number
  onSpeedChange: (v: number) => void
  onPlayProject: () => void
  onStop: () => void
}) {
  const { isPlaying, progress, totalMs, loop, setLoop, toggle, restart, scrub } = engine
  const shownTotal = active ? totalMs : 0
  return (
    <div className="transport">
      <div className="transport-row">
        <button
          onClick={() => (active ? toggle() : onPlayProject())}
          title={active ? (isPlaying ? 'pause' : 'play') : 'play the whole project'}
        >
          {active && isPlaying ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button onClick={restart} disabled={!active} title="restart">↺</button>
        <button onClick={onStop} disabled={!active} title="stop — back to editing">■ Stop</button>
        <input
          type="range"
          className="scrubber"
          min={0}
          max={Math.max(1, shownTotal)}
          step={1}
          value={Math.min(progress, shownTotal)}
          onChange={(e) => scrub(Number(e.target.value))}
          disabled={!active || shownTotal <= 0}
        />
        <span className="time">
          {(Math.min(progress, shownTotal) / 1000).toFixed(1)}s / {(shownTotal / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="transport-row transport-row2">
        {active ? (
          <span className="muted transport-scope">playing {scopeLabel ?? 'project'}</span>
        ) : (
          <span className="muted transport-scope">▶ plays the whole project · or play a single slide/textbox from its chip</span>
        )}
        <label className="toggle">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} disabled={!active} />
          Loop
        </label>
        <label className="speed-control">
          <span className="speed-label">
            speed <b>×{speed.toFixed(2)}</b> <span className="muted">(applies to the exported video)</span>
          </span>
          <input type="range" min={0.25} max={12} step={0.05} value={speed} onChange={(e) => onSpeedChange(Number(e.target.value))} />
        </label>
      </div>
    </div>
  )
}

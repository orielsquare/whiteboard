/**
 * Pure decision logic for scheduling a voiceover clip's <audio> against the preview
 * playback clock. Kept framework-free so it's unit-testable (the engine that owns
 * the rAF loop + the real <audio> elements lives in usePlaybackEngine).
 *
 * The key rule: trigger each cue exactly ONCE on entry (seek + play), then let it
 * play out — NEVER re-seek to chase the clock. Re-seeking mid-clip glitches the
 * audio, and re-seeking while the clip is still spinning up (play()/decode latency)
 * clips the BEGINNING — the bug this fixes. A small constant lag from start-up
 * latency is imperceptible; a clipped first word is not.
 */

/** A voiceover clip in the playback clock's time base (ms). */
export interface AudioCue {
  id: string
  startMs: number
  endMs: number
  url: string
}

export type AudioAction =
  | { kind: 'start'; seekTo: number } // seek to `seekTo` seconds, then play
  | { kind: 'pause' } // outside the cue window (or not playing) → pause + re-arm
  | { kind: 'none' } // already playing this cue → leave it alone

/**
 * Decide what to do with cue `c` at clock `t` (ms): `playing` is the transport
 * state, `started` is whether this cue was already triggered in the current pass.
 */
export function nextAudioAction(c: AudioCue, t: number, playing: boolean, started: boolean): AudioAction {
  const inWindow = playing && t >= c.startMs && t < c.endMs
  if (!inWindow) return { kind: 'pause' }
  if (started) return { kind: 'none' }
  const offset = (t - c.startMs) / 1000
  // A tiny offset = a frame elapsed while crossing the cue's start → play from 0 so
  // the very beginning isn't clipped. A large offset = playback resumed mid-cue (a
  // scrub or un-pause) → seek there so audio stays aligned with the visuals.
  return { kind: 'start', seekTo: offset < 0.1 ? 0 : offset }
}

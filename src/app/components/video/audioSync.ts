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
  /** the clip's natural END (startMs + the audio's real duration — NOT the shorter
   *  VTT/caption window). Bounds *triggering* so a far-ahead scrub doesn't start a
   *  finished clip; a clip that's already playing is left to finish on its own. */
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
  if (!playing) return { kind: 'pause' }
  if (started) {
    // Already triggered → let it play to its NATURAL end (the <audio> stops itself
    // when the clip finishes). Don't cut the tail at a fixed time — that clipped the
    // END. Only stop if the clock moved back before the cue (a scrub/loop), which
    // re-arms it to trigger again.
    return t < c.startMs ? { kind: 'pause' } : { kind: 'none' }
  }
  // Not started yet → trigger only within the clip's span [startMs, endMs); never
  // start a clip the clock has already advanced past (e.g. after scrubbing ahead).
  if (t < c.startMs || t >= c.endMs) return { kind: 'pause' }
  const offset = (t - c.startMs) / 1000
  // A tiny offset = a frame elapsed while crossing the cue's start → play from 0 so
  // the very beginning isn't clipped. A large offset = playback resumed mid-cue (a
  // scrub or un-pause) → seek there so audio stays aligned with the visuals.
  return { kind: 'start', seekTo: offset < 0.1 ? 0 : offset }
}

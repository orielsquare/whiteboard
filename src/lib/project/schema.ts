import type { BrushSettings } from '@lib/manifest/schema'
import type { StylePatch } from './runs'

/**
 * A "video project": a sequence of slides of animated handwritten text.
 * Geometry is proportional PER AXIS: `frame.x` and `frame.w` are fractions of
 * canvas WIDTH; `frame.y` is a fraction of canvas HEIGHT. A box's frame is stored
 * per aspect (`frame['16:9']` / `frame['9:16']`); when its position lock is on the
 * two are identical, so "matching" needs no transform — only the per-aspect
 * `× canvasW` (x,w) / `× canvasH` (y) at render time. See `aspect.ts` for the
 * `projectForAspect` seam that flattens a project to the single-aspect shape the
 * pure render/layout/timing pipeline consumes.
 */

export const PROJECT_VERSION = 2 as const

export type Aspect = '16:9' | '9:16'

/** The two independent per-textbox locks linking the 16:9 and 9:16 cuts.
 *  `position` links frame (x,y,w); `content` links runs/text/style. Stored once
 *  per logical box (a lock describes the relationship between the two cuts). */
export interface BoxLockState {
  position: boolean
  content: boolean
}

export const DEFAULT_LOCK: BoxLockState = { position: true, content: true }
export type TransitionKind = 'none' | 'fade' | 'rubout' | 'scroll-up' | 'scroll-down' | 'scroll-left' | 'scroll-right'
export type TextAlign = 'left' | 'center' | 'right'

/** A styled span of text within a textbox. */
export interface TextRun {
  text: string
  /** multiplier on the project base size (default 1). */
  sizeScale?: number
  /** overrides the global brush colour for this run (null/undefined = brush colour). */
  color?: string | null
  underline?: boolean
  /** extra tracking between glyphs in ems (kerning); default 0. */
  letterSpacing?: number
  /** font for this run (=== a saved font's id/hash); unset/'' = inherit the
   *  project default font (VideoProject.fontId). */
  fontId?: string
}

/** Normalized rect. `x` and `w` are fractions of canvas WIDTH; `y` is a fraction
 *  of canvas HEIGHT (both in [0,1]). `w = null` means no wrapping. */
export interface NormRect {
  x: number
  y: number
  w: number | null
}

/** Box content that MAY diverge between aspects when the content lock is off.
 *  Absent from a box until it actually diverges (Phase 4 — currently unused). */
export interface BoxContent {
  runs: TextRun[]
  align: TextAlign
  lineHeightScale: number
  brush?: BrushSettings
}

export interface TextBox {
  id: string
  /** per-aspect geometry; BOTH keys always present (equal while position-locked). */
  frame: Record<Aspect, NormRect>
  align: TextAlign
  runs: TextRun[]
  lineHeightScale: number
  /** animation order within the slide; kept contiguous 0..n-1. Always shared across aspects. */
  animOrder: number
  /** ms before this box starts, from the previous box's animation END (first box: from slide shown). Shared. */
  delayBeforeMs: number
  /** handwriting cadence between glyphs in this box. Shared. */
  interCharDelayMs: number
  /** per-box brush override; undefined = use the project brush. A run's colour still wins. */
  brush?: BrushSettings
  /** per-box lock override; undefined fields inherit slide then `project.lockDefault`. */
  lock?: Partial<BoxLockState>
  /** opt-in per-aspect content override (only when content-unlocked AND diverged; Phase 4). */
  contentByAspect?: Partial<Record<Aspect, BoxContent>>
}

export interface ClosingTransition {
  kind: TransitionKind
  durationMs: number
  ruboutMode?: 'reverse' | 'eraser'
}

/** A reusable named text style. `style` is a Partial run style: only the fields
 *  it sets are applied, so a style captured from a mixed selection (mixed fields
 *  omitted) neither bakes an arbitrary value nor overwrites those fields on apply. */
export interface NamedStyle {
  id: string
  name: string
  style: StylePatch
}

/** A placed drawing on a slide: references a SAVED drawing artifact (by id),
 *  positioned with a per-aspect frame, and animated in turn with the text via a
 *  shared `animOrder`. The per-part stacking (zOrder) lives inside the drawing
 *  itself; `animOrder` only decides when it draws relative to the textboxes. */
export interface SlideDrawing {
  id: string
  /** the saved drawing's id (=== DrawingManifest.metadata.drawingId). */
  drawingId: string
  /** cached display name (the live name still comes from the saved file). */
  name?: string
  /** per-aspect placement; `x`/`w` are fractions of canvas WIDTH, `y` a fraction
   *  of canvas HEIGHT (same convention as TextBox.frame). Height follows the
   *  drawing's viewBox aspect, so only width is stored. */
  frame: Record<Aspect, NormRect>
  /** animation order within the slide, SHARED with textBoxes (so a drawing can
   *  draw before/after/between text). Kept contiguous across boxes + drawings. */
  animOrder: number
  /** ms before this drawing starts, from the previous item's animation END. */
  delayBeforeMs: number
  /** per-drawing relative draw speed (×); >1 draws faster. Combines with the
   *  project playbackRate. Absent ⇒ 1. */
  speed?: number
}

export interface Slide {
  id: string
  background: string
  textBoxes: TextBox[]
  /** placed drawings (SVG animations) on this slide; share animOrder with textBoxes. */
  drawings?: SlideDrawing[]
  /** ms the finished slide holds before its closing transition begins. */
  holdBeforeTransitionMs: number
  transition: ClosingTransition
  /** slide-level lock override (the "lock/unlock all" target); per-box still wins. */
  lock?: Partial<BoxLockState>
}

export interface ProjectDefaults {
  /** default run size for new textboxes (the format bar edits this when nothing is selected). */
  sizeScale: number
  interCharDelayMs: number
  lineHeightScale: number
  delayBeforeMs: number
  holdBeforeTransitionMs: number
  transition: ClosingTransition
  /** default text alignment for new textboxes. */
  align: TextAlign
  /** default run colour for new textboxes (null = use the brush colour). */
  runColor: string | null
  /** default underline for new textboxes. */
  runUnderline: boolean
  /** default kerning (ems) for new textboxes. */
  runLetterSpacing: number
}

/** Generated/recorded audio for a voiceover cue. */
export interface VoiceoverAudio {
  /** file name under the project's voiceover dir (served via /api/voiceover). */
  file: string
  durationMs: number
  /** the full synthesis settings this clip was generated with — shown on the cue
   *  chip and reusable via "use these settings". */
  tts?: TtsSettings
  /** hash of the text the audio was generated from — staleness is **text-only**
   *  (a clip made with different voice/settings is NOT stale, just different). */
  textHash?: string
  /** bumped each (re)generation; appended to the audio URL so players reload the new clip. */
  version?: number
}

/** ElevenLabs voice settings (applied to v2/Flash/Turbo models). */
export interface TtsVoiceSettings {
  /** 0..1 — lower is more variable/expressive, higher is more consistent. */
  stability: number
  /** 0..1 — adherence to the original voice. */
  similarityBoost: number
  /** 0..1 — style exaggeration. */
  style: number
  /** 0.7..1.2 — playback rate baked into the synthesis. */
  speed: number
}

/** Project-wide voice-synthesis settings (ElevenLabs). */
export interface TtsSettings {
  /** ElevenLabs voice id (carries the accent). */
  voiceId: string
  /** display name for the chosen voice. */
  voiceName: string
  /** ElevenLabs model id (e.g. "eleven_multilingual_v2", "eleven_v3"). */
  model: string
  /** v3 only: a free-text delivery direction (audio-tag style cues) prepended to the text. */
  direction: string
  /** non-v3 models: ElevenLabs voice settings. */
  settings: TtsVoiceSettings
}

export const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2'
export const DEFAULT_TTS_VOICE_SETTINGS: TtsVoiceSettings = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  speed: 1,
}
export const DEFAULT_TTS: TtsSettings = {
  voiceId: '',
  voiceName: '',
  model: DEFAULT_TTS_MODEL,
  direction: '',
  settings: { ...DEFAULT_TTS_VOICE_SETTINGS },
}

/**
 * A timed voiceover snippet (WebVTT cue). Times are ABSOLUTE project real-time
 * (ms) and not linked to any slide/textbox — association is purely positional.
 */
export interface VoiceoverCue {
  id: string
  startMs: number
  endMs: number
  text: string
  audio?: VoiceoverAudio
}

export interface VideoProject {
  version: number
  id: string
  name: string
  /** the font this project animates with (=== LoadedFont.hash / manifest.metadata.fontId). */
  fontId: string
  /** default lock state new boxes inherit (and the floor of the box→slide→project resolution). */
  lockDefault: BoxLockState
  /** global texture; a textbox or run can override it. */
  brush: BrushSettings
  /** playback/export speed multiplier (1 = real time); scales the whole video's time. */
  playbackRate: number
  /** em height of a size-1 run as a fraction of canvas width. */
  baseEmFraction: number
  defaults: ProjectDefaults
  slides: Slide[]
  /** reusable named text styles (applied to a selection from the format bar). */
  namedStyles: NamedStyle[]
  /** project-wide voiceover track (absolute-time WebVTT cues). */
  voiceover: VoiceoverCue[]
  /** voice-synthesis settings for generating cue audio. */
  tts?: TtsSettings
  createdAt: string
  updatedAt: string
}

export const DEFAULT_TRANSITION: ClosingTransition = { kind: 'fade', durationMs: 600 }

export const DEFAULT_DEFAULTS: ProjectDefaults = {
  sizeScale: 1,
  interCharDelayMs: 55,
  lineHeightScale: 1.2,
  delayBeforeMs: 300,
  holdBeforeTransitionMs: 1000,
  transition: DEFAULT_TRANSITION,
  align: 'left',
  runColor: null,
  runUnderline: false,
  runLetterSpacing: 0,
}

export function makeId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'x-' + Math.random().toString(36).slice(2, 10)
  }
}

/** `x` is a fraction of width, `y` a fraction of HEIGHT (both stored identically
 *  across aspects — a fresh box is position-linked). */
export function newTextBox(defaults: ProjectDefaults, x: number, y: number, animOrder: number): TextBox {
  // Seed the starter run from the format defaults, omitting no-op default values
  // so the JSON stays minimal (matches runs.ts `styleOf`).
  const run: TextRun = { text: 'Text' }
  if (defaults.sizeScale !== 1) run.sizeScale = defaults.sizeScale
  if (defaults.runColor != null) run.color = defaults.runColor
  if (defaults.runUnderline) run.underline = true
  if (defaults.runLetterSpacing) run.letterSpacing = defaults.runLetterSpacing
  const rect: NormRect = { x, y, w: 0.7 }
  return {
    id: makeId(),
    frame: { '16:9': { ...rect }, '9:16': { ...rect } },
    align: defaults.align,
    runs: [run],
    lineHeightScale: defaults.lineHeightScale,
    animOrder,
    delayBeforeMs: defaults.delayBeforeMs,
    interCharDelayMs: defaults.interCharDelayMs,
  }
}

/** A freshly-placed drawing: position-linked across aspects (both frames equal),
 *  default delay, given the next animation slot. `w` is a width fraction. */
export function newSlideDrawing(
  drawingId: string,
  name: string,
  x: number,
  y: number,
  w: number,
  animOrder: number,
  delayBeforeMs = 300,
): SlideDrawing {
  const rect: NormRect = { x, y, w }
  return {
    id: makeId(),
    drawingId,
    name,
    frame: { '16:9': { ...rect }, '9:16': { ...rect } },
    animOrder,
    delayBeforeMs,
  }
}

export function newSlide(defaults: ProjectDefaults, withStarterBox = true): Slide {
  // y is a fraction of height; 0.39 ≈ the old 0.22 width-units position in 16:9.
  return {
    id: makeId(),
    background: '#0b0d11',
    textBoxes: withStarterBox ? [newTextBox(defaults, 0.12, 0.39, 0)] : [],
    holdBeforeTransitionMs: defaults.holdBeforeTransitionMs,
    transition: { ...defaults.transition },
  }
}

export function newVideoProject(fontId: string, brush: BrushSettings, isoNow: string): VideoProject {
  const defaults = { ...DEFAULT_DEFAULTS, transition: { ...DEFAULT_TRANSITION } }
  return {
    version: PROJECT_VERSION,
    id: makeId(),
    name: 'Untitled video',
    fontId,
    lockDefault: { ...DEFAULT_LOCK },
    brush: { ...brush },
    playbackRate: 1,
    baseEmFraction: 0.085,
    defaults,
    slides: [newSlide(defaults)],
    namedStyles: [],
    voiceover: [],
    tts: { ...DEFAULT_TTS },
    createdAt: isoNow,
    updatedAt: isoNow,
  }
}

import type { BrushSettings } from '@lib/manifest/schema'

/**
 * A "video project": a sequence of slides of animated handwritten text.
 * All geometry is normalized to canvas WIDTH (1.0 = full width; y is also in
 * width-units) so it is resolution- and aspect-independent. Pixels are derived
 * once per frame as `value × canvasW`.
 */

export const PROJECT_VERSION = 1 as const

export type Aspect = '16:9' | '9:16'
export type TransitionKind = 'none' | 'fade' | 'rubout' | 'scroll-up' | 'scroll-left'
export type TextAlign = 'left' | 'center' | 'right'

/** A styled span of text within a textbox. */
export interface TextRun {
  text: string
  /** multiplier on the project base size (default 1). */
  sizeScale?: number
  /** overrides the global brush colour for this run (null/undefined = brush colour). */
  color?: string | null
  underline?: boolean
}

/** Normalized rect; basis is canvas width. `w = null` means no wrapping. */
export interface NormRect {
  x: number
  y: number
  w: number | null
}

export interface TextBox {
  id: string
  frame: NormRect
  align: TextAlign
  runs: TextRun[]
  lineHeightScale: number
  /** animation order within the slide; kept contiguous 0..n-1. */
  animOrder: number
  /** ms before this box starts, from the previous box's animation END (first box: from slide shown). */
  delayBeforeMs: number
  /** handwriting cadence between glyphs in this box. */
  interCharDelayMs: number
  /** per-box brush override; undefined = use the project brush. A run's colour still wins. */
  brush?: BrushSettings
}

export interface ClosingTransition {
  kind: TransitionKind
  durationMs: number
  ruboutMode?: 'reverse' | 'eraser'
}

export interface Slide {
  id: string
  background: string
  textBoxes: TextBox[]
  /** ms the finished slide holds before its closing transition begins. */
  holdBeforeTransitionMs: number
  transition: ClosingTransition
}

export interface ProjectDefaults {
  sizeScale: number
  interCharDelayMs: number
  lineHeightScale: number
  delayBeforeMs: number
  holdBeforeTransitionMs: number
  transition: ClosingTransition
}

/** Generated/recorded audio for a voiceover cue. */
export interface VoiceoverAudio {
  /** file name under the project's voiceover dir (served via /api/voiceover). */
  file: string
  durationMs: number
  voice?: string
  /** the spoken accent this clip was generated with — detects staleness when it changes. */
  accent?: string
  /** the style prompt this clip was generated with — detects staleness when it changes. */
  prompt?: string
  /** hash of the text the audio was generated from — detects staleness after edits. */
  textHash?: string
  /** bumped each (re)generation; appended to the audio URL so players reload the new clip. */
  version?: number
}

/** Project-wide voice-synthesis settings (Gemini TTS on Vertex AI). */
export interface TtsSettings {
  /** prebuilt Gemini voice name (e.g. "Kore"). */
  voice: string
  /** spoken accent, woven into the synthesis instruction (e.g. "British", "Received Pronunciation"). */
  accent: string
  /** natural-language style instruction prepended to each cue's text (may be empty). */
  prompt: string
}

export const DEFAULT_TTS: TtsSettings = { voice: 'Kore', accent: 'British', prompt: '' }

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
  aspect: Aspect
  /** global texture; a textbox or run can override it. */
  brush: BrushSettings
  /** playback/export speed multiplier (1 = real time); scales the whole video's time. */
  playbackRate: number
  /** em height of a size-1 run as a fraction of canvas width. */
  baseEmFraction: number
  defaults: ProjectDefaults
  slides: Slide[]
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
}

export function makeId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'x-' + Math.random().toString(36).slice(2, 10)
  }
}

export function newTextBox(defaults: ProjectDefaults, x: number, y: number, animOrder: number): TextBox {
  return {
    id: makeId(),
    frame: { x, y, w: 0.7 },
    align: 'left',
    runs: [{ text: 'Text' }],
    lineHeightScale: defaults.lineHeightScale,
    animOrder,
    delayBeforeMs: defaults.delayBeforeMs,
    interCharDelayMs: defaults.interCharDelayMs,
  }
}

export function newSlide(defaults: ProjectDefaults, withStarterBox = true): Slide {
  return {
    id: makeId(),
    background: '#0b0d11',
    textBoxes: withStarterBox ? [newTextBox(defaults, 0.12, 0.22, 0)] : [],
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
    aspect: '16:9',
    brush: { ...brush },
    playbackRate: 1,
    baseEmFraction: 0.085,
    defaults,
    slides: [newSlide(defaults)],
    voiceover: [],
    tts: { ...DEFAULT_TTS },
    createdAt: isoNow,
    updatedAt: isoNow,
  }
}

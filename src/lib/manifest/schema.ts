import type { EasingName } from '@lib/geometry/easing'
import type { ExtractionParams } from '@lib/extraction/types'

/**
 * The editable Font Animator manifest. Geometry (the centerline points + width)
 * is the immutable extraction output; editorial intent (order, direction,
 * timing, pauses) lives alongside as flags applied at evaluate time, so editing
 * is lossless and re-openable. All coordinates are font design units (y-down,
 * baseline at y=0), matching the extraction output.
 */

export const MANIFEST_VERSION = 1 as const

export type BrushStyle = 'chalk' | 'ink' | 'marker'
export type NibModel = 'round' | 'chisel'
export type CapStyle = 'flat' | 'round' | 'ragged'
export type SectionKind = 'line' | 'curve' | 'loop'

export interface Bbox {
  x: number
  y: number
  w: number
  h: number
}

/** A centerline point carrying the pen width at that point (design units). */
export interface StrokePoint {
  x: number
  y: number
  width: number
}

/** A hold partway through drawing a section. */
export interface MidPause {
  atProgress: number // 0..1 along the drawn length
  holdMs: number
}

export interface SectionTiming {
  durationMs: number
  delayBeforeMs: number
  easing: EasingName
  pauses: MidPause[]
}

/** One pen-stroke section: immutable geometry + editorial intent. */
export interface StrokeSection {
  id: string
  points: StrokePoint[]
  kind: SectionKind
  orderIndex: number
  reversed: boolean
  timing: SectionTiming
}

export interface GlyphAnimation {
  unicode: number
  char: string
  advanceWidth: number
  bbox: Bbox
  sections: StrokeSection[]
  reviewed: boolean
  /** true once the user has manually edited the glyph; protects it from auto re-derivation. */
  edited?: boolean
  /** signature of the extraction params this glyph was derived from (extractionSig). */
  derivedSig?: string
  /** Per-glyph extraction settings (tuned in the Stroke extraction tab, persisted with
   *  the manifest). Absent ⇒ this glyph uses DEFAULT_PARAMS. */
  extractionParams?: ExtractionParams
}

/** Deterministic, fully describes the look so headless render matches preview. */
export interface BrushSettings {
  style: BrushStyle
  color: string
  sizeScale: number
  opacity: number
  jitter: number
  nibModel: NibModel
  nibAngle?: number
  cap: CapStyle
  seed: number
}

export interface FontMetadata {
  fontId: string
  family: string
  fileName: string
  hash: string
  unitsPerEm: number
  ascender: number
  descender: number
  /** The font's space-glyph advance (design units); absent in older manifests. */
  spaceAdvance?: number
  /** Cosmetic, user-facing name (rename), decoupled from the content-hash id.
   *  Defaults to `family` when unset. */
  name?: string
}

/** Top-level editable artifact: one JSON file = one font's animation treatment. */
export interface FontManifest {
  version: number
  metadata: FontMetadata
  defaultTiming: SectionTiming
  glyphs: Record<string, GlyphAnimation>
  createdAt: string
  updatedAt: string
}

export const DEFAULT_TIMING: SectionTiming = {
  durationMs: 600,
  delayBeforeMs: 110,
  easing: 'cubicInOut',
  pauses: [],
}

export const DEFAULT_BRUSH: BrushSettings = {
  style: 'ink',
  color: '#f4f4f5',
  sizeScale: 1,
  opacity: 1,
  jitter: 0,
  nibModel: 'round',
  cap: 'round',
  seed: 1337,
}

import { aspectHeightUnits } from './coords'
import type {
  Aspect,
  BoxContent,
  BoxLockState,
  NormRect,
  Slide,
  TextBox,
  VideoProject,
} from './schema'
import { DEFAULT_DEFAULTS, DEFAULT_LOCK, PROJECT_VERSION } from './schema'

/**
 * Dual-aspect seam. A project stores each textbox's geometry per aspect
 * (`frame['16:9']` / `frame['9:16']`) with `y` as a fraction of HEIGHT. The pure
 * render/layout/timing pipeline, the editor canvases and the headless exporter
 * all consume a single-aspect ("flat") shape where `frame` is one `NormRect` with
 * `y` back in WIDTH-units (so the existing `× canvasW` math is unchanged).
 * `projectForAspect` is the one place that conversion happens.
 *
 * y conversion: stored `y` (fraction of height) × `aspectHeightUnits(aspect)` =
 * width-units y; the pipeline then multiplies by `canvasW` to get pixels, i.e.
 * `y_frac × aspectHeightUnits × canvasW = y_frac × canvasH`.
 */

export { aspectHeightUnits } from './coords'

/** The two aspects, in canonical order. */
export const ASPECTS: Aspect[] = ['16:9', '9:16']
/** The other aspect of a pair. */
export const otherAspect = (a: Aspect): Aspect => (a === '16:9' ? '9:16' : '16:9')

/** A textbox flattened to one aspect: `frame` is a single width-units `NormRect`. */
export type FlatBox = Omit<TextBox, 'frame'> & { frame: NormRect }
export type FlatSlide = Omit<Slide, 'textBoxes'> & { textBoxes: FlatBox[] }
/** A single-aspect project: the legacy shape the pure pipeline + exporter take.
 *  Carries `aspect` so canvas-sizing code can read it. */
export type FlatProject = Omit<VideoProject, 'slides'> & { slides: FlatSlide[]; aspect: Aspect }

/** Stored per-aspect frame → flattened width-units frame for `aspect`. */
export function frameOf(box: TextBox, aspect: Aspect): NormRect {
  const f = box.frame[aspect]
  return { x: f.x, y: f.y * aspectHeightUnits(aspect), w: f.w }
}

/** The effective content (runs/align/line-height/brush) for `aspect`: the
 *  per-aspect override if the box's format diverged, else the shared base. */
export function contentOf(box: TextBox, aspect: Aspect): BoxContent {
  return (
    box.contentByAspect?.[aspect] ?? {
      runs: box.runs,
      align: box.align,
      lineHeightScale: box.lineHeightScale,
      brush: box.brush,
    }
  )
}

/** A flattened box for `aspect`: width-units frame + the per-aspect content
 *  folded onto the shared fields, so layout/render/export see the right cut. */
export function boxForAspect(box: TextBox, aspect: Aspect): FlatBox {
  return { ...box, frame: frameOf(box, aspect), ...contentOf(box, aspect) }
}

/** A flattened slide for `aspect`. */
export function flattenSlide(slide: Slide, aspect: Aspect): FlatSlide {
  return { ...slide, textBoxes: slide.textBoxes.map((b) => boxForAspect(b, aspect)) }
}

/** Flatten a whole project to its single-aspect shape (the pipeline/export seam). */
export function projectForAspect(p: VideoProject, aspect: Aspect): FlatProject {
  return { ...p, aspect, slides: p.slides.map((s) => flattenSlide(s, aspect)) }
}

/** Inverse of `frameOf`'s y: editor width-units y → stored fraction-of-height. */
export function toStoredY(yWidthUnits: number, aspect: Aspect): number {
  return yWidthUnits / aspectHeightUnits(aspect)
}

/** Resolve a box's effective lock: box → slide → project default. */
export function effLock(p: VideoProject, slide: Slide, box: TextBox): BoxLockState {
  const def = p.lockDefault ?? DEFAULT_LOCK
  return {
    position: box.lock?.position ?? slide.lock?.position ?? def.position,
    content: box.lock?.content ?? slide.lock?.content ?? def.content,
  }
}

/**
 * Load-time migration + defensive defaulting. Returns the v2 project AND the
 * aspect it was authored in (the active aspect is transient, not stored on the
 * document). v1 projects stored a single `frame` with `y` in WIDTH-units against
 * `raw.aspect`; convert to per-aspect frames with `y` as a fraction of height
 * (the same value in both cuts — a migrated box is position-linked). Detection is
 * VERSION-keyed (never frame-shape), so a projected/flattened box can never
 * double-migrate. Pure + framework-free: shared by the editor store and the
 * headless exporter so the migrator matches live exactly.
 */
export function migrateProject(raw: VideoProject): { project: VideoProject; aspect: Aspect } {
  const r = raw as VideoProject & { aspect?: Aspect; version?: number }
  const savedAspect: Aspect = r.aspect === '9:16' ? '9:16' : '16:9'
  let slides = r.slides ?? []
  if (!r.version || r.version < 2) {
    const H = aspectHeightUnits(savedAspect)
    slides = slides.map((s) => ({
      ...s,
      textBoxes: (s.textBoxes ?? []).map((b) => {
        const f = (b as unknown as { frame: NormRect }).frame ?? { x: 0.1, y: 0.1, w: 0.7 }
        const rect: NormRect = { x: f.x, y: f.y / H, w: f.w ?? null }
        return { ...b, frame: { '16:9': { ...rect }, '9:16': { ...rect } } }
      }),
    }))
  }
  const project: VideoProject = {
    ...r,
    version: PROJECT_VERSION,
    defaults: { ...DEFAULT_DEFAULTS, ...r.defaults },
    namedStyles: r.namedStyles ?? [],
    lockDefault: r.lockDefault ?? { ...DEFAULT_LOCK },
    slides,
  }
  delete (project as Partial<VideoProject> & { aspect?: Aspect }).aspect
  return { project, aspect: savedAspect }
}

const EPS = 0.002
/** Whether a box's two cuts differ in geometry (the position lock is "broken"). */
export function framesDiverge(box: TextBox): boolean {
  const a = box.frame['16:9']
  const b = box.frame['9:16']
  const wDiff = (a.w == null) !== (b.w == null) || (a.w != null && b.w != null && Math.abs(a.w - b.w) > EPS)
  return Math.abs(a.x - b.x) > EPS || Math.abs(a.y - b.y) > EPS || wDiff
}

const contentKey = (c: BoxContent): string =>
  JSON.stringify([c.runs, c.align, c.lineHeightScale, c.brush ?? null])
/** Whether a box's two cuts differ in formatted content (the format lock is "broken"). */
export function contentsDiverge(box: TextBox): boolean {
  if (!box.contentByAspect) return false
  return contentKey(contentOf(box, '16:9')) !== contentKey(contentOf(box, '9:16'))
}

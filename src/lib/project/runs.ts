import type { TextRun } from './schema'

/**
 * Pure, immutable helpers for editing a textbox's styled runs (mirrors
 * `manifest/edit.ts`). Selection is expressed as **offsets into the flattened
 * plain-text string**; those offsets are converted into run splits only at apply
 * time, so nothing caches a fragile runs↔selection map. Every mutation runs
 * through `normalizeRuns` (drop empty + merge adjacent equal-style).
 */

/** The style-only patch the UI applies to a selection. */
export type StylePatch = Partial<Pick<TextRun, 'sizeScale' | 'color' | 'underline' | 'letterSpacing' | 'fontId'>>

/** Resolved style with defaults filled in (for UI display). */
export interface ResolvedStyle {
  sizeScale: number
  color: string | null
  underline: boolean
  /** extra tracking between glyphs, in ems (kerning). 0 = normal. */
  letterSpacing: number
  /** per-run font id, or null = inherit the project default font. */
  fontId: string | null
}

/** Sentinel for a field that has more than one value across a selection. */
export const MIXED = Symbol('mixed')
export type Maybe<T> = T | typeof MIXED

/** Per-field resolved style across a selection — a field is `MIXED` when the
 *  covered runs disagree. Drives the format bar's synced/indeterminate display
 *  and "save a named style ignoring the mixed parts". */
export interface SelectionStyle {
  sizeScale: Maybe<number>
  color: Maybe<string | null>
  underline: Maybe<boolean>
  letterSpacing: Maybe<number>
  fontId: Maybe<string | null>
}

export function runsToPlainText(runs: TextRun[]): string {
  let s = ''
  for (const r of runs) s += r.text
  return s
}

/** Canonical key of a run's style (text-independent), for equality + merging.
 *  EVERY style field must appear here or adjacent runs differing only in that
 *  field will wrongly merge in normalizeRuns. */
export function styleKey(run: TextRun): string {
  const sizeScale = run.sizeScale ?? 1
  const color = run.color ?? ''
  const underline = run.underline ? 1 : 0
  const letterSpacing = run.letterSpacing ?? 0
  const fontId = run.fontId ?? ''
  return `${sizeScale}|${color}|${underline}|${letterSpacing}|${fontId}`
}

/** Style fields of a run, with defaults dropped so the JSON stays minimal. */
function styleOf(run: TextRun): Omit<TextRun, 'text'> {
  const s: Omit<TextRun, 'text'> = {}
  const ss = run.sizeScale ?? 1
  if (ss !== 1) s.sizeScale = ss
  const color = run.color ?? null
  if (color != null && color !== '') s.color = color
  if (run.underline) s.underline = true
  if (run.letterSpacing) s.letterSpacing = run.letterSpacing
  if (run.fontId) s.fontId = run.fontId
  return s
}

/** A new run with `run`'s (canonicalized) style and the given text. */
function mk(run: TextRun, text: string): TextRun {
  return { ...styleOf(run), text }
}

/** Drop empty runs and merge adjacent runs with identical style. Never returns []. */
export function normalizeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = []
  for (const r of runs) {
    if (r.text.length === 0) continue
    const last = out[out.length - 1]
    if (last && styleKey(last) === styleKey(r)) {
      out[out.length - 1] = { ...last, text: last.text + r.text }
    } else {
      out.push(mk(r, r.text))
    }
  }
  if (out.length === 0) {
    // Preserve the leading style so re-typing keeps the look after a full delete.
    return [runs[0] ? mk(runs[0], '') : { text: '' }]
  }
  return out
}

/** Return runs with a guaranteed boundary at `offset` (a run is split if needed). */
export function splitRunAt(runs: TextRun[], offset: number): TextRun[] {
  const out: TextRun[] = []
  let pos = 0
  for (const r of runs) {
    const len = r.text.length
    if (offset > pos && offset < pos + len) {
      const a = offset - pos
      out.push(mk(r, r.text.slice(0, a)))
      out.push(mk(r, r.text.slice(a)))
    } else {
      out.push(mk(r, r.text))
    }
    pos += len
  }
  return out
}

/** Apply `patch` to the runs covering [start, end) (string offsets). Immutable. */
export function applyStyleToRange(
  runs: TextRun[],
  start: number,
  end: number,
  patch: StylePatch,
): TextRun[] {
  const total = runsToPlainText(runs).length
  const s = Math.max(0, Math.min(start, end))
  const e = Math.min(total, Math.max(start, end))
  if (e <= s) return normalizeRuns(runs)

  let split = splitRunAt(runs, s)
  split = splitRunAt(split, e)

  const out: TextRun[] = []
  let pos = 0
  for (const r of split) {
    const len = r.text.length
    if (len > 0 && pos >= s && pos + len <= e) {
      const merged: TextRun = { ...styleOf(r), ...patch, text: r.text }
      out.push(mk(merged, r.text))
    } else {
      out.push(r)
    }
    pos += len
  }
  return normalizeRuns(out)
}

/**
 * Replace the plain text while preserving styles: diff old vs new by common
 * prefix/suffix; the changed middle inherits the boundary run's style (left if
 * present, else right). Immutable.
 */
export function setPlainTextPreservingStyles(runs: TextRun[], nextText: string): TextRun[] {
  const prev = runsToPlainText(runs)
  if (prev === nextText) return normalizeRuns(runs)

  let p = 0
  while (p < prev.length && p < nextText.length && prev[p] === nextText[p]) p++
  let suf = 0
  while (suf < prev.length - p && suf < nextText.length - p && prev[prev.length - 1 - suf] === nextText[nextText.length - 1 - suf]) suf++

  const deleteEnd = prev.length - suf
  const inserted = nextText.slice(p, nextText.length - suf)

  let split = splitRunAt(runs, p)
  split = splitRunAt(split, deleteEnd)

  const before: TextRun[] = []
  const after: TextRun[] = []
  let styleBefore: Omit<TextRun, 'text'> | null = null
  let styleAfter: Omit<TextRun, 'text'> | null = null
  let pos = 0
  for (const r of split) {
    const len = r.text.length
    if (pos + len <= p) {
      before.push(r)
      if (len > 0) styleBefore = styleOf(r)
    } else if (pos >= deleteEnd) {
      after.push(r)
      if (styleAfter === null && len > 0) styleAfter = styleOf(r)
    }
    // runs strictly inside [p, deleteEnd) are deleted
    pos += len
  }

  const midStyle = styleBefore ?? styleAfter ?? {}
  const result: TextRun[] = [...before]
  if (inserted.length > 0) result.push({ ...midStyle, text: inserted })
  result.push(...after)
  return normalizeRuns(result)
}

/** Resolved style at a string offset (the run containing that char). For UI. */
export function runStyleAt(runs: TextRun[], offset: number): ResolvedStyle {
  let pos = 0
  let last: TextRun | undefined
  for (const r of runs) {
    if (r.text.length === 0) continue
    last = r
    if (offset < pos + r.text.length) return resolved(r)
    pos += r.text.length
  }
  return resolved(last ?? { text: '' })
}

function resolved(r: TextRun): ResolvedStyle {
  return {
    sizeScale: r.sizeScale ?? 1,
    color: r.color ?? null,
    underline: !!r.underline,
    letterSpacing: r.letterSpacing ?? 0,
    fontId: r.fontId && r.fontId.length ? r.fontId : null,
  }
}

/**
 * Resolve the style across [start, end), reporting each field as either its
 * common value or `MIXED`. A collapsed range (caret) returns the single-offset
 * insertion style (never MIXED). Comparison is on *resolved* values so two runs
 * that are both "default size" don't read as mixed. `color: null` (use the brush
 * colour) is a legitimate shared value — only genuinely-differing colours mix.
 */
export function selectionStyle(runs: TextRun[], start: number, end: number): SelectionStyle {
  const total = runsToPlainText(runs).length
  const s = Math.max(0, Math.min(start, end))
  const e = Math.min(total, Math.max(start, end))
  const single = (): SelectionStyle => {
    const r = runStyleAt(runs, s)
    return { sizeScale: r.sizeScale, color: r.color, underline: r.underline, letterSpacing: r.letterSpacing, fontId: r.fontId }
  }
  if (e <= s) return single()

  let acc: SelectionStyle | null = null
  let pos = 0
  for (const r of runs) {
    const len = r.text.length
    if (len === 0) continue
    const runStart = pos
    const runEnd = pos + len
    pos = runEnd
    if (runEnd <= s || runStart >= e) continue // no overlap with the selection
    const rs = resolved(r)
    if (acc === null) {
      acc = { sizeScale: rs.sizeScale, color: rs.color, underline: rs.underline, letterSpacing: rs.letterSpacing, fontId: rs.fontId }
    } else {
      if (acc.sizeScale !== MIXED && acc.sizeScale !== rs.sizeScale) acc.sizeScale = MIXED
      if (acc.color !== MIXED && acc.color !== rs.color) acc.color = MIXED
      if (acc.underline !== MIXED && acc.underline !== rs.underline) acc.underline = MIXED
      if (acc.letterSpacing !== MIXED && acc.letterSpacing !== rs.letterSpacing) acc.letterSpacing = MIXED
      if (acc.fontId !== MIXED && acc.fontId !== rs.fontId) acc.fontId = MIXED
    }
  }
  return acc ?? single()
}

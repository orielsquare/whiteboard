import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Aspect, TextBox } from '@lib/project/schema'
import { aspectWidthFraction } from '@lib/project/coords'
import { contentOf, frameOf } from '@lib/project/aspect'
import { runsToPlainText, setPlainTextPreservingStyles } from '@lib/project/runs'
import { useVideoStore } from '../../state/videoStore'
import { ensureFontFaceById, fontFamilyFor, registerFontFace } from './fontFaces'

const FALLBACK_FAMILY = 'system-ui, sans-serif'

// The overlay currently mounted (at most one). Lets focus-stealing format
// controls (font/colour/style selects) return focus + the selection to it.
let activeOverlay: { el: HTMLElement; boxId: string } | null = null
export function restoreOverlaySelection(): void {
  const a = activeOverlay
  if (!a) return
  requestAnimationFrame(() => {
    if (!activeOverlay || activeOverlay.el !== a.el) return
    a.el.focus()
    const st = useVideoStore.getState().selection
    if (st && st.boxId === a.boxId) applySelection(a.el, st.anchor, st.focus)
  })
}

/**
 * Direct on-canvas text editor: a contentEditable positioned over the box that
 * the user is editing, rendering one styled <span> per run with the real font.
 * It owns its DOM children imperatively (React renders an empty editable), so a
 * typing burst doesn't rebuild the DOM and the caret stays put. Text/style still
 * round-trips through the pure `runs.ts` engine via the store.
 *
 * Selection is expressed as offsets into the flattened plain text (the same
 * space runs.ts uses), mapped to/from the DOM with Range. Newlines and pastes
 * are intercepted so the DOM never grows <br>/block nodes (which would desync
 * the offsets).
 */
export function TextBoxOverlay({
  box,
  aspect,
  slideId,
  canvasEl,
  baseEmFraction,
  lineHeightEm,
  brushColor,
  editorFontId,
  editorFontBuffer,
  defaultFontId,
  onExit,
}: {
  box: TextBox
  /** the active aspect, to resolve the box's per-aspect frame for positioning. */
  aspect: Aspect
  slideId: string
  canvasEl: HTMLCanvasElement | null
  baseEmFraction: number
  /** font line-box height in ems ((asc+|desc|)/upm); CSS line-height = this × lineHeightScale,
   *  so the overlay's line spacing matches the canvas. */
  lineHeightEm: number
  brushColor: string
  /** the Font-tab font's id + bytes (registered directly for its @font-face). */
  editorFontId: string
  editorFontBuffer: ArrayBuffer
  /** the project default font, used when a run has no fontId. */
  defaultFontId: string
  onExit: () => void
}) {
  const updateTextBoxRuns = useVideoStore((s) => s.updateTextBoxRuns)
  const setSelection = useVideoStore((s) => s.setSelection)

  // Resolve a run's font to a registered @font-face family (per run), kicking off
  // registration if needed (editor font from bytes, others fetched by id).
  const familyForRun = (fontId?: string): string => {
    const fid = fontId || defaultFontId
    if (fid === editorFontId) registerFontFace(fid, editorFontBuffer)
    else void ensureFontFaceById(fid)
    return `${fontFamilyFor(fid)}, ${FALLBACK_FAMILY}`
  }

  const elRef = useRef<HTMLDivElement | null>(null)
  // True while committing our own typing — the runs-effect then skips the DOM
  // rebuild (the browser already holds the new text), so the caret doesn't jump.
  const selfEditRef = useRef(false)
  // A flat caret offset to restore after a model-driven rebuild (Enter/paste).
  const pendingCaretRef = useRef<number | null>(null)
  const didFocusRef = useRef(false)
  // True during a model-driven DOM rebuild + the frame after it. `replaceChildren`
  // momentarily collapses the DOM selection before we restore it; without this
  // guard that transient collapse can be recorded to the store (via selectionchange)
  // and then "restored" as a caret on the next format change — the recurring
  // selection-collapse bug. The layoutEffect sets the authoritative selection, so
  // ignoring selectionchange in this window loses nothing.
  const rebuildingRef = useRef(false)

  // Edit the ACTIVE aspect's content (which may diverge from the shared base when
  // the box's format lock is off).
  const content = contentOf(box, aspect)

  // The canvas client width drives positioning + base font size (everything is
  // normalized to canvas width). Re-measure on canvas/window resize.
  const [clientW, setClientW] = useState(() => canvasEl?.clientWidth ?? 0)
  useEffect(() => {
    if (!canvasEl) return
    const update = () => setClientW(canvasEl.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(canvasEl)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [canvasEl])

  // Rebuild the styled spans from the runs (imperative — React owns no children).
  const syncDom = (el: HTMLElement) => {
    el.replaceChildren(
      ...content.runs.map((r, i) => {
        const span = document.createElement('span')
        span.setAttribute('data-run', String(i))
        const sizeScale = r.sizeScale ?? 1
        span.style.fontSize = `${sizeScale}em` // relative to the container's base px
        span.style.color = r.color ?? brushColor
        span.style.textDecoration = r.underline ? 'underline' : 'none'
        const ls = r.letterSpacing ?? 0
        span.style.letterSpacing = ls ? `${ls}em` : ''
        span.style.fontFamily = familyForRun(r.fontId)
        span.textContent = r.text
        return span
      }),
    )
  }

  // Rebuild + restore caret on any model-driven runs change (format apply, undo,
  // Enter/paste). Skipped for our own keystroke commits (selfEditRef).
  useLayoutEffect(() => {
    if (selfEditRef.current) {
      selfEditRef.current = false
      return
    }
    const el = elRef.current
    if (!el) return
    rebuildingRef.current = true
    syncDom(el)
    const len = runsToPlainText(content.runs).length
    let a = len
    let f = len
    const pc = pendingCaretRef.current
    if (pc != null) {
      a = f = Math.min(pc, len)
      pendingCaretRef.current = null
    } else {
      const st = useVideoStore.getState().selection
      if (st && st.boxId === box.id) {
        a = Math.min(st.anchor, len)
        f = Math.min(st.focus, len)
      }
    }
    if (!didFocusRef.current) {
      el.focus()
      didFocusRef.current = true
    }
    applySelection(el, a, f)
    // Release the guard after this turn's selectionchange events have flushed.
    requestAnimationFrame(() => {
      rebuildingRef.current = false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.runs])

  // Mirror the DOM selection into the store while this overlay is focused.
  useEffect(() => {
    const onSelChange = () => {
      const el = elRef.current
      const sel = window.getSelection()
      if (!el || !sel || sel.rangeCount === 0) return
      // Ignore the transient selection churn while we rebuild the spans (the
      // layoutEffect sets the real selection); recording it would clobber the range.
      if (rebuildingRef.current) return
      // Only record the selection while WE are focused. Otherwise a focus-stealing
      // format control (font/style select, colour picker) blurs the overlay, which
      // collapses the DOM selection and would otherwise clobber the real range.
      if (document.activeElement !== el) return
      const r = sel.getRangeAt(0)
      if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return
      setSelection({
        boxId: box.id,
        anchor: flatOffset(el, sel.anchorNode!, sel.anchorOffset),
        focus: flatOffset(el, sel.focusNode!, sel.focusOffset),
      })
    }
    document.addEventListener('selectionchange', onSelChange)
    return () => document.removeEventListener('selectionchange', onSelChange)
  }, [box.id, setSelection])

  // Publish this as the active overlay so focus-stealing format controls (font /
  // colour / style selects) can return focus + the selection after applying.
  useEffect(() => {
    const el = elRef.current
    if (el) activeOverlay = { el, boxId: box.id }
    return () => {
      if (activeOverlay && activeOverlay.el === elRef.current) activeOverlay = null
    }
  }, [box.id])

  const onInput = () => {
    const el = elRef.current
    if (!el) return
    selfEditRef.current = true
    updateTextBoxRuns(slideId, box.id, setPlainTextPreservingStyles(content.runs, el.textContent ?? ''))
  }

  // Insert a literal string at the live selection, committing through the model
  // (so the DOM rebuilds with no stray <br>/block nodes). Used by Enter + paste.
  const replaceSelectionWith = (str: string) => {
    const el = elRef.current
    const sel = window.getSelection()
    if (!el || !sel || sel.rangeCount === 0) return
    const r = sel.getRangeAt(0)
    const s = flatOffset(el, r.startContainer, r.startOffset)
    const e = flatOffset(el, r.endContainer, r.endOffset)
    const lo = Math.min(s, e)
    const hi = Math.max(s, e)
    const text = el.textContent ?? ''
    const next = text.slice(0, lo) + str + text.slice(hi)
    pendingCaretRef.current = lo + str.length
    updateTextBoxRuns(slideId, box.id, setPlainTextPreservingStyles(content.runs, next))
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      replaceSelectionWith('\n')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onExit()
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    replaceSelectionWith(e.clipboardData.getData('text/plain'))
  }

  const f = frameOf(box, aspect)
  const noWrap = f.w == null
  // Font basis is the 16:9-equivalent width (aspect-invariant), so the overlay's
  // type matches the canvas (which sizes fonts against BACKING_W, not the narrower
  // portrait width). Position/width use clientW directly (fractions of width).
  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${f.x * clientW}px`,
    top: `${f.y * clientW}px`,
    width: noWrap ? 'max-content' : `${f.w! * clientW}px`,
    fontSize: `${(baseEmFraction * clientW) / aspectWidthFraction(aspect)}px`,
    lineHeight: lineHeightEm * content.lineHeightScale,
    textAlign: content.align,
    fontFamily: FALLBACK_FAMILY, // per-run families are set on each span
    color: brushColor,
  }

  return (
    <div
      ref={elRef}
      className="tb-overlay"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      style={style}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  )
}

/** Flat plain-text offset of a DOM (node, offset) position within `root`. */
function flatOffset(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange()
  range.selectNodeContents(root)
  try {
    range.setEnd(node, offset)
  } catch {
    return 0
  }
  return range.toString().length
}

/** Apply a flat-offset [start, end] selection to `root` via the window selection. */
function applySelection(root: HTMLElement, start: number, end: number): void {
  const sel = window.getSelection()
  if (!sel) return
  const a = domPointAt(root, start)
  const b = domPointAt(root, end)
  const range = document.createRange()
  range.setStart(a.node, a.offset)
  range.setEnd(b.node, b.offset)
  sel.removeAllRanges()
  sel.addRange(range)
}

/** Map a flat plain-text offset to a DOM (textNode, offset) position in `root`. */
function domPointAt(root: HTMLElement, flat: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let acc = 0
  let last: Text | null = null
  let n: Node | null
  while ((n = walker.nextNode())) {
    const t = n as Text
    if (flat <= acc + t.length) return { node: t, offset: flat - acc }
    acc += t.length
    last = t
  }
  if (last) return { node: last, offset: last.length }
  return { node: root, offset: 0 }
}

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { LoadedFont } from '@lib/font/load'
import { aspectHeightUnits, canvasSize } from '@lib/project/coords'
import { contentOf, flattenSlide, framesDiverge, projectForAspect, type FlatBox, type FlatDrawing } from '@lib/project/aspect'
import { fontFor, type FontSet, type TextBoxLayout } from '@lib/project/layout'
import {
  drawingHeightPx,
  drawingMinHalfWidth,
  drawingTransform,
  renderPreparedDrawing,
  type DrawingSet,
} from '@lib/drawing/render'
import { buildRenderContext, renderProject, renderSlide, renderTextBox } from '@lib/project/render'
import { elementSlot } from '@lib/project/timing'
import { coerceInkPoints, inkBounds, inkHitDistance, renderInk, INK_BASE_WIDTH } from '@lib/project/ink'
import type { InkPoint, InkTool } from '@lib/project/schema'
import { useVideoStore } from '../../state/videoStore'
import { clientToNorm, drawSelection, hitTest, previewCanvasW, type NormPoint } from './layoutCanvas'
import { FormatBar } from './FormatBar'
import { TextBoxOverlay } from './TextBoxOverlay'
import { Transport } from './Transport'
import { usePlaybackEngine, type AudioCue } from './usePlaybackEngine'
import { cueAudioUrl } from './VttView'
import { registerFontFace } from './fontFaces'

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
/** Clamp a width-units y to the visible canvas extent for the aspect [0, H]. */
const clampY = (v: number, aspect: '16:9' | '9:16') => {
  const m = aspectHeightUnits(aspect)
  return v < 0 ? 0 : v > m ? m : v
}
const EMPTY_LAYOUTS: Map<string, TextBoxLayout> = new Map()

/** A dashed selection ring around a placed drawing's bounding rect (px). */
function drawRectRing(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 4])
  ctx.strokeRect(x - 2, y - 2, w + 4, h + 4)
  ctx.restore()
}

/**
 * The editor's central stage: ONE canvas that is editable when idle (drag/select/
 * add/double-click-to-edit) and plays the selected scope when `playback` is set
 * (project via the transport, or a single slide/textbox looped from its chip).
 * A persistent `Transport` sits permanently under it.
 */
export function SlideCanvas({
  fonts,
  font,
  drawings,
}: {
  fonts: FontSet
  font: LoadedFont
  drawings: DrawingSet
}) {
  const project = useVideoStore((s) => s.project)
  const activeAspect = useVideoStore((s) => s.activeAspect)
  const selectedSlideId = useVideoStore((s) => s.selectedSlideId)
  const selectedTextBoxId = useVideoStore((s) => s.selectedTextBoxId)
  const playback = useVideoStore((s) => s.playback)
  const setPlayback = useVideoStore((s) => s.setPlayback)
  const selectTextBox = useVideoStore((s) => s.selectTextBox)
  const addTextBox = useVideoStore((s) => s.addTextBox)
  const updateTextBoxFrame = useVideoStore((s) => s.updateTextBoxFrame)
  const selectedDrawingId = useVideoStore((s) => s.selectedDrawingId)
  const selectDrawing = useVideoStore((s) => s.selectDrawing)
  const updateDrawingFrame = useVideoStore((s) => s.updateDrawingFrame)
  const selectedInkId = useVideoStore((s) => s.selectedInkId)
  const selectInk = useVideoStore((s) => s.selectInk)
  const selectedElementIds = useVideoStore((s) => s.selectedElementIds)
  const toggleSelectElement = useVideoStore((s) => s.toggleSelectElement)
  const setSelectedElements = useVideoStore((s) => s.setSelectedElements)
  const translateSelected = useVideoStore((s) => s.translateSelected)
  const removeElements = useVideoStore((s) => s.removeElements)
  const inkTool = useVideoStore((s) => s.inkTool)
  const setInkTool = useVideoStore((s) => s.setInkTool)
  const inkArrow = useVideoStore((s) => s.inkArrow)
  const setInkArrow = useVideoStore((s) => s.setInkArrow)
  const addInk = useVideoStore((s) => s.addInk)
  const updateInk = useVideoStore((s) => s.updateInk)

  // The box currently in text-edit mode (double-click to enter). Separate from
  // mere selection: a selected box can be dragged; an editing box shows the
  // on-canvas text overlay instead of its handwriting.
  const [editingBoxId, setEditingBoxId] = useState<string | null>(null)
  // Transient preview speed — a playback aid only (scales the preview clock +
  // voiceover audio rate). Never written to the project; the MP4 runs at ×1.
  const [previewSpeed, setPreviewSpeed] = useState(1)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Register the editor font's @font-face eagerly (the overlay also resolves
  // per-run families on demand).
  useEffect(() => {
    registerFontFace(font.hash, font.buffer)
  }, [font.hash, font.buffer])
  // Live drag: the grabbed item's id, the pointer→origin offset, and its current
  // transient position (normalized; for inks AND multi-selections x/y are the
  // translation DELTA). Written to the store only on release.
  const dragRef = useRef<{ kind: 'box' | 'drawing' | 'ink' | 'multi'; id: string; offX: number; offY: number; x: number; y: number } | null>(null)
  const movedRef = useRef(false)
  const downNormRef = useRef<NormPoint | null>(null)
  const downHitRef = useRef<string | null>(null)
  // The in-progress direct-drawing stroke (flat width-unit points); null = not drawing.
  const strokeRef = useRef<InkPoint[] | null>(null)
  // The in-progress marquee (rubber-band) selection, in flat width units.
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  const slide = project ? project.slides.find((s) => s.id === selectedSlideId) ?? project.slides[0] : undefined
  // Flattened (single-aspect) slide for all canvas geometry/layout. Box ids are
  // preserved, so selection/edit lookups against the raw `slide` still line up.
  const fslide = useMemo(() => (slide ? flattenSlide(slide, activeAspect) : undefined), [slide, activeAspect])
  const divergedIds = useMemo(
    () => new Set((slide?.textBoxes ?? []).filter(framesDiverge).map((b) => b.id)),
    [slide],
  )
  const baseEmFraction = project?.baseEmFraction ?? 0.085
  const editingBox = editingBoxId ? slide?.textBoxes.find((b) => b.id === editingBoxId) : undefined
  // Per-aspect preview backing width (portrait = 9/16 as wide as landscape).
  const previewW = previewCanvasW(activeAspect)

  // Full render context (every slide, projected to the active aspect) — drives the
  // voiceover extract AND inline playback; the editing layouts reuse its per-slide map.
  const flatProject = useMemo(() => (project ? projectForAspect(project, activeAspect) : null), [project, activeAspect])
  const rc = useMemo(
    () => (flatProject ? buildRenderContext(flatProject, fonts, drawings, previewW) : null),
    [flatProject, fonts, drawings, previewW],
  )
  const layouts = useMemo(
    () => (slide && rc ? rc.layoutsBySlide.get(slide.id) ?? EMPTY_LAYOUTS : EMPTY_LAYOUTS),
    [rc, slide],
  )
  // Prepared direct drawings for this slide (LUTs + natural durations, from rc).
  const slideInks = useMemo(
    () => (slide && rc ? rc.inksBySlide.get(slide.id) ?? new Map() : new Map()),
    [rc, slide],
  )

  // An element's bounding rect in flat width units — selection rings + marquee.
  const elementBoundsWU = (id: string): { x: number; y: number; w: number; h: number } | null => {
    if (!fslide) return null
    const b = fslide.textBoxes.find((x) => x.id === id)
    if (b) {
      const l = layouts.get(id)
      return l ? { x: b.frame.x, y: b.frame.y, w: l.widthPx / previewW, h: l.heightPx / previewW } : null
    }
    const d = fslide.drawings.find((x) => x.id === id)
    if (d) {
      const entry = drawings.get(d.drawingId)
      const fw = d.frame.w
      if (!entry || fw == null || fw <= 0) return null
      return { x: d.frame.x, y: d.frame.y, w: fw, h: (fw * entry.viewBox.h) / Math.max(entry.viewBox.w, 1) }
    }
    const k = fslide.inks.find((x) => x.id === id)
    return k ? inkBounds(k.points) : null
  }

  // Leave edit mode when the slide changes or play starts/stops (so the overlay
  // doesn't re-open and steal focus when playback ends).
  useEffect(() => {
    setEditingBoxId(null)
  }, [selectedSlideId, playback])

  // --- inline playback (project / single slide / single textbox loop) --------
  const playbackDraw = useCallback(
    (ctx: CanvasRenderingContext2D, t: number, w: number, h: number) => {
      if (!flatProject || !rc || !playback) return
      if (playback.kind === 'project') {
        renderProject(ctx, flatProject, rc, t, w, h)
      } else if (playback.kind === 'slide') {
        const idx = flatProject.slides.findIndex((s) => s.id === playback.slideId)
        if (idx >= 0) renderSlide(ctx, flatProject, rc, idx, t, w, h)
      } else if (playback.kind === 'drawing') {
        const fs = flatProject.slides.find((s) => s.id === playback.slideId)
        const entry = rc.drawingsBySlide.get(playback.slideId)?.get(playback.drawingId)
        const fd = fs?.drawings.find((d) => d.id === playback.drawingId)
        ctx.clearRect(0, 0, w, h)
        if (fs) {
          ctx.fillStyle = fs.background
          ctx.fillRect(0, 0, w, h)
        }
        if (entry && fd) {
          const fw = fd.frame.w
          if (fw != null && fw > 0) {
            const tr = drawingTransform(entry.viewBox, fd.frame.x * w, fd.frame.y * w, fw * w)
            // play the whole envelope: padding, then the block sampled at its own rate
            const slot = elementSlot(entry.prepared.totalMs, fd.speed, fd.envelopeMs, fd.delayBeforeMs)
            const animStart = slot.animOffMs / rc.speed
            const animWin = slot.animMs / rc.speed
            const factor = animWin > 0 ? entry.prepared.totalMs / animWin : 0
            const writingMs = t >= animStart + animWin ? Infinity : (t - animStart) * factor
            renderPreparedDrawing(ctx, entry.prepared, tr, flatProject.brush, drawingMinHalfWidth(entry.viewBox), writingMs)
          }
        }
      } else if (playback.kind === 'ink') {
        const fs = flatProject.slides.find((s) => s.id === playback.slideId)
        const fk = fs?.inks.find((k) => k.id === playback.inkId)
        const prepared = rc.inksBySlide.get(playback.slideId)?.get(playback.inkId)
        ctx.clearRect(0, 0, w, h)
        if (fs) {
          ctx.fillStyle = fs.background
          ctx.fillRect(0, 0, w, h)
        }
        if (fk && prepared) {
          const slot = elementSlot(prepared.totalMs, fk.speed, fk.envelopeMs, fk.delayBeforeMs)
          const animStart = slot.animOffMs / rc.speed
          const animWin = slot.animMs / rc.speed
          const factor = animWin > 0 ? prepared.totalMs / animWin : 0
          const writingMs = t >= animStart + animWin ? Infinity : (t - animStart) * factor
          renderInk(ctx, prepared, w, flatProject.brush, fk.color, writingMs, fk.id)
        }
      } else {
        const fs = flatProject.slides.find((s) => s.id === playback.slideId)
        const layout = rc.layoutsBySlide.get(playback.slideId)?.get(playback.boxId)
        const fb = fs?.textBoxes.find((b) => b.id === playback.boxId)
        ctx.clearRect(0, 0, w, h)
        if (fs) {
          ctx.fillStyle = fs.background
          ctx.fillRect(0, 0, w, h)
        }
        // Play the box's whole envelope (padding-before, then the writing block
        // at its own rate), matching renderSlideContent/timing — so a box's chip
        // preview plays at the same pace as slide/project playback + the export.
        if (layout && fb) {
          const slot = elementSlot(layout.contentMs, fb.speed, fb.envelopeMs, fb.delayBeforeMs)
          const animStart = slot.animOffMs / rc.speed
          const animWin = slot.animMs / rc.speed
          const factor = animWin > 0 ? layout.contentMs / animWin : 0
          const writingMs = t >= animStart + animWin ? Infinity : (t - animStart) * factor
          renderTextBox(ctx, layout, { x: fb.frame.x * w, y: fb.frame.y * w }, fb.brush ?? flatProject.brush, writingMs)
        }
      }
    },
    [flatProject, rc, playback],
  )
  const playbackTotalMs = useMemo(() => {
    if (!rc || !playback) return 0
    if (playback.kind === 'project') return rc.timing.totalMs
    if (playback.kind === 'slide') return rc.timing.slides.find((s) => s.slideId === playback.slideId)?.timing.totalMs ?? 0
    if (playback.kind === 'drawing') {
      const entry = rc.drawingsBySlide.get(playback.slideId)?.get(playback.drawingId)
      const fd = flatProject?.slides.find((s) => s.id === playback.slideId)?.drawings.find((d) => d.id === playback.drawingId)
      return entry ? elementSlot(entry.prepared.totalMs, fd?.speed, fd?.envelopeMs, fd?.delayBeforeMs).envMs / rc.speed : 0
    }
    if (playback.kind === 'ink') {
      const prepared = rc.inksBySlide.get(playback.slideId)?.get(playback.inkId)
      const fk = flatProject?.slides.find((s) => s.id === playback.slideId)?.inks.find((k) => k.id === playback.inkId)
      return prepared ? elementSlot(prepared.totalMs, fk?.speed, fk?.envelopeMs, fk?.delayBeforeMs).envMs / rc.speed : 0
    }
    // box: its whole envelope in real time (padding + writing block, ÷ global rate)
    const fb = flatProject?.slides.find((s) => s.id === playback.slideId)?.textBoxes.find((b) => b.id === playback.boxId)
    const contentMs = rc.layoutsBySlide.get(playback.slideId)?.get(playback.boxId)?.contentMs ?? 0
    return elementSlot(contentMs, fb?.speed, fb?.envelopeMs, fb?.delayBeforeMs).envMs / rc.speed
  }, [rc, playback, flatProject])
  // Voiceover plays only for whole-project playback (cues are project-time).
  const audioCues = useMemo<AudioCue[] | undefined>(() => {
    if (playback?.kind !== 'project' || !project) return undefined
    const list: AudioCue[] = []
    for (const c of project.voiceover ?? []) {
      const url = cueAudioUrl(project.id, c)
      if (!url) continue
      // Bound playback by the audio's REAL length (startMs + duration), not the
      // VTT/caption window `c.endMs` (often shorter) — otherwise the engine pauses
      // the clip before it finishes. The MP4 export already plays the full clip.
      const dur = c.audio?.durationMs
      const endMs = dur && dur > 0 ? c.startMs + dur : c.endMs
      list.push({ id: c.id, startMs: c.startMs, endMs, url })
    }
    return list
  }, [playback, project])
  const engine = usePlaybackEngine(canvasRef, {
    draw: playbackDraw,
    totalMs: playbackTotalMs,
    aspect: activeAspect,
    active: !!playback,
    resetKey: JSON.stringify(playback),
    audioCues,
    speed: previewSpeed,
  })

  // Paint the slide statically (idle/editing). `drag`, when set, overrides one
  // box's origin with its live transient position so a drag repaints without a
  // store write (and without re-deriving layouts).
  const drawScene = useCallback(
    (drag?: { kind: 'box' | 'drawing' | 'ink' | 'multi'; id: string; x: number; y: number } | null) => {
      const canvas = canvasRef.current
      if (!canvas || !project || !fslide) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const { w, h } = canvasSize(activeAspect, previewW)
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = fslide.background
      ctx.fillRect(0, 0, w, h)
      const multiSel = new Set(selectedElementIds)
      // drag.{x,y} are width-units (like frame), so × w matches boxOriginPx. A
      // 'multi' drag carries a DELTA applied to every selected element.
      const groupDelta = (id: string) =>
        drag && drag.kind === 'multi' && multiSel.has(id) ? { dx: drag.x, dy: drag.y } : null
      const originFor = (id: string, frame: { x: number; y: number }) => {
        const g = groupDelta(id)
        if (g) return { x: (frame.x + g.dx) * w, y: (frame.y + g.dy) * w }
        return drag && drag.kind !== 'multi' && drag.id === id ? { x: drag.x * w, y: drag.y * w } : { x: frame.x * w, y: frame.y * w }
      }

      // Textboxes, placed drawings AND direct inks interleaved by their shared
      // animOrder, so the editor preview stacks them exactly as playback/export will.
      const items: { animOrder: number; box?: FlatBox; drawing?: FlatDrawing; ink?: (typeof fslide.inks)[number] }[] = [
        ...fslide.textBoxes.filter((b) => b.id !== editingBoxId).map((b) => ({ animOrder: b.animOrder, box: b })),
        ...fslide.drawings.map((d) => ({ animOrder: d.animOrder, drawing: d })),
        ...fslide.inks.map((k) => ({ animOrder: k.animOrder, ink: k })),
      ]
      items.sort((a, b) => a.animOrder - b.animOrder)
      for (const it of items) {
        if (it.box) {
          const layout = layouts.get(it.box.id)
          if (layout) renderTextBox(ctx, layout, originFor(it.box.id, it.box.frame), it.box.brush ?? project.brush, Infinity)
        } else if (it.drawing) {
          const entry = drawings.get(it.drawing.drawingId)
          const fw = it.drawing.frame.w
          if (entry && fw != null && fw > 0) {
            const o = originFor(it.drawing.id, it.drawing.frame)
            const tr = drawingTransform(entry.viewBox, o.x, o.y, fw * w)
            renderPreparedDrawing(ctx, entry.prepared, tr, project.brush, drawingMinHalfWidth(entry.viewBox), Infinity)
          }
        } else if (it.ink) {
          const prepared = slideInks.get(it.ink.id)
          if (!prepared) continue
          // an ink being dragged translates via the ctx (its points are absolute)
          const g = groupDelta(it.ink.id)
          const single = drag && drag.kind === 'ink' && drag.id === it.ink.id
          const moved = g ?? (single ? { dx: drag.x, dy: drag.y } : null)
          if (moved) {
            ctx.save()
            ctx.translate(moved.dx * w, moved.dy * w)
          }
          renderInk(ctx, prepared, w, project.brush, it.ink.color, Infinity, it.ink.id)
          if (moved) ctx.restore()
        }
      }
      // The in-progress pen stroke (simple preview line; ribbon on commit).
      const live = strokeRef.current
      if (live && live.length > 1) {
        ctx.save()
        ctx.strokeStyle = project.brush.color
        ctx.lineWidth = Math.max(1.5, INK_BASE_WIDTH * w * 0.8)
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.globalAlpha = 0.85
        ctx.beginPath()
        ctx.moveTo(live[0].x * w, live[0].y * w)
        for (let i = 1; i < live.length; i++) ctx.lineTo(live[i].x * w, live[i].y * w)
        ctx.stroke()
        ctx.restore()
      }
      // Diverged boxes (differ between aspects) get an amber ring, under the selection.
      for (const box of fslide.textBoxes) {
        if (box.id === editingBoxId || !divergedIds.has(box.id)) continue
        const l = layouts.get(box.id)
        if (l) drawSelection(ctx, box, l, w, '#e0a23a', originFor(box.id, box.frame))
      }
      const selBox = fslide.textBoxes.find((b) => b.id === selectedTextBoxId)
      if (selBox && selBox.id !== editingBoxId) {
        const l = layouts.get(selBox.id)
        if (l) drawSelection(ctx, selBox, l, w, undefined, originFor(selBox.id, selBox.frame))
      }
      // Selected drawing: a dashed bounding ring (skipped if the drawing isn't
      // loaded — matches the render path, and avoids a wrong-aspect fallback).
      const selDraw = selectedDrawingId ? fslide.drawings.find((d) => d.id === selectedDrawingId) : undefined
      if (selDraw) {
        const entry = drawings.get(selDraw.drawingId)
        const fw = selDraw.frame.w
        if (entry && fw != null && fw > 0) {
          const o = originFor(selDraw.id, selDraw.frame)
          drawRectRing(ctx, o.x, o.y, fw * w, drawingHeightPx(entry.viewBox, fw * w), '#7aa2ff')
        }
      }
      // Selected ink: a dashed ring around its bounds (translated while dragging).
      const selInk = selectedInkId ? fslide.inks.find((k) => k.id === selectedInkId) : undefined
      if (selInk) {
        const b = inkBounds(selInk.points)
        if (b) {
          const g = groupDelta(selInk.id)
          const dx = g ? g.dx : drag && drag.kind === 'ink' && drag.id === selInk.id ? drag.x : 0
          const dy = g ? g.dy : drag && drag.kind === 'ink' && drag.id === selInk.id ? drag.y : 0
          drawRectRing(ctx, (b.x + dx) * w - 4, (b.y + dy) * w - 4, b.w * w + 8, b.h * w + 8, '#7aa2ff')
        }
      }
      // Multi-selection: ring every other selected element too.
      if (multiSel.size > 1) {
        for (const id of multiSel) {
          if (id === selectedTextBoxId || id === selectedDrawingId || id === selectedInkId) continue
          const b = elementBoundsWU(id)
          if (!b) continue
          const g = groupDelta(id)
          const dx = g ? g.dx : 0
          const dy = g ? g.dy : 0
          drawRectRing(ctx, (b.x + dx) * w - 4, (b.y + dy) * w - 4, b.w * w + 8, b.h * w + 8, '#7aa2ff')
        }
      }
      // The marquee rubber-band, while dragging one out.
      const mq = marqueeRef.current
      if (mq) {
        ctx.save()
        ctx.strokeStyle = '#7aa2ff'
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1
        ctx.strokeRect(Math.min(mq.x0, mq.x1) * w, Math.min(mq.y0, mq.y1) * w, Math.abs(mq.x1 - mq.x0) * w, Math.abs(mq.y1 - mq.y0) * w)
        ctx.fillStyle = 'rgba(122, 162, 255, 0.08)'
        ctx.fillRect(Math.min(mq.x0, mq.x1) * w, Math.min(mq.y0, mq.y1) * w, Math.abs(mq.x1 - mq.x0) * w, Math.abs(mq.y1 - mq.y0) * w)
        ctx.restore()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, fslide, activeAspect, previewW, layouts, divergedIds, selectedTextBoxId, editingBoxId, drawings, selectedDrawingId, selectedInkId, slideInks, selectedElementIds],
  )

  // Static draw when idle; also re-fires on Stop (playback → null) to repaint the
  // editing canvas the engine had taken over.
  useEffect(() => {
    if (playback) return
    drawScene(null)
  }, [drawScene, playback])

  // Escape cancels an in-progress ink stroke (or drops the pen back to Select);
  // Delete/Backspace removes the selected ink (when not typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (strokeRef.current) {
          strokeRef.current = null
          drawScene(null)
          e.preventDefault()
        } else if (useVideoStore.getState().inkTool) {
          setInkTool(null)
          e.preventDefault()
        }
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const st = useVideoStore.getState()
        const slideId = st.selectedSlideId ?? st.project?.slides[0]?.id
        if (!slideId) return
        const ae = document.activeElement as HTMLElement | null
        if (ae && (ae.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName))) return
        // Delete the whole multi-selection; a lone selected INK also deletes (boxes
        // and drawings keep their explicit Inspector delete when single-selected,
        // so a stray keypress can't nuke the box you're working in).
        if (st.selectedElementIds.length > 1) {
          removeElements(slideId, st.selectedElementIds)
          e.preventDefault()
        } else if (st.selectedInkId) {
          removeElements(slideId, [st.selectedInkId])
          e.preventDefault()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawScene, setInkTool, removeElements])

  if (!project || !slide || !fslide) return <div className="stage video-stage">No slide.</div>

  const scopeLabel = !playback
    ? undefined
    : playback.kind === 'project'
      ? 'the project'
      : playback.kind === 'slide'
        ? `slide ${project.slides.findIndex((s) => s.id === playback.slideId) + 1}`
        : playback.kind === 'drawing'
          ? 'this drawing'
          : playback.kind === 'ink'
            ? 'this ink'
            : 'this textbox'

  // The canvas spaces lines by (ascender+|descender|)/upm × lineHeightScale; pass
  // that em-ratio to the overlay so its CSS line-height matches (editing a box
  // mustn't change its line spacing).
  let editLineHeightEm = 1
  if (editingBox) {
    const c = contentOf(editingBox, activeAspect)
    const m = fontFor(fonts, c.runs[0]?.fontId ?? project.fontId).metrics
    editLineHeightEm = (m.ascender + Math.abs(m.descender)) / m.unitsPerEm
  }

  // Topmost placed drawing (by animOrder) whose bounds contain the point, else null.
  const hitDrawing = (nx: number, ny: number): string | null => {
    const pad = 6 / previewW
    for (const d of [...fslide.drawings].sort((a, b) => b.animOrder - a.animOrder)) {
      const entry = drawings.get(d.drawingId)
      const fw = d.frame.w
      if (!entry || fw == null || fw <= 0) continue
      const hWU = (fw * entry.viewBox.h) / Math.max(entry.viewBox.w, 1) // height in width-units
      if (nx >= d.frame.x - pad && nx <= d.frame.x + fw + pad && ny >= d.frame.y - pad && ny <= d.frame.y + hWU + pad) return d.id
    }
    return null
  }

  // Topmost ink whose polyline passes near the point (annotations sit on top).
  const hitInk = (nx: number, ny: number): string | null => {
    const tol = 8 / previewW + INK_BASE_WIDTH
    for (const k of [...fslide.inks].sort((a, b) => b.animOrder - a.animOrder)) {
      if (inkHitDistance(k.points, { x: nx, y: ny }) <= tol * Math.max(1, k.widthScale ?? 1)) return k.id
    }
    return null
  }

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (playback) return
    const canvas = canvasRef.current
    if (!canvas) return
    // A pointerdown that reaches the canvas is necessarily outside the edit
    // overlay (which sits on top of its box), so it leaves edit mode.
    if (editingBoxId) setEditingBoxId(null)
    const p = clientToNorm(canvas, e.clientX, e.clientY)
    downNormRef.current = p
    movedRef.current = false
    // A pen tool is active → start capturing a direct-drawing stroke.
    if (inkTool) {
      strokeRef.current = [{ x: p.nx, y: p.ny }]
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic pointer (tests) — move/up still arrive via the canvas */
      }
      return
    }
    const capture = () => {
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic pointer (tests) */
      }
    }
    const multiKey = e.shiftKey || e.metaKey || e.ctrlKey
    // Unified hit: inks sit on top (annotations), then textboxes, then drawings.
    const kh = hitInk(p.nx, p.ny)
    const bh = kh ? null : hitTest(fslide, layouts, p.nx, p.ny, previewW)
    const dh = kh || bh ? null : hitDrawing(p.nx, p.ny)
    const hit = kh ?? bh ?? dh
    downHitRef.current = hit
    if (hit) {
      // Shift/Ctrl/Cmd-click toggles the element in/out of the multi-selection.
      if (multiKey) {
        toggleSelectElement(hit)
        return
      }
      // Clicking a member of a multi-selection drags the WHOLE group (delta-based;
      // committed as one store write on release).
      if (selectedElementIds.length > 1 && selectedElementIds.includes(hit)) {
        dragRef.current = { kind: 'multi', id: hit, offX: p.nx, offY: p.ny, x: 0, y: 0 }
        capture()
        return
      }
      if (kh) {
        selectInk(kh)
        dragRef.current = { kind: 'ink', id: kh, offX: p.nx, offY: p.ny, x: 0, y: 0 }
        capture()
        return
      }
      if (bh) {
        const box = fslide.textBoxes.find((b) => b.id === bh)
        if (!box) return
        selectTextBox(bh)
        // Deferred write: hold the grabbed item's live position locally and commit it
        // to the store exactly once on release — so dragging never re-derives layouts
        // or churns history every frame.
        dragRef.current = { kind: 'box', id: bh, offX: p.nx - box.frame.x, offY: p.ny - box.frame.y, x: box.frame.x, y: box.frame.y }
        capture()
        return
      }
      const d = fslide.drawings.find((x) => x.id === dh)
      if (!d) return
      selectDrawing(dh!)
      dragRef.current = { kind: 'drawing', id: dh!, offX: p.nx - d.frame.x, offY: p.ny - d.frame.y, x: d.frame.x, y: d.frame.y }
      capture()
      return
    }
    // Empty space: with a modifier, keep the selection; otherwise start a marquee
    // (a no-move click falls back to deselect / add-textbox on release).
    if (multiKey) return
    marqueeRef.current = { x0: p.nx, y0: p.ny, x1: p.nx, y1: p.ny }
    capture()
  }

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Drawing an ink stroke: append and repaint the live preview line.
    if (strokeRef.current) {
      const p = clientToNorm(canvas, e.clientX, e.clientY)
      strokeRef.current.push({ x: clamp01(p.nx), y: clampY(p.ny, activeAspect) })
      drawScene(null)
      return
    }
    // Marquee: stretch the rubber band.
    if (marqueeRef.current) {
      const p = clientToNorm(canvas, e.clientX, e.clientY)
      marqueeRef.current.x1 = p.nx
      marqueeRef.current.y1 = p.ny
      const dn = downNormRef.current
      if (dn && Math.hypot((p.nx - dn.nx) * previewW, (p.ny - dn.ny) * previewW) >= 3) movedRef.current = true
      drawScene(null)
      return
    }
    const d = dragRef.current
    if (!d) return
    const p = clientToNorm(canvas, e.clientX, e.clientY)
    if (!movedRef.current) {
      const dn = downNormRef.current
      if (dn && Math.hypot((p.nx - dn.nx) * previewW, (p.ny - dn.ny) * previewW) < 3) return
      movedRef.current = true
    }
    // Local move only: update the transient position and repaint. y is width-units;
    // clamp to the active aspect's visible extent. (Inks and groups move by DELTA.)
    if (d.kind === 'ink' || d.kind === 'multi') {
      d.x = p.nx - d.offX
      d.y = p.ny - d.offY
    } else {
      d.x = clamp01(p.nx - d.offX)
      d.y = clampY(p.ny - d.offY, activeAspect)
    }
    drawScene({ kind: d.kind, id: d.id, x: d.x, y: d.y })
  }

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    if (playback) return
    const canvas = canvasRef.current
    // Finish an ink stroke: coerce it to the tool's shape and commit (one undo).
    const raw = strokeRef.current
    if (raw) {
      strokeRef.current = null
      try {
        canvas?.releasePointerCapture(e.pointerId)
      } catch {
        /* never captured */
      }
      const H = aspectHeightUnits(activeAspect)
      const tool = inkTool ?? 'freehand'
      const pts = coerceInkPoints(tool, raw)
      if (pts.length >= 2) {
        // flat width-units → stored (y as a fraction of height, like frames).
        // Freehand never gets an arrowhead; line/curve honour the pre-draw toggle.
        const arrow = inkArrow && tool !== 'freehand'
        addInk(slide.id, tool, pts.map((pt) => ({ x: pt.x, y: pt.y / H })), undefined, undefined, arrow)
      } else {
        drawScene(null) // too small — drop the preview line
      }
      return
    }
    // Marquee release: select everything the band touched (empty band = clear);
    // a no-move click keeps the old behaviour (deselect chain / add a textbox).
    const mq = marqueeRef.current
    if (mq) {
      marqueeRef.current = null
      try {
        canvas?.releasePointerCapture(e.pointerId)
      } catch {
        /* never captured */
      }
      if (movedRef.current) {
        const x = Math.min(mq.x0, mq.x1)
        const y = Math.min(mq.y0, mq.y1)
        const w = Math.abs(mq.x1 - mq.x0)
        const h = Math.abs(mq.y1 - mq.y0)
        const ids: string[] = []
        for (const el of [...fslide.textBoxes, ...fslide.drawings, ...fslide.inks].sort((a, b) => a.animOrder - b.animOrder)) {
          const b = elementBoundsWU(el.id)
          if (b && b.x <= x + w && b.x + b.w >= x && b.y <= y + h && b.y + b.h >= y) ids.push(el.id)
        }
        setSelectedElements(ids)
        drawScene(null)
        return
      }
      // fall through to the bare-click behaviour below
    }
    const d = dragRef.current
    if (d) {
      dragRef.current = null
      try {
        canvas?.releasePointerCapture(e.pointerId)
      } catch {
        /* never captured, or already lost (e.g. pointercancel) */
      }
      // Commit the gesture as one store write ≡ one undo step. A bare click (no
      // movement past the threshold) only (re)selected the item — nothing to write.
      if (movedRef.current) {
        if (d.kind === 'multi') {
          if (d.x !== 0 || d.y !== 0) translateSelected(slide.id, selectedElementIds, d.x, d.y)
        } else if (d.kind === 'box') updateTextBoxFrame(slide.id, d.id, { x: d.x, y: d.y })
        else if (d.kind === 'drawing') updateDrawingFrame(slide.id, d.id, { x: d.x, y: d.y })
        else {
          // translate the ink's stored points by the drag delta (y back to height units)
          const ink = slide.inks?.find((k) => k.id === d.id)
          if (ink && (d.x !== 0 || d.y !== 0)) {
            const H = aspectHeightUnits(activeAspect)
            updateInk(slide.id, d.id, {
              points: ink.points.map((pt) => ({ x: pt.x + d.x, y: pt.y + d.y / H })),
            })
          }
        }
      }
      return
    }
    if (!downHitRef.current && !movedRef.current) {
      const p = downNormRef.current
      if (selectedElementIds.length) setSelectedElements([])
      else if (selectedTextBoxId) selectTextBox(null)
      else if (selectedDrawingId) selectDrawing(null)
      else if (selectedInkId) selectInk(null)
      else if (p) addTextBox(slide.id, clamp01(p.nx), clampY(p.ny, activeAspect))
    }
  }

  // Interrupted gesture (pointercancel) → abandon the move/stroke/marquee; nothing is written.
  const onPointerCancel = () => {
    if (dragRef.current || strokeRef.current || marqueeRef.current) {
      dragRef.current = null
      strokeRef.current = null
      marqueeRef.current = null
      drawScene(null)
    }
  }

  // Double-click a box to edit its text in place.
  const onDoubleClick = (e: PointerEvent<HTMLCanvasElement>) => {
    if (playback) return
    const canvas = canvasRef.current
    if (!canvas) return
    const p = clientToNorm(canvas, e.clientX, e.clientY)
    const hit = hitTest(fslide, layouts, p.nx, p.ny, previewW)
    if (hit) {
      selectTextBox(hit)
      setEditingBoxId(hit)
    }
  }

  const INK_TOOLS: { tool: InkTool; label: string; title: string }[] = [
    { tool: 'freehand', label: '✎', title: 'Freehand pen — draw loops, circles, underlines by hand' },
    { tool: 'line', label: '─', title: 'Straight line' },
    { tool: 'curve', label: '～', title: 'Smooth curve — freehand, coerced to a curve' },
  ]
  // The arrowhead toggle only applies to line/curve (freehand never gets a head).
  const arrowApplies = inkTool === 'line' || inkTool === 'curve'

  return (
    <div className="slidecanvas">
      <FormatBar />
      <div className="ink-tools seg" title="Direct drawing — annotate the slide with pen strokes (they animate in turn, like everything else)">
        <button
          className={inkTool == null ? 'tool tool-on' : 'tool'}
          title="Select / move (Esc)"
          onClick={() => setInkTool(null)}
        >
          ↖
        </button>
        {INK_TOOLS.map((t) => (
          <button
            key={t.tool}
            className={inkTool === t.tool ? 'tool tool-on' : 'tool'}
            title={t.title}
            onClick={() => setInkTool(inkTool === t.tool ? null : t.tool)}
          >
            {t.label}
          </button>
        ))}
        <button
          className={inkArrow ? 'tool tool-on' : 'tool'}
          disabled={!arrowApplies}
          title="Arrowhead — draw the next line/curve with an arrow at its end"
          onClick={() => setInkArrow(!inkArrow)}
        >
          →
        </button>
        <span className="ink-tools-hint muted">
          {inkTool ? 'draw on the slide · Esc to stop' : ''}
        </span>
      </div>
      <div className="stage stage-overlay video-stage">
        <div className="canvas-wrap">
          <canvas
            ref={canvasRef}
            className="slide-canvas-el"
            width={canvasSize(activeAspect, previewW).w}
            height={canvasSize(activeAspect, previewW).h}
            style={inkTool ? { cursor: 'crosshair' } : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onDoubleClick={onDoubleClick}
          />
          {!playback && editingBox && (
            <TextBoxOverlay
              key={editingBox.id}
              box={editingBox}
              aspect={activeAspect}
              slideId={slide.id}
              canvasEl={canvasRef.current}
              baseEmFraction={baseEmFraction}
              lineHeightEm={editLineHeightEm}
              brushColor={editingBox.brush?.color ?? project.brush.color}
              editorFontId={font.hash}
              editorFontBuffer={font.buffer}
              defaultFontId={project.fontId}
              onExit={() => setEditingBoxId(null)}
            />
          )}
        </div>
      </div>
      <Transport
        engine={engine}
        active={!!playback}
        scopeLabel={scopeLabel}
        speed={previewSpeed}
        onSpeedChange={setPreviewSpeed}
        onPlayProject={() => setPlayback({ kind: 'project' })}
        onStop={() => setPlayback(null)}
      />
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { LoadedFont } from '@lib/font/load'
import { aspectHeightUnits, canvasSize } from '@lib/project/coords'
import { contentOf, flattenSlide, framesDiverge, projectForAspect, type FlatBox } from '@lib/project/aspect'
import { fontFor, type FontSet, type TextBoxLayout } from '@lib/project/layout'
import { buildRenderContext, renderProject, renderSlide, renderTextBox } from '@lib/project/render'
import { useVideoStore } from '../../state/videoStore'
import { BACKING_W, boxOriginPx, clientToNorm, drawSelection, hitTest, type NormPoint } from './layoutCanvas'
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

/**
 * The editor's central stage: ONE canvas that is editable when idle (drag/select/
 * add/double-click-to-edit) and plays the selected scope when `playback` is set
 * (project via the transport, or a single slide/textbox looped from its chip).
 * A persistent `Transport` sits permanently under it.
 */
export function SlideCanvas({
  fonts,
  font,
}: {
  fonts: FontSet
  font: LoadedFont
}) {
  const project = useVideoStore((s) => s.project)
  const activeAspect = useVideoStore((s) => s.activeAspect)
  const selectedSlideId = useVideoStore((s) => s.selectedSlideId)
  const selectedTextBoxId = useVideoStore((s) => s.selectedTextBoxId)
  const playback = useVideoStore((s) => s.playback)
  const setPlayback = useVideoStore((s) => s.setPlayback)
  const playbackRate = useVideoStore((s) => s.project?.playbackRate ?? 1)
  const setPlaybackRate = useVideoStore((s) => s.setPlaybackRate)
  const selectTextBox = useVideoStore((s) => s.selectTextBox)
  const addTextBox = useVideoStore((s) => s.addTextBox)
  const updateTextBoxFrame = useVideoStore((s) => s.updateTextBoxFrame)

  // The box currently in text-edit mode (double-click to enter). Separate from
  // mere selection: a selected box can be dragged; an editing box shows the
  // on-canvas text overlay instead of its handwriting.
  const [editingBoxId, setEditingBoxId] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Register the editor font's @font-face eagerly (the overlay also resolves
  // per-run families on demand).
  useEffect(() => {
    registerFontFace(font.hash, font.buffer)
  }, [font.hash, font.buffer])
  // Live drag: the grabbed box's id, the pointer→origin offset, and the box's
  // current transient position (normalized). Written to the store only on release.
  const dragRef = useRef<{ boxId: string; offX: number; offY: number; x: number; y: number } | null>(null)
  const movedRef = useRef(false)
  const downNormRef = useRef<NormPoint | null>(null)
  const downHitRef = useRef<string | null>(null)

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

  // Full render context (every slide, projected to the active aspect) — drives the
  // voiceover extract AND inline playback; the editing layouts reuse its per-slide map.
  const flatProject = useMemo(() => (project ? projectForAspect(project, activeAspect) : null), [project, activeAspect])
  const rc = useMemo(
    () => (flatProject ? buildRenderContext(flatProject, fonts, BACKING_W, playbackRate) : null),
    [flatProject, fonts, playbackRate],
  )
  const layouts = useMemo(
    () => (slide && rc ? rc.layoutsBySlide.get(slide.id) ?? EMPTY_LAYOUTS : EMPTY_LAYOUTS),
    [rc, slide],
  )

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
      } else {
        const fs = flatProject.slides.find((s) => s.id === playback.slideId)
        const layout = rc.layoutsBySlide.get(playback.slideId)?.get(playback.boxId)
        const fb = fs?.textBoxes.find((b) => b.id === playback.boxId)
        ctx.clearRect(0, 0, w, h)
        if (fs) {
          ctx.fillStyle = fs.background
          ctx.fillRect(0, 0, w, h)
        }
        // Scale the real-time clock to writing time by rc.speed, matching how
        // renderSlideContent/timing treat the per-box animation (so a box's chip
        // preview plays at the same rate as slide/project playback + the export).
        if (layout && fb) renderTextBox(ctx, layout, { x: fb.frame.x * w, y: fb.frame.y * w }, fb.brush ?? flatProject.brush, t * rc.speed)
      }
    },
    [flatProject, rc, playback],
  )
  const playbackTotalMs = useMemo(() => {
    if (!rc || !playback) return 0
    if (playback.kind === 'project') return rc.timing.totalMs
    if (playback.kind === 'slide') return rc.timing.slides.find((s) => s.slideId === playback.slideId)?.timing.totalMs ?? 0
    // real-time window = unscaled writing duration ÷ speed (rc.speed is sanitized > 0)
    return (rc.layoutsBySlide.get(playback.slideId)?.get(playback.boxId)?.contentMs ?? 0) / rc.speed
  }, [rc, playback])
  // Voiceover plays only for whole-project playback (cues are project-time).
  const audioCues = useMemo<AudioCue[] | undefined>(() => {
    if (playback?.kind !== 'project' || !project) return undefined
    const list: AudioCue[] = []
    for (const c of project.voiceover ?? []) {
      const url = cueAudioUrl(project.id, c)
      if (url) list.push({ id: c.id, startMs: c.startMs, endMs: c.endMs, url })
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
  })

  // Paint the slide statically (idle/editing). `drag`, when set, overrides one
  // box's origin with its live transient position so a drag repaints without a
  // store write (and without re-deriving layouts).
  const drawScene = useCallback(
    (drag?: { boxId: string; x: number; y: number } | null) => {
      const canvas = canvasRef.current
      if (!canvas || !project || !fslide) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const { w, h } = canvasSize(activeAspect, BACKING_W)
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = fslide.background
      ctx.fillRect(0, 0, w, h)
      // drag.{x,y} are width-units (like frame), so × w matches boxOriginPx.
      const originFor = (box: FlatBox) =>
        drag && drag.boxId === box.id ? { x: drag.x * w, y: drag.y * w } : boxOriginPx(box, w)
      for (const box of fslide.textBoxes) {
        if (box.id === editingBoxId) continue // the edit overlay shows this box's text
        const layout = layouts.get(box.id)
        if (!layout) continue
        renderTextBox(ctx, layout, originFor(box), box.brush ?? project.brush, Infinity)
      }
      // Diverged boxes (differ between aspects) get an amber ring, under the selection.
      for (const box of fslide.textBoxes) {
        if (box.id === editingBoxId || !divergedIds.has(box.id)) continue
        const l = layouts.get(box.id)
        if (l) drawSelection(ctx, box, l, w, '#e0a23a', originFor(box))
      }
      const selBox = fslide.textBoxes.find((b) => b.id === selectedTextBoxId)
      if (selBox && selBox.id !== editingBoxId) {
        const l = layouts.get(selBox.id)
        if (l) drawSelection(ctx, selBox, l, w, undefined, originFor(selBox))
      }
    },
    [project, fslide, activeAspect, layouts, divergedIds, selectedTextBoxId, editingBoxId],
  )

  // Static draw when idle; also re-fires on Stop (playback → null) to repaint the
  // editing canvas the engine had taken over.
  useEffect(() => {
    if (playback) return
    drawScene(null)
  }, [drawScene, playback])

  if (!project || !slide || !fslide) return <div className="stage video-stage">No slide.</div>

  const scopeLabel = !playback
    ? undefined
    : playback.kind === 'project'
      ? 'the project'
      : playback.kind === 'slide'
        ? `slide ${project.slides.findIndex((s) => s.id === playback.slideId) + 1}`
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
    const hit = hitTest(fslide, layouts, p.nx, p.ny, BACKING_W)
    downHitRef.current = hit
    if (hit) {
      const box = fslide.textBoxes.find((b) => b.id === hit)
      if (!box) return
      selectTextBox(hit)
      // Deferred write: hold the grabbed box's live position locally and commit it
      // to the store exactly once on release — so dragging never re-derives layouts
      // or churns history every frame.
      dragRef.current = { boxId: hit, offX: p.nx - box.frame.x, offY: p.ny - box.frame.y, x: box.frame.x, y: box.frame.y }
      canvas.setPointerCapture(e.pointerId)
    }
  }

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    const canvas = canvasRef.current
    if (!d || !canvas) return
    const p = clientToNorm(canvas, e.clientX, e.clientY)
    if (!movedRef.current) {
      const dn = downNormRef.current
      if (dn && Math.hypot((p.nx - dn.nx) * BACKING_W, (p.ny - dn.ny) * BACKING_W) < 3) return
      movedRef.current = true
    }
    // Local move only: update the transient position and repaint. y is width-units;
    // clamp to the active aspect's visible extent.
    d.x = clamp01(p.nx - d.offX)
    d.y = clampY(p.ny - d.offY, activeAspect)
    drawScene({ boxId: d.boxId, x: d.x, y: d.y })
  }

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    if (playback) return
    const canvas = canvasRef.current
    const d = dragRef.current
    if (d) {
      dragRef.current = null
      try {
        canvas?.releasePointerCapture(e.pointerId)
      } catch {
        /* never captured, or already lost (e.g. pointercancel) */
      }
      // Commit the gesture as one store write ≡ one undo step. A bare click (no
      // movement past the threshold) only (re)selected the box — nothing to write.
      if (movedRef.current) updateTextBoxFrame(slide.id, d.boxId, { x: d.x, y: d.y })
      return
    }
    if (!downHitRef.current && !movedRef.current) {
      const p = downNormRef.current
      if (selectedTextBoxId) selectTextBox(null)
      else if (p) addTextBox(slide.id, clamp01(p.nx), clampY(p.ny, activeAspect))
    }
  }

  // Interrupted gesture (pointercancel) → abandon the move; nothing is written.
  const onPointerCancel = () => {
    if (dragRef.current) {
      dragRef.current = null
      drawScene(null)
    }
  }

  // Double-click a box to edit its text in place.
  const onDoubleClick = (e: PointerEvent<HTMLCanvasElement>) => {
    if (playback) return
    const canvas = canvasRef.current
    if (!canvas) return
    const p = clientToNorm(canvas, e.clientX, e.clientY)
    const hit = hitTest(fslide, layouts, p.nx, p.ny, BACKING_W)
    if (hit) {
      selectTextBox(hit)
      setEditingBoxId(hit)
    }
  }

  return (
    <div className="slidecanvas">
      {!playback && <FormatBar />}
      <div className="stage stage-overlay video-stage">
        <div className="canvas-wrap">
          <canvas
            ref={canvasRef}
            className="slide-canvas-el"
            width={canvasSize(activeAspect, BACKING_W).w}
            height={canvasSize(activeAspect, BACKING_W).h}
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
        speed={playbackRate}
        onSpeedChange={setPlaybackRate}
        onPlayProject={() => setPlayback({ kind: 'project' })}
        onStop={() => setPlayback(null)}
      />
    </div>
  )
}

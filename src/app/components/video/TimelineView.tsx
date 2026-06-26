import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { aspectHeightUnits } from '@lib/project/coords'
import type { FontSet } from '@lib/project/layout'
import { buildRenderContext } from '@lib/project/render'
import { slideTimeWindows } from '@lib/project/timing'
import { runsToPlainText } from '@lib/project/runs'
import { isAudioStale } from '@lib/project/vtt'
import type { VoiceoverCue } from '@lib/project/schema'
import { useVideoStore } from '../../state/videoStore'
import { BACKING_W } from './layoutCanvas'
import { SlideThumbnail } from './SlideThumbnail'

const EMPTY: VoiceoverCue[] = []

// Vertical bands (px). The track is one tall relative box; everything inside is
// positioned absolutely by project time (x) and band (y).
const LEADERS_H = 140 // voiceover labels + lines hang here, above the ruler
const AXIS_H = 22
const SECTIONS_H = 72
const THUMBS_H = 84
const TRACK_H = LEADERS_H + AXIS_H + SECTIONS_H + THUMBS_H
const END_PAD = 90 // breathing room past the project end

// Leader-line staircase so adjacent cues don't collide.
const LEADER_BASE = 26
const LEADER_STEP = 28
const LEADER_LEVELS = 4

// Below these section widths, fine detail (labels, hold/transition tints, thumbs)
// is hidden — only legible when there's room to read it.
const DETAIL_MIN_W = 46
// Displayed thumbnail height — keep in sync with `.tl-thumb .slide-thumb-canvas` in styles.css.
const THUMB_DISP_H = 62

const clampPxPerSec = (v: number) => Math.min(600, Math.max(6, v))

/** Pick a "nice" major-tick spacing (sec) so ticks land ~targetPx apart. */
function niceStepSec(pxPerSec: number, targetPx = 96): number {
  const target = targetPx / pxPerSec
  const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
  for (const s of nice) if (s >= target) return s
  return nice[nice.length - 1]
}

function fmtAxis(sec: number): string {
  if (sec >= 60) {
    const m = Math.floor(sec / 60)
    const s = Math.round(sec % 60)
    return `${m}:${String(s).padStart(2, '0')}`
  }
  return Number.isInteger(sec) ? `${sec}s` : `${sec.toFixed(1)}s`
}

/** A one-line, whitespace-collapsed label for a cue (or its textbox). */
const cueLabel = (text: string): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length ? t : '(empty)'
}

/**
 * Full-width voiceover timeline. Slide **sections** partition the project's real
 * time; inside each, numbered **textbox bars** show the writing, plus the **hold**
 * and (overlapping) closing **transition**. Voiceover **leader lines** hang above
 * the ruler and can be dragged to re-time their cues. Zoom + horizontal scroll.
 * Everything is plain DOM (crisp text + hover + drag), scaled to real project time.
 */
export function TimelineView({ fonts }: { fonts: FontSet }) {
  const project = useVideoStore((s) => s.project)
  const cues = useVideoStore((s) => s.project?.voiceover ?? EMPTY)
  const updateCue = useVideoStore((s) => s.updateCue)
  const addCue = useVideoStore((s) => s.addCue)
  const selectSlide = useVideoStore((s) => s.selectSlide)

  const [pxPerSec, setPxPerSec] = useState(80)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pxPerSecRef = useRef(pxPerSec)
  const spaceRef = useRef(false)
  const hoverRef = useRef(false)
  const anchorRef = useRef<{ timeSec: number; offsetX: number } | null>(null)
  pxPerSecRef.current = pxPerSec

  const playbackRate = project?.playbackRate ?? 1
  // rc (slide layout + timing) depends only on the SLIDES, not the voiceover — so
  // dragging/adding/removing a cue doesn't re-lay-out the whole timeline. `slides`
  // stays referentially equal across voiceover edits (updateCue spreads the project).
  const rc = useMemo(
    () => (project ? buildRenderContext(project, fonts, BACKING_W, playbackRate) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.slides, project?.baseEmFraction, fonts, playbackRate],
  )
  const windows = useMemo(() => (rc ? slideTimeWindows(rc.timing) : []), [rc])
  const sortedCues = useMemo(() => [...cues].sort((a, b) => a.startMs - b.startMs), [cues])
  const xOf = useCallback((ms: number) => (ms / 1000) * pxPerSec, [pxPerSec])

  // Track whether Space is held (Space + wheel scrolls horizontally). Suppress the
  // page's space-scroll only while the timeline is hovered.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = true
        if (hoverRef.current) e.preventDefault()
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = false
    }
    // Don't leave Space "stuck" if the window loses focus mid-press (the keyup
    // would go to another window).
    const clear = () => (spaceRef.current = false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [])

  // Mouse wheel over the track zooms toward the cursor; Space/Shift + wheel scrolls
  // left/right. Native non-passive listener so we can preventDefault the page scroll.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
      // Space/Shift + wheel, or a natural two-finger horizontal swipe → pan left/right.
      if (spaceRef.current || e.shiftKey || horizontal) {
        e.preventDefault()
        el.scrollLeft += horizontal ? e.deltaX : e.deltaY
        return
      }
      if (e.deltaY === 0) return // no vertical intent → nothing to zoom
      e.preventDefault()
      const cur = pxPerSecRef.current
      const offsetX = e.clientX - el.getBoundingClientRect().left
      const timeSec = (el.scrollLeft + offsetX) / cur
      const next = clampPxPerSec(cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
      if (next === cur) return
      anchorRef.current = { timeSec, offsetX }
      setPxPerSec(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // After a zoom re-lays out the track at the new scale, keep the time that was
  // under the cursor in place (anchored zoom).
  useEffect(() => {
    const el = scrollRef.current
    const a = anchorRef.current
    if (!el || !a) return
    el.scrollLeft = a.timeSec * pxPerSec - a.offsetX
    anchorRef.current = null
  }, [pxPerSec])

  const totalMs = rc ? rc.timing.totalMs : 0

  const fit = () => {
    const el = scrollRef.current
    if (!el || totalMs <= 0) return
    setPxPerSec(clampPxPerSec((el.clientWidth - END_PAD - 16) / (totalMs / 1000)))
  }

  // Double-click empty space in the leaders band → add a cue at that time.
  const onLeadersDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ms = Math.max(0, ((e.clientX - rect.left) / pxPerSec) * 1000)
    addCue(Math.round(ms))
  }

  if (!project || !rc) return <div className="timelineview"><div className="placeholder">No project.</div></div>

  const trackWidth = Math.max(360, xOf(totalMs) + END_PAD)
  const thumbW = THUMB_DISP_H / aspectHeightUnits(project.aspect) // rendered thumbnail width (aspect-aware)
  const stepSec = niceStepSec(pxPerSec)
  const ticks: number[] = []
  for (let t = 0; t <= totalMs / 1000 + 1e-6; t += stepSec) ticks.push(t)

  return (
    <div className="timelineview">
      <div className="tl-toolbar">
        <span className="tl-title">Timeline</span>
        <span className="muted">
          {(totalMs / 1000).toFixed(1)}s · {project.slides.length} slide(s) · {cues.length} cue(s)
        </span>
        <div className="spacer" />
        <span className="muted tl-zoom-label">zoom</span>
        <button className="tool" onClick={() => setPxPerSec((v) => clampPxPerSec(v / 1.4))} title="zoom out">−</button>
        <button className="tool" onClick={() => setPxPerSec((v) => clampPxPerSec(v * 1.4))} title="zoom in">＋</button>
        <button className="tool" onClick={fit} title="fit to width">Fit</button>
      </div>

      <div
        className="tl-scroll"
        ref={scrollRef}
        onMouseEnter={() => (hoverRef.current = true)}
        onMouseLeave={() => (hoverRef.current = false)}
      >
        <div className="tl-track" style={{ width: trackWidth, height: TRACK_H }}>
          {/* P4 — voiceover leader lines */}
          <div
            className="tl-leaders"
            style={{ height: LEADERS_H, width: trackWidth }}
            onDoubleClick={onLeadersDoubleClick}
            title="double-click to add a cue"
          >
            {sortedCues.map((c, i) => (
              <LeaderLine
                key={c.id}
                cue={c}
                level={i % LEADER_LEVELS}
                leftPx={xOf(c.startMs)}
                pxPerSec={pxPerSec}
                onMove={updateCue}
              />
            ))}
          </div>

          {/* time ruler */}
          <div className="tl-axis" style={{ top: LEADERS_H, height: AXIS_H }}>
            {ticks.map((t) => (
              <div key={t} className="tl-tick" style={{ left: xOf(t * 1000) }}>
                <span className="tl-tick-label">{fmtAxis(t)}</span>
              </div>
            ))}
          </div>

          {/* P3 — slide sections (background + writing bars + hold) */}
          <div className="tl-sections" style={{ top: LEADERS_H + AXIS_H, height: SECTIONS_H }}>
            {windows.map((win, i) => {
              const st = rc.timing.slides[i].timing
              const left = xOf(win.startMs)
              const width = xOf(win.endMs) - left
              const detail = width > DETAIL_MIN_W
              const slide = project.slides[i]
              return (
                <div
                  key={win.slideId}
                  className={i % 2 === 0 ? 'tl-section even' : 'tl-section odd'}
                  style={{ left, width }}
                  onClick={() => selectSlide(win.slideId)}
                  title={
                    st.transitionMs > 0 && slide
                      ? `Slide ${i + 1} — ${slide.transition.kind} transition`
                      : `Slide ${i + 1}`
                  }
                >
                  {detail && <div className="tl-section-label">Slide {i + 1}</div>}
                  {detail && st.holdEndMs > st.contentEndMs && (
                    <div
                      className="tl-hold"
                      style={{ left: xOf(st.contentEndMs), width: xOf(st.holdEndMs - st.contentEndMs) }}
                      title="hold before transition"
                    />
                  )}
                  {st.boxes.map((b, bi) => {
                    const box = slide?.textBoxes.find((x) => x.id === b.boxId)
                    const bw = xOf(b.endMs - b.startMs)
                    const text = box ? cueLabel(runsToPlainText(box.runs)) : ''
                    return (
                      <div
                        key={b.boxId}
                        className="tl-box"
                        style={{ left: xOf(b.startMs), width: Math.max(3, bw) }}
                        title={`${bi + 1}. ${text}`}
                      >
                        {detail && bw > 26 && (
                          <span className="tl-box-label">
                            {bi + 1}. {text}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>

          {/* closing transitions — drawn on top, bleed into the next section (real overlap) */}
          <div className="tl-transitions" style={{ top: LEADERS_H + AXIS_H, height: SECTIONS_H }}>
            {windows.map((win, i) => {
              const st = rc.timing.slides[i].timing
              if (st.transitionMs <= 0) return null
              const projStart = rc.timing.slides[i].startMs
              const left = xOf(projStart + st.holdEndMs)
              const width = xOf(st.transitionMs)
              const kind = project.slides[i].transition.kind
              return (
                <div key={win.slideId} className="tl-transition" style={{ left, width }}>
                  {width > 40 && <span className="tl-transition-label">{kind}</span>}
                </div>
              )
            })}
          </div>

          {/* slide screenshots floating below wide-enough sections */}
          <div className="tl-thumbs" style={{ top: LEADERS_H + AXIS_H + SECTIONS_H, height: THUMBS_H }}>
            {windows.map((win, i) => {
              const left = xOf(win.startMs)
              const width = xOf(win.endMs) - left
              const slide = project.slides[i]
              if (width < thumbW + 8 || !slide) return null
              return (
                <div key={win.slideId} className="tl-thumb" style={{ left: left + 4 }}>
                  <SlideThumbnail slide={slide} fonts={fonts} />
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <p className="hint">
        Each slide is a section: numbered bars are the textbox writing, the striped block is the hold, and the
        red overlay is the closing transition (it bleeds into the next slide — they overlap on screen).
        Voiceover cues hang above as leader lines — <b>drag</b> one to re-time it, <b>double-click</b> empty
        space to add one; the bar to the right of a line shows its generated audio length (yellow = ready,
        amber/hatched = stale → regenerate). Zoom with
        the <b>mouse wheel</b> (or −/＋/Fit); <b>Space</b>+wheel scrolls left/right.
      </p>
    </div>
  )
}

/**
 * One voiceover cue as a labelled leader line above the ruler. The line rises to a
 * staircase level (so neighbours don't overlap); hovering brings it to front and
 * reveals a drag handle. Dragging the label or handle re-times the cue live
 * (preserving its duration), as a single undo step.
 */
function LeaderLine({
  cue,
  level,
  leftPx,
  pxPerSec,
  onMove,
}: {
  cue: VoiceoverCue
  level: number
  leftPx: number
  pxPerSec: number
  onMove: (id: string, patch: Partial<VoiceoverCue>) => void
}) {
  const lineLen = LEADER_BASE + level * LEADER_STEP
  // Audio state, mirrored from the VTT view: fresh = green tint + bright bar;
  // stale (text changed) = amber tint + hatched bar (regenerate); none = nothing.
  const stale = !!cue.audio && isAudioStale(cue)
  const fresh = !!cue.audio && !stale
  const dur = cue.audio ? (cue.audio.durationMs / 1000).toFixed(1) : '0'
  const dragRef = useRef<{ x0: number; start0: number; dur: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dragDeltaPx, setDragDeltaPx] = useState(0)

  // Dragging manipulates ONLY this line (a cheap CSS transform); the cue model
  // (and therefore the VTT + the whole timeline layout) is written exactly once on
  // release — so the timeline isn't re-laid-out on every pointermove. A single
  // commit is also one natural undo step, so no history pause/resume is needed.
  const clampDelta = (clientX: number, d: { x0: number; start0: number }) => {
    const delta = clientX - d.x0
    const minDelta = -(d.start0 / 1000) * pxPerSec // can't drag earlier than t=0
    return delta < minDelta ? minDelta : delta
  }
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    e.stopPropagation()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture unavailable (e.g. headless) — drag still tracks via window-relative move */
    }
    dragRef.current = { x0: e.clientX, start0: cue.startMs, dur: Math.max(0, cue.endMs - cue.startMs) }
    setDragging(true)
    setDragDeltaPx(0)
  }
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    if (!d) return
    setDragDeltaPx(clampDelta(e.clientX, d)) // local only — no store write
  }
  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    if (!d) return
    const delta = clampDelta(e.clientX, d)
    dragRef.current = null
    setDragging(false)
    setDragDeltaPx(0)
    if (Math.round(delta) !== 0) {
      const start = Math.max(0, Math.round(d.start0 + (delta / pxPerSec) * 1000))
      onMove(cue.id, { startMs: start, endMs: start + d.dur }) // the one write
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* never captured */
    }
  }
  // Gesture interrupted → abandon the drag and snap back (no write).
  const onPointerCancel = () => {
    dragRef.current = null
    setDragging(false)
    setDragDeltaPx(0)
  }
  const drag = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }

  return (
    <div
      className={dragging ? 'tl-leader dragging' : 'tl-leader'}
      style={{ left: leftPx, height: LEADERS_H, transform: dragDeltaPx ? `translateX(${dragDeltaPx}px)` : undefined }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div
        className={fresh ? 'tl-leader-label has-audio' : stale ? 'tl-leader-label stale-audio' : 'tl-leader-label'}
        style={{ bottom: lineLen }}
        title={cue.text}
        {...drag}
      >
        {cue.audio && (
          <span
            className={stale ? 'tl-leader-note stale' : 'tl-leader-note'}
            title={stale ? 'audio is stale — regenerate in the VTT view' : 'audio ready'}
          >
            ♪
          </span>
        )}
        <span className="tl-leader-text">{cueLabel(cue.text)}</span>
      </div>
      <div className="tl-leader-line" style={{ height: lineLen }} />
      {cue.audio && (
        <div
          className={stale ? 'tl-leader-audio stale' : 'tl-leader-audio'}
          style={{ width: Math.max(2, (cue.audio.durationMs / 1000) * pxPerSec) }}
          title={stale ? `stale audio ~${dur}s — regenerate` : `audio ${dur}s`}
        />
      )}
      <div className="tl-leader-handle" title="drag to re-time" {...drag} />
    </div>
  )
}

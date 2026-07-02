import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { aspectHeightUnits } from '@lib/project/coords'
import { projectForAspect } from '@lib/project/aspect'
import type { FontSet } from '@lib/project/layout'
import type { DrawingSet } from '@lib/drawing/render'
import { buildRenderContext } from '@lib/project/render'
import { slideTimeWindows } from '@lib/project/timing'
import { runsToPlainText } from '@lib/project/runs'
import { isAudioStale } from '@lib/project/vtt'
import type { VoiceoverCue } from '@lib/project/schema'
import { useVideoStore } from '../../state/videoStore'
import { prefGet, prefSetDebounced } from '../../state/sessionPrefs'
import { previewCanvasW } from './layoutCanvas'
import { SlideThumbnail } from './SlideThumbnail'
import {
  MIN_ENV_MS,
  applyEnvelopeResize,
  lozengeDrag,
  lozengeDragPatch,
  type EnvPatch,
  type LozengeDragKind,
} from './envelopeEdit'

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
export function TimelineView({ fonts, drawings }: { fonts: FontSet; drawings: DrawingSet }) {
  const project = useVideoStore((s) => s.project)
  const activeAspect = useVideoStore((s) => s.activeAspect)
  const cues = useVideoStore((s) => s.project?.voiceover ?? EMPTY)
  const addCue = useVideoStore((s) => s.addCue)
  const selectSlide = useVideoStore((s) => s.selectSlide)
  const translateCues = useVideoStore((s) => s.translateCues)
  const resizeElementTiming = useVideoStore((s) => s.resizeElementTiming)
  const scaleWithEnvelope = useVideoStore((s) => s.scaleWithEnvelope)
  const setScaleWithEnvelope = useVideoStore((s) => s.setScaleWithEnvelope)

  // Zoom lives in the (transient) store so it survives tab switches, and is
  // mirrored to a per-project pref so it survives refreshes. `tlZoom === null`
  // means "not initialized for this project yet" → restore from prefs.
  const tlZoom = useVideoStore((s) => s.tlZoom)
  const setTlZoom = useVideoStore((s) => s.setTlZoom)
  const projectId = project?.id
  const pxPerSec = tlZoom ?? (projectId ? clampPxPerSec(prefGet(`wb.tl.${projectId}`, { zoom: 80, scroll: 0 }).zoom) : 80)
  const setPxPerSec = useCallback(
    (next: number) => {
      setTlZoom(next)
      if (projectId) prefSetDebounced(`wb.tl.${projectId}`, { zoom: next, scroll: scrollRef.current?.scrollLeft ?? 0 })
    },
    [setTlZoom, projectId],
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pxPerSecRef = useRef(pxPerSec)
  const spaceRef = useRef(false)
  const hoverRef = useRef(false)
  const anchorRef = useRef<{ timeSec: number; offsetX: number } | null>(null)
  pxPerSecRef.current = pxPerSec

  // Restore the scroll position (store survives tab switches; prefs a refresh),
  // and keep both up to date as the user scrolls (no re-render — refs + store).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const st = useVideoStore.getState()
    el.scrollLeft = st.tlZoom != null ? st.tlScroll : projectId ? prefGet(`wb.tl.${projectId}`, { zoom: 80, scroll: 0 }).scroll : 0
    if (st.tlZoom == null) setTlZoom(pxPerSecRef.current) // mark initialized for this project
    const onScroll = () => {
      useVideoStore.getState().setTlScroll(el.scrollLeft)
      if (projectId) prefSetDebounced(`wb.tl.${projectId}`, { zoom: pxPerSecRef.current, scroll: el.scrollLeft })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const playbackRate = project?.playbackRate ?? 1
  // rc (slide layout + timing) depends only on the SLIDES, not the voiceover — so
  // dragging/adding/removing a cue doesn't re-lay-out the whole timeline. `slides`
  // stays referentially equal across voiceover edits (updateCue spreads the project).
  const rc = useMemo(
    () =>
      project
        ? buildRenderContext(projectForAspect(project, activeAspect), fonts, drawings, previewCanvasW(activeAspect), playbackRate)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.slides, project?.baseEmFraction, fonts, drawings, playbackRate, activeAspect],
  )
  const windows = useMemo(() => (rc ? slideTimeWindows(rc.timing) : []), [rc])
  const sortedCues = useMemo(() => [...cues].sort((a, b) => a.startMs - b.startMs), [cues])
  const xOf = useCallback((ms: number) => (ms / 1000) * pxPerSec, [pxPerSec])

  // --- voiceover multi-selection (marquee / modifier-click) + group drag -------
  // Selection is transient view state; the group drag is deferred-write like a
  // single leader drag: local deltaPx during the gesture, ONE translateCues write
  // on release (= one undo step).
  const [selectedCueIds, setSelectedCueIds] = useState<ReadonlySet<string>>(() => new Set())
  const [leaderDrag, setLeaderDrag] = useState<{ ids: ReadonlySet<string>; deltaPx: number } | null>(null)
  // pxPerSec is FROZEN at pointer-down so a wheel zoom mid-drag can't rescale the delta
  const leaderDragRef = useRef<{ ids: string[]; x0: number; minStartMs: number; additive: boolean; downId: string; pxPerSec: number } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; x1: number } | null>(null)
  const marqueeRef = useRef<{ x0: number; additive: boolean; moved: boolean } | null>(null)
  const isAdditive = (e: PointerEvent<HTMLElement>) => e.shiftKey || e.metaKey || e.ctrlKey

  const onLeaderDown = (cue: VoiceoverCue, e: PointerEvent<HTMLElement>) => {
    const additive = isAdditive(e)
    const inSelection = selectedCueIds.has(cue.id)
    // dragging a selected leader moves the whole selection; an unselected one moves alone
    const ids = inSelection ? [...selectedCueIds] : [cue.id]
    if (!inSelection && !additive) setSelectedCueIds(new Set([cue.id]))
    const minStartMs = ids.reduce((m, id) => Math.min(m, cues.find((c) => c.id === id)?.startMs ?? Infinity), cue.startMs)
    leaderDragRef.current = { ids, x0: e.clientX, minStartMs, additive, downId: cue.id, pxPerSec }
    setLeaderDrag({ ids: new Set(ids), deltaPx: 0 })
  }
  const leaderDelta = (d: NonNullable<typeof leaderDragRef.current>, clientX: number) =>
    Math.max(-(d.minStartMs / 1000) * d.pxPerSec, clientX - d.x0) // none of the group before t=0
  const onLeaderMove = (e: PointerEvent<HTMLElement>) => {
    const d = leaderDragRef.current
    if (!d) return
    if ((e.buttons & 1) === 0) return onLeaderCancel() // button already released — stale gesture
    setLeaderDrag({ ids: new Set(d.ids), deltaPx: leaderDelta(d, e.clientX) })
  }
  const onLeaderUp = (e: PointerEvent<HTMLElement>) => {
    const d = leaderDragRef.current
    leaderDragRef.current = null
    if (!d) return
    const deltaPx = leaderDelta(d, e.clientX)
    setLeaderDrag(null)
    if (Math.abs(deltaPx) < 3) {
      // a click, not a drag: plain = select only this cue; modifier = toggle it
      setSelectedCueIds((prev) => {
        if (!d.additive) return new Set([d.downId])
        const next = new Set(prev)
        if (next.has(d.downId)) next.delete(d.downId)
        else next.add(d.downId)
        return next
      })
      return
    }
    if (Math.round(deltaPx) !== 0) translateCues(d.ids, (deltaPx / d.pxPerSec) * 1000) // the one write
  }
  const onLeaderCancel = () => {
    leaderDragRef.current = null
    setLeaderDrag(null)
  }

  // Marquee over empty leaders-band space (an x-range; leaders are picked by their
  // start time). Plain click on empty space clears the selection.
  const onLeadersDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return // leaders swallow their own pointerdowns
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left
    marqueeRef.current = { x0: x, additive: isAdditive(e), moved: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture unavailable — window-relative move still tracks */
    }
    setMarquee({ x0: x, x1: x })
  }
  const onLeadersMove = (e: PointerEvent<HTMLDivElement>) => {
    const m = marqueeRef.current
    if (!m) return
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left
    if (Math.abs(x - m.x0) > 3) m.moved = true
    setMarquee({ x0: m.x0, x1: x })
  }
  const onLeadersUp = (e: PointerEvent<HTMLDivElement>) => {
    const m = marqueeRef.current
    marqueeRef.current = null
    if (!m) return
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left
    setMarquee(null)
    if (!m.moved) {
      if (!m.additive) setSelectedCueIds(new Set())
      return
    }
    const [lo, hi] = [Math.min(m.x0, x), Math.max(m.x0, x)]
    const hit = sortedCues.filter((c) => xOf(c.startMs) >= lo && xOf(c.startMs) <= hi).map((c) => c.id)
    setSelectedCueIds((prev) => (m.additive ? new Set([...prev, ...hit]) : new Set(hit)))
  }
  const onLeadersCancel = () => {
    marqueeRef.current = null
    setMarquee(null)
  }

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
  const thumbW = THUMB_DISP_H / aspectHeightUnits(activeAspect) // rendered thumbnail width (aspect-aware)
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
        <label
          className="toggle"
          title="Applies while dragging an envelope's right edge. Ticked: padding AND animation scale with the envelope. Unticked: the animation keeps its absolute length and padding absorbs the change."
        >
          <input type="checkbox" checked={scaleWithEnvelope} onChange={(e) => setScaleWithEnvelope(e.target.checked)} />
          scale with envelope
        </label>
        <span className="muted tl-zoom-label">zoom</span>
        {/* read the CURRENT zoom (store), not the render's — rapid clicks must all land */}
        <button className="tool" onClick={() => setPxPerSec(clampPxPerSec((useVideoStore.getState().tlZoom ?? pxPerSecRef.current) / 1.4))} title="zoom out">−</button>
        <button className="tool" onClick={() => setPxPerSec(clampPxPerSec((useVideoStore.getState().tlZoom ?? pxPerSecRef.current) * 1.4))} title="zoom in">＋</button>
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
            onPointerDown={onLeadersDown}
            onPointerMove={onLeadersMove}
            onPointerUp={onLeadersUp}
            onPointerCancel={onLeadersCancel}
            onLostPointerCapture={onLeadersCancel}
            title="double-click to add a cue · drag to marquee-select cues"
          >
            {sortedCues.map((c, i) => (
              <LeaderLine
                key={c.id}
                cue={c}
                level={i % LEADER_LEVELS}
                leftPx={xOf(c.startMs)}
                pxPerSec={pxPerSec}
                selected={selectedCueIds.has(c.id)}
                dragDeltaPx={leaderDrag?.ids.has(c.id) ? leaderDrag.deltaPx : null}
                onDown={onLeaderDown}
                onMove={onLeaderMove}
                onUp={onLeaderUp}
                onCancel={onLeaderCancel}
              />
            ))}
            {marquee && (
              <div
                className="tl-marquee"
                style={{ left: Math.min(marquee.x0, marquee.x1), width: Math.abs(marquee.x1 - marquee.x0) }}
              />
            )}
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
                  {[
                    ...st.boxes.map((b) => ({ ...b, id: b.boxId, kind: 'box' as const })),
                    ...st.drawings.map((d) => ({ ...d, kind: 'drawing' as const })),
                    ...st.inks.map((k) => ({ ...k, kind: 'ink' as const })),
                  ]
                    .sort((a, b) => a.startMs - b.startMs)
                    .map((it, bi) => {
                      const box = it.kind === 'box' ? slide?.textBoxes.find((x) => x.id === it.id) : undefined
                      const drawing = it.kind === 'drawing' ? slide?.drawings?.find((x) => x.id === it.id) : undefined
                      const ink = it.kind === 'ink' ? slide?.inks?.find((x) => x.id === it.id) : undefined
                      const el = box ?? drawing ?? ink
                      if (!el) return null
                      const text = box ? cueLabel(runsToPlainText(box.runs)) : ink ? `${ink.tool} ink` : drawing?.name ?? 'drawing'
                      const contentMs =
                        it.kind === 'box'
                          ? rc.layoutsBySlide.get(win.slideId)?.get(it.id)?.contentMs ?? 0
                          : it.kind === 'drawing'
                            ? rc.drawingsBySlide.get(win.slideId)?.get(it.id)?.prepared.totalMs ?? 0
                            : rc.inksBySlide.get(win.slideId)?.get(it.id)?.totalMs ?? 0
                      return (
                        <ElementBar
                          key={it.id}
                          it={it}
                          index={bi}
                          text={text}
                          detail={detail}
                          fixed={el.envelopeMs != null && el.envelopeMs > 0}
                          speed={el.speed}
                          contentMs={contentMs}
                          rate={playbackRate}
                          pxPerSec={pxPerSec}
                          scaleWithEnvelope={scaleWithEnvelope}
                          onCommit={(patch, envDeltaStoredMs) => {
                            // An envelope-length change shifts everything after this
                            // slide — move the audio over those slides by the same
                            // real delta, in the SAME write, so it stays locked.
                            const deltaReal = envDeltaStoredMs / playbackRate
                            resizeElementTiming(
                              win.slideId,
                              it.kind,
                              it.id,
                              patch,
                              Math.round(deltaReal) !== 0 ? { fromMs: win.endMs, deltaMs: deltaReal } : undefined,
                            )
                          }}
                        />
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
                  <SlideThumbnail slide={slide} fonts={fonts} drawings={drawings} />
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <p className="hint">
        Each slide is a section: numbered bars are the element envelopes, the solid block inside is the
        writing. <b>Drag the block</b> to slide it inside its envelope, <b>drag a block edge</b> to retime the
        animation (trades with the adjacent padding), and <b>drag the envelope's right edge</b> to resize it —
        everything after shifts, and <i>scale with envelope</i> (toolbar) decides whether the contents scale
        too. The striped block is the hold; the red overlay is the closing transition (it bleeds into the next
        slide). Voiceover cues hang above as leader lines — <b>drag</b> one to re-time it,{' '}
        <b>marquee-drag</b> empty space or <b>shift/⌘-click</b> to select several (they drag together),{' '}
        <b>double-click</b> empty space to add one; the bar to the right of a line shows its generated audio
        length (yellow = ready, amber/hatched = stale → regenerate). Resizing an envelope keeps the audio
        over LATER slides locked to them. Zoom with the <b>mouse wheel</b> (or −/＋/Fit); <b>Space</b>+wheel
        scrolls left/right.
      </p>
    </div>
  )
}

/** The slice of an element's slide-local timing the bar needs (real ms). */
interface ElementTiming {
  id: string
  kind: 'box' | 'drawing' | 'ink'
  startMs: number
  endMs: number
  animStartMs: number
  animEndMs: number
}

/**
 * One element's envelope bar in a slide section, with the animation block inside.
 * Direct manipulation, mirroring the Inspector's EnvelopeBar lozenge:
 *  - drag the **block** to slide it inside the envelope (trades the paddings);
 *  - drag a **block edge** to retime the animation against the adjacent padding;
 *  - drag the **envelope's right edge** to resize the envelope itself — the
 *    global "scale with envelope" toggle picks the repartition mode, and
 *    everything after the element shifts when the write lands.
 * All drags are deferred-write like `LeaderLine`: pointermove only moves local
 * state (this bar re-renders; the timeline does NOT re-lay-out), the model is
 * written once on release (= one undo step, no history pause needed), and
 * pointercancel abandons the gesture. Timeline px are REAL time; stored values
 * are ×1 time — deltas convert via `rate` (the project playbackRate).
 */
function ElementBar({
  it,
  index,
  text,
  detail,
  fixed,
  speed,
  contentMs,
  rate,
  pxPerSec,
  scaleWithEnvelope,
  onCommit,
}: {
  it: ElementTiming
  index: number
  text: string
  detail: boolean
  /** whether the envelope is pinned (envelopeMs set) — display only. */
  fixed: boolean
  /** the element's stored speed (for the natural length in recovery previews). */
  speed: number | undefined
  /** the element's natural content time (×1 ms). */
  contentMs: number
  /** the project playbackRate — real ms × rate = stored (×1) ms. */
  rate: number
  pxPerSec: number
  scaleWithEnvelope: boolean
  /** `envDeltaStoredMs` is the envelope-length change (×1 ms; 0 for drags inside
   *  a pinned envelope) — the caller uses it to keep later slides' audio locked. */
  onCommit: (patch: EnvPatch, envDeltaStoredMs: number) => void
}) {
  // The committed partition in STORED (×1) ms — timing was divided by rate.
  const env0 = (it.endMs - it.startMs) * rate
  const startPad0 = (it.animStartMs - it.startMs) * rate
  const bubble0 = (it.animEndMs - it.animStartMs) * rate
  const pxPerStoredMs = pxPerSec / 1000 / rate

  const [live, setLive] = useState<{ env: number; startPad: number; bubble: number } | null>(null)
  // pxPerStoredMs is FROZEN at pointer-down — a wheel zoom mid-gesture must not
  // rescale the accumulated pixel delta.
  const dragRef = useRef<{ kind: LozengeDragKind | 'env'; x0: number; minBubble: number; pxPerStoredMs: number } | null>(null)
  // whether the last gesture actually moved — a plain click falls through to the
  // section's select-slide, matching the pre-interactive bars.
  const movedRef = useRef(false)

  const env = live?.env ?? env0
  const startPad = live?.startPad ?? startPad0
  const bubble = live?.bubble ?? bubble0
  const bw = Math.max(3, env * pxPerStoredMs)
  const blockLeft = env > 0 ? (startPad / env) * 100 : 0
  const blockW = env > 0 ? (bubble / env) * 100 : 0

  const basePartition = () => ({
    env: env0,
    startPad: startPad0,
    bubble: bubble0,
    endPad: Math.max(0, env0 - startPad0 - bubble0),
    contentMs,
    naturalMs: contentMs / (speed && speed > 0 ? speed : 1),
  })
  const liveFor = (d: NonNullable<typeof dragRef.current>, clientX: number) => {
    const deltaMs = (clientX - d.x0) / d.pxPerStoredMs
    if (d.kind === 'env') {
      const newEnv = Math.max(MIN_ENV_MS, env0 + deltaMs)
      const v = applyEnvelopeResize(basePartition(), newEnv, scaleWithEnvelope)
      return { env: newEnv, startPad: v.startPad, bubble: v.bubble }
    }
    const v = lozengeDrag(d.kind, { env: env0, startPad0, bubble0, minBubble: d.minBubble }, deltaMs)
    return { env: env0, ...v }
  }

  const startDrag = (kind: NonNullable<typeof dragRef.current>['kind']) => (e: PointerEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if ((kind === 'left' || kind === 'right') && contentMs <= 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture unavailable — window-relative move still tracks */
    }
    const scale = pxPerStoredMs > 0 ? pxPerStoredMs : 1
    dragRef.current = { kind, x0: e.clientX, minBubble: 2 / scale, pxPerStoredMs: scale }
    movedRef.current = false
    setLive({ env: env0, startPad: startPad0, bubble: bubble0 })
  }
  const onMove = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    if (!d) return
    if ((e.buttons & 1) === 0) return cancelDrag() // button already released — stale gesture
    if (Math.abs(e.clientX - d.x0) >= 3) movedRef.current = true
    setLive(liveFor(d, e.clientX))
  }
  const endDrag = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    const v = liveFor(d, e.clientX)
    setLive(null)
    if (d.kind === 'env') {
      // the one write — subsequent elements/slides shift when timing recomputes
      if (Math.round(v.env) !== Math.round(env0)) {
        onCommit(applyEnvelopeResize(basePartition(), v.env, scaleWithEnvelope).patch, v.env - env0)
      }
      return
    }
    const patch = lozengeDragPatch(d.kind, env0, { startPad: startPad0, bubble: bubble0 }, v, contentMs)
    // an in-place click (nothing moved) shouldn't pin an auto envelope
    if (patch.delayBeforeMs != null || patch.speed != null) onCommit(patch, 0)
  }
  const cancelDrag = () => {
    dragRef.current = null
    setLive(null)
  }
  const drag = { onPointerMove: onMove, onPointerUp: endDrag, onPointerCancel: cancelDrag, onLostPointerCapture: cancelDrag }
  // Swallow the click only after a real drag; a plain click bubbles to the
  // section and selects the slide (the bars' pre-interactive behavior).
  const swallowClick = (e: MouseEvent<HTMLElement>) => {
    if (movedRef.current) e.stopPropagation()
  }

  // Grip mounting is gated on the COMMITTED geometry — live-value gates would
  // unmount the grip holding pointer capture mid-shrink, stranding the gesture.
  const bw0 = Math.max(3, env0 * pxPerStoredMs)
  const blockPx0 = bubble0 * pxPerStoredMs
  return (
    <div
      className={
        (it.kind === 'drawing' ? 'tl-box tl-draw' : it.kind === 'ink' ? 'tl-box tl-ink' : 'tl-box') +
        (fixed ? ' tl-fixed' : '') +
        (live ? ' dragging' : '')
      }
      style={{ left: (it.startMs / 1000) * pxPerSec, width: bw }}
      title={`${index + 1}. ${text}${fixed ? ` — fixed ${(env0 / rate / 1000).toFixed(1)}s envelope` : ''}`}
    >
      <div
        className="tl-box-block"
        style={{ left: `${blockLeft}%`, width: `${Math.max(1, blockW)}%` }}
        title="the writing — drag to slide it inside its envelope"
        onPointerDown={startDrag('body')}
        onClick={swallowClick}
        {...drag}
      >
        {contentMs > 0 && blockPx0 >= 16 && (
          <>
            <span className="tl-blockgrip left" title="retime the writing — keeps the end padding" onPointerDown={startDrag('left')} onClick={swallowClick} {...drag} />
            <span className="tl-blockgrip right" title="retime the writing — keeps the start padding" onPointerDown={startDrag('right')} onClick={swallowClick} {...drag} />
          </>
        )}
      </div>
      {detail && bw > 26 && (
        <span className="tl-box-label">
          {fixed ? '⧖ ' : ''}
          {index + 1}. {text}
        </span>
      )}
      {bw0 >= 10 && (
        <span
          className="tl-envgrip"
          title="resize the time envelope — everything after it shifts; 'scale with envelope' picks whether the writing scales too"
          onPointerDown={startDrag('env')}
          onClick={swallowClick}
          {...drag}
        />
      )}
    </div>
  )
}

/**
 * One voiceover cue as a labelled leader line above the ruler. The line rises to a
 * staircase level (so neighbours don't overlap); hovering brings it to front and
 * reveals a drag handle. Selection and dragging are owned by the PARENT (so a
 * marquee/modifier-click selection drags as a group): this component only reports
 * pointer events and renders the parent-supplied drag transform. Dragging is a
 * cheap CSS transform; the cue model is written once on release (one undo step).
 */
function LeaderLine({
  cue,
  level,
  leftPx,
  pxPerSec,
  selected,
  dragDeltaPx,
  onDown,
  onMove,
  onUp,
  onCancel,
}: {
  cue: VoiceoverCue
  level: number
  leftPx: number
  pxPerSec: number
  selected: boolean
  /** the group drag's live offset when this cue is part of it; null otherwise. */
  dragDeltaPx: number | null
  onDown: (cue: VoiceoverCue, e: PointerEvent<HTMLElement>) => void
  onMove: (e: PointerEvent<HTMLElement>) => void
  onUp: (e: PointerEvent<HTMLElement>) => void
  onCancel: () => void
}) {
  const lineLen = LEADER_BASE + level * LEADER_STEP
  // Audio state, mirrored from the VTT view: fresh = green tint + bright bar;
  // stale (text changed) = amber tint + hatched bar (regenerate); none = nothing.
  const stale = !!cue.audio && isAudioStale(cue)
  const fresh = !!cue.audio && !stale
  const dur = cue.audio ? (cue.audio.durationMs / 1000).toFixed(1) : '0'

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    e.stopPropagation() // keep the leaders band's marquee out of it
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture unavailable (e.g. headless) — drag still tracks via window-relative move */
    }
    onDown(cue, e)
  }
  const drag = { onPointerDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onCancel, onLostPointerCapture: onCancel }
  const dragging = dragDeltaPx != null

  return (
    <div
      className={'tl-leader' + (dragging ? ' dragging' : '') + (selected ? ' selected' : '')}
      style={{ left: leftPx, height: LEADERS_H, transform: dragging && dragDeltaPx ? `translateX(${dragDeltaPx}px)` : undefined }}
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
      <div className="tl-leader-handle" title="drag to re-time (a selection moves together)" {...drag} />
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { canvasSize } from '@lib/project/coords'
import type { Aspect } from '@lib/project/schema'
import { BACKING_W } from './layoutCanvas'

const END_HOLD_MS = 500

/** A voiceover clip to play, in the SAME time base as the playback clock (ms). */
export interface AudioCue {
  id: string
  startMs: number
  endMs: number
  url: string
}

/**
 * Reusable playback surface: a canvas driven by a single rAF that calls
 * `draw(ctx, tMs, w, h)` every frame, plus transport (play/pause/restart/scrub/
 * speed/loop). The owner supplies `draw` (renderSlide or renderProject), the
 * total duration, the aspect, and a `resetKey` that rewinds playback when the
 * thing being played changes. Scrub for a deterministic frame.
 */
export function PlaybackCanvas({
  aspect,
  totalMs,
  ready,
  resetKey,
  draw,
  speed,
  onSpeedChange,
  audioCues,
  autoPlay = false,
  notReadyHint = 'extracting…',
  emptyHint,
}: {
  aspect: Aspect
  totalMs: number
  ready: boolean
  resetKey: string
  draw: (ctx: CanvasRenderingContext2D, tMs: number, w: number, h: number) => void
  /** Playback/export speed multiplier (project-level). */
  speed: number
  onSpeedChange: (v: number) => void
  /** Voiceover clips to play in sync (same time base as the clock). */
  audioCues?: AudioCue[]
  /** Start playing automatically once content is ready (resets per `resetKey`). */
  autoPlay?: boolean
  notReadyHint?: string
  emptyHint?: string
}) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const [progress, setProgress] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawRef = useRef(draw)
  const totalRef = useRef(totalMs)
  const aspectRef = useRef<Aspect>(aspect)
  const tRef = useRef(0)
  const playingRef = useRef(false)
  const loopRef = useRef(true)

  const audioRef = useRef<AudioCue[]>(audioCues ?? [])
  const audioElsRef = useRef<Map<string, { el: HTMLAudioElement; url: string }>>(new Map())

  drawRef.current = draw
  totalRef.current = totalMs
  aspectRef.current = aspect
  playingRef.current = isPlaying
  loopRef.current = loop
  audioRef.current = audioCues ?? []

  // Keep one <audio> per cue, src in sync. Pause + drop removed cues.
  useEffect(() => {
    const els = audioElsRef.current
    const ids = new Set((audioCues ?? []).map((c) => c.id))
    for (const [id, entry] of els) {
      if (!ids.has(id)) {
        entry.el.pause()
        els.delete(id)
      }
    }
    for (const c of audioCues ?? []) {
      let entry = els.get(c.id)
      if (!entry) {
        const el = new Audio()
        el.preload = 'auto'
        entry = { el, url: '' }
        els.set(c.id, entry)
      }
      if (entry.url !== c.url) {
        entry.el.src = c.url
        entry.url = c.url
      }
    }
  }, [audioCues])
  // Pause all audio on unmount.
  useEffect(() => () => audioElsRef.current.forEach(({ el }) => el.pause()), [])

  // Tracks whether we've auto-started for the current `resetKey`, so a manual
  // pause isn't overridden and we don't loop-restart on every re-render.
  const autoStartedRef = useRef(false)

  // Rewind when the played content changes (slide selection / play scope).
  useEffect(() => {
    tRef.current = 0
    setProgress(0)
    setIsPlaying(false)
    autoStartedRef.current = false
  }, [resetKey])

  // Auto-start once content is ready (e.g. opening the Play view should just play).
  useEffect(() => {
    if (autoPlay && ready && totalMs > 0 && !autoStartedRef.current) {
      autoStartedRef.current = true
      tRef.current = 0
      setProgress(0)
      setIsPlaying(true)
    }
  }, [autoPlay, ready, totalMs, resetKey])

  // Single rAF loop, driven by refs (deterministic when scrubbing).
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let lastProg = 0
    const tick = (now: number) => {
      const dt = now - last
      last = now
      const canvas = canvasRef.current
      if (canvas) {
        const total = totalRef.current
        if (playingRef.current && total > 0) {
          // Real time — speed is already baked into the timeline (rc).
          tRef.current += dt
          if (tRef.current >= total + END_HOLD_MS) {
            if (loopRef.current) tRef.current = 0
            else {
              tRef.current = total
              playingRef.current = false
              setIsPlaying(false)
            }
          }
        }
        const { w, h } = canvasSize(aspectRef.current, BACKING_W)
        if (canvas.width !== w) canvas.width = w
        if (canvas.height !== h) canvas.height = h
        const ctx = canvas.getContext('2d')
        if (ctx) drawRef.current(ctx, tRef.current, w, h)
        // schedule voiceover audio against the playback clock
        const t = tRef.current
        for (const c of audioRef.current) {
          const entry = audioElsRef.current.get(c.id)
          if (!entry) continue
          const el = entry.el
          if (playingRef.current && t >= c.startMs && t < c.endMs) {
            const target = (t - c.startMs) / 1000
            if (el.paused) {
              try {
                el.currentTime = Math.max(0, target)
              } catch {
                /* not seekable yet */
              }
              void el.play().catch(() => {})
            } else if (Math.abs(el.currentTime - target) > 0.35) {
              try {
                el.currentTime = Math.max(0, target)
              } catch {
                /* ignore */
              }
            }
          } else if (!el.paused) {
            el.pause()
          }
        }
        if (now - lastProg > 80) {
          lastProg = now
          setProgress(tRef.current)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const onScrub = (v: number) => {
    tRef.current = v
    setProgress(v)
    setIsPlaying(false)
  }
  const canPlay = ready && totalMs > 0

  return (
    <>
      <div className="stage stage-overlay video-stage">
        <canvas
          ref={canvasRef}
          className="slide-canvas-el"
          width={canvasSize(aspect, BACKING_W).w}
          height={canvasSize(aspect, BACKING_W).h}
        />
      </div>
      <div className="transport">
        <div className="transport-row">
          <button
            onClick={() => {
              if (tRef.current >= totalMs) tRef.current = 0
              setIsPlaying((p) => !p)
            }}
            disabled={!canPlay}
          >
            {isPlaying ? '❚❚ Pause' : '▶ Play'}
          </button>
          <button
            onClick={() => {
              tRef.current = 0
              setProgress(0)
              setIsPlaying(canPlay)
            }}
            disabled={!canPlay}
          >
            ↺ Restart
          </button>
          <input
            type="range"
            className="scrubber"
            min={0}
            max={Math.max(1, totalMs)}
            step={1}
            value={Math.min(progress, totalMs)}
            onChange={(e) => onScrub(Number(e.target.value))}
            disabled={totalMs <= 0}
          />
          <span className="time">
            {(Math.min(progress, totalMs) / 1000).toFixed(1)}s / {(totalMs / 1000).toFixed(1)}s
          </span>
        </div>
        <div className="transport-row transport-row2">
          <label className="toggle">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
            Loop
          </label>
          <label className="speed-control">
            <span className="speed-label">
              speed <b>×{speed.toFixed(2)}</b> <span className="muted">(applies to the exported video)</span>
            </span>
            <input
              type="range"
              min={0.25}
              max={6}
              step={0.05}
              value={speed}
              onChange={(e) => onSpeedChange(Number(e.target.value))}
            />
          </label>
          {!ready && <span className="busy">{notReadyHint}</span>}
          {ready && totalMs <= 0 && emptyHint && <span className="busy">{emptyHint}</span>}
        </div>
      </div>
    </>
  )
}

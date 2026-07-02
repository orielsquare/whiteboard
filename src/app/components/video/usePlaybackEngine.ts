import { useEffect, useRef, useState } from 'react'
import { canvasSize } from '@lib/project/coords'
import type { Aspect } from '@lib/project/schema'
import { previewCanvasW } from './layoutCanvas'
import { nextAudioAction, type AudioCue } from './audioSync'

export type { AudioCue }

const END_HOLD_MS = 500

export interface PlaybackEngine {
  isPlaying: boolean
  progress: number
  totalMs: number
  loop: boolean
  setLoop: (v: boolean) => void
  toggle: () => void
  restart: () => void
  scrub: (v: number) => void
}

/**
 * Drives playback onto a SHARED canvas (the editor's own canvas). When `active`
 * (a playback scope is selected) it owns the canvas: a single rAF advances the
 * clock, sizes the canvas, calls `draw(ctx, t, w, h)`, and schedules voiceover
 * audio. When inactive it does nothing, leaving the canvas to the editor's static
 * draw. Becoming active (or a `resetKey`/scope change while active) rewinds to 0
 * and autoplays. Extracted from the old PlaybackCanvas so the transport can be a
 * permanent, separate control.
 */
export function usePlaybackEngine(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  {
    draw,
    totalMs,
    aspect,
    active,
    resetKey,
    audioCues,
    speed = 1,
  }: {
    draw: (ctx: CanvasRenderingContext2D, tMs: number, w: number, h: number) => void
    totalMs: number
    aspect: Aspect
    active: boolean
    resetKey: string
    audioCues?: AudioCue[]
    /** preview-only clock multiplier (a playback aid — the timeline itself is
     *  real time). Voiceover <audio> plays at the same rate to stay in sync. */
    speed?: number
  },
): PlaybackEngine {
  const [isPlaying, setIsPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const [progress, setProgress] = useState(0)

  const tRef = useRef(0)
  const playingRef = useRef(false)
  const loopRef = useRef(true)
  const totalRef = useRef(totalMs)
  const drawRef = useRef(draw)
  const aspectRef = useRef(aspect)
  const speedRef = useRef(1)
  const audioRef = useRef<AudioCue[]>(audioCues ?? [])
  const audioElsRef = useRef<Map<string, { el: HTMLAudioElement; url: string }>>(new Map())
  // cues already triggered in the current play pass (so each plays once, no re-seek).
  const startedRef = useRef<Set<string>>(new Set())

  drawRef.current = draw
  totalRef.current = totalMs
  playingRef.current = isPlaying
  loopRef.current = loop
  aspectRef.current = aspect
  speedRef.current = speed > 0 ? speed : 1
  audioRef.current = audioCues ?? []

  // Keep one <audio> per cue, src in sync; drop removed cues.
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
  useEffect(() => () => audioElsRef.current.forEach(({ el }) => el.pause()), [])

  // Activate/deactivate + rewind on scope change: autoplay from 0 when active.
  useEffect(() => {
    tRef.current = 0
    setProgress(0)
    setIsPlaying(active)
    startedRef.current.clear()
    if (!active) audioElsRef.current.forEach(({ el }) => el.pause())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, resetKey])

  // Single rAF loop; only paints while active (else the editor owns the canvas).
  useEffect(() => {
    if (!active) return
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
          tRef.current += dt * speedRef.current // timeline is real time; speed only scales the preview clock
          if (tRef.current >= total + END_HOLD_MS) {
            if (loopRef.current) {
              tRef.current = 0
              startedRef.current.clear() // re-arm cues for the next loop
            } else {
              tRef.current = total
              playingRef.current = false
              setIsPlaying(false)
            }
          }
        }
        const { w, h } = canvasSize(aspectRef.current, previewCanvasW(aspectRef.current))
        if (canvas.width !== w) canvas.width = w
        if (canvas.height !== h) canvas.height = h
        const ctx = canvas.getContext('2d')
        if (ctx) drawRef.current(ctx, tRef.current, w, h)
        const t = tRef.current
        const started = startedRef.current
        for (const c of audioRef.current) {
          const entry = audioElsRef.current.get(c.id)
          if (!entry) continue
          const el = entry.el
          const action = nextAudioAction(c, t, playingRef.current, started.has(c.id))
          if (action.kind === 'start') {
            started.add(c.id)
            el.playbackRate = speedRef.current // keep the clip on the (scaled) clock
            try {
              el.currentTime = action.seekTo
            } catch {
              /* not seekable yet — it'll start from 0 once loaded */
            }
            void el.play().catch(() => {})
          } else if (action.kind === 'pause') {
            if (!el.paused) el.pause()
            started.delete(c.id) // re-arm so a loop / scrub / resume re-triggers it
          } else if (el.playbackRate !== speedRef.current) {
            // 'none' → already playing; just track a mid-clip speed change.
            el.playbackRate = speedRef.current
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
    return () => {
      cancelAnimationFrame(raf)
      audioElsRef.current.forEach(({ el }) => el.pause())
    }
  }, [active, canvasRef])

  return {
    isPlaying,
    progress,
    totalMs,
    loop,
    setLoop,
    toggle: () => {
      if (tRef.current >= totalMs) {
        tRef.current = 0
        startedRef.current.clear()
      }
      setIsPlaying((p) => !p)
    },
    restart: () => {
      tRef.current = 0
      setProgress(0)
      startedRef.current.clear()
      setIsPlaying(true)
    },
    scrub: (v: number) => {
      tRef.current = v
      setProgress(v)
      startedRef.current.clear()
      setIsPlaying(false)
    },
  }
}

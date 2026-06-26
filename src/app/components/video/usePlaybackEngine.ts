import { useEffect, useRef, useState } from 'react'
import { canvasSize } from '@lib/project/coords'
import type { Aspect } from '@lib/project/schema'
import { previewCanvasW } from './layoutCanvas'

const END_HOLD_MS = 500

/** A voiceover clip to play in the playback clock's time base (ms). */
export interface AudioCue {
  id: string
  startMs: number
  endMs: number
  url: string
}

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
  }: {
    draw: (ctx: CanvasRenderingContext2D, tMs: number, w: number, h: number) => void
    totalMs: number
    aspect: Aspect
    active: boolean
    resetKey: string
    audioCues?: AudioCue[]
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
  const audioRef = useRef<AudioCue[]>(audioCues ?? [])
  const audioElsRef = useRef<Map<string, { el: HTMLAudioElement; url: string }>>(new Map())

  drawRef.current = draw
  totalRef.current = totalMs
  playingRef.current = isPlaying
  loopRef.current = loop
  aspectRef.current = aspect
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
          tRef.current += dt // real time — speed is baked into the timeline
          if (tRef.current >= total + END_HOLD_MS) {
            if (loopRef.current) tRef.current = 0
            else {
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
      if (tRef.current >= totalMs) tRef.current = 0
      setIsPlaying((p) => !p)
    },
    restart: () => {
      tRef.current = 0
      setProgress(0)
      setIsPlaying(true)
    },
    scrub: (v: number) => {
      tRef.current = v
      setProgress(v)
      setIsPlaying(false)
    },
  }
}

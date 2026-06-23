import { useEffect, useRef, useState } from 'react'
import { extractionSig, type ExtractionParams, type GlyphExtractor } from '@lib/extraction'
import type { LoadedFont } from '@lib/font/load'
import { type BrushSettings, type BrushStyle } from '@lib/manifest/schema'
import { layoutText, prepareGlyph, sampleGlyph, type PreparedGlyph, type TextTimeline } from '@lib/animation/timeline'
import { paintStroke } from '@lib/render/brush'
import { type Transform } from '@lib/render/ribbon'
import { ensureGlyphDerived, useEditorStore } from '../state/store'

const INTER_CHAR_DELAY = 140
const END_HOLD_MS = 700
const BRUSH_STYLES: BrushStyle[] = ['chalk', 'ink', 'marker']

export function PreviewView({
  font,
  extractor,
  params,
  brush,
  onBrushChange,
  selectedChar,
}: {
  font: LoadedFont
  extractor: GlyphExtractor | null
  params: ExtractionParams
  brush: BrushSettings
  onBrushChange: (b: BrushSettings) => void
  selectedChar: string
}) {
  // Initialised to the shared selected char each time the tab is entered, while
  // still allowing a typed multi-character word.
  const [text, setText] = useState(selectedChar)
  const [speed, setSpeed] = useState(1)
  const [loop, setLoop] = useState(true)
  const [isPlaying, setIsPlaying] = useState(true)
  const [status, setStatus] = useState<'loading' | 'ready'>('loading')
  const [progress, setProgress] = useState(0)
  const [totalMs, setTotalMs] = useState(1)

  const manifestGlyphs = useEditorStore((s) => s.manifest?.glyphs)
  const manifestFontId = useEditorStore((s) => s.manifest?.metadata.fontId)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const timelineRef = useRef<TextTimeline | null>(null)
  const transformRef = useRef<Transform>({ scale: 1, ox: 0, oy: 0 })
  const tRef = useRef(0)
  const playingRef = useRef(true)
  const speedRef = useRef(1)
  const loopRef = useRef(true)
  const brushRef = useRef(brush)

  playingRef.current = isPlaying
  speedRef.current = speed
  loopRef.current = loop
  brushRef.current = brush

  // reset playback when the text changes
  useEffect(() => {
    tRef.current = 0
    setIsPlaying(true)
  }, [text])

  // ensure every character in the text is seeded/current in the shared manifest.
  // Gated on the loaded manifest belonging to the current font, so a font switch
  // can't commit the new font's glyphs into the old manifest.
  useEffect(() => {
    if (!extractor || manifestFontId !== font.hash) return
    let cancelled = false
    ;(async () => {
      for (const c of [...new Set(text)].filter((ch) => ch.trim().length > 0)) {
        if (cancelled) return
        await ensureGlyphDerived(extractor, c, params)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [text, extractor, params, manifestFontId, font.hash])

  // (re)build the timeline from the shared (possibly edited) manifest glyphs.
  // A glyph counts as "pending" if it's missing OR stale w.r.t. the current
  // params (and not manually edited) — so the status reflects an in-flight
  // re-derivation rather than showing stale geometry as ready.
  useEffect(() => {
    const sig = extractionSig(params)
    const map = new Map<string, PreparedGlyph>()
    let pending = false
    for (const c of [...new Set(text)].filter((ch) => ch.trim().length > 0)) {
      const cp = c.codePointAt(0)
      if (cp == null) continue
      const g = manifestGlyphs?.[String(cp)]
      if (g) {
        map.set(c, prepareGlyph(g))
        if (!g.edited && g.derivedSig !== sig) pending = true
      } else {
        pending = true
      }
    }
    const timeline = layoutText(text, map, INTER_CHAR_DELAY, font.unitsPerEm * 0.3)
    timelineRef.current = timeline
    transformRef.current = computeTransform(timeline, canvasRef.current)
    setTotalMs(Math.max(1, timeline.totalMs))
    setStatus(pending ? 'loading' : 'ready')
  }, [text, manifestGlyphs, font, params])

  // single rAF loop, driven by refs
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let lastProgress = 0
    const tick = (now: number) => {
      const dt = now - last
      last = now
      const tl = timelineRef.current
      if (tl) {
        if (playingRef.current) {
          tRef.current += dt * speedRef.current
          const end = tl.totalMs + END_HOLD_MS
          if (tRef.current >= end) {
            if (loopRef.current) tRef.current = 0
            else {
              tRef.current = tl.totalMs
              playingRef.current = false
              setIsPlaying(false)
            }
          }
        }
        drawFrame(canvasRef.current, tl, transformRef.current, tRef.current, brushRef.current, font.unitsPerEm)
        if (now - lastProgress > 80) {
          lastProgress = now
          setProgress(tRef.current)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [font])

  const onScrub = (v: number) => {
    tRef.current = v
    setProgress(v)
    setIsPlaying(false)
  }

  return (
    <div className="preview">
      <div className="preview-controls">
        <label className="field">
          <span>Holding text</span>
          <input value={text} onChange={(e) => setText(e.target.value)} style={{ minWidth: 140 }} />
        </label>
        <div className="field">
          <span>Brush</span>
          <div className="toolrow">
            {BRUSH_STYLES.map((st) => (
              <button
                key={st}
                className={brush.style === st ? 'tool tool-on' : 'tool'}
                onClick={() => onBrushChange({ ...brush, style: st })}
              >
                {st}
              </button>
            ))}
            <input type="color" value={brush.color} onChange={(e) => onBrushChange({ ...brush, color: e.target.value })} />
          </div>
        </div>
        <label className="field">
          <span>Speed ×{speed.toFixed(2)}</span>
          <input type="range" min={0.25} max={3} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
          Loop
        </label>
        {status === 'loading' && <span className="busy">extracting…</span>}
      </div>

      <div className="stage stage-overlay">
        <canvas ref={canvasRef} width={900} height={420} />
      </div>

      <div className="transport">
        <button onClick={() => setIsPlaying((p) => !p)}>{isPlaying ? '❚❚ Pause' : '▶ Play'}</button>
        <button
          onClick={() => {
            tRef.current = 0
            setProgress(0)
            setIsPlaying(true)
          }}
        >
          ↺ Restart
        </button>
        <input
          type="range"
          className="scrubber"
          min={0}
          max={totalMs}
          step={1}
          value={Math.min(progress, totalMs)}
          onChange={(e) => onScrub(Number(e.target.value))}
        />
        <span className="time">
          {(Math.min(progress, totalMs) / 1000).toFixed(1)}s / {(totalMs / 1000).toFixed(1)}s
        </span>
      </div>

      <p className="hint">
        Animates the holding text with the chosen brush (an applied style, not saved to the glyph),
        reflecting your per-glyph edits from the Editor.
      </p>
    </div>
  )
}

function computeTransform(tl: TextTimeline, canvas: HTMLCanvasElement | null): Transform {
  const W = canvas?.width ?? 900
  const H = canvas?.height ?? 420
  const m = 56
  const bw = Math.max(tl.bbox.w, 1)
  const bh = Math.max(tl.bbox.h, 1)
  const scale = Math.min((W - m * 2) / bw, (H - m * 2) / bh)
  const ox = (W - bw * scale) / 2 - tl.bbox.x * scale
  const oy = (H - bh * scale) / 2 - tl.bbox.y * scale
  return { scale, ox, oy }
}

function drawFrame(
  canvas: HTMLCanvasElement | null,
  tl: TextTimeline,
  base: Transform,
  t: number,
  brush: BrushSettings,
  unitsPerEm: number,
) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width
  const H = canvas.height
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = '#0b0d11'
  ctx.fillRect(0, 0, W, H)

  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(20, base.oy)
  ctx.lineTo(W - 20, base.oy)
  ctx.stroke()

  const minHalfWidth = unitsPerEm * 0.004
  for (const item of tl.items) {
    const tr: Transform = { scale: base.scale, ox: base.ox + item.xOffset * base.scale, oy: base.oy }
    const { reveals } = sampleGlyph(item.glyph, t - item.startMs)
    for (const r of reveals) {
      if (r.revealedLen <= 0 && !r.active) continue
      paintStroke(ctx, r.lut, r.revealedLen, tr, brush, minHalfWidth, r.id)
    }
  }
}

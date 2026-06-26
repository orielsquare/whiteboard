import { useEffect, useRef, useState } from 'react'
import type { LoadedFont } from '@lib/font/load'
import type { GlyphExtractor } from '@lib/extraction'
import type { GlyphAnimation } from '@lib/manifest/schema'
import { orderedSections } from '@lib/manifest/edit'
import { toCanvas } from '@lib/render/ribbon'
import { computeGlyphTransform } from './editorCanvas'
import { ensureGlyphDerived, useEditorStore } from '../state/store'

type GridMode = 'font' | 'strokes'

// Backing-store size (rendered at 2× the CSS cell for crispness on HiDPI).
const CELL = 112

/**
 * The Font tool's landing screen: every Unicode glyph in a scrolling grid. A
 * global Font/Strokes toggle flips all cells between the font outline and the
 * extracted pen-strokes. Clicking a cell opens that glyph (handled by App, which
 * routes to its last-visited view). Strokes are derived lazily as cells scroll
 * into view, so a large font never stalls the UI.
 */
export function GlyphGridView({
  font,
  extractor,
  chars,
  onPick,
}: {
  font: LoadedFont
  extractor: GlyphExtractor | null
  chars: string[]
  onPick: (c: string) => void
}) {
  const [mode, setMode] = useState<GridMode>('font')
  // Only derive into the store once its manifest belongs to THIS font — otherwise
  // a font switch (new extractor ready before the new manifest loads) could commit
  // the new font's strokes into the old font's manifest.
  const manifestFontId = useEditorStore((s) => s.manifest?.metadata.fontId)
  const ready = manifestFontId === font.hash
  return (
    <div className="glyphgrid">
      <div className="glyphgrid-controls">
        <span className="muted">{chars.length} glyphs</span>
        <div className="toolrow">
          <button className={mode === 'font' ? 'tool tool-on' : 'tool'} onClick={() => setMode('font')}>
            Font
          </button>
          <button className={mode === 'strokes' ? 'tool tool-on' : 'tool'} onClick={() => setMode('strokes')}>
            Strokes
          </button>
        </div>
        <span className="muted">click a glyph to open it</span>
      </div>
      <div className="glyphgrid-scroll">
        <div className="glyphgrid-cells">
          {chars.map((c) => (
            <GlyphCell key={c} char={c} font={font} extractor={extractor} mode={mode} ready={ready} onPick={onPick} />
          ))}
        </div>
      </div>
    </div>
  )
}

function GlyphCell({
  char,
  font,
  extractor,
  mode,
  ready,
  onPick,
}: {
  char: string
  font: LoadedFont
  extractor: GlyphExtractor | null
  mode: GridMode
  ready: boolean
  onPick: (c: string) => void
}) {
  const cp = char.codePointAt(0) ?? 0
  const key = String(cp)
  const glyph = useEditorStore((s) => s.manifest?.glyphs[key])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rootRef = useRef<HTMLButtonElement | null>(null)
  const [visible, setVisible] = useState(false)

  // Flag the cell visible (once) so strokes derive only when it's on screen.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setVisible(true)
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // Derive this glyph's strokes on demand once it's visible (strokes mode only),
  // and only into the manifest that belongs to this font.
  useEffect(() => {
    if (mode !== 'strokes' || !visible || !ready || !extractor || glyph) return
    void ensureGlyphDerived(extractor, char)
  }, [mode, visible, ready, extractor, glyph, char])

  // Paint the thumbnail — only once the cell is visible, so a large font doesn't
  // paint hundreds of off-screen thumbnails on mount. In strokes mode, fall back
  // to a faint outline until the strokes are derived, so a pending cell isn't blank.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !visible) return
    if (mode === 'font') drawFontThumb(canvas, font, char, '#e7e7ea')
    else if (glyph) drawStrokesThumb(canvas, glyph)
    else drawFontThumb(canvas, font, char, 'rgba(150,160,180,0.22)')
  }, [mode, glyph, font, char, visible])

  const status = glyph?.edited ? 'edited' : glyph?.reviewed ? 'reviewed' : ''
  const hex = cp.toString(16).toUpperCase().padStart(4, '0')
  return (
    <button ref={rootRef} className="glyphcell" title={`${char}  ·  U+${hex}`} onClick={() => onPick(char)}>
      <canvas ref={canvasRef} width={CELL} height={CELL} />
      {status && <span className={`gc-dot gc-${status}`} title={status} />}
      <span className="gc-label">{char}</span>
    </button>
  )
}

/** Draw the font's own outline for a character, centered and color-filled. */
function drawFontThumb(canvas: HTMLCanvasElement, font: LoadedFont, char: string, color: string) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width
  const H = canvas.height
  ctx.clearRect(0, 0, W, H)

  const path = font.font.getPath(char, 0, 0, H * 0.6)
  const bb = path.getBoundingBox()
  const gw = bb.x2 - bb.x1
  const gh = bb.y2 - bb.y1
  if (!(gw > 0) || !(gh > 0)) return // empty glyph (e.g. space)
  const scale = Math.min((W * 0.7) / gw, (H * 0.7) / gh, 1)

  ctx.save()
  ctx.translate(W / 2, H / 2)
  ctx.scale(scale, scale)
  ctx.translate(-(bb.x1 + gw / 2), -(bb.y1 + gh / 2))
  ctx.fillStyle = color
  ctx.beginPath()
  for (const c of path.commands) {
    if (c.type === 'M') ctx.moveTo(c.x, c.y)
    else if (c.type === 'L') ctx.lineTo(c.x, c.y)
    else if (c.type === 'C') ctx.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y)
    else if (c.type === 'Q') ctx.quadraticCurveTo(c.x1, c.y1, c.x, c.y)
    else if (c.type === 'Z') ctx.closePath()
  }
  ctx.fill('nonzero')
  ctx.restore()
}

/** Draw the extracted pen-strokes (variable width centerlines) for a glyph. */
function drawStrokesThumb(canvas: HTMLCanvasElement, glyph: GlyphAnimation) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width
  const H = canvas.height
  ctx.clearRect(0, 0, W, H)

  const tr = computeGlyphTransform(glyph.bbox, W, H, W * 0.16)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#d2d5de'
  for (const s of orderedSections(glyph)) {
    const pts = s.reversed ? [...s.points].reverse() : s.points
    if (pts.length < 2) continue
    for (let i = 1; i < pts.length; i++) {
      const a = toCanvas(tr, pts[i - 1].x, pts[i - 1].y)
      const b = toCanvas(tr, pts[i].x, pts[i].y)
      ctx.lineWidth = Math.max(1, ((pts[i - 1].width + pts[i].width) / 2) * tr.scale)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
  }
}

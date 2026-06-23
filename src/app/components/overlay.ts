import type { GlyphStrokes, Vec2 } from '@lib/extraction'

export interface OverlayOptions {
  outline: boolean
  skeleton: boolean
  nodes: boolean
  width: boolean
  arrows: boolean
  orderLabels: boolean
}

/** Draw the extraction debug overlay for one glyph onto a canvas. */
export function renderOverlay(canvas: HTMLCanvasElement, glyph: GlyphStrokes, opts: OverlayOptions) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width
  const H = canvas.height
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = '#0b0d11'
  ctx.fillRect(0, 0, W, H)

  const bbox = glyph.bbox
  const bw = Math.max(bbox.w, 1)
  const bh = Math.max(bbox.h, 1)
  const margin = 60
  const K = Math.min((W - margin * 2) / bw, (H - margin * 2) / bh)
  const offX = (W - bw * K) / 2
  const offY = (H - bh * K) / 2
  const toC = (p: Vec2): Vec2 => ({ x: (p.x - bbox.x) * K + offX, y: (p.y - bbox.y) * K + offY })

  // baseline (glyph y = 0)
  const baseY = (0 - bbox.y) * K + offY
  if (baseY > 0 && baseY < H) {
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(20, baseY)
    ctx.lineTo(W - 20, baseY)
    ctx.stroke()
    ctx.setLineDash([])
  }

  const debug = glyph.debug

  // 1. outline
  if (opts.outline && debug) {
    ctx.fillStyle = 'rgba(150,160,180,0.10)'
    ctx.strokeStyle = 'rgba(150,160,180,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const c of debug.outline) {
      if (c.points.length < 2) continue
      const p0 = toC(c.points[0])
      ctx.moveTo(p0.x, p0.y)
      for (let i = 1; i < c.points.length; i++) {
        const p = toC(c.points[i])
        ctx.lineTo(p.x, p.y)
      }
      ctx.closePath()
    }
    ctx.fill('nonzero')
    ctx.stroke()
  }

  // 2. raw skeleton bitmap
  if (opts.skeleton && debug) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    const { skeleton, maskWidth, maskHeight, scale, pad, originX, originY } = debug
    const r = Math.max(1, K / scale / 2)
    for (let y = 0; y < maskHeight; y++) {
      for (let x = 0; x < maskWidth; x++) {
        if (!skeleton[y * maskWidth + x]) continue
        const g = { x: (x - pad) / scale + originX, y: (y - pad) / scale + originY }
        const c = toC(g)
        ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2)
      }
    }
  }

  const orderPos = new Map<number, number>()
  glyph.order.forEach((sectionIdx, pos) => orderPos.set(sectionIdx, pos))
  const total = glyph.sections.length

  // 3. sections (in draw order so later strokes paint on top)
  for (const sectionIdx of glyph.order) {
    const s = glyph.sections[sectionIdx]
    if (s.points.length === 0) continue
    const pos = orderPos.get(sectionIdx) ?? 0
    const color = hue(pos, total)
    const drawPts = glyph.reversed[sectionIdx] ? [...s.points].reverse() : [...s.points]
    const drawW = glyph.reversed[sectionIdx] ? [...s.widths].reverse() : [...s.widths]

    // stroke body (variable width)
    if (opts.width && drawPts.length >= 2) {
      ctx.strokeStyle = fade(color, 0.22)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (let i = 1; i < drawPts.length; i++) {
        const a = toC(drawPts[i - 1])
        const b = toC(drawPts[i])
        ctx.lineWidth = Math.max(1, ((drawW[i - 1] + drawW[i]) / 2) * K)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    }

    // bright centerline
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    if (drawPts.length === 1) {
      const p = toC(drawPts[0])
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    } else {
      const p0 = toC(drawPts[0])
      ctx.moveTo(p0.x, p0.y)
      for (let i = 1; i < drawPts.length; i++) {
        const p = toC(drawPts[i])
        ctx.lineTo(p.x, p.y)
      }
      ctx.stroke()
    }

    // direction arrowhead at the draw end
    if (opts.arrows && drawPts.length >= 2) {
      const tip = toC(drawPts[drawPts.length - 1])
      const ref = toC(drawPts[Math.max(0, drawPts.length - 4)])
      drawArrow(ctx, ref, tip, color)
    }

    // order number at the draw start
    if (opts.orderLabels) {
      const start = toC(drawPts[0])
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(start.x, start.y, 9, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#0b0d11'
      ctx.font = 'bold 11px ui-sans-serif, system-ui'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(pos + 1), start.x, start.y + 0.5)
    }
  }

  // 4. nodes
  if (opts.nodes && debug) {
    for (const n of debug.nodes) {
      const c = toC(n)
      if (n.degree === 1) {
        ctx.fillStyle = '#4ade80' // endpoint — green
      } else if (n.degree >= 3) {
        ctx.fillStyle = '#fb923c' // junction — orange
      } else {
        continue
      }
      ctx.beginPath()
      ctx.arc(c.x, c.y, 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, from: Vec2, to: Vec2, color: string) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x)
  const size = 9
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - size * Math.cos(ang - 0.4), to.y - size * Math.sin(ang - 0.4))
  ctx.lineTo(to.x - size * Math.cos(ang + 0.4), to.y - size * Math.sin(ang + 0.4))
  ctx.closePath()
  ctx.fill()
}

function hue(pos: number, total: number): string {
  const h = total > 1 ? (pos / total) * 300 : 200
  return `hsl(${h}, 80%, 62%)`
}

function fade(hsl: string, alpha: number): string {
  return hsl.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`)
}

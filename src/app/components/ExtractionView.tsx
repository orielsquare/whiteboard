import { useEffect, useMemo, useRef, useState } from 'react'
import { type ExtractionParams, type GlyphExtractor, type GlyphStrokes } from '@lib/extraction'
import { renderOverlay, type OverlayOptions } from './overlay'
import { useEditorStore } from '../state/store'

const SAMPLE_CHARS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'r', 'o', 'e', 'a', '8', 'i']

const DEFAULT_VIEW: OverlayOptions = {
  outline: true,
  skeleton: false,
  nodes: true,
  width: true,
  arrows: true,
  orderLabels: true,
}

export function ExtractionView({
  extractor,
  params,
  onParamsChange,
  selectedChar,
  onSelectChar,
}: {
  extractor: GlyphExtractor | null
  params: ExtractionParams
  onParamsChange: (p: ExtractionParams) => void
  selectedChar: string
  onSelectChar: (c: string) => void
}) {
  const [glyph, setGlyph] = useState<GlyphStrokes | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<OverlayOptions>(DEFAULT_VIEW)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const key = String(selectedChar.codePointAt(0) ?? 0)
  const isEdited = useEditorStore((s) => s.manifest?.glyphs[key]?.edited ?? false)

  // Live, read-only extraction for the overlay (debug payload). This tab never
  // writes the manifest — re-derivation is centralised in App.
  useEffect(() => {
    if (!extractor) return
    let cancelled = false
    setBusy(true)
    // Debounced so dragging a parameter slider doesn't flood the shared worker.
    const timer = setTimeout(() => {
      extractor
        .extract(selectedChar, params, true)
        .then((g) => {
          if (cancelled) return
          setGlyph(g)
          setError(null)
        })
        .catch((e) => !cancelled && setError(String(e)))
        .finally(() => !cancelled && setBusy(false))
    }, 160)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [extractor, selectedChar, params])

  useEffect(() => {
    if (canvasRef.current && glyph) renderOverlay(canvasRef.current, glyph, view)
  }, [glyph, view])

  const orderPos = useMemo(() => {
    const map = new Map<number, number>()
    glyph?.order.forEach((sectionIdx, pos) => map.set(sectionIdx, pos))
    return map
  }, [glyph])

  return (
    <div className="extract">
      <div className="extract-controls">
        <label className="field">
          <span>Character</span>
          <input
            value={selectedChar}
            maxLength={2}
            onChange={(e) => onSelectChar(e.target.value || ' ')}
            style={{ width: 70 }}
          />
        </label>
        <div className="chips">
          {SAMPLE_CHARS.map((c, i) => (
            <button
              key={`${c}-${i}`}
              className={selectedChar === c ? 'chip chip-on' : 'chip'}
              onClick={() => onSelectChar(c)}
            >
              {c}
            </button>
          ))}
        </div>
        {busy && <span className="busy">extracting…</span>}
      </div>

      {isEdited && (
        <div className="warn">
          ⚠ This glyph has manual edits in the Editor. The overlay below shows the automatic
          extraction for the current params (a preview, not saved). Tuning params won't overwrite
          your edits — use <b>Reset glyph</b> in the Editor to re-derive from scratch.
        </div>
      )}

      <div className="extract-body">
        <div className="stage stage-overlay">
          <canvas ref={canvasRef} width={720} height={560} />
        </div>

        <aside className="inspector">
          <h3>View</h3>
          <div className="toggles">
            {(
              [
                ['outline', 'Outline'],
                ['skeleton', 'Raw skeleton'],
                ['nodes', 'Nodes'],
                ['width', 'Stroke width'],
                ['arrows', 'Direction'],
                ['orderLabels', 'Order #'],
              ] as [keyof OverlayOptions, string][]
            ).map(([k, label]) => (
              <label key={k} className="toggle">
                <input
                  type="checkbox"
                  checked={view[k]}
                  onChange={(e) => setView((v) => ({ ...v, [k]: e.target.checked }))}
                />
                {label}
              </label>
            ))}
          </div>

          <h3>Extraction</h3>
          <label className="slider">
            <span>
              Spur prune k <b>{params.pruneK.toFixed(2)}</b>
            </span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.05}
              value={params.pruneK}
              onChange={(e) => onParamsChange({ ...params, pruneK: Number(e.target.value) })}
            />
          </label>
          <label className="slider">
            <span>Raster resolution</span>
            <select
              value={params.targetInkPx}
              onChange={(e) => onParamsChange({ ...params, targetInkPx: Number(e.target.value) })}
            >
              <option value={128}>128 px</option>
              <option value={192}>192 px</option>
              <option value={256}>256 px</option>
              <option value={384}>384 px</option>
            </select>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={params.smooth}
              onChange={(e) => onParamsChange({ ...params, smooth: e.target.checked })}
            />
            Smooth (Catmull-Rom)
          </label>

          <h3>Sections{glyph ? ` (${glyph.sections.length})` : ''}</h3>
          {error && <div className="error">{error}</div>}
          {glyph?.warnings.map((w) => (
            <div key={w} className="warn">
              ⚠ {w}
            </div>
          ))}
          <ol className="sectionlist">
            {glyph?.order.map((sectionIdx) => {
              const s = glyph.sections[sectionIdx]
              const rev = glyph.reversed[sectionIdx]
              const pos = orderPos.get(sectionIdx) ?? 0
              return (
                <li key={s.id}>
                  <span className="swatch" style={{ background: hueFor(pos, glyph.sections.length) }} />
                  <span className="sk">{s.kind}</span>
                  <span className="muted">{s.points.length} pts</span>
                  {rev && <span className="rev">reversed</span>}
                  {s.componentId > 0 && <span className="muted">c{s.componentId}</span>}
                </li>
              )
            })}
          </ol>
        </aside>
      </div>
    </div>
  )
}

function hueFor(pos: number, total: number): string {
  const h = total > 1 ? (pos / total) * 300 : 200
  return `hsl(${h}, 80%, 60%)`
}

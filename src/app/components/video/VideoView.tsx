import { useEffect, useMemo, useState } from 'react'
import type { LoadedFont } from '@lib/font/load'
import { extractionSig, type ExtractionParams, type GlyphExtractor } from '@lib/extraction'
import type { BrushSettings, BrushStyle } from '@lib/manifest/schema'
import { prepareGlyph, type PreparedGlyph } from '@lib/animation/timeline'
import type { FontMetrics } from '@lib/project/layout'
import type { Aspect } from '@lib/project/schema'
import { projectStore, type ProjectSummary } from '@lib/persistence/ProjectStore'
import { ensureProjectGlyphsDerived, useVideoStore, videoHistory } from '../../state/videoStore'
import { useEditorStore } from '../../state/store'
import { SlidePanel } from './SlidePanel'
import { SlideCanvas } from './SlideCanvas'
import { Inspector } from './Inspector'

const ASPECTS: Aspect[] = ['16:9', '9:16']
const BRUSH_STYLES: BrushStyle[] = ['chalk', 'ink', 'marker']

export function VideoView({
  font,
  extractor,
  params,
  brush,
}: {
  font: LoadedFont
  extractor: GlyphExtractor | null
  params: ExtractionParams
  brush: BrushSettings
}) {
  const project = useVideoStore((s) => s.project)
  const newProject = useVideoStore((s) => s.newProject)
  const loadProject = useVideoStore((s) => s.loadProject)
  const saveProject = useVideoStore((s) => s.saveProject)
  const setAspect = useVideoStore((s) => s.setAspect)
  const setBaseEmFraction = useVideoStore((s) => s.setBaseEmFraction)
  const setBrush = useVideoStore((s) => s.setBrush)

  const [status, setStatus] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<
    { file: string; bytes: number; w: number; h: number; durationMs: number; frames: number } | null
  >(null)

  // The shared font manifest drives glyph geometry; gate derivation on it
  // belonging to the current font (as App + PreviewView do).
  const manifestGlyphs = useEditorStore((s) => s.manifest?.glyphs)
  const manifestMeta = useEditorStore((s) => s.manifest?.metadata)
  const manifestFontId = manifestMeta?.fontId

  // Prepared glyphs keyed by character, rebuilt only when the manifest changes.
  const glyphs = useMemo(() => {
    const m = new Map<string, PreparedGlyph>()
    if (!manifestGlyphs) return m
    for (const key of Object.keys(manifestGlyphs)) {
      const g = manifestGlyphs[key]
      try {
        m.set(g.char, prepareGlyph(g))
      } catch {
        /* malformed glyph — skip */
      }
    }
    return m
  }, [manifestGlyphs])

  const metrics: FontMetrics | null = useMemo(
    () =>
      manifestMeta
        ? { unitsPerEm: manifestMeta.unitsPerEm, ascender: manifestMeta.ascender, descender: manifestMeta.descender }
        : { unitsPerEm: font.unitsPerEm, ascender: font.font.ascender, descender: font.font.descender },
    [manifestMeta, font],
  )

  // Bootstrap a project on first entry.
  useEffect(() => {
    if (!useVideoStore.getState().project) {
      newProject(font.hash, brush)
      videoHistory.clear()
    }
  }, [font, brush, newProject])

  // Derive every character used in the project so it can render. Keyed on a
  // signature of the needed chars + extraction params (NOT the whole project),
  // so dragging/positioning doesn't re-trigger derivation every frame.
  const paramsSig = extractionSig(params)
  const charsSig = useMemo(() => {
    if (!project) return ''
    const set = new Set<string>()
    for (const sl of project.slides)
      for (const b of sl.textBoxes) for (const r of b.runs) for (const ch of r.text) if (ch.trim().length) set.add(ch)
    return [...set].sort().join('')
  }, [project])
  useEffect(() => {
    if (!extractor || manifestFontId !== font.hash) return
    const p = useVideoStore.getState().project
    if (p) void ensureProjectGlyphsDerived(extractor, p, params)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charsSig, paramsSig, extractor, manifestFontId, font.hash])

  const refreshList = () => projectStore.list().then(setProjects).catch(() => {})
  useEffect(() => {
    refreshList()
  }, [])

  const doSave = async () => {
    setStatus('saving…')
    try {
      await saveProject(font)
      setStatus('saved to disk')
      refreshList()
    } catch (e) {
      setStatus('save failed: ' + e)
    }
  }
  const doLoad = async (id: string) => {
    setStatus('loading…')
    await loadProject(id)
    videoHistory.clear()
    setStatus('loaded')
  }
  const doExport = async () => {
    const p = useVideoStore.getState().project
    const m = useEditorStore.getState().manifest
    if (!p || !m) return
    setExporting(true)
    setExportResult(null)
    setStatus('rendering MP4 — this can take a moment…')
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: p,
          glyphs: m.glyphs,
          metrics: { unitsPerEm: m.metadata.unitsPerEm, ascender: m.metadata.ascender, descender: m.metadata.descender },
          fps: 30,
          width: 1280,
          speed: p.playbackRate ?? 1,
          name: p.name,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setExportResult(data)
        setStatus(null)
      } else {
        setStatus('export failed: ' + (data.error ?? 'unknown'))
      }
    } catch (e) {
      setStatus('export failed: ' + e)
    } finally {
      setExporting(false)
    }
  }

  if (!project) return <div className="stage">Loading project…</div>

  return (
    <div className="video">
      <div className="video-top">
        <strong className="proj-name">{project.name}</strong>
        <div className="seg">
          {ASPECTS.map((a) => (
            <button key={a} className={project.aspect === a ? 'tool tool-on' : 'tool'} onClick={() => setAspect(a)}>
              {a}
            </button>
          ))}
        </div>
        <label className="slider inline">
          <span>size</span>
          <input
            type="range"
            min={0.03}
            max={0.2}
            step={0.005}
            value={project.baseEmFraction}
            onChange={(e) => setBaseEmFraction(Number(e.target.value))}
          />
        </label>
        <div className="seg">
          {BRUSH_STYLES.map((st) => (
            <button
              key={st}
              className={project.brush.style === st ? 'tool tool-on' : 'tool'}
              onClick={() => setBrush({ ...project.brush, style: st })}
            >
              {st}
            </button>
          ))}
          <input
            type="color"
            value={project.brush.color}
            onChange={(e) => setBrush({ ...project.brush, color: e.target.value })}
          />
        </div>
        <div className="spacer" />
        <button onClick={() => videoHistory.undo()} title="undo">↶</button>
        <button onClick={() => videoHistory.redo()} title="redo">↷</button>
        <button className="primary" onClick={doSave}>💾 Save</button>
        <select value="" onChange={(e) => e.target.value && doLoad(e.target.value)}>
          <option value="">Load…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.slideCount})
            </option>
          ))}
        </select>
        <button onClick={() => { newProject(font.hash, brush); videoHistory.clear() }}>New</button>
        <button onClick={doExport} disabled={exporting} title="render to MP4 (saved under ./exports)">
          {exporting ? '⏳ Exporting…' : '🎬 Export MP4'}
        </button>
      </div>
      {status && <div className="savestatus">{status}</div>}
      {exportResult && (
        <div className="exportresult">
          <div className="exportresult-info">
            Exported <code>exports/{exportResult.file}</code> — {(exportResult.bytes / 1048576).toFixed(2)} MB ·{' '}
            {exportResult.w}×{exportResult.h} · {(exportResult.durationMs / 1000).toFixed(1)}s · {exportResult.frames} frames{' '}
            <a href={`/api/export/${exportResult.file}`} target="_blank" rel="noreferrer" download>
              ↓ download
            </a>
          </div>
          <video className="export-preview" src={`/api/export/${exportResult.file}`} controls />
        </div>
      )}

      <div className="video-body">
        <SlidePanel glyphs={glyphs} metrics={metrics} />
        <SlideCanvas glyphs={glyphs} metrics={metrics ?? { unitsPerEm: font.unitsPerEm, ascender: font.font.ascender, descender: font.font.descender }} />
        <Inspector />
      </div>

      <p className="hint">
        Video editor — layout view: click empty space to add a textbox, drag to move (one undo per
        drag). Select a textbox to edit its text, per-selection styling, alignment, wrap width and
        timing in the inspector. Animated playback comes next.
      </p>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import type { LoadedFont } from '@lib/font/load'
import { captionsVtt } from '@lib/project/vtt'
import { extractionSig, type ExtractionParams, type GlyphExtractor } from '@lib/extraction'
import type { BrushSettings } from '@lib/manifest/schema'
import { prepareGlyph, type PreparedGlyph } from '@lib/animation/timeline'
import type { FontEntry, FontMetrics, FontSet } from '@lib/project/layout'
import type { Aspect } from '@lib/project/schema'
import { projectStore, type ProjectSummary } from '@lib/persistence/ProjectStore'
import { httpStore } from '@lib/persistence/FontStore'
import { ensureProjectGlyphsDerived, useVideoStore, videoHistory } from '../../state/videoStore'
import { useFontRegistry } from '../../state/fontRegistry'
import { useEditorStore } from '../../state/store'
import { SlidePanel } from './SlidePanel'
import { SlideCanvas } from './SlideCanvas'
import { Inspector } from './Inspector'
import { TimelineView } from './TimelineView'
import { VttView } from './VttView'

const ASPECTS: Aspect[] = ['16:9', '9:16']
const VIEWS = [
  { id: 'layout', label: 'Layout' },
  { id: 'order', label: 'Order' },
  { id: 'vtt', label: 'VTT' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'play', label: '▶ Play' },
] as const

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
  const slideView = useVideoStore((s) => s.slideView)
  const setSlideView = useVideoStore((s) => s.setSlideView)

  const [status, setStatus] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<
    {
      file: string
      bytes: number
      w: number
      h: number
      durationMs: number
      frames: number
      audioMuxed?: boolean
      audioCues?: number
      audioWarning?: string | null
      /** WebVTT captions snapshotted at export time, so they match the rendered MP4. */
      captionsVtt?: string | null
    } | null
  >(null)

  // Optional captions for the exported-video preview, built from the voiceover as
  // it was at export time (snapshot in exportResult), so they stay in sync with the
  // rendered MP4 even if the script is edited afterwards. Served as a WebVTT blob.
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [showCaptions, setShowCaptions] = useState(true)
  const captionsUrl = useMemo(() => {
    const vtt = exportResult?.captionsVtt
    if (!vtt) return null
    return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }))
  }, [exportResult?.captionsVtt])
  useEffect(() => () => { if (captionsUrl) URL.revokeObjectURL(captionsUrl) }, [captionsUrl])
  // Keep the caption track's visibility in sync with the toggle.
  useEffect(() => {
    const v = videoRef.current
    if (!v || v.textTracks.length === 0) return
    v.textTracks[0].mode = showCaptions ? 'showing' : 'hidden'
  }, [showCaptions, captionsUrl, exportResult])

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
  const safeMetrics: FontMetrics = metrics ?? {
    unitsPerEm: font.unitsPerEm,
    ascender: font.font.ascender,
    descender: font.font.descender,
  }

  // Multi-font: assemble a FontSet for the pure pipeline. The Font-tab font is
  // supplied live (newly-derived glyphs show at once); other referenced saved
  // fonts come from the registry (their on-disk manifests).
  const registryFonts = useFontRegistry((s) => s.fonts)
  const ensureFonts = useFontRegistry((s) => s.ensureFonts)
  const referencedKey = useMemo(() => {
    if (!project) return ''
    const set = new Set<string>([project.fontId])
    for (const sl of project.slides)
      for (const b of sl.textBoxes) for (const r of b.runs) if (r.fontId) set.add(r.fontId)
    return [...set].sort().join(',')
  }, [project])
  // Per (non-editor) font, the chars it must render — the registry loads each
  // font's manifest and derives any missing glyphs on demand from its bytes.
  const fontCharSpecs = useMemo(() => {
    if (!project) return [] as { id: string; chars: string[] }[]
    const byFont = new Map<string, Set<string>>()
    for (const sl of project.slides)
      for (const b of sl.textBoxes)
        for (const r of b.runs) {
          const fid = r.fontId || project.fontId
          if (fid === font.hash) continue // the Font-tab font derives live (App extractor)
          let set = byFont.get(fid)
          if (!set) byFont.set(fid, (set = new Set()))
          for (const ch of r.text) if (ch.trim().length) set.add(ch)
        }
    return [...byFont].map(([id, set]) => ({ id, chars: [...set].sort() }))
  }, [project, font.hash])
  const fontCharSpecsKey = fontCharSpecs.map((s) => `${s.id}:${s.chars.join('')}`).join('|')
  useEffect(() => {
    if (fontCharSpecs.length) void ensureFonts(fontCharSpecs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontCharSpecsKey])
  const fonts: FontSet = useMemo(() => {
    const byId = new Map<string, FontEntry>()
    byId.set(font.hash, { glyphs, metrics: safeMetrics }) // live editor font
    for (const id of referencedKey ? referencedKey.split(',') : []) {
      if (!id || id === font.hash) continue
      const e = registryFonts.get(id)
      if (e) byId.set(id, { glyphs: e.glyphs, metrics: e.metrics })
    }
    const defaultId = project?.fontId ?? font.hash
    if (!byId.has(defaultId)) byId.set(defaultId, { glyphs: new Map(), metrics: safeMetrics })
    return { byId, defaultId }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glyphs, safeMetrics, font.hash, project?.fontId, referencedKey, registryFonts])

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

  // Textbox clipboard: Cmd/Ctrl C / X / V on the selected box (across slides).
  // Defers to the browser while editing text (overlay / form fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName))) return
      const k = e.key.toLowerCase()
      if (k !== 'c' && k !== 'x' && k !== 'v') return
      const st = useVideoStore.getState()
      const slideId = st.selectedSlideId ?? st.project?.slides[0]?.id
      if (!slideId) return
      if (k === 'v') {
        if (!st.clipboardBox) return
        st.pasteTextBox(slideId)
        e.preventDefault()
      } else if (st.selectedTextBoxId) {
        if (k === 'c') st.copyTextBox(slideId, st.selectedTextBoxId)
        else st.cutTextBox(slideId, st.selectedTextBoxId)
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
      // Per-run multi-font: send every referenced font's raw glyphs + metrics so
      // the headless exporter renders each run in its own font (preview == export).
      const referenced = new Set<string>([p.fontId])
      for (const sl of p.slides)
        for (const b of sl.textBoxes) for (const r of b.runs) if (r.fontId) referenced.add(r.fontId)
      const fontsById: Record<string, { glyphs: unknown; metrics: FontMetrics }> = {}
      for (const id of referenced) {
        const mf = id === m.metadata.fontId ? m : await httpStore.load(id)
        if (!mf) continue
        fontsById[id] = {
          glyphs: mf.glyphs,
          metrics: { unitsPerEm: mf.metadata.unitsPerEm, ascender: mf.metadata.ascender, descender: mf.metadata.descender },
        }
      }
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: p,
          fontsById,
          fps: 30,
          width: 1280,
          speed: p.playbackRate ?? 1,
          name: p.name,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        // snapshot the captions from the project we just rendered, so they match the MP4
        const vo = p.voiceover ?? []
        setExportResult({ ...data, captionsVtt: vo.length ? captionsVtt(vo) : null })
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
            {exportResult.w}×{exportResult.h} · {(exportResult.durationMs / 1000).toFixed(1)}s · {exportResult.frames} frames
            {exportResult.audioMuxed ? ` · 🔊 ${exportResult.audioCues} voiceover clip(s)` : ''}
            {exportResult.audioWarning ? ` · ⚠ ${exportResult.audioWarning}` : ''}{' '}
            <a href={`/api/export/${exportResult.file}`} target="_blank" rel="noreferrer" download>
              ↓ download
            </a>
          </div>
          {captionsUrl && (
            <label className="toggle export-captions">
              <input type="checkbox" checked={showCaptions} onChange={(e) => setShowCaptions(e.target.checked)} />
              Captions (from the voiceover script)
            </label>
          )}
          <video ref={videoRef} className="export-preview" src={`/api/export/${exportResult.file}`} controls>
            {captionsUrl && <track kind="captions" src={captionsUrl} srcLang="en" label="Voiceover" default />}
          </video>
        </div>
      )}

      <div className="slideview-toggle seg">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={slideView === v.id ? 'tool tool-on' : 'tool'}
            onClick={() => setSlideView(v.id)}
          >
            {v.label}
          </button>
        ))}
        <span className="slideview-hint">
          {slideView === 'layout' ? 'drag to move · click empty space to add a textbox' : ''}
        </span>
      </div>

      {slideView === 'timeline' ? (
        <TimelineView fonts={fonts} />
      ) : slideView === 'vtt' ? (
        <VttView />
      ) : (
        <div className="video-body">
          <SlidePanel fonts={fonts} />
          <SlideCanvas fonts={fonts} font={font} />
          <Inspector />
        </div>
      )}

      <p className="hint">
        Video editor — Layout/Order/Play tune the animation; <b>VTT</b> edits the voiceover script and
        <b> Timeline</b> aligns voiceover to the animation. The slide view shows the voiceover in range
        beneath the canvas.
      </p>
    </div>
  )
}

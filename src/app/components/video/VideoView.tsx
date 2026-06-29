import { useEffect, useMemo, useRef, useState } from 'react'
import type { LoadedFont } from '@lib/font/load'
import { captionsVtt } from '@lib/project/vtt'
import { exportCanvasW } from '@lib/project/coords'
import { type GlyphExtractor } from '@lib/extraction'
import type { BrushSettings } from '@lib/manifest/schema'
import { prepareGlyph, type PreparedGlyph } from '@lib/animation/timeline'
import type { FontEntry, FontMetrics, FontSet } from '@lib/project/layout'
import type { Aspect } from '@lib/project/schema'
import { projectStore, type ProjectSummary } from '@lib/persistence/ProjectStore'
import { httpStore } from '@lib/persistence/FontStore'
import { drawingHttpStore } from '@lib/persistence/DrawingStore'
import { apiUrl, apiFetch } from '@lib/persistence/apiBase'
import { ensureProjectGlyphsDerived, useVideoStore, videoHistory } from '../../state/videoStore'
import { useFontRegistry } from '../../state/fontRegistry'
import { useDrawingRegistry } from '../../state/drawingRegistry'
import { useEditorStore } from '../../state/store'
import { NavigatorPanel } from './NavigatorPanel'
import { SlideCanvas } from './SlideCanvas'
import { Inspector } from './Inspector'
import { VoiceoverExtractPanel } from './VoiceoverExtractPanel'
import { TimelineView } from './TimelineView'
import { VttView } from './VttView'

const ASPECTS: Aspect[] = ['16:9', '9:16']
const VIEWS = [
  { id: 'editor', label: 'Editor' },
  { id: 'vtt', label: 'VTT' },
  { id: 'timeline', label: 'Timeline' },
] as const

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Read a Response as JSON, tolerating a NON-JSON body (e.g. a reverse proxy's HTML
 *  502/504 page) — return a shaped error instead of throwing a cryptic
 *  "Unexpected token '<'" SyntaxError. */
async function readJsonSafe(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 140)
    return { error: `HTTP ${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ''}` }
  }
}

/** Poll an export job until it finishes, reporting 0..1 progress. Each poll is a
 *  short request, so a long render never trips the proxy timeout. Tolerates a few
 *  transient gateway errors before giving up. */
async function pollExportStatus(
  jobId: string,
  onProgress: (p: number) => void,
): Promise<Record<string, unknown>> {
  const statusUrl = `${apiUrl('/api/export')}/status/${encodeURIComponent(jobId)}`
  let misses = 0
  for (;;) {
    await sleep(1200)
    let res: Response
    try {
      res = await apiFetch(statusUrl)
    } catch {
      if (++misses > 8) return { status: 'error', error: 'lost connection to the server while rendering' }
      continue
    }
    if (res.status === 404) return { status: 'error', error: 'the export job expired or was lost (server restart?)' }
    if (!res.ok) {
      // transient gateway hiccup (502/503/504) — retry a bounded number of times
      if (++misses > 8) {
        const d = await readJsonSafe(res)
        return { status: 'error', error: (d.error as string) ?? `status check failed (HTTP ${res.status})` }
      }
      continue
    }
    misses = 0
    const data = await readJsonSafe(res)
    if (data.status === 'rendering') {
      onProgress(typeof data.progress === 'number' ? data.progress : 0)
      continue
    }
    return data // 'done' or 'error'
  }
}

export function VideoView({
  font,
  extractor,
  brush,
}: {
  font: LoadedFont
  extractor: GlyphExtractor | null
  brush: BrushSettings
}) {
  const project = useVideoStore((s) => s.project)
  const newProject = useVideoStore((s) => s.newProject)
  const loadProject = useVideoStore((s) => s.loadProject)
  const saveProject = useVideoStore((s) => s.saveProject)
  const renameProject = useVideoStore((s) => s.renameProject)
  const saveProjectAs = useVideoStore((s) => s.saveProjectAs)
  const activeAspect = useVideoStore((s) => s.activeAspect)
  const setActiveAspect = useVideoStore((s) => s.setActiveAspect)
  const setBaseEmFraction = useVideoStore((s) => s.setBaseEmFraction)
  const slideView = useVideoStore((s) => s.slideView)
  const setSlideView = useVideoStore((s) => s.setSlideView)

  const [status, setStatus] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [filesOpen, setFilesOpen] = useState(false)
  // Local draft of the project name; committed (renamed) on blur/Enter so typing
  // doesn't spam the undo history per keystroke.
  const [nameDraft, setNameDraft] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<number | null>(null)
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

  // Always carry the live font's real space advance (the manifest may predate it),
  // so the canvas wraps text with the same spacing as the on-canvas editor.
  const metrics: FontMetrics | null = useMemo(
    () =>
      manifestMeta
        ? {
            unitsPerEm: manifestMeta.unitsPerEm,
            ascender: manifestMeta.ascender,
            descender: manifestMeta.descender,
            spaceAdvance: manifestMeta.spaceAdvance ?? font.spaceAdvance,
          }
        : {
            unitsPerEm: font.unitsPerEm,
            ascender: font.font.ascender,
            descender: font.font.descender,
            spaceAdvance: font.spaceAdvance,
          },
    [manifestMeta, font],
  )
  const safeMetrics: FontMetrics = metrics ?? {
    unitsPerEm: font.unitsPerEm,
    ascender: font.font.ascender,
    descender: font.font.descender,
    spaceAdvance: font.spaceAdvance,
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

  // Placed drawings: load + prepare every drawing referenced by the project's
  // slides, keyed by drawingId (mirrors the font registry). The map IS a DrawingSet.
  const registryDrawings = useDrawingRegistry((s) => s.drawings)
  const ensureDrawings = useDrawingRegistry((s) => s.ensureDrawings)
  const drawingIdsKey = useMemo(() => {
    if (!project) return ''
    const ids = new Set<string>()
    for (const sl of project.slides) for (const d of sl.drawings ?? []) ids.add(d.drawingId)
    return [...ids].sort().join(',')
  }, [project])
  useEffect(() => {
    if (drawingIdsKey) void ensureDrawings(drawingIdsKey.split(','))
  }, [drawingIdsKey, ensureDrawings])

  // Bootstrap a project on first entry.
  useEffect(() => {
    if (!useVideoStore.getState().project) {
      newProject(font.hash, brush)
      videoHistory.clear()
    }
  }, [font, brush, newProject])

  // Derive every character used in the project so it can render. Keyed on a
  // signature of the needed chars (NOT the whole project), so dragging/positioning
  // doesn't re-trigger derivation every frame. Each glyph derives with its own
  // stored extraction settings; tuning a glyph in the Font tab re-derives it into
  // the shared manifest, which rebuilds `glyphs` above and re-renders here.
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
    if (p) void ensureProjectGlyphsDerived(extractor, p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charsSig, extractor, manifestFontId, font.hash])

  const refreshList = () => projectStore.list().then(setProjects).catch(() => {})
  useEffect(() => {
    refreshList()
  }, [])

  // Keep the name field in sync when the open project changes (load/new/copy).
  useEffect(() => {
    setNameDraft(project?.name ?? '')
  }, [project?.id])

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

  const commitName = () => {
    const name = nameDraft.trim()
    if (name && name !== project?.name) renameProject(name)
    else setNameDraft(project?.name ?? '')
  }
  const doSave = async () => {
    // Prompt for a real name the first time an "Untitled video" is saved, so the
    // Drive file lands with a meaningful name.
    const cur = useVideoStore.getState().project
    if (cur && (!cur.name || cur.name === 'Untitled video')) {
      const entered = window.prompt('Name this video:', '')
      if (entered && entered.trim()) {
        renameProject(entered.trim())
        setNameDraft(entered.trim())
      }
    }
    setStatus('saving…')
    try {
      await saveProject(font)
      setStatus('saved')
      refreshList()
    } catch (e) {
      setStatus('save failed: ' + e)
    }
  }
  const doSaveAs = async () => {
    const cur = useVideoStore.getState().project
    if (!cur) return
    const entered = window.prompt('Save a copy as:', `${cur.name} copy`)
    if (!entered || !entered.trim()) return
    setStatus('saving copy…')
    try {
      const id = await saveProjectAs(entered.trim(), font)
      setNameDraft(entered.trim())
      setStatus('saved copy')
      refreshList()
      setFilesOpen(false)
      return id
    } catch (e) {
      setStatus('copy failed: ' + e)
    }
  }
  const doDelete = async (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This moves it to Drive trash.`)) return
    try {
      await projectStore.remove(id)
      refreshList()
      if (useVideoStore.getState().project?.id === id) {
        newProject(font.hash, brush)
        videoHistory.clear()
      }
    } catch (e) {
      setStatus('delete failed: ' + e)
    }
  }
  const doLoad = async (id: string) => {
    setStatus('loading…')
    await loadProject(id)
    videoHistory.clear()
    setFilesOpen(false)
    setStatus('loaded')
  }
  const doExport = async () => {
    const p = useVideoStore.getState().project
    const m = useEditorStore.getState().manifest
    if (!p || !m) return
    setExporting(true)
    setExportResult(null)
    setExportProgress(null)
    setStatus('preparing fonts & drawings…')
    try {
      // Per-run multi-font: send every referenced font's raw glyphs + metrics so
      // the headless exporter renders each run in its own font (preview == export).
      const referenced = new Set<string>([p.fontId])
      for (const sl of p.slides)
        for (const b of sl.textBoxes) for (const r of b.runs) if (r.fontId) referenced.add(r.fontId)
      const fontsById: Record<string, { glyphs: unknown; metrics: FontMetrics }> = {}
      // load referenced fonts in parallel (a slow Drive backend shouldn't serialize)
      await Promise.all(
        [...referenced].map(async (id) => {
          const mf = id === m.metadata.fontId ? m : await httpStore.load(id)
          if (!mf) return
          fontsById[id] = {
            glyphs: mf.glyphs,
            metrics: {
              unitsPerEm: mf.metadata.unitsPerEm,
              ascender: mf.metadata.ascender,
              descender: mf.metadata.descender,
              // keep the live font's real space advance even if its manifest predates it
              spaceAdvance: mf.metadata.spaceAdvance ?? (id === font.hash ? font.spaceAdvance : undefined),
            },
          }
        }),
      )
      // Placed drawings: send every referenced drawing's manifest so the headless
      // exporter can prepare + render them (preview == export). Loaded in parallel.
      const drawingIds = new Set<string>()
      for (const sl of p.slides) for (const d of sl.drawings ?? []) drawingIds.add(d.drawingId)
      const drawingsById: Record<string, unknown> = {}
      await Promise.all(
        [...drawingIds].map(async (id) => {
          try {
            const dm = await drawingHttpStore.load(id)
            if (dm) drawingsById[id] = dm
          } catch {
            /* missing drawing — exporter skips it */
          }
        }),
      )

      // text/plain so the builder's global 1 MB JSON parser skips this large
      // payload (it bundles every referenced font's glyph data); the route reads
      // the raw body. The render runs as a BACKGROUND JOB on the server — POST
      // returns a jobId immediately, then we poll for progress (so a long render
      // never trips the reverse-proxy request timeout).
      setStatus('starting render…')
      const res = await apiFetch(apiUrl('/api/export'), {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          project: p,
          fontsById,
          drawingsById,
          fps: 30,
          aspect: activeAspect,
          width: exportCanvasW(activeAspect),
          speed: p.playbackRate ?? 1,
          name: p.name,
        }),
      })
      const start = await readJsonSafe(res)
      if (!res.ok || start.ok !== true || typeof start.jobId !== 'string') {
        setStatus('export failed: ' + ((start.error as string) ?? `HTTP ${res.status}`))
        return
      }
      setStatus('rendering MP4…')
      setExportProgress(0)
      const result = await pollExportStatus(start.jobId, (pr) => setExportProgress(pr))
      if (result.status === 'done') {
        // snapshot the captions from the project we just rendered, so they match the MP4
        const vo = p.voiceover ?? []
        setExportResult({
          ...(result as unknown as NonNullable<typeof exportResult>),
          captionsVtt: vo.length ? captionsVtt(vo) : null,
        })
        setStatus(null)
      } else {
        setStatus('export failed: ' + ((result.error as string) ?? 'unknown'))
      }
    } catch (e) {
      setStatus('export failed: ' + e)
    } finally {
      setExporting(false)
      setExportProgress(null)
    }
  }

  if (!project) return <div className="stage">Loading project…</div>

  return (
    <div className="video">
      <div className="video-top">
        <input
          className="proj-name-input"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          title="Rename this video"
          aria-label="Video name"
        />
        <div className="seg">
          {ASPECTS.map((a) => (
            <button key={a} className={activeAspect === a ? 'tool tool-on' : 'tool'} onClick={() => setActiveAspect(a)}>
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
        <button onClick={doSaveAs} title="Save a copy under a new name">⎘ Save a copy</button>
        <div className="files-menu" style={{ position: 'relative' }}>
          <button
            onClick={() => {
              if (!filesOpen) refreshList()
              setFilesOpen((o) => !o)
            }}
            title="Open or delete saved videos"
          >
            Files ▾
          </button>
          {filesOpen && (
            <div
              className="files-panel"
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                zIndex: 30,
                minWidth: 240,
                maxHeight: 360,
                overflowY: 'auto',
                background: 'var(--panel, #fff)',
                color: 'var(--text, #111)',
                border: '1px solid var(--border, #ccc)',
                borderRadius: 6,
                boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
                padding: 4,
              }}
            >
              {projects.length === 0 ? (
                <div style={{ padding: 8, opacity: 0.7 }}>No saved videos</div>
              ) : (
                projects.map((p) => (
                  <div
                    key={p.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <button
                      style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={`Open ${p.name}`}
                      onClick={() => doLoad(p.id)}
                    >
                      {p.id === project.id ? '● ' : ''}
                      {p.name} <span style={{ opacity: 0.6 }}>({p.slideCount})</span>
                    </button>
                    <button title="Delete" onClick={() => doDelete(p.id, p.name)}>
                      🗑
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <button onClick={() => { newProject(font.hash, brush); videoHistory.clear(); setNameDraft('Untitled video') }}>New</button>
        <button onClick={doExport} disabled={exporting} title="render to MP4 (download only — not saved to Drive)">
          {exporting
            ? exportProgress != null
              ? `⏳ ${Math.round(exportProgress * 100)}%`
              : '⏳ Exporting…'
            : '🎬 Export MP4'}
        </button>
      </div>
      {status && <div className="savestatus">{status}</div>}
      {exporting && exportProgress != null && (
        <div
          className="export-progress"
          role="progressbar"
          aria-valuenow={Math.round(exportProgress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="export-progress-fill" style={{ width: `${Math.max(2, Math.round(exportProgress * 100))}%` }} />
          <span className="export-progress-pct">{Math.round(exportProgress * 100)}%</span>
        </div>
      )}
      {exportResult && (
        <div className="exportresult">
          <div className="exportresult-info">
            Rendered MP4 — {(exportResult.bytes / 1048576).toFixed(2)} MB ·{' '}
            {exportResult.w}×{exportResult.h} · {(exportResult.durationMs / 1000).toFixed(1)}s · {exportResult.frames} frames
            {exportResult.audioMuxed ? ` · 🔊 ${exportResult.audioCues} voiceover clip(s)` : ''}
            {exportResult.audioWarning ? ` · ⚠ ${exportResult.audioWarning}` : ''}{' '}
            <a href={`${apiUrl('/api/export')}/${exportResult.file}`} target="_blank" rel="noreferrer" download>
              ↓ download
            </a>
          </div>
          {captionsUrl && (
            <label className="toggle export-captions">
              <input type="checkbox" checked={showCaptions} onChange={(e) => setShowCaptions(e.target.checked)} />
              Captions (from the voiceover script)
            </label>
          )}
          <video ref={videoRef} className="export-preview" src={`${apiUrl('/api/export')}/${exportResult.file}`} controls>
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
          {slideView === 'editor' ? 'drag to move · click empty space to add a textbox · ▶ a slide/textbox chip to preview it' : ''}
        </span>
      </div>

      {slideView === 'timeline' ? (
        <TimelineView fonts={fonts} drawings={registryDrawings} />
      ) : slideView === 'vtt' ? (
        <VttView />
      ) : (
        <div className="video-body">
          <NavigatorPanel fonts={fonts} />
          <SlideCanvas fonts={fonts} font={font} drawings={registryDrawings} />
          <div className="inspector-col">
            <Inspector />
            <VoiceoverExtractPanel fonts={fonts} drawings={registryDrawings} />
          </div>
        </div>
      )}
    </div>
  )
}

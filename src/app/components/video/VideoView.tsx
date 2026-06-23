import { useEffect, useState } from 'react'
import type { LoadedFont } from '@lib/font/load'
import type { ExtractionParams, GlyphExtractor } from '@lib/extraction'
import type { BrushSettings, BrushStyle } from '@lib/manifest/schema'
import type { Aspect, TransitionKind } from '@lib/project/schema'
import { projectStore, type ProjectSummary } from '@lib/persistence/ProjectStore'
import { useVideoStore, videoHistory } from '../../state/videoStore'
import { SlidePanel } from './SlidePanel'

const ASPECTS: Aspect[] = ['16:9', '9:16']
const BRUSH_STYLES: BrushStyle[] = ['chalk', 'ink', 'marker']
const TRANSITIONS: TransitionKind[] = ['none', 'fade', 'rubout', 'scroll-up', 'scroll-left']

export function VideoView({
  font,
  brush,
}: {
  font: LoadedFont
  extractor: GlyphExtractor | null
  params: ExtractionParams
  brush: BrushSettings
}) {
  const project = useVideoStore((s) => s.project)
  const selectedSlideId = useVideoStore((s) => s.selectedSlideId)
  const newProject = useVideoStore((s) => s.newProject)
  const loadProject = useVideoStore((s) => s.loadProject)
  const saveProject = useVideoStore((s) => s.saveProject)
  const setAspect = useVideoStore((s) => s.setAspect)
  const setBaseEmFraction = useVideoStore((s) => s.setBaseEmFraction)
  const setBrush = useVideoStore((s) => s.setBrush)
  const setSlideTransition = useVideoStore((s) => s.setSlideTransition)
  const updateSlide = useVideoStore((s) => s.updateSlide)

  const [status, setStatus] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])

  // Bootstrap a project on first entry.
  useEffect(() => {
    if (!useVideoStore.getState().project) {
      newProject(font.hash, brush)
      videoHistory.clear()
    }
  }, [font, brush, newProject])

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

  if (!project) return <div className="stage">Loading project…</div>
  const slide = project.slides.find((s) => s.id === selectedSlideId) ?? project.slides[0]

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
      </div>
      {status && <div className="savestatus">{status}</div>}

      <div className="video-body">
        <SlidePanel />
        <div className="stage stage-overlay video-stage">
          <div className="placeholder">
            Slide {project.slides.indexOf(slide) + 1} / {project.slides.length} — layout canvas arrives in
            the next phase. {slide.textBoxes.length} textbox(es).
          </div>
        </div>
        <aside className="inspector">
          <h3>Slide</h3>
          <label className="slider">
            <span>closing transition</span>
            <select
              value={slide.transition.kind}
              onChange={(e) => setSlideTransition(slide.id, { kind: e.target.value as TransitionKind })}
            >
              {TRANSITIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="slider">
            <span>transition <b>{slide.transition.durationMs}ms</b></span>
            <input
              type="range"
              min={100}
              max={2000}
              step={50}
              value={slide.transition.durationMs}
              onChange={(e) => setSlideTransition(slide.id, { durationMs: Number(e.target.value) })}
            />
          </label>
          <label className="slider">
            <span>hold before <b>{slide.holdBeforeTransitionMs}ms</b></span>
            <input
              type="range"
              min={0}
              max={4000}
              step={100}
              value={slide.holdBeforeTransitionMs}
              onChange={(e) => updateSlide(slide.id, { holdBeforeTransitionMs: Number(e.target.value) })}
            />
          </label>
        </aside>
      </div>

      <p className="hint">
        Video editor — phase 1: slides (add/copy/delete/drag-reorder) + save/load to disk. Layout,
        inline styling, and animated playback come next.
      </p>
    </div>
  )
}

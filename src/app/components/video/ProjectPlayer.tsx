import { useCallback, useMemo, useState } from 'react'
import type { PreparedGlyph } from '@lib/animation/timeline'
import type { FontMetrics } from '@lib/project/layout'
import { buildRenderContext, projectDurationMs, renderProject } from '@lib/project/render'
import type { VideoProject } from '@lib/project/schema'
import { useVideoStore } from '../../state/videoStore'
import { BACKING_W } from './layoutCanvas'
import { PlaybackCanvas } from './PlaybackCanvas'

type Scope = 'all' | 'selected'

/**
 * Project-level player: plays a sequence of slides (all, or just the ones ticked
 * in the panel) through `renderProject` — slides write on in order with their
 * closing transitions overlapping the next. A single ticked slide plays on its
 * own. Same pure render path as a future MP4 exporter.
 */
export function ProjectPlayer({ glyphs, metrics }: { glyphs: Map<string, PreparedGlyph>; metrics: FontMetrics }) {
  const project = useVideoStore((s) => s.project)
  const selectedSlideId = useVideoStore((s) => s.selectedSlideId)
  const playSelectedIds = useVideoStore((s) => s.playSelectedIds)
  const setPlaySelected = useVideoStore((s) => s.setPlaySelected)
  const playbackRate = useVideoStore((s) => s.project?.playbackRate ?? 1)
  const setPlaybackRate = useVideoStore((s) => s.setPlaybackRate)
  const [scope, setScope] = useState<Scope>('all')

  // The slides actually played, in project order.
  const subProject: VideoProject | null = useMemo(() => {
    if (!project) return null
    if (scope === 'all') return project
    const set = new Set(playSelectedIds)
    return { ...project, slides: project.slides.filter((s) => set.has(s.id)) }
  }, [project, scope, playSelectedIds])

  const rc = useMemo(
    () => (subProject ? buildRenderContext(subProject, glyphs, BACKING_W, metrics, playbackRate) : null),
    [subProject, glyphs, metrics, playbackRate],
  )
  const totalMs = rc ? projectDurationMs(rc) : 0

  const ready = useMemo(() => {
    if (!subProject) return false
    for (const slide of subProject.slides)
      for (const box of slide.textBoxes)
        for (const run of box.runs)
          for (const ch of run.text) if (ch.trim().length && !glyphs.has(ch)) return false
    return true
  }, [subProject, glyphs])

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, t: number, w: number, h: number) => {
      if (rc && subProject) renderProject(ctx, subProject, rc, t, w, h)
    },
    [rc, subProject],
  )

  if (!project) return null

  const playedCount = subProject ? subProject.slides.length : 0
  const resetKey = `${scope}:${scope === 'all' ? project.slides.length : playSelectedIds.join(',')}`

  const onSelectedScope = () => {
    // Make "Selected" immediately meaningful: seed with the current slide.
    if (playSelectedIds.length === 0 && selectedSlideId) setPlaySelected([selectedSlideId])
    setScope('selected')
  }

  return (
    <div className="orderview">
      <div className="play-scope seg">
        <button className={scope === 'all' ? 'tool tool-on' : 'tool'} onClick={() => setScope('all')}>
          All slides
        </button>
        <button className={scope === 'selected' ? 'tool tool-on' : 'tool'} onClick={onSelectedScope}>
          Selected ({playSelectedIds.length})
        </button>
        <span className="slideview-hint">
          {scope === 'all'
            ? `playing all ${project.slides.length} slide(s) in order`
            : 'tick slides in the panel ← to choose what plays'}
        </span>
      </div>

      <PlaybackCanvas
        aspect={project.aspect}
        totalMs={totalMs}
        ready={ready}
        resetKey={resetKey}
        draw={draw}
        speed={playbackRate}
        onSpeedChange={setPlaybackRate}
        autoPlay
        emptyHint={scope === 'selected' ? 'tick one or more slides in the panel' : 'no slides'}
      />

      <div className="order-head">
        {scope === 'all'
          ? 'Plays every slide in order, with closing transitions between them.'
          : `Plays ${playedCount} ticked slide(s) in project order; closing transitions play between them.`}
      </div>
    </div>
  )
}

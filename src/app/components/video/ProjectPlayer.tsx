import { useCallback, useMemo, useState } from 'react'
import { projectForAspect } from '@lib/project/aspect'
import { fontFor, type FontSet } from '@lib/project/layout'
import { buildRenderContext, projectDurationMs, renderProject } from '@lib/project/render'
import type { VideoProject } from '@lib/project/schema'
import { useVideoStore } from '../../state/videoStore'
import { BACKING_W } from './layoutCanvas'
import { PlaybackCanvas, type AudioCue } from './PlaybackCanvas'
import { cueAudioUrl } from './VttView'

type Scope = 'all' | 'selected'

/**
 * Project-level player: plays a sequence of slides (all, or just the ones ticked
 * in the panel) through `renderProject` — slides write on in order with their
 * closing transitions overlapping the next. A single ticked slide plays on its
 * own. Same pure render path as a future MP4 exporter.
 */
export function ProjectPlayer({ fonts }: { fonts: FontSet }) {
  const project = useVideoStore((s) => s.project)
  const activeAspect = useVideoStore((s) => s.activeAspect)
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

  // Flatten to the active aspect for the pure render pipeline.
  const flat = useMemo(
    () => (subProject ? projectForAspect(subProject, activeAspect) : null),
    [subProject, activeAspect],
  )
  const rc = useMemo(
    () => (flat ? buildRenderContext(flat, fonts, BACKING_W, playbackRate) : null),
    [flat, fonts, playbackRate],
  )
  const totalMs = rc ? projectDurationMs(rc) : 0

  const ready = useMemo(() => {
    if (!subProject) return false
    for (const slide of subProject.slides)
      for (const box of slide.textBoxes)
        for (const run of box.runs)
          for (const ch of run.text) if (ch.trim().length && !fontFor(fonts, run.fontId).glyphs.has(ch)) return false
    return true
  }, [subProject, fonts])

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, t: number, w: number, h: number) => {
      if (rc && flat) renderProject(ctx, flat, rc, t, w, h)
    },
    [rc, flat],
  )

  // Voiceover plays only in the full-project scope, where the clock = project time.
  const audioCues = useMemo<AudioCue[] | undefined>(() => {
    if (!project || scope !== 'all') return undefined
    const list: AudioCue[] = []
    for (const c of project.voiceover ?? []) {
      const url = cueAudioUrl(project.id, c)
      if (url) list.push({ id: c.id, startMs: c.startMs, endMs: c.endMs, url })
    }
    return list
  }, [project, scope])

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
        aspect={activeAspect}
        totalMs={totalMs}
        ready={ready}
        resetKey={resetKey}
        draw={draw}
        speed={playbackRate}
        onSpeedChange={setPlaybackRate}
        audioCues={audioCues}
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

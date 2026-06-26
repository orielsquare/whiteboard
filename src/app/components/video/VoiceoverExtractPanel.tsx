import { useMemo } from 'react'
import { projectForAspect } from '@lib/project/aspect'
import type { FontSet } from '@lib/project/layout'
import { buildRenderContext } from '@lib/project/render'
import { slideTimeWindows } from '@lib/project/timing'
import { useVideoStore } from '../../state/videoStore'
import { previewCanvasW } from './layoutCanvas'
import { SlideVttExtract } from './SlideVttExtract'

/**
 * The read-only "voiceover in range" extract for the selected slide, shown in the
 * right column beneath the properties panel (it used to sit under the canvas).
 * Hidden while playing. Computes the slide's project-time window from the timing.
 */
export function VoiceoverExtractPanel({ fonts }: { fonts: FontSet }) {
  const project = useVideoStore((s) => s.project)
  const activeAspect = useVideoStore((s) => s.activeAspect)
  const selectedSlideId = useVideoStore((s) => s.selectedSlideId)
  const playback = useVideoStore((s) => s.playback)
  const playbackRate = project?.playbackRate ?? 1

  const slide = project ? project.slides.find((s) => s.id === selectedSlideId) ?? project.slides[0] : undefined
  const window = useMemo(() => {
    if (!project || !slide || playback) return null
    const rc = buildRenderContext(projectForAspect(project, activeAspect), fonts, previewCanvasW(activeAspect), playbackRate)
    return slideTimeWindows(rc.timing).find((x) => x.slideId === slide.id) ?? null
  }, [project, slide, activeAspect, fonts, playbackRate, playback])

  if (!project || !window) return null
  return <SlideVttExtract cues={project.voiceover ?? []} startMs={window.startMs} endMs={window.endMs} />
}

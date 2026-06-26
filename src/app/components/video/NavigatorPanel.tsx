import type { FontSet } from '@lib/project/layout'
import { useVideoStore } from '../../state/videoStore'
import { SlidePanel } from './SlidePanel'
import { TextboxNavigator } from './TextboxNavigator'

/** The Editor's left panel: a tabbed navigator switching between the slide list
 *  and the current slide's textbox list (both carry the position/format locks).
 *  The active tab lives in the store so selecting a box can switch to it and the
 *  Inspector can show the matching properties. */
export function NavigatorPanel({ fonts }: { fonts: FontSet }) {
  const tab = useVideoStore((s) => s.navTab)
  const setTab = useVideoStore((s) => s.setNavTab)
  return (
    <div className="navpanel">
      <div className="navpanel-tabs">
        <button className={tab === 'slides' ? 'navtab navtab-on' : 'navtab'} onClick={() => setTab('slides')}>
          Slides
        </button>
        <button className={tab === 'boxes' ? 'navtab navtab-on' : 'navtab'} onClick={() => setTab('boxes')}>
          Textboxes
        </button>
      </div>
      {tab === 'slides' ? <SlidePanel fonts={fonts} /> : <TextboxNavigator />}
    </div>
  )
}

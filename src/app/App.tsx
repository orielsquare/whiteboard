import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import { DEFAULT_PARAMS, GlyphExtractor, type ExtractionParams } from '@lib/extraction'
import { DEFAULT_BRUSH, type BrushSettings } from '@lib/manifest/schema'
import { loadFontFromArrayBuffer, loadFontFromUrl, type LoadedFont } from '@lib/font/load'
import { ExtractionView } from './components/ExtractionView'
import { PreviewView } from './components/PreviewView'
import { EditorView } from './components/EditorView'
import { VideoView } from './components/video/VideoView'
import { editorHistory, ensureGlyphDerived, useEditorStore } from './state/store'

/** The two distinct tools. Font (load → extract → edit → animate → save) and
 *  Video (slide-based animated-text editor) are separate apps that happen to
 *  share a loaded font + extractor, so they get top-level tabs. */
type TopTab = 'font' | 'video'
/** Sub-tabs within the Font tool, in working order. */
type FontSubTab = 'extract' | 'editor' | 'animate'

const BUNDLED = [
  { label: 'Patrick Hand (handwriting)', url: '/fonts/PatrickHand-Regular.ttf' },
  { label: 'Fira Sans (sans)', url: '/fonts/FiraSans-Regular.ttf' },
]

export function App() {
  const [font, setFont] = useState<LoadedFont | null>(null)
  const [source, setSource] = useState(BUNDLED[0].url)
  const [error, setError] = useState<string | null>(null)
  const [topTab, setTopTab] = useState<TopTab>('font')
  const [fontSubTab, setFontSubTab] = useState<FontSubTab>('extract')

  // Shared across tabs: the active character, extraction params, and the brush.
  // selectedChar + params + brush are session/view state (NOT saved with the
  // per-glyph manifest); the brush is an applied render style, not glyph data.
  const [selectedChar, setSelectedChar] = useState('r')
  const [params, setParams] = useState<ExtractionParams>(DEFAULT_PARAMS)
  const [brush, setBrush] = useState<BrushSettings>(DEFAULT_BRUSH)

  // A single shared extractor per font (one Web Worker, one font parse).
  const [extractor, setExtractor] = useState<GlyphExtractor | null>(null)

  // The fontId of the currently-loaded manifest — used to gate derivation until
  // the right manifest is in the store.
  const manifestFontId = useEditorStore((s) => s.manifest?.metadata.fontId)

  // Load the selected bundled font.
  useEffect(() => {
    let cancelled = false
    loadFontFromUrl(source)
      .then((f) => !cancelled && (setFont(f), setError(null)))
      .catch((e) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [source])

  // One extractor, rebuilt only when the font changes.
  useEffect(() => {
    if (!font) {
      setExtractor(null)
      return
    }
    const ex = new GlyphExtractor(font.buffer)
    setExtractor(ex)
    return () => ex.dispose()
  }, [font])

  // Load (or seed) this font's manifest into the store when the font changes.
  useEffect(() => {
    if (!font) return
    useEditorStore
      .getState()
      .loadFontManifest(font)
      .then(() => editorHistory.clear())
  }, [font])

  // Central, debounced re-derivation of the active glyph: seeds it if missing
  // and re-derives it when extraction params change — unless it's been edited.
  // This fires regardless of which tab is open, so tuning in the Extraction tab
  // shows up in the Editor and Animation tabs.
  useEffect(() => {
    if (!extractor || !font || manifestFontId !== font.hash) return
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      void ensureGlyphDerived(extractor, selectedChar, params)
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [extractor, font, manifestFontId, selectedChar, params])

  const onFile = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const buf = await file.arrayBuffer()
      setFont(await loadFontFromArrayBuffer(buf, file.name))
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <h1>Font Animator</h1>
        <span className="tag">proof of concept</span>
        {font && (
          <span className="meta-inline">
            <strong>{font.family}</strong> · {font.unitsPerEm} upm
          </span>
        )}
      </header>

      {/* Top-level tool switch. */}
      <div className="tabs tabs-top">
        <button className={topTab === 'font' ? 'tab tab-on' : 'tab'} onClick={() => setTopTab('font')}>
          Font
        </button>
        <button className={topTab === 'video' ? 'tab tab-on' : 'tab'} onClick={() => setTopTab('video')}>
          Video
        </button>
      </div>

      {/* The Font tool is all about working in a font: keep its loader prominent. */}
      {topTab === 'font' && (
        <>
          <div className="toolbar">
            <label className="field">
              <span>Bundled font</span>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                {BUNDLED.map((b) => (
                  <option key={b.url} value={b.url}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>…or load your own</span>
              <input type="file" accept=".ttf,.otf,.woff" onChange={onFile} />
            </label>
          </div>

          <div className="tabs tabs-sub">
            <button className={fontSubTab === 'extract' ? 'tab tab-on' : 'tab'} onClick={() => setFontSubTab('extract')}>
              Stroke extraction
            </button>
            <button className={fontSubTab === 'editor' ? 'tab tab-on' : 'tab'} onClick={() => setFontSubTab('editor')}>
              Editor
            </button>
            <button className={fontSubTab === 'animate' ? 'tab tab-on' : 'tab'} onClick={() => setFontSubTab('animate')}>
              Animation preview
            </button>
          </div>
        </>
      )}

      {error && <div className="error">{error}</div>}

      {topTab === 'video' ? (
        !font ? (
          <div className="stage">Loading font…</div>
        ) : (
          <VideoView font={font} extractor={extractor} params={params} brush={brush} />
        )
      ) : !font ? (
        <div className="stage">Loading font…</div>
      ) : fontSubTab === 'extract' ? (
        <ExtractionView
          extractor={extractor}
          params={params}
          onParamsChange={setParams}
          selectedChar={selectedChar}
          onSelectChar={setSelectedChar}
        />
      ) : fontSubTab === 'editor' ? (
        <EditorView
          font={font}
          extractor={extractor}
          params={params}
          selectedChar={selectedChar}
          onSelectChar={setSelectedChar}
        />
      ) : (
        <PreviewView
          font={font}
          extractor={extractor}
          params={params}
          brush={brush}
          onBrushChange={setBrush}
          selectedChar={selectedChar}
        />
      )}
    </div>
  )
}

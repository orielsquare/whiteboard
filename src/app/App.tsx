import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { GlyphExtractor, extractionSig } from '@lib/extraction'
import { DEFAULT_BRUSH, type BrushSettings } from '@lib/manifest/schema'
import { loadFontFromArrayBuffer, loadFontFromUrl, type LoadedFont } from '@lib/font/load'
import { httpStore } from '@lib/persistence/FontStore'
import { apiFetch, authUrl } from '@lib/persistence/apiBase'
import { ExtractionView } from './components/ExtractionView'
import { PreviewView } from './components/PreviewView'
import { EditorView } from './components/EditorView'
import { GlyphGridView } from './components/GlyphGridView'
import { VideoView } from './components/video/VideoView'
import { DrawingView } from './components/drawing/DrawingView'
import { listFontChars } from './fontGlyphs'
import { editorHistory, ensureGlyphDerived, glyphParams, useEditorStore } from './state/store'

/** The distinct tools. Font (load → extract → edit → animate → save), Video
 *  (slide-based animated-text editor), and Drawing (SVG → animated pen strokes +
 *  hatch fills) are separate apps that get top-level tabs. */
type TopTab = 'font' | 'video' | 'draw'
/** Sub-tabs within the Font tool, in working order (Glyphs is the landing grid). */
type FontSubTab = 'glyphs' | 'extract' | 'editor' | 'animate'

// Bundled public assets resolve under the mount base (Vite serves public/ there
// but does NOT rewrite runtime URL strings), so prefix with BASE_URL.
const BUNDLED = [
  { label: 'Patrick Hand (handwriting)', url: `${import.meta.env.BASE_URL}fonts/PatrickHand-Regular.ttf` },
  { label: 'Fira Sans (sans)', url: `${import.meta.env.BASE_URL}fonts/FiraSans-Regular.ttf` },
]

export function App() {
  const [font, setFont] = useState<LoadedFont | null>(null)
  const [source, setSource] = useState(BUNDLED[0].url)
  const [error, setError] = useState<string | null>(null)
  const [topTab, setTopTab] = useState<TopTab>(() => {
    try {
      const saved = localStorage.getItem('wb.topTab')
      if (saved === 'font' || saved === 'video' || saved === 'draw') return saved
    } catch {
      /* localStorage unavailable */
    }
    return 'font'
  })
  // Reopen on the same top tool after a browser refresh.
  useEffect(() => {
    try {
      localStorage.setItem('wb.topTab', topTab)
    } catch {
      /* ignore */
    }
  }, [topTab])
  const [fontSubTab, setFontSubTab] = useState<FontSubTab>('glyphs')

  // Shared across tabs: the active character and the brush. selectedChar + brush
  // are session/view state; extraction settings are now stored PER GLYPH in the
  // manifest (see store.ts), not held here.
  const [selectedChar, setSelectedChar] = useState('r')
  const [brush, setBrush] = useState<BrushSettings>(DEFAULT_BRUSH)

  // Per-glyph "last visited" view, so clicking a glyph in the grid reopens it
  // where you last worked (stroke extraction by default, editor if you've been).
  const [glyphView, setGlyphView] = useState<Record<string, 'extract' | 'editor'>>({})
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  // Signed-in user (from the shared builder server), shown in the header.
  const [user, setUser] = useState<{ email?: string } | null>(null)
  // Cosmetic font name (rename); local draft committed on blur/Enter.
  const setFontName = useEditorStore((s) => s.setFontName)
  const manifestName = useEditorStore((s) => (s.manifest ? s.manifest.metadata.name ?? s.manifest.metadata.family : ''))
  const [fontNameDraft, setFontNameDraft] = useState('')

  // A single shared extractor per font (one Web Worker, one font parse).
  const [extractor, setExtractor] = useState<GlyphExtractor | null>(null)

  // The fontId of the currently-loaded manifest — gates derivation until the
  // right manifest is in the store.
  const manifestFontId = useEditorStore((s) => s.manifest?.metadata.fontId)
  // Save is enabled only when the live manifest differs from what's on disk
  // (collision-free monotonic edit counter vs. its last-saved baseline).
  const dirty = useEditorStore((s) => !!s.manifest && s.editRev !== s.savedRev)
  // The selected glyph's params signature — so tuning its settings re-derives it.
  const selParamsSig = useEditorStore((s) => {
    const g = s.manifest?.glyphs[String(selectedChar.codePointAt(0) ?? 0)]
    return g ? extractionSig(glyphParams(g)) : ''
  })

  // Every Unicode-mapped character in the font, ordered by code point — drives
  // the Glyphs grid and the prev/next browse arrows.
  const charList = useMemo(() => (font ? listFontChars(font.font) : []), [font])

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
  // Guarded so a rapid font switch can't let an older load land after a newer
  // one (and clear the freshly-loaded history out of order).
  useEffect(() => {
    if (!font) return
    let cancelled = false
    useEditorStore
      .getState()
      .loadFontManifest(font)
      .then(() => !cancelled && editorHistory.clear())
    return () => {
      cancelled = true
    }
  }, [font])

  // Central, debounced re-derivation of the active glyph: seeds it if missing
  // and re-derives it when ITS stored extraction settings change — unless it's
  // been edited. Fires regardless of which tab is open, so tuning in the
  // Extraction tab shows up in the Editor and Animation tabs.
  useEffect(() => {
    if (!extractor || !font || manifestFontId !== font.hash) return
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      void ensureGlyphDerived(extractor, selectedChar)
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [extractor, font, manifestFontId, selectedChar, selParamsSig])

  // Remember which per-glyph view we last used, for grid → glyph navigation.
  useEffect(() => {
    if (topTab !== 'font' || (fontSubTab !== 'extract' && fontSubTab !== 'editor')) return
    setGlyphView((m) => (m[selectedChar] === fontSubTab ? m : { ...m, [selectedChar]: fontSubTab }))
  }, [topTab, fontSubTab, selectedChar])

  // Who's signed in (the shared builder server's Google session).
  useEffect(() => {
    apiFetch(authUrl('/auth/me'))
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => u && setUser(u))
      .catch(() => {})
  }, [])

  // Sync the font-name field when the loaded font changes.
  useEffect(() => {
    setFontNameDraft(manifestName)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestFontId])

  const commitFontName = useCallback(() => {
    const n = fontNameDraft.trim()
    if (n && n !== manifestName) setFontName(n)
    else setFontNameDraft(manifestName)
  }, [fontNameDraft, manifestName, setFontName])

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

  // Click a glyph in the grid → open it where it was last worked on.
  const onPickGlyph = useCallback(
    (c: string) => {
      setSelectedChar(c)
      setFontSubTab(glyphView[c] ?? 'extract')
    },
    [glyphView],
  )

  const doSave = useCallback(async () => {
    const m = useEditorStore.getState().manifest
    if (!m || !font) return
    setSaveStatus('saving…')
    try {
      await httpStore.save(m)
      await httpStore.saveFont(m.metadata.fontId, font.buffer)
      useEditorStore.getState().markSaved()
      setSaveStatus(null) // the greyed-out Save button is the "saved" signal
    } catch (e) {
      setSaveStatus(`save failed: ${e}`)
    }
  }, [font])

  const onReload = useCallback(() => {
    if (!font) return
    void useEditorStore
      .getState()
      .loadFontManifest(font)
      .then(() => editorHistory.clear())
    setSaveStatus(null)
  }, [font])

  return (
    <div className="app">
      <header className="topbar">
        <h1>Font Animator</h1>
        <span className="tag">proof of concept</span>
        {/* The font reference is only meaningful on the Font tab; in the Video tool
            fonts are a per-run formatting choice, so it would be redundant/confusing. */}
        {font && topTab === 'font' && (
          <span className="meta-inline">
            <strong>{font.family}</strong> · {font.unitsPerEm} upm
          </span>
        )}
        <span className="spacer" />
        {user?.email && <span className="meta-inline user-inline" title="signed in">{user.email}</span>}
      </header>

      {/* Top-level tool switch. */}
      <div className="tabs tabs-top">
        <button className={topTab === 'font' ? 'tab tab-on' : 'tab'} onClick={() => setTopTab('font')}>
          Font
        </button>
        <button className={topTab === 'draw' ? 'tab tab-on' : 'tab'} onClick={() => setTopTab('draw')}>
          Drawing
        </button>
        <button className={topTab === 'video' ? 'tab tab-on' : 'tab'} onClick={() => setTopTab('video')}>
          Video
        </button>
      </div>

      {/* The Font tool is all about working in a font: keep its loader + the
          font-wide Undo/Save/Reload actions prominent across every sub-tab. */}
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

          <div className="font-actions">
            <button onClick={() => editorHistory.undo()}>↶ Undo</button>
            <button onClick={() => editorHistory.redo()}>↷ Redo</button>
            <label className="field font-name-field">
              <span>Name</span>
              <input
                className="font-name-input"
                value={fontNameDraft}
                onChange={(e) => setFontNameDraft(e.target.value)}
                onBlur={commitFontName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                placeholder="font name"
                title="Rename this font (cosmetic — the font is identified by its content hash)"
              />
            </label>
            <span className="spacer" />
            {saveStatus && <span className="savestatus-inline">{saveStatus}</span>}
            <button className="primary" onClick={doSave} disabled={!dirty} title={dirty ? 'Save font to disk' : 'No unsaved changes'}>
              💾 Save font
            </button>
            <button onClick={onReload}>Reload from disk</button>
          </div>

          <div className="tabs tabs-sub">
            <button className={fontSubTab === 'glyphs' ? 'tab tab-on' : 'tab'} onClick={() => setFontSubTab('glyphs')}>
              Glyphs
            </button>
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

      {topTab === 'draw' ? (
        <DrawingView brush={brush} onBrushChange={setBrush} />
      ) : topTab === 'video' ? (
        !font ? (
          <div className="stage">Loading font…</div>
        ) : (
          <VideoView font={font} extractor={extractor} brush={brush} />
        )
      ) : !font ? (
        <div className="stage">Loading font…</div>
      ) : fontSubTab === 'glyphs' ? (
        <GlyphGridView font={font} extractor={extractor} chars={charList} onPick={onPickGlyph} />
      ) : fontSubTab === 'extract' ? (
        <ExtractionView
          extractor={extractor}
          selectedChar={selectedChar}
          onSelectChar={setSelectedChar}
          chars={charList}
        />
      ) : fontSubTab === 'editor' ? (
        <EditorView
          font={font}
          extractor={extractor}
          selectedChar={selectedChar}
          onSelectChar={setSelectedChar}
          chars={charList}
        />
      ) : (
        <PreviewView
          font={font}
          extractor={extractor}
          brush={brush}
          onBrushChange={setBrush}
          selectedChar={selectedChar}
        />
      )}
    </div>
  )
}

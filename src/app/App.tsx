import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { GlyphExtractor, extractionSig } from '@lib/extraction'
import { DEFAULT_BRUSH, type BrushSettings } from '@lib/manifest/schema'
import { loadFontFromArrayBuffer, loadFontFromUrl, type LoadedFont } from '@lib/font/load'
import { httpStore, type FontSummary } from '@lib/persistence/FontStore'
import { apiFetch, authUrl } from '@lib/persistence/apiBase'
import { FilesMenu } from './components/files/FilesMenu'
import { usePrompt } from './components/files/PromptDialog'
import { useConfirm } from './components/video/ConfirmDialog'
import { ExtractionView } from './components/ExtractionView'
import { PreviewView } from './components/PreviewView'
import { EditorView } from './components/EditorView'
import { GlyphGridView } from './components/GlyphGridView'
import { VideoView } from './components/video/VideoView'
import { DrawingView } from './components/drawing/DrawingView'
import { listFontChars } from './fontGlyphs'
import { editorHistory, ensureGlyphDerived, glyphParams, useEditorStore } from './state/store'
import { prefGet, prefSet } from './state/sessionPrefs'
import { autosaveRead, slotIsNewer } from './state/autosave'
import type { FontManifest } from '@lib/manifest/schema'

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

/** A font source: a bundled URL, or `saved:<id>` for a Drive-stored font. */
const isKnownSource = (s: string) => s.startsWith('saved:') || BUNDLED.some((b) => b.url === s)

export function App() {
  const [font, setFont] = useState<LoadedFont | null>(null)
  // The last-opened source survives a refresh (bundled URL or saved:<id>; a font
  // loaded from a local FILE can't be restored — its bytes only existed in the picker).
  const [source, setSource] = useState(() => {
    const s = prefGet('wb.font.source', BUNDLED[0].url)
    return isKnownSource(s) ? s : BUNDLED[0].url
  })
  useEffect(() => {
    prefSet('wb.font.source', source)
  }, [source])
  const [error, setError] = useState<string | null>(null)
  const [topTab, setTopTab] = useState<TopTab>(() => {
    const saved = prefGet<string>('wb.topTab', 'font')
    return saved === 'video' || saved === 'draw' ? saved : 'font'
  })
  // Reopen on the same top tool after a browser refresh.
  useEffect(() => {
    prefSet('wb.topTab', topTab)
  }, [topTab])
  const [fontSubTab, setFontSubTab] = useState<FontSubTab>(() => {
    const t = prefGet<string>('wb.font.subTab', 'glyphs')
    return t === 'extract' || t === 'editor' || t === 'animate' ? t : 'glyphs'
  })
  useEffect(() => {
    prefSet('wb.font.subTab', fontSubTab)
  }, [fontSubTab])

  // Shared across tabs: the active character and the brush. selectedChar + brush
  // are session/view state (persisted across refreshes); extraction settings are
  // stored PER GLYPH in the manifest (see store.ts), not held here.
  const [selectedChar, setSelectedChar] = useState(() => prefGet('wb.font.char', 'r') || 'r')
  useEffect(() => {
    prefSet('wb.font.char', selectedChar)
  }, [selectedChar])
  const [brush, setBrush] = useState<BrushSettings>(() => ({ ...DEFAULT_BRUSH, ...prefGet<Partial<BrushSettings>>('wb.brush', {}) }))
  useEffect(() => {
    prefSet('wb.brush', brush)
  }, [brush])

  // Per-glyph "last visited" view, so clicking a glyph in the grid reopens it
  // where you last worked (stroke extraction by default, editor if you've been).
  const [glyphView, setGlyphView] = useState<Record<string, 'extract' | 'editor'>>({})
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  // Saved fonts on Drive (the Files ▾ menu).
  const [savedFonts, setSavedFonts] = useState<FontSummary[]>([])
  const refreshFonts = useCallback(() => {
    void httpStore.list().then(setSavedFonts).catch(() => {})
  }, [])
  const { prompt, modal: promptModal } = usePrompt()
  const { confirm, modal: confirmModal } = useConfirm()
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
  // Ask before discarding unsaved font edits (Open / switch source / Reload).
  const confirmDiscard = useCallback(
    async () => !useEditorStore.getState().manifest || !dirty || (await confirm('You have unsaved font changes — discard them?')),
    [dirty, confirm],
  )
  // The selected glyph's params signature — so tuning its settings re-derives it.
  const selParamsSig = useEditorStore((s) => {
    const g = s.manifest?.glyphs[String(selectedChar.codePointAt(0) ?? 0)]
    return g ? extractionSig(glyphParams(g)) : ''
  })

  // Every Unicode-mapped character in the font, ordered by code point — drives
  // the Glyphs grid and the prev/next browse arrows.
  const charList = useMemo(() => (font ? listFontChars(font.font) : []), [font])

  // Load the selected source: a bundled URL, or a SAVED font (`saved:<id>` —
  // bytes from Drive; the font's identity becomes the STORED id, not the bytes
  // hash, so a duplicated font opens with its own manifest).
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<LoadedFont> => {
      if (source.startsWith('saved:')) {
        const id = source.slice('saved:'.length)
        const buf = await httpStore.loadFontBytes(id)
        if (!buf) throw new Error('saved font not found on the server')
        const f = await loadFontFromArrayBuffer(buf, `${id}.ttf`)
        return { ...f, hash: id }
      }
      return loadFontFromUrl(source)
    }
    load()
      .then((f) => !cancelled && (setFont(f), setError(null)))
      .catch((e) => {
        if (cancelled) return
        setError(String(e))
        // A stale saved:<id> (deleted on Drive) must not brick the app — fall back.
        if (source.startsWith('saved:')) setSource(BUNDLED[0].url)
      })
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
  // one (and clear the freshly-loaded history out of order). If a NEWER autosaved
  // working copy of this font exists (an edit session lost to a refresh/crash),
  // restore it and mark the manifest dirty.
  useEffect(() => {
    if (!font) return
    let cancelled = false
    useEditorStore
      .getState()
      .loadFontManifest(font)
      .then(() => {
        if (cancelled) return
        const slot = autosaveRead<FontManifest>('font')
        const cur = useEditorStore.getState().manifest
        if (
          slot &&
          cur &&
          slot.id === font.hash &&
          slot.doc?.metadata?.fontId === font.hash &&
          slotIsNewer(slot.at, cur.updatedAt)
        ) {
          useEditorStore.getState().restoreManifest(slot.doc)
          setSaveStatus('restored unsaved changes — Save to keep them')
        }
        editorHistory.clear()
      })
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

  const onFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      e.target.value = ''
      if (!(await confirmDiscard())) return
      try {
        const buf = await file.arrayBuffer()
        setFont(await loadFontFromArrayBuffer(buf, file.name))
        setError(null)
      } catch (err) {
        setError(String(err))
      }
    },
    [confirmDiscard],
  )

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
      refreshFonts()
    } catch (e) {
      setSaveStatus(`save failed: ${e}`)
    }
  }, [font, refreshFonts])

  const onReload = useCallback(async () => {
    if (!font) return
    if (!(await confirmDiscard())) return
    void useEditorStore
      .getState()
      .loadFontManifest(font)
      .then(() => editorHistory.clear())
    setSaveStatus(null)
  }, [font, confirmDiscard])

  const rid = () => {
    try {
      return crypto.randomUUID().slice(0, 8)
    } catch {
      return Math.random().toString(36).slice(2, 10)
    }
  }

  /** Save a copy of the LIVE font treatment (manifest + bytes) under a new id and
   *  switch to it — so one typeface can carry two stroke treatments. */
  const doSaveAsFont = useCallback(async () => {
    const m = useEditorStore.getState().manifest
    if (!m || !font) return
    const name = await prompt('Save a copy as:', `${m.metadata.name ?? m.metadata.family} copy`)
    if (!name) return
    setSaveStatus('saving copy…')
    try {
      const now = new Date().toISOString()
      const newId = `${m.metadata.fontId}-${rid()}`
      await httpStore.save({ ...m, metadata: { ...m.metadata, fontId: newId, name }, createdAt: now, updatedAt: now })
      await httpStore.saveFont(newId, font.buffer)
      setSaveStatus(null)
      refreshFonts()
      setSource(`saved:${newId}`) // switch the editor to the copy
    } catch (e) {
      setSaveStatus(`copy failed: ${e}`)
    }
  }, [font, prompt, refreshFonts])

  // Files-menu operations (Open/Rename/Duplicate/Delete on the saved-fonts list).
  const openSavedFont = useCallback(
    async (id: string) => {
      if (font?.hash === id) return
      if (!(await confirmDiscard())) return
      setSource(`saved:${id}`)
    },
    [font, confirmDiscard],
  )
  const renameSavedFont = useCallback(
    async (id: string, name: string) => {
      if (font?.hash === id) {
        setFontName(name)
        setFontNameDraft(name)
        setSaveStatus('renamed — Save to persist')
        return
      }
      const m = await httpStore.load(id)
      if (m) await httpStore.save({ ...m, metadata: { ...m.metadata, name }, updatedAt: new Date().toISOString() })
    },
    [font, setFontName],
  )
  const duplicateSavedFont = useCallback(async (id: string, name: string) => {
    const [m, bytes] = await Promise.all([httpStore.load(id), httpStore.loadFontBytes(id)])
    if (!m || !bytes) {
      setSaveStatus('duplicate failed: the saved font is incomplete (missing manifest or bytes)')
      return
    }
    const now = new Date().toISOString()
    const newId = `${id}-${rid()}`
    await httpStore.save({ ...m, metadata: { ...m.metadata, fontId: newId, name }, createdAt: now, updatedAt: now })
    await httpStore.saveFont(newId, bytes)
  }, [])
  const deleteSavedFont = useCallback(
    async (id: string) => {
      try {
        await httpStore.remove(id)
        if (font?.hash === id) setSaveStatus('deleted from Drive — the open font is now unsaved')
      } catch (e) {
        setSaveStatus(`delete failed: ${e}`)
      }
    },
    [font],
  )

  return (
    <div className="app">
      {promptModal}
      {confirmModal}
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
              <select
                value={source.startsWith('saved:') ? '' : source}
                onChange={async (e) => {
                  const url = e.target.value
                  if (!url || url === source) return
                  if (!(await confirmDiscard())) return
                  setSource(url)
                }}
              >
                {source.startsWith('saved:') && <option value="">(saved font open)</option>}
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
            <button className="primary" onClick={doSave} disabled={!dirty} title={dirty ? 'Save font to Drive' : 'No unsaved changes'}>
              💾 Save font
            </button>
            <button onClick={doSaveAsFont} title="Save a copy of this treatment under a new name">⎘ Save a copy</button>
            <FilesMenu
              items={savedFonts.map((f) => ({
                id: f.id,
                name: f.name ?? f.family,
                meta: `${f.glyphCount} glyph${f.glyphCount === 1 ? '' : 's'}`,
                updatedAt: f.updatedAt,
              }))}
              currentId={font?.hash ?? null}
              emptyLabel="No saved fonts"
              onRefresh={refreshFonts}
              onOpen={openSavedFont}
              onRename={renameSavedFont}
              onDuplicate={duplicateSavedFont}
              onDelete={deleteSavedFont}
              renameHint="renamed — Save to persist"
            />
            <button onClick={onReload} title="Reload the open font from Drive (discards unsaved changes)">Reload</button>
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

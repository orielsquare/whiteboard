// Standalone unit test for the pure WebVTT engine (src/lib/project/vtt.ts).
// Type-only imports → esbuild strips them and it runs alone. Run: node tools/vtt.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const src = readFileSync(new URL('../src/lib/project/vtt.ts', import.meta.url), 'utf8')
const js = (await esbuild.transform(src, { loader: 'ts', format: 'esm' })).code
const dir = mkdtempSync(join(tmpdir(), 'vtt-'))
const out = join(dir, 'vtt.mjs')
writeFileSync(out, js)
const V = await import(pathToFileURL(out).href)

let passed = 0
let failed = 0
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (name, cond, got) => {
  if (cond) passed++
  else { failed++; console.error(`✗ ${name}` + (got !== undefined ? ` — got ${JSON.stringify(got)}` : '')) }
}

// timestamps
check('fmt 0', V.formatTimestamp(0) === '00:00:00.000', V.formatTimestamp(0))
check('fmt 3661500', V.formatTimestamp(3661500) === '01:01:01.500', V.formatTimestamp(3661500))
check('parse HH:MM:SS.mmm', V.parseTimestamp('01:01:01.500') === 3661500, V.parseTimestamp('01:01:01.500'))
check('parse MM:SS.mmm', V.parseTimestamp('00:05.250') === 5250, V.parseTimestamp('00:05.250'))
check('parse comma frac', V.parseTimestamp('00:00:01,000') === 1000, V.parseTimestamp('00:00:01,000'))
check('parse bad → null', V.parseTimestamp('nope') === null)

// serialize → parse round trip
{
  const cues = [
    { id: 'c1', startMs: 1000, endMs: 4000, text: 'Hello there.' },
    { id: 'c2', startMs: 4500, endMs: 8000, text: 'Two\nlines.' },
  ]
  const vtt = V.serializeVtt(cues)
  check('serialize starts WEBVTT', vtt.startsWith('WEBVTT'), vtt.slice(0, 10))
  const { cues: p, errors } = V.parseVtt(vtt)
  check('roundtrip no errors', errors.length === 0, errors)
  check('roundtrip 2 cues', p.length === 2, p.length)
  check('roundtrip ids', p[0].id === 'c1' && p[1].id === 'c2', p.map((c) => c.id))
  check('roundtrip times', p[0].startMs === 1000 && p[1].endMs === 8000, [p[0].startMs, p[1].endMs])
  check('roundtrip multiline text', p[1].text === 'Two\nlines.', p[1].text)
}

// serialize sorts by start
{
  const vtt = V.serializeVtt([
    { id: 'b', startMs: 5000, endMs: 6000, text: 'second' },
    { id: 'a', startMs: 1000, endMs: 2000, text: 'first' },
  ])
  const { cues } = V.parseVtt(vtt)
  check('serialize sorted', cues[0].id === 'a' && cues[1].id === 'b', cues.map((c) => c.id))
}

// tolerant parse: cue without id + malformed block
{
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
no id cue

garbage block without timing

00:00:03.000 --> 00:00:04.000
ok`
  const { cues, errors } = V.parseVtt(vtt)
  check('parse 2 valid cues', cues.length === 2, cues.length)
  check('parse cue w/o id', cues[0].id === undefined, cues[0].id)
  check('parse reports error', errors.length >= 1, errors)
}

// reconcileParsed: preserve audio by id, assign id when missing
{
  let n = 0
  const mk = () => `new-${++n}`
  const prev = [{ id: 'c1', startMs: 0, endMs: 1, text: 'x', audio: { file: 'c1.m4a', durationMs: 1200, textHash: 'h' } }]
  const parsed = [
    { id: 'c1', startMs: 100, endMs: 1100, text: 'x' }, // matches → keep audio
    { startMs: 2000, endMs: 3000, text: 'fresh' }, // no id → new
  ]
  const r = V.reconcileParsed(prev, parsed, mk)
  check('reconcile keeps audio', r[0].audio && r[0].audio.file === 'c1.m4a', r[0].audio)
  check('reconcile updates time', r[0].startMs === 100, r[0].startMs)
  check('reconcile new id assigned', r[1].id === 'new-1' && !r[1].audio, r[1])
}

// estimate + range + staleness
check('estimate min', V.estimateDurationMs('') === 600, V.estimateDurationMs(''))
check('estimate words', V.estimateDurationMs('one two three') === 1080, V.estimateDurationMs('one two three'))
{
  const cues = [
    { id: 'a', startMs: 500, endMs: 1000, text: 'a' },
    { id: 'b', startMs: 2500, endMs: 3000, text: 'b' },
    { id: 'c', startMs: 4000, endMs: 5000, text: 'c' },
  ]
  const inRange = V.cuesInRange(cues, 1000, 4000)
  check('cuesInRange by start', eq(inRange.map((c) => c.id), ['b']), inRange.map((c) => c.id))
}
{
  const text = 'hello'
  const fresh = { id: 'x', startMs: 0, endMs: 1, text, audio: { file: 'x', durationMs: 1, textHash: V.hashText(text) } }
  const stale = { id: 'y', startMs: 0, endMs: 1, text: 'changed', audio: { file: 'y', durationMs: 1, textHash: V.hashText('orig') } }
  check('not stale when hash matches', V.isAudioStale(fresh) === false)
  check('stale when text changed', V.isAudioStale(stale) === true)
}
{
  // staleness is text-only: different voice/settings is NOT stale
  const text = 'hello'
  const tts = { voiceId: 'v1', voiceName: 'V', model: 'eleven_multilingual_v2', direction: '', settings: { stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1 } }
  const other = { ...tts, voiceId: 'v2', settings: { ...tts.settings, stability: 0.9 } }
  const cue = { id: 'z', startMs: 0, endMs: 1, text, audio: { file: 'z', durationMs: 1, tts, textHash: V.hashText(text) } }
  check('fresh when text matches (any tts)', V.isAudioStale(cue) === false)
  check('not stale just because tts would differ', V.isAudioStale({ ...cue, audio: { ...cue.audio, tts: other } }) === false)
  check('stale when text changed', V.isAudioStale({ ...cue, text: 'changed' }) === true)
  check('no audio → not stale', V.isAudioStale({ id: 'n', startMs: 0, endMs: 1, text }) === false)
}
{
  // captionsVtt: escape markup chars + drop zero-length/reversed cues
  const out = V.captionsVtt([
    { id: 'a', startMs: 1000, endMs: 3000, text: '3 < 5 & x > 0' },
    { id: 'b', startMs: 5000, endMs: 5000, text: 'zero length' }, // dropped
    { id: 'c', startMs: 9000, endMs: 8000, text: 'reversed' }, // dropped
  ])
  check('captions escape < > &', out.includes('3 &lt; 5 &amp; x &gt; 0'))
  check('captions drop zero-length cue', !out.includes('zero length'))
  check('captions drop reversed cue', !out.includes('reversed'))
  check('captions keep the valid cue id+timing', out.includes('a\n00:00:01.000 --> 00:00:03.000'))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

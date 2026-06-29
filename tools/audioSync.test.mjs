// Unit test for nextAudioAction (src/app/components/video/audioSync.ts) — the pure
// scheduling decision behind the preview voiceover playback. audioSync.ts has only
// `import type`, so esbuild strips types and we run it standalone (cf. svgGeometry).
// Run: node tools/audioSync.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const src = readFileSync(new URL('../src/app/components/video/audioSync.ts', import.meta.url), 'utf8')
const js = (await esbuild.transform(src, { loader: 'ts', format: 'esm' })).code
const dir = mkdtempSync(join(tmpdir(), 'audiosync-'))
const out = join(dir, 'audioSync.mjs')
writeFileSync(out, js)
const { nextAudioAction } = await import(pathToFileURL(out).href)

let passed = 0
let failed = 0
const eq = (got, want, msg) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) passed++
  else { failed++; console.error(`✗ ${msg}\n    got:  ${g}\n    want: ${w}`) }
}

const cue = { id: 'a', startMs: 1000, endMs: 5000, url: 'x' }

// forward playback crossing the cue's start (offset = one frame) → play from 0, no clip
eq(nextAudioAction(cue, 1000, true, false), { kind: 'start', seekTo: 0 }, 'exactly at start → start at 0')
eq(nextAudioAction(cue, 1016, true, false), { kind: 'start', seekTo: 0 }, 'one frame in → still start at 0 (no clipped intro)')
eq(nextAudioAction(cue, 1090, true, false), { kind: 'start', seekTo: 0 }, 'within 100ms → start at 0')

// resumed mid-cue (a scrub / un-pause well inside the clip) → seek there to stay aligned
eq(nextAudioAction(cue, 1100, true, false), { kind: 'start', seekTo: 0.1 }, '100ms in → seek to 0.1')
eq(nextAudioAction(cue, 3000, true, false), { kind: 'start', seekTo: 2 }, 'mid-cue resume → seek to the offset')

// THE FIX: once started, an in-window cue is left alone — no clock-chasing re-seek
// (re-seeking during start-up latency is what clipped the beginning).
eq(nextAudioAction(cue, 1016, true, true), { kind: 'none' }, 'already started → none (no re-seek at the start)')
eq(nextAudioAction(cue, 4000, true, true), { kind: 'none' }, 'already started, deep in cue → none')

// outside the window, paused, or before/after → pause (and the engine re-arms it)
eq(nextAudioAction(cue, 500, true, false), { kind: 'pause' }, 'before the cue → pause')
eq(nextAudioAction(cue, 5000, true, true), { kind: 'pause' }, 'at endMs (exclusive) → pause')
eq(nextAudioAction(cue, 6000, true, true), { kind: 'pause' }, 'after the cue → pause')
eq(nextAudioAction(cue, 2000, false, false), { kind: 'pause' }, 'not playing (paused) → pause even mid-window')
eq(nextAudioAction(cue, 2000, false, true), { kind: 'pause' }, 'not playing, already started → pause (re-arm)')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

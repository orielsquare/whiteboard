// Unit test for buildTtsText (tools/tts.mjs): how a v3 delivery `direction` is
// folded into the synthesized text as an inline AUDIO TAG (square-bracketed, so v3
// interprets it rather than speaking it). tts.mjs is plain ESM with no load-time
// side effects, so we import it directly. Run: node tools/tts.test.mjs
import { buildTtsText } from './tts.mjs'

let passed = 0
let failed = 0
const eq = (got, want, msg) => {
  if (got === want) passed++
  else { failed++; console.error(`✗ ${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`) }
}

// v3 + a bare direction → wrapped in [..] so it's an audio tag, not spoken
eq(buildTtsText('Hello there', true, 'warmly'), '[warmly] Hello there', 'v3 bare direction is bracketed')
eq(buildTtsText('Hi', true, 'slowly and softly'), '[slowly and softly] Hi', 'v3 wraps a multi-word bare direction')

// v3 + a direction the user already bracketed → passed through verbatim
eq(buildTtsText('Hello', true, '[whispers]'), '[whispers] Hello', 'v3 keeps the user’s own audio tags')
eq(buildTtsText('Hello', true, '[warmly] [slowly]'), '[warmly] [slowly] Hello', 'v3 keeps multiple user tags')
eq(buildTtsText('Hi', true, '  [excited]  '), '[excited] Hi', 'v3 trims surrounding whitespace')

// v3 + empty/blank direction → just the text (no stray brackets)
eq(buildTtsText('Hello', true, ''), 'Hello', 'v3 empty direction → text only')
eq(buildTtsText('Hello', true, '   '), 'Hello', 'v3 blank direction → text only')
eq(buildTtsText('Hello', true, undefined), 'Hello', 'v3 missing direction → text only')

// non-v3 models have no audio tags → the direction is IGNORED (never read aloud)
eq(buildTtsText('Hello', false, 'warmly'), 'Hello', 'non-v3 ignores the direction (not spoken)')
eq(buildTtsText('Hello', false, '[whispers]'), 'Hello', 'non-v3 ignores even bracketed directions')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)

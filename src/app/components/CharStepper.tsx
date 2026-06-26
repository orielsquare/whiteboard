/**
 * The "Character" / "Glyph" input plus ‹ › arrows that step through the font's
 * glyph list, so you can browse neighbouring characters without retyping. Shared
 * by the Stroke extraction and Editor tabs.
 */
export function CharStepper({
  label,
  value,
  onChange,
  chars,
  width = 70,
}: {
  label: string
  value: string
  onChange: (c: string) => void
  chars: string[]
  width?: number
}) {
  const idx = chars.indexOf(value)
  const step = (dir: -1 | 1) => {
    // Off-list value (a typed word / a char without a glyph): recover to the
    // first glyph rather than stepping in a misleading direction.
    if (idx < 0) {
      if (chars.length) onChange(chars[0])
      return
    }
    const j = idx + dir
    if (j >= 0 && j < chars.length) onChange(chars[j])
  }
  // maxLength={2} allows a surrogate-pair emoji; normalise to a single code point
  // so the displayed value can't be two BMP chars while consumers use codePointAt(0).
  const onInput = (raw: string) => {
    const cp = raw.codePointAt(0)
    onChange(cp != null ? String.fromCodePoint(cp) : ' ')
  }
  return (
    <div className="charstepper">
      <button className="step" title="previous glyph" onClick={() => step(-1)} disabled={chars.length === 0 || idx === 0}>
        ‹
      </button>
      <label className="field">
        <span>{label}</span>
        <input value={value} maxLength={2} onChange={(e) => onInput(e.target.value)} style={{ width }} />
      </label>
      <button
        className="step"
        title="next glyph"
        onClick={() => step(1)}
        disabled={chars.length === 0 || (idx >= 0 && idx >= chars.length - 1)}
      >
        ›
      </button>
    </div>
  )
}

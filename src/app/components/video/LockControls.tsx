import type { MouseEvent } from 'react'

export type LockState = 'on' | 'off' | 'mixed'

/** A padlock glyph: open (unlocked/unlinked) or closed (locked/linked). */
function LockIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        // closed: ∩ with both legs into the body; open: right leg lifted out.
        d={open ? 'M5 8V5a3 3 0 0 1 5.8-1.1' : 'M5 8V5a3 3 0 0 1 6 0v3'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="3.2" y="8" width="9.6" height="6.3" rx="1.4" fill="currentColor" />
    </svg>
  )
}

/** A single padlock toggle (position 'p' or format 'f'). Stops click propagation
 *  so it doesn't also select the row. */
export function LockButton({
  kind,
  state,
  disabled,
  title,
  onClick,
}: {
  kind: 'p' | 'f'
  state: LockState
  disabled?: boolean
  title?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      className={`lockbtn lock-${kind} lock-${state}${disabled ? ' lock-disabled' : ''}`}
      title={title}
      disabled={disabled}
      onClick={(e: MouseEvent) => {
        e.stopPropagation()
        onClick?.()
      }}
    >
      <LockIcon open={state === 'off'} />
    </button>
  )
}

/** A column header: the letter 'p' / 'f', sized to sit directly over its padlock
 *  column. Clickable (bulk-apply); its colour reflects the aggregate lock state. */
export function LockColHeader({
  label,
  state,
  disabled,
  title,
  onClick,
}: {
  label: string
  state: LockState
  disabled?: boolean
  title?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      className={`lockhead lock-${state}${disabled ? ' lock-disabled' : ''}`}
      title={title}
      disabled={disabled}
      onClick={(e: MouseEvent) => {
        e.stopPropagation()
        onClick?.()
      }}
    >
      {label}
    </button>
  )
}

/** Aggregate a set of booleans into a tri-state lock indicator. */
export function aggregateLock(values: boolean[]): LockState {
  if (values.length === 0) return 'on'
  if (values.every(Boolean)) return 'on'
  if (values.every((v) => !v)) return 'off'
  return 'mixed'
}

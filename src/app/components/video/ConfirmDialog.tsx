import { useState, type ReactNode } from 'react'

/**
 * Minimal promise-based confirm dialog. `confirm(message)` resolves true/false;
 * render `modal` somewhere in the component. Used for the lock revert warning
 * ("re-linking will change the other aspect to match this one"). Phase 3 will
 * enrich this into the directional re-link modal (with before/after preview).
 */
export function useConfirm() {
  const [state, setState] = useState<{ message: ReactNode; resolve: (ok: boolean) => void } | null>(null)
  const confirm = (message: ReactNode) => new Promise<boolean>((resolve) => setState({ message, resolve }))
  const close = (ok: boolean) => {
    setState((s) => {
      s?.resolve(ok)
      return null
    })
  }
  const modal = state ? (
    <div className="confirm-overlay" onClick={() => close(false)}>
      <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-msg">{state.message}</p>
        <div className="confirm-actions">
          <button className="tool" onClick={() => close(false)}>
            Cancel
          </button>
          <button className="tool primary" onClick={() => close(true)}>
            Continue
          </button>
        </div>
      </div>
    </div>
  ) : null
  return { confirm, modal }
}

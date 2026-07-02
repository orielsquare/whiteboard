import { useState, type ReactNode } from 'react'

/**
 * Minimal promise-based text prompt (the `window.prompt` replacement, styled like
 * `useConfirm`'s dialog). `prompt(message, initial)` resolves the entered string,
 * or null on cancel; render `modal` somewhere in the component.
 */
export function usePrompt() {
  const [state, setState] = useState<{ message: ReactNode; resolve: (v: string | null) => void } | null>(null)
  const [draft, setDraft] = useState('')
  const prompt = (message: ReactNode, initial = '') =>
    new Promise<string | null>((resolve) => {
      setDraft(initial)
      setState({ message, resolve })
    })
  const close = (v: string | null) => {
    setState((s) => {
      s?.resolve(v)
      return null
    })
  }
  const modal = state ? (
    <div className="confirm-overlay" onClick={() => close(null)}>
      <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-msg">{state.message}</p>
        <input
          className="prompt-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) close(draft.trim())
            if (e.key === 'Escape') close(null)
          }}
        />
        <div className="confirm-actions">
          <button className="tool" onClick={() => close(null)}>
            Cancel
          </button>
          <button className="tool primary" disabled={!draft.trim()} onClick={() => close(draft.trim())}>
            OK
          </button>
        </div>
      </div>
    </div>
  ) : null
  return { prompt, modal }
}

import { useEffect } from 'react'
import { useApp } from '../store/app'

/**
 * Agent-mode (v2) approval dialog. Main is blocked on this answer — Approve
 * resolves the harness gate and the tool executes; Deny / Escape reports a
 * safe denial back to the loop (nothing runs).
 */
export default function ApproveModal() {
  const ask = useApp((s) => s.v2Ask)
  const answer = useApp((s) => s.answerV2)

  // Escape = deny while the dialog is up
  useEffect(() => {
    if (!ask) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        useApp.getState().answerV2(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ask])

  if (!ask) return null

  const entries = Object.entries(ask.args ?? {})
  const describe =
    ask.name === 'write_file'
      ? 'write this file'
      : ask.name === 'run_command'
        ? 'run this command'
        : `use ${ask.name}`

  return (
    <div className="overlay approve-overlay">
      <div className="modal approve-modal" role="dialog" aria-modal="true" aria-label="Approve tool action">
        <h2>
          CODEZY wants to {describe}
          <span className="approve-badge">agent mode</span>
        </h2>

        <div className="approve-tool">{ask.name}</div>

        {entries.map(([k, v]) => (
          <div className="approve-arg" key={k}>
            <b>{k}</b>
            <pre>{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>
          </div>
        ))}

        <div className="approve-note">Confined to the linked folder — paths outside it are rejected</div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn ghost" onClick={() => answer(false)}>
            Deny
          </button>
          <button className="btn primary" autoFocus onClick={() => answer(true)}>
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}

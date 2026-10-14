import { useEffect, useState } from 'react'
import { useApp } from '../store/app'
import { changeCounts, type ParsedEdit } from '../../../shared/edits'
import { DiffFile } from './EditCard'

/**
 * Agent-mode (v2) approval dialog. Main is blocked on this answer — Approve
 * resolves the harness gate and the tool executes; Deny / Escape reports a
 * safe denial back to the loop (nothing runs).
 *
 * v3 review-first: write_file and edit_file show a REAL diff — the same card
 * the v1 edit bar uses — instead of a wall of raw JSON. write_file reads the
 * current file from disk so you see exactly what the rewrite replaces;
 * edit_file diffs the old/new fragments the model passed.
 */
export default function ApproveModal() {
  const ask = useApp((s) => s.v2Ask)
  const answer = useApp((s) => s.answerV2)
  const [current, setCurrent] = useState<{ text: string | null; loaded: boolean }>({ text: null, loaded: false })

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

  // write_file: fetch the CURRENT content so the diff shows the real delta
  useEffect(() => {
    setCurrent({ text: null, loaded: false })
    if (!ask || ask.name !== 'write_file') return
    const target = String((ask.args as Record<string, unknown>)?.path ?? '')
    const sid = useApp.getState().activeId
    if (!target || !sid) {
      setCurrent({ text: null, loaded: true })
      return
    }
    let dead = false
    void window.codezy.ide
      .read(sid, target)
      .then((res) => !dead && setCurrent({ text: res?.content ?? null, loaded: true }))
      .catch(() => !dead && setCurrent({ text: null, loaded: true }))
    return () => {
      dead = true
    }
  }, [ask])

  if (!ask) return null

  const args = (ask.args ?? {}) as Record<string, unknown>
  const describe =
    ask.name === 'write_file'
      ? 'write this file'
      : ask.name === 'edit_file'
        ? 'edit this file'
        : ask.name === 'run_command'
          ? args.background
            ? 'start this background task'
            : 'run this command'
          : `use ${ask.name}`

  // build the diff card for the two editing tools
  let edit: ParsedEdit | null = null
  if (ask.name === 'write_file' && typeof args.content === 'string') {
    edit = {
      path: String(args.path ?? '(no path)'),
      search: current.text ?? '',
      replace: args.content,
      isNew: current.text === null,
      ...changeCounts(current.text ?? '', args.content, current.text === null)
    }
  } else if (ask.name === 'edit_file' && typeof args.old === 'string' && typeof args.new === 'string') {
    edit = {
      path: String(args.path ?? '(no path)'),
      search: args.old,
      replace: args.new,
      isNew: false,
      ...changeCounts(args.old, args.new)
    }
  }

  // the raw payload stays available, just not as the first thing you see
  const rawEntries = Object.entries(args).filter(
    ([k]) => !edit || (k !== 'content' && k !== 'old' && k !== 'new')
  )

  return (
    <div className="overlay approve-overlay">
      <div className="modal approve-modal" role="dialog" aria-modal="true" aria-label="Approve tool action">
        <h2>
          CODEZY wants to {describe}
          <span className="approve-badge">agent mode</span>
        </h2>

        <div className="approve-tool">{ask.name}</div>

        {edit &&
          (ask.name === 'write_file' && !current.loaded ? (
            <div className="approve-loading">reading the current file…</div>
          ) : (
            <div className="approve-diff">
              <DiffFile edit={edit} />
            </div>
          ))}

        {rawEntries.length > 0 && (
          <details className="approve-raw">
            <summary>raw arguments</summary>
            {rawEntries.map(([k, v]) => (
              <div className="approve-arg" key={k}>
                <b>{k}</b>
                <pre>{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>
              </div>
            ))}
          </details>
        )}

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

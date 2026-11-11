import { useEffect } from 'react'
import { useApp } from '../store/app'
import type { Notice } from '../store/app'
import { IconAlert, IconInfo, IconUndo } from './Icons'

/** One toast: informational ones fade away on their own, errors wait for a
 *  click. Errors render a short WHAT + FIX sentence, with the raw engine text
 *  behind a "Technical details" disclosure — no more a wall of JSON. */
function Toast({ notice }: { notice: Notice }) {
  const dismiss = useApp((s) => s.dismissNotice)

  useEffect(() => {
    // errors and action pills (Undo) wait for the user; info fades away
    if (notice.kind === 'error' || notice.action) return
    const t = setTimeout(() => dismiss(notice.id), 7000)
    return () => clearTimeout(t)
  }, [notice.id, notice.kind, notice.action, dismiss])

  return (
    <div className={`toast${notice.kind === 'error' ? ' error' : ''}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <span className="toast-mark" aria-hidden>
        {notice.kind === 'error' ? <IconAlert style={{ width: 14, height: 14 }} /> : <IconInfo style={{ width: 14, height: 14 }} />}
      </span>
      <div className="toast-body">
        <span className="toast-text">{notice.text}</span>
        {notice.detail && (
          <details className="toast-detail">
            <summary>Technical details</summary>
            <pre>{notice.detail}</pre>
          </details>
        )}
      </div>
      {notice.action && (
        <button
          className="toast-action"
          onClick={(e) => {
            e.stopPropagation()
            dismiss(notice.id)
            void notice.action?.run()
          }}
        >
          <IconUndo style={{ width: 13, height: 13 }} />
          {notice.action.label}
        </button>
      )}
      <button
        className="toast-close"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={(e) => {
          e.stopPropagation()
          dismiss(notice.id)
        }}
      >
        ×
      </button>
    </div>
  )
}

/** Bottom-right stack replacing the old in-chat notice rows. */
export default function ToastStack() {
  const notices = useApp((s) => s.notices)
  if (!notices.length) return null
  return (
    <div className="toast-stack" aria-live="polite">
      {notices.map((n) => (
        <Toast key={n.id} notice={n} />
      ))}
    </div>
  )
}

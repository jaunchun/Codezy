import { useEffect, useState } from 'react'
import { useApp } from '../store/app'
import type { TaskInfo } from '../../../shared/api'

/** Compact "3m 12s ago" for a task's start time. */
const fmtAgo = (ts: number) => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** batch30 — the agent's background children (`run_command {"background":
 *  true}`), surfaced for the user as an in-chat window (same shape as
 *  /usage): live status, output tail, and a kill button. Polls while open so
 *  exit codes and output stream in without a manual refresh. */
export default function TasksPanel() {
  const open = useApp((s) => s.tasksOpen)
  const setOpen = useApp((s) => s.setTasksOpen)
  const [tasks, setTasks] = useState<TaskInfo[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    const pull = () => {
      void window.codezy.tasks
        .list()
        .then((ts) => {
          if (!alive) return
          setTasks(ts)
          void useApp.getState().refreshTasks() // keep the composer chip in sync
        })
        .catch(() => undefined)
    }
    pull()
    const iv = window.setInterval(pull, 1600) // live-ish output + exit codes
    return () => {
      alive = false
      window.clearInterval(iv)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  const kill = (uid: string) => {
    void window.codezy.tasks
      .stop(uid)
      .then(() => {
        // the tree-kill fires the child's 'close' in main — one more pull
        // (a beat later) shows the exit code
        window.setTimeout(() => {
          void window.codezy.tasks
            .list()
            .then((ts) => setTasks(ts))
            .catch(() => undefined)
        }, 260)
      })
      .catch(() => undefined)
  }

  const toggle = (uid: string) => setExpanded(expanded === uid ? null : uid)

  return (
    <div className="tasks-panel" role="region" aria-label="Background tasks">
      <div className="tasks-body">
        <div className="tasks-head">
          <span className="tasks-title">Background tasks</span>
          <span className="tasks-sub">
            {tasks ? `${tasks.filter((t) => t.running).length} running · ${tasks.length} total` : '…'}
          </span>
          <button className="tasks-x" onClick={() => setOpen(false)} title="Close (Esc)">
            ✕
          </button>
        </div>

        {!tasks ? (
          <div className="tasks-loading">checking…</div>
        ) : !tasks.length ? (
          <div className="tasks-empty">
            No background tasks — ask the agent for <code>run_command {'{"background": true}'}</code> and it
            shows up here.
          </div>
        ) : (
          <div className="tasks-list">
            {tasks.map((t) => (
              <div key={t.uid} className="task-row">
                <div
                  className="task-line"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(t.uid)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggle(t.uid)
                    }
                  }}
                >
                  <span
                    className={`task-dot${t.running ? ' run' : t.code != null && t.code !== 0 ? ' bad' : ''}`}
                  />
                  <span className="task-id" title={t.workspace}>
                    #{t.id}
                  </span>
                  <span className="task-cmd" title={t.command}>
                    {t.command}
                  </span>
                  <span className="task-meta">
                    {t.running
                      ? t.started
                        ? `${fmtAgo(t.started)} ago`
                        : 'running'
                      : `exit ${t.code ?? '?'}`}
                  </span>
                  {t.running && (
                    <button
                      className="task-kill"
                      onClick={(e) => {
                        e.stopPropagation()
                        kill(t.uid)
                      }}
                      title="Stop this task"
                    >
                      stop
                    </button>
                  )}
                </div>
                {expanded === t.uid && <pre className="task-out">{t.out || '(no output yet)'}</pre>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

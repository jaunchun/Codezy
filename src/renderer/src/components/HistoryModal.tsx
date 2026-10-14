import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../store/app'
import type { BackupInfo } from '../../../shared/api'

/**
 * /history — every safety copy CODEZY wrote before touching a file, newest
 * first, with a Restore button on each.
 *
 * Why it exists: /undo only ever steps back one batch. After a few accepts
 * (or an auto-mode run) the only way back was "hope you saved it yourself".
 * Restoring an older point snapshots the CURRENT state first, so /undo still
 * returns you to where you were — you can never lose work by rolling back.
 */
export default function HistoryModal() {
  const open = useApp((s) => s.historyOpen)
  const setOpen = useApp((s) => s.setHistoryOpen)
  const activeId = useApp((s) => s.activeId)
  const ideTick = useApp((s) => s.ideTick)
  const addNotice = useApp((s) => s.addNotice)
  const undoLast = useApp((s) => s.undoLast)
  const bumpIdeTick = useApp((s) => s.bumpIdeTick)
  const [rows, setRows] = useState<BackupInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!activeId) {
      setRows([])
      return
    }
    void window.codezy.edits
      .list(activeId)
      .then((r) => setRows(r))
      .catch(() => setRows([]))
  }, [activeId])

  useEffect(() => {
    if (open) load()
  }, [open, load, ideTick])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  const restore = async (id: string) => {
    if (!activeId || busy) return
    setBusy(id)
    try {
      const res = await window.codezy.edits.restore(activeId, id)
      addNotice(res.message, res.restored ? 'info' : 'error')
      if (res.restored) {
        bumpIdeTick() // the cowork tree shows the restored contents
        load()
      }
    } catch (e) {
      addNotice(`Restore failed: ${e instanceof Error ? e.message : e}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const stepBack = async () => {
    await undoLast()
    bumpIdeTick()
    load()
  }

  if (!open) return null

  const stamp = (ts: number) =>
    new Date(ts).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })

  return (
    <div className="usage-panel hist-panel" role="region" aria-label="Edit history">
      <div className="usage-body">
        <div className="usage-head">
          <div className="usage-tabs">
            <button className="usage-tab on">Edit history</button>
            <span className="hist-sub">
              a backup of the originals is written before every file change
            </span>
          </div>
          <div className="segmented">
            <button onClick={() => void stepBack()} title="Revert the newest batch (/undo)">
              Undo newest
            </button>
            <button className="x" onClick={() => setOpen(false)} title="Close (Esc)">
              ✕
            </button>
          </div>
        </div>

        {rows === null ? (
          <div className="usage-loading">reading backups…</div>
        ) : rows.length === 0 ? (
          <div className="usage-fact">
            No backups for this chat yet — CODEZY writes one the moment an edit touches a file.
          </div>
        ) : (
          <div className="hist-list">
            {rows.map((r, i) => (
              <div className="hist-row" key={r.id} style={{ animationDelay: `${i * 35}ms` }}>
                <span className="hist-time">{stamp(r.ts)}</span>
                <span className="hist-files" title={r.files.join('\n')}>
                  {r.files.slice(0, 3).join(', ')}
                  {r.files.length > 3 ? ` +${r.files.length - 3}` : ''}
                </span>
                <span className="hist-count">
                  {r.files.length} file{r.files.length === 1 ? '' : 's'}
                </span>
                <button
                  className="btn"
                  disabled={busy === r.id}
                  onClick={() => void restore(r.id)}
                  title="Put these files back as they were before that batch"
                >
                  {busy === r.id ? 'Restoring…' : 'Restore'}
                </button>
              </div>
            ))}
            <div className="usage-fact">
              Restoring an older point keeps a backup of the current files — /undo returns to them.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

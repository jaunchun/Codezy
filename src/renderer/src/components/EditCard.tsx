import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../store/app'
import {
  parseEdits,
  diffLines,
  toHunks,
  composeHunks,
  type ParsedEdit,
  type DiffLine
} from '../../../shared/edits'
import type { ChatMessage } from '../../../shared/types'
import { IconAlert, IconCheck, IconPencil, IconX } from './Icons'

const MAX_PREVIEW_LINES = 400
const CTX_COLLAPSE = 14 // unchanged runs longer than this collapse to …
const CTX_KEEP = 4

type DiffItem = DiffLine | { gap: number }

/** Collapse long unchanged runs so the changed lines stay on screen. */
function collapse(lines: DiffLine[]): DiffItem[] {
  const out: DiffItem[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].type !== 'ctx') {
      out.push(lines[i])
      i++
      continue
    }
    let j = i
    while (j < lines.length && lines[j].type === 'ctx') j++
    const run = j - i
    if (run > CTX_COLLAPSE) {
      out.push(...lines.slice(i, i + CTX_KEEP), { gap: run - CTX_KEEP * 2 }, ...lines.slice(j - CTX_KEEP))
    } else {
      out.push(...lines.slice(i, j))
    }
    i = j
  }
  return out
}

/** One file's side of the preview popup: header + numbered, collapsed diff.
 *  With `review` set it becomes PIECEWISE — every hunk carries a toggle and
 *  the composed text is reported upward (`null` = every hunk kept, so the
 *  caller needs no override for this file). */
export function DiffFile({
  edit,
  review
}: {
  edit: ParsedEdit
  review?: { onCompose: (replace: string | null) => void }
}) {
  const lines = useMemo<DiffLine[]>(
    () => (edit.isNew ? diffLines('', edit.replace) : diffLines(edit.search, edit.replace)),
    [edit]
  )
  const hunks = useMemo(() => toHunks(lines), [lines])
  const [keep, setKeep] = useState<Set<number>>(() => new Set(hunks.map((h) => h.id)))
  useEffect(() => {
    if (!review) return
    review.onCompose(keep.size === hunks.length ? null : composeHunks(lines, hunks, keep))
    // review is an inline prop — only the selection should re-report
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keep, hunks])
  const toggleHunk = (id: number) =>
    setKeep((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const items = useMemo(() => collapse(lines), [lines])
  const shown = items.slice(0, MAX_PREVIEW_LINES)
  const base = edit.path.split(/[\\/]/).pop() ?? edit.path
  const reviewable = !!review && hunks.length > 0
  let oldNo = 1
  let newNo = 1

  return (
    <div className="diff-file">
      <header>
        <span className="diff-name">
          <b>{base}</b>
          <span className="diff-path">{edit.path}</span>
        </span>
        <span className="diff-badges">
          <span className={`badge ${edit.isNew ? 'new' : 'mod'}`}>{edit.isNew ? 'new file' : 'modify'}</span>
          <b className="add">+{edit.added}</b>
          <b className="del">−{edit.removed}</b>
        </span>
      </header>
      <div className="diff-body">
        {reviewable ? (
          <>
            {hunks.length > 1 && (
              <div className="hunk-toolbar">
                <span className="hunk-count">
                  {keep.size} of {hunks.length} hunks will be applied
                </span>
                <button className="btn ghost" onClick={() => setKeep(new Set(hunks.map((h) => h.id)))}>
                  all
                </button>
                <button className="btn ghost" onClick={() => setKeep(new Set())}>
                  none
                </button>
              </div>
            )}
            {hunks.map((h) => (
              <div key={h.id} className={`diff-hunk${keep.has(h.id) ? '' : ' off'}`}>
                {hunks.length > 1 && (
                  <label className="hunk-pick" title={keep.has(h.id) ? 'Click to skip this hunk' : 'Click to apply this hunk'}>
                    <input
                      type="checkbox"
                      checked={keep.has(h.id)}
                      onChange={() => toggleHunk(h.id)}
                      aria-label={`Apply hunk ${h.id + 1} of ${edit.path}`}
                    />
                    <span>
                      hunk {h.id + 1} · <b className="add">+{h.added}</b> <b className="del">−{h.removed}</b>
                    </span>
                  </label>
                )}
                {h.lines.map((it, i) => (
                  <div key={i} className={`diff-line ${it.type}`}>
                    <span className="gl">{it.type === 'add' ? '+' : it.type === 'del' ? '−' : ' '}</span>
                    <span className="tx">{it.text || ' '}</span>
                  </div>
                ))}
              </div>
            ))}
          </>
        ) : (
          <>
            {shown.map((it, i) => {
              if ('gap' in it) {
                return (
                  <div key={i} className="diff-line gap">
                    ⋯ {it.gap} unchanged lines ⋯
                  </div>
                )
              }
              const isAdd = it.type === 'add'
              const isDel = it.type === 'del'
              const num = isAdd ? newNo : oldNo
              if (!isAdd) oldNo++
              if (!isDel) newNo++
              return (
                <div
                  key={i}
                  className={`diff-line ${it.type}`}
                  style={{ animationDelay: `${Math.min(i * 8, 420)}ms` }}
                >
                  <span className="ln">{num}</span>
                  <span className="gl">{isAdd ? '+' : isDel ? '−' : ' '}</span>
                  <span className="tx">{it.text || ' '}</span>
                </div>
              )
            })}
            {items.length > shown.length && (
              <div className="diff-line more">… {items.length - shown.length} more lines</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** The "Preview and confirm edits" popup: full diff, accept or decline.
 *  Every block is tickable, so one file of a five-file proposal can be
 *  written now and the rest reviewed later. */
function EditPreview({
  items,
  onClose,
  onAccept,
  onAlways,
  onDecline
}: {
  items: { edit: ParsedEdit; idx: number }[]
  onClose: () => void
  onAccept: (only: number[], overrides: Record<number, string>) => void
  onAlways: () => void
  onDecline: () => void
}) {
  const folders = useApp((s) => s.sessions.find((x) => x.id === s.activeId)?.linkedFolders ?? null)
  const [picked, setPicked] = useState<Set<number>>(() => new Set(items.map((i) => i.idx)))
  // per-edit composed text from hunk-level review — idx → the replacement
  // that applies ONLY the ticked hunks (missing = the file as proposed)
  const [overrides, setOverrides] = useState<Record<number, string>>({})
  const hunksOff = Object.keys(overrides).length

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (picked.size) onAccept([...picked], overrides)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onAccept, picked, overrides])

  const toggle = (idx: number) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  const allOn = picked.size === items.length

  return (
    <div
      className="overlay preview-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal preview-modal" role="dialog" aria-label="Preview edits">
        <h2>
          <span>
            Preview edits <em className="count">{items.length} file{items.length === 1 ? '' : 's'}</em>
          </span>
          <button className="x" onClick={onClose} title="Close">
            <IconX style={{ width: 14, height: 14 }} />
          </button>
        </h2>

        <div className="preview-note">
          {folders?.length
            ? 'Accepting writes the TICKED files into your linked folder — every original is backed up, /undo reverts.'
            : 'No folder linked yet — link one with the folder button in the composer before accepting.'}
          <button
            className="btn ghost"
            style={{ marginLeft: 8 }}
            onClick={() => setPicked(allOn ? new Set() : new Set(items.map((i) => i.idx)))}
          >
            {allOn ? 'none' : 'all'}
          </button>
        </div>

        <div className="diff-list">
          {items.map(({ edit, idx }) => (
            <div key={edit.path + edit.search.slice(0, 24)} className={`diff-wrap${picked.has(idx) ? '' : ' off'}`}>
              <label className="diff-pick" title="Write this file on accept">
                <input
                  type="checkbox"
                  checked={picked.has(idx)}
                  onChange={() => toggle(idx)}
                  aria-label={`Include ${edit.path}`}
                />
                <span>{picked.has(idx) ? 'will write' : 'skipped'}</span>
              </label>
              <DiffFile
                edit={edit}
                review={{
                  onCompose: (replace) =>
                    setOverrides((prev) => {
                      const next = { ...prev }
                      if (replace === null) delete next[idx]
                      else next[idx] = replace
                      return next
                    })
                }}
              />
            </div>
          ))}
        </div>

        <div className="preview-actions">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <span className="kbd-hint">Ctrl + Enter accept · Esc close</span>
          <span className="grow" />
          <button
            className="btn ghost"
            onClick={onAlways}
            title="Switch to auto mode — this and every future proposal applies immediately"
          >
            Always
          </button>
          <button className="btn danger" onClick={onDecline}>
            <IconX style={{ width: 13, height: 13 }} />
            Decline
          </button>
          <button
            className="btn primary"
            disabled={!picked.size}
            onClick={() => onAccept([...picked], overrides)}
            title={allOn ? 'Write every proposed file' : `Write the ${picked.size} ticked file(s)`}
          >
            <IconCheck style={{ width: 13, height: 13 }} />
            {allOn ? 'Accept and write' : `Write ${picked.size} of ${items.length}`}
            {hunksOff ? ' (ticked hunks only)' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The bar under an assistant message that proposed file changes —
 * "New edit" · counts · Preview and confirm edits · Accept / Decline.
 */
export default function EditCard({ message }: { message: ChatMessage }) {
  const s = useApp()
  const session = s.sessions.find((x) => x.id === s.activeId)
  const all = useMemo(() => parseEdits(message.content), [message.content])
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!all.length || !session) return null
  if (session.resolvedEdits?.includes(message.id)) return null
  // blocks written by an earlier PARTIAL accept drop out of the offer
  const written = new Set(session.appliedEdits?.[message.id] ?? [])
  const items = all
    .map((edit, idx) => ({ edit, idx }))
    .filter((x) => !written.has(x.idx))
  if (!items.length) return null
  const edits = items.map((x) => x.edit)

  const folders = session.linkedFolders ?? []
  const added = edits.reduce((n, e) => n + e.added, 0)
  const removed = edits.reduce((n, e) => n + e.removed, 0)
  const mode = s.settings?.mode ?? 'build'

  async function accept(only?: number[], overrides?: Record<number, string>) {
    setBusy(true)
    try {
      await s.acceptEdits(message.id, only, overrides)
    } finally {
      setBusy(false)
    }
  }

  /** The TUI's "a" key: switch to auto mode, then write this proposal. */
  async function always() {
    setBusy(true)
    try {
      await s.updateSettings({ mode: 'auto' })
      s.addNotice('Auto mode on — future edits apply immediately (backed up, /undo reverts).')
      await s.acceptEdits(message.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="editbar" role="group" aria-label="Proposed file edits">
        <span className="edit-ico" aria-hidden>
          <IconPencil style={{ width: 15, height: 15 }} />
        </span>
        <span className="edit-title">New edit{edits.length === 1 ? '' : 's'}</span>
        <span className="edit-meta">
          {edits.length} file{edits.length === 1 ? '' : 's'} ·{' '}
          <b className="add">+{added}</b> <b className="del">−{removed}</b>
        </span>
        <span className="grow" />

        <button className="btn ghost" onClick={() => setPreview(true)}>
          Preview and confirm edits
        </button>
        {mode !== 'plan' && (
          <>
            <button
              className="btn ghost"
              disabled={busy}
              title="Switch to auto mode — this and every future proposal applies immediately"
              onClick={() => void always()}
            >
              Always
            </button>
            <button
              className="btn primary"
              disabled={busy}
              title={
                folders.length
                  ? 'Write these edits to the linked folder'
                  : 'No folder linked yet — you will pick one right now'
              }
              onClick={() => void accept()}
            >
              <IconCheck style={{ width: 13, height: 13 }} />
              Accept
            </button>
            <button className="btn danger" disabled={busy} onClick={() => void s.declineEdits(message.id)}>
              <IconX style={{ width: 13, height: 13 }} />
              Decline
            </button>
          </>
        )}
        {mode === 'plan' && <span className="edit-hint">plan mode — switch to build/auto to apply</span>}
      </div>

      {preview && (
        <EditPreview
          items={items}
          onClose={() => setPreview(false)}
          onAccept={(only, overrides) => {
            setPreview(false)
            void accept(only, overrides)
          }}
          onAlways={() => {
            setPreview(false)
            void always()
          }}
          onDecline={() => {
            setPreview(false)
            void s.declineEdits(message.id)
          }}
        />
      )}
    </>
  )
}

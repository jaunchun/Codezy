import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../store/app'
import { parseEdits, diffLines, type ParsedEdit, type DiffLine } from '../../../shared/edits'
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

/** One file's side of the preview popup: header + numbered, collapsed diff. */
function DiffFile({ edit }: { edit: ParsedEdit }) {
  const lines = useMemo<DiffLine[]>(
    () => (edit.isNew ? diffLines('', edit.replace) : diffLines(edit.search, edit.replace)),
    [edit]
  )
  const items = useMemo(() => collapse(lines), [lines])
  const shown = items.slice(0, MAX_PREVIEW_LINES)
  const base = edit.path.split(/[\\/]/).pop() ?? edit.path
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
      </div>
    </div>
  )
}

/** The "Preview and confirm edits" popup: full diff, accept or decline. */
function EditPreview({
  edits,
  onClose,
  onAccept,
  onAlways,
  onDecline
}: {
  edits: ParsedEdit[]
  onClose: () => void
  onAccept: () => void
  onAlways: () => void
  onDecline: () => void
}) {
  const folders = useApp((s) => s.sessions.find((x) => x.id === s.activeId)?.linkedFolders ?? null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        onAccept()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onAccept])

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
            Preview edits <em className="count">{edits.length} file{edits.length === 1 ? '' : 's'}</em>
          </span>
          <button className="x" onClick={onClose} title="Close">
            <IconX style={{ width: 14, height: 14 }} />
          </button>
        </h2>

        <div className="preview-note">
          {folders?.length
            ? 'Accepting writes these into your linked folder — every original is backed up, /undo reverts.'
            : 'No folder linked yet — link one with the folder button in the composer before accepting.'}
        </div>

        <div className="diff-list">
          {edits.map((e) => (
            <DiffFile key={e.path + e.search.slice(0, 24)} edit={e} />
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
          <button className="btn primary" onClick={onAccept}>
            <IconCheck style={{ width: 13, height: 13 }} />
            Accept and write
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
  const edits = useMemo(() => parseEdits(message.content), [message.content])
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!edits.length || !session) return null
  if (session.resolvedEdits?.includes(message.id)) return null

  const folders = session.linkedFolders ?? []
  const added = edits.reduce((n, e) => n + e.added, 0)
  const removed = edits.reduce((n, e) => n + e.removed, 0)
  const mode = s.settings?.mode ?? 'build'

  async function accept() {
    setBusy(true)
    try {
      await s.acceptEdits(message.id)
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
          edits={edits}
          onClose={() => setPreview(false)}
          onAccept={() => {
            setPreview(false)
            void accept()
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

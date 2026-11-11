import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store/app'
import type { FileSearchHit, FileSearchResult } from '../../../shared/api'
import { useFocusTrap } from '../lib/useFocusTrap'
import { IconCode, IconSearch, IconX } from './Icons'

/** One line of a hit, with the exact match wrapped in <mark>. */
function HitLine({ hit, query }: { hit: FileSearchHit; query: string }): React.JSX.Element {
  const q = query.trim()
  let at = Math.max(0, hit.previewColumn - 1)
  if (hit.text.slice(at, at + q.length).toLowerCase() !== q.toLowerCase()) {
    const found = hit.text.toLowerCase().indexOf(q.toLowerCase())
    at = found === -1 ? 0 : found
  }
  const len = hit.length || q.length
  return (
    <>
      <span className="find-line-no">{hit.line}</span>
      <span className="find-line-text">
        {hit.text.slice(0, at)}
        <mark>{hit.text.slice(at, at + len)}</mark>
        {hit.text.slice(at + len)}
      </span>
    </>
  )
}

/**
 * Ctrl+Shift+G — Find in files (v3.1). Literal, case-insensitive content
 * search across every folder linked to the active chat, grouped by file.
 * Enter (or a click) opens the hit in the cowork editor at that line.
 */
export default function FindInFiles(): React.JSX.Element | null {
  const open = useApp((s) => s.findFilesOpen)
  const activeId = useApp((s) => s.activeId)
  const sessions = useApp((s) => s.sessions)
  const linked = useMemo(
    () => sessions.find((x) => x.id === activeId)?.linkedFolders ?? [],
    [sessions, activeId]
  )

  const [query, setQuery] = useState('')
  const [result, setResult] = useState<FileSearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  const close = (): void => {
    useApp.getState().setFindFilesOpen(false)
  }
  useFocusTrap(open, panelRef, close, inputRef)

  // a fresh open starts empty and focuses the query
  useEffect(() => {
    if (!open) return
    seq.current++
    setQuery('')
    setResult(null)
    setSel(0)
    setBusy(false)
  }, [open])

  // switching chats drops the previous chat's hits immediately
  useEffect(() => {
    if (!open) return
    seq.current++
    setResult(null)
    setSel(0)
    setBusy(false)
  }, [open, activeId])

  // debounce typing into one main-process walk
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    // bump the token now, not in the timeout: a walk already on the way must
    // not paint hits for a query or chat the user just moved away from
    const token = ++seq.current
    if (q.length < 2 || !activeId || !linked.length) {
      setResult(null)
      setBusy(false)
      return
    }
    setBusy(true)
    const t = window.setTimeout(() => {
      void window.codezy.files
        .search(activeId, q)
        .then((r) => {
          if (token !== seq.current) return
          setResult(r)
          setSel(0)
          setBusy(false)
        })
        .catch(() => {
          if (token !== seq.current) return
          setResult(null)
          setBusy(false)
        })
    }, 180)
    return () => window.clearTimeout(t)
  }, [open, query, activeId, linked.length])

  const hits = result?.hits ?? []
  const files = useMemo(() => new Set(hits.map((h) => h.path)).size, [hits])

  // keep the keyboard cursor visible
  useEffect(() => {
    if (!open) return
    document.getElementById(`find-hit-${sel}`)?.scrollIntoView({ block: 'nearest' })
  }, [sel, open])

  if (!open) return null

  const typed = query.trim().length >= 2
  const openHit = (hit: FileSearchHit): void => {
    useApp.getState().revealInIde(hit)
    useApp.getState().setFindFilesOpen(false)
  }
  const link = async (): Promise<void> => {
    const st = useApp.getState()
    if (!st.activeId) await st.newChat()
    const folder = await window.codezy.dialog.pickFolder('Search a folder')
    if (folder) await useApp.getState().linkFolder(folder)
    inputRef.current?.focus()
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((i) => Math.min(i + 1, Math.max(0, hits.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      const hit = hits[sel] ?? hits[0]
      if (hit) {
        e.preventDefault()
        openHit(hit)
      }
    }
  }

  return (
    <div
      className="find-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        className="find-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Find in files"
      >
        <div className="find-head">
          <IconSearch style={{ width: 15, height: 15 }} aria-hidden />
          <input
            ref={inputRef}
            value={query}
            placeholder="Find in files…"
            aria-label="Find in files"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          {typed && !busy && (
            <span className="find-count" aria-live="polite">
              {hits.length} {hits.length === 1 ? 'match' : 'matches'}
              {hits.length ? ` · ${files} ${files === 1 ? 'file' : 'files'}` : ''}
            </span>
          )}
          {busy && <span className="find-count">searching…</span>}
          <button className="find-close" aria-label="Close find in files" onClick={close}>
            <IconX style={{ width: 13, height: 13 }} />
          </button>
        </div>

        <div className="find-results">
          {!linked.length ? (
            <div className="find-empty">
              <p>This chat has no linked folder to search.</p>
              <button className="btn primary" onClick={() => void link()}>
                Link a folder
              </button>
            </div>
          ) : !typed ? (
            <div className="find-empty">Type at least two characters to search the linked folders.</div>
          ) : !busy && result && !hits.length ? (
            <div className="find-empty">No file matches “{query.trim()}”.</div>
          ) : (
            hits.map((hit, i) => {
              const first = i === 0 || hits[i - 1].path !== hit.path
              return (
                <div key={`${hit.path}:${hit.line}:${hit.column}`} className="find-group-item">
                  {first && (
                    <div className="find-file">
                      <IconCode style={{ width: 13, height: 13 }} aria-hidden />
                      <span className="find-file-name">{hit.name}</span>
                    </div>
                  )}
                  <button
                    id={`find-hit-${i}`}
                    className={`find-hit${i === sel ? ' on' : ''}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => openHit(hit)}
                  >
                    <HitLine hit={hit} query={query} />
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="find-foot">
          {result ? (
            <>
              {result.scanned.toLocaleString()} files scanned
              {result.truncated ? ' · stopped at a search cap — narrow the query' : ''}
            </>
          ) : (
            'Enter opens the highlighted hit · ↑ ↓ to move · Esc closes'
          )}
        </div>
      </div>
    </div>
  )
}

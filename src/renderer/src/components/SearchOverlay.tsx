import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store/app'
import type { ChatSearchHit } from '../../../shared/api'
import { IconSearch, IconX } from './Icons'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Snippet with every query occurrence wrapped in <mark> (case-insensitive). */
function mark(snippet: string, q: string) {
  const t = q.trim()
  if (t.length < 2) return snippet
  const parts = snippet.split(new RegExp(`(${escapeRe(t)})`, 'ig'))
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))
}

/** "14:32" for today, "Oct 8" otherwise. */
const when = (ts: number) => {
  const d = new Date(ts)
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Ctrl+Shift+F — full-text search across every chat (v3.1). Picking a hit
 *  jumps to that chat; ChatView scrolls the message into view and flashes it. */
export default function SearchOverlay() {
  const open = useApp((s) => s.searchOpen)
  const hits = useApp((s) => s.searchHits)
  const query = useApp((s) => s.searchQuery)
  const [text, setText] = useState('')
  const [active, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // reset + focus whenever the overlay opens
  useEffect(() => {
    if (!open) return
    setText('')
    setActiveIdx(0)
    void useApp.getState().runSearch('')
    const t = window.setTimeout(() => inputRef.current?.focus(), 10)
    return () => window.clearTimeout(t)
  }, [open])

  // debounce the typing into a store search (180 ms — feels instant, hammers nothing)
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => void useApp.getState().runSearch(text), 180)
    return () => window.clearTimeout(t)
  }, [text, open])

  // a new result set resets the highlight
  useEffect(() => {
    setActiveIdx(0)
  }, [hits.length])

  if (!open) return null
  const typed = text.trim().length >= 2
  const pick = (hit: ChatSearchHit) => useApp.getState().openSearchHit(hit)

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, hits.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      const hit = hits[active] ?? hits[0]
      if (hit) pick(hit)
    } else if (e.key === 'Escape') {
      useApp.getState().setSearchOpen(false)
    }
  }

  return (
    <div
      className="search-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useApp.getState().setSearchOpen(false)
      }}
    >
      <div className="search-panel" role="dialog" aria-label="Search every chat">
        <div className="search-head">
          <IconSearch style={{ width: 15, height: 15 }} aria-hidden />
          <input
            ref={inputRef}
            value={text}
            placeholder="Search every chat…"
            aria-label="Search every chat"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
          {typed && (
            <span className="search-count">
              {hits.length} {hits.length === 1 ? 'hit' : 'hits'}
            </span>
          )}
          <button className="search-close" aria-label="Close search" onClick={() => useApp.getState().setSearchOpen(false)}>
            <IconX style={{ width: 13, height: 13 }} />
          </button>
        </div>
        <div className="search-results">
          {!typed && <div className="search-empty">Type at least two characters to search every chat’s messages.</div>}
          {typed && !hits.length && <div className="search-empty">No message matches “{query}”.</div>}
          {hits.map((hit, i) => (
            <button
              key={`${hit.sessionId}:${hit.messageId}:${i}`}
              className={`search-hit${i === active ? ' on' : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => pick(hit)}
            >
              <span className="hit-meta">
                <span className="hit-chat">{hit.sessionTitle}</span>
                <span className="hit-role">{hit.role}</span>
                <span className="hit-time">{when(hit.ts)}</span>
              </span>
              <span className="hit-text">{mark(hit.snippet, query)}</span>
            </button>
          ))}
        </div>
        <div className="search-foot">Enter opens the highlighted hit · ↑ ↓ to move · Esc closes</div>
      </div>
    </div>
  )
}

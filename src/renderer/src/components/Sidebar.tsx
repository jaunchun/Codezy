import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../store/app'
import {
  CubeLogo,
  IconAlert,
  IconChat,
  IconCheck,
  IconDownload,
  IconDrive,
  IconDuplicate,
  IconFolder,
  IconGear,
  IconPencil,
  IconPin,
  IconPlus,
  IconSearch,
  IconSquare,
  IconTerminal,
  IconTrash,
  IconUser,
  IconX
} from './Icons'

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Sorting of the chat list — remembered between sessions. */
type ChatSort = 'recent' | 'name'

const readSort = (): ChatSort => {
  try {
    return localStorage.getItem('codezy.chatSort') === 'name' ? 'name' : 'recent'
  } catch {
    return 'recent'
  }
}

export default function Sidebar() {
  const s = useApp()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [group, setGroup] = useState('')
  const [rootPath, setRootPath] = useState<string | null>(null)
  // right-click menu on a chat row + inline rename state
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; confirmDel: boolean } | null>(null)
  // confirm menu opened by the row trash — a plain click used to hard-delete
  const [delConfirm, setDelConfirm] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const renameCancelled = useRef(false)
  // chat search + archive + sort
  const [q, setQ] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [sort, setSort] = useState<ChatSort>(readSort)

  // close the context / delete-confirm menu on outside clicks / Escape
  useEffect(() => {
    if (!menu && !delConfirm) return
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.ctx-menu')) return
      setMenu(null)
      setDelConfirm(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null)
        setDelConfirm(null)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, delConfirm])

  // group projects like folders: { Work: [...], University: [...] }
  const groups = new Map<string, typeof s.projects>()
  for (const p of s.projects) {
    const key = p.group || 'General'
    groups.set(key, [...(groups.get(key) ?? []), p])
  }

  const base = s.filterProjectId
    ? s.sessions.filter((x) => x.projectId === s.filterProjectId)
    : s.sessions
  const archivedCount = base.filter((x) => x.archived).length
  // archived chats disappear until you ask for them (search includes them,
  // or an archived chat would be unfindable while it is hidden)
  const term = q.trim().toLowerCase()
  const visible = base.filter((x) => (term ? true : showArchived || !x.archived))
  const searched = term
    ? visible.filter(
        (x) =>
          x.title.toLowerCase().includes(term) ||
          x.messages.some((m) => !m.hidden && m.content.toLowerCase().includes(term))
      )
    : visible
  // pinned chats float to the top (stable sort keeps recency inside each group)
  const chats = [...searched].sort((a, b) => {
    const pin = Number(!!b.pinned) - Number(!!a.pinned)
    if (pin) return pin
    if (sort === 'name') return a.title.localeCompare(b.title)
    return b.updatedAt - a.updatedAt
  })
  // what the active chat will actually run on (per-chat override wins)
  const effModel = s.sessions.find((x) => x.id === s.activeId)?.model ?? s.settings?.activeModel ?? 'Ollama'

  const changeSort = (next: ChatSort) => {
    setSort(next)
    try {
      localStorage.setItem('codezy.chatSort', next)
    } catch {
      /* not remembered — the sort still applies for this session */
    }
  }

  async function createProject() {
    if (!name.trim()) return
    await s.addProject({ name, group, rootPath })
    setAdding(false)
    setName('')
    setGroup('')
    setRootPath(null)
  }

  return (
    <aside className="sidebar">
      {/* PROJECTS ------------------------------------------------------- */}
      <div className="side-section-title">
        Projects
        <IconPlus
          style={{ cursor: 'pointer', width: 14, height: 14 }}
          onClick={() => setAdding((v) => !v)}
        />
      </div>

      {adding && (
        <div className="composer" style={{ padding: 8, gap: 6 }}>
          <input
            type="text"
            placeholder="Project name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void createProject()}
            style={inputStyle}
          />
          <input
            type="text"
            placeholder="Folder (Work, Uni, …)"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            style={inputStyle}
          />
          <div className="row">
            <button
              className="chip"
              onClick={async () => setRootPath(await window.codezy.dialog.pickFolder('Link a folder'))}
            >
              <IconFolder style={{ width: 13, height: 13 }} />
              {rootPath ? (
                <>
                  <span>Linked</span>
                  <IconCheck style={{ width: 13, height: 13 }} />
                </>
              ) : (
                'Link folder'
              )}
            </button>
            <button className="btn primary" style={{ marginLeft: 'auto', padding: '4px 10px' }} onClick={() => void createProject()}>
              Add
            </button>
          </div>
        </div>
      )}

      <div className="side-scroll">
        {[...groups.entries()].map(([groupName, items]) => (
          <div key={groupName}>
            <div className="side-section-title">{groupName}</div>
            {items.map((p) => (
              <div
                key={p.id}
                className={`side-item ${s.filterProjectId === p.id ? 'active' : ''}`}
                onClick={() => s.setFilter(p.id)}
                title={p.rootPath ?? p.name}
              >
                <IconFolder className="icon" />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                <IconTrash
                  className="icon"
                  style={{ marginLeft: 'auto', opacity: 0.45 }}
                  onClick={(e) => {
                    e.stopPropagation()
                    void s.removeProject(p.id)
                  }}
                />
              </div>
            ))}
          </div>
        ))}

        {/* NEW CHAT ----------------------------------------------------- */}
        <div className="side-item" style={{ color: 'var(--text)', border: '1px solid var(--border-strong)' }} onClick={() => void s.newChat(s.filterProjectId)}>
          <IconPlus className="icon" />
          New chat
        </div>

        {/* CHATS -------------------------------------------------------- */}
        <div className="side-section-title">
          Chats{s.filterProjectId ? ' · filtered' : ''}
          <span className="grow" />
          <span
            className="side-mini"
            title="Sort by recent / name"
            onClick={() => changeSort(sort === 'recent' ? 'name' : 'recent')}
          >
            {sort === 'recent' ? 'recent' : 'A→Z'}
          </span>
          <button
            className="side-mini"
            title="Export every chat as one Markdown file"
            onClick={() => void s.exportAll()}
            style={{ display: 'grid', placeItems: 'center', padding: 2 }}
          >
            <IconDownload style={{ width: 13, height: 13 }} />
          </button>
          {s.filterProjectId && (
            <span style={{ cursor: 'pointer' }} onClick={() => s.setFilter(null)}>
              clear
            </span>
          )}
        </div>

        {/* search: title + message text, live */}
        <div className="side-search">
          <IconSearch style={{ width: 12, height: 12 }} />
          <input
            value={q}
            placeholder="Search chats…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQ('')
            }}
          />
          {q && (
            <span className="side-search-x" onClick={() => setQ('')} title="Clear">
              <IconX style={{ width: 11, height: 11 }} />
            </span>
          )}
        </div>

        {chats.map((session) => (
          <div
            key={session.id}
            className={`side-item ${s.activeId === session.id ? 'active' : ''}${session.archived ? ' archived' : ''}`}
            onClick={() => {
              if (renamingId !== session.id) s.setActive(session.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setRenamingId(null)
              setDelConfirm(null)
              setMenu({ id: session.id, x: e.clientX, y: e.clientY, confirmDel: false })
            }}
          >
            <IconChat className="icon" />
            {session.pinned && (
              <span className="pin-mark" title="Pinned to top" aria-hidden>
                <IconPin style={{ width: 11, height: 11 }} />
              </span>
            )}
            {renamingId === session.id ? (
              <input
                className="rename-input"
                autoFocus
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => {
                  if (!renameCancelled.current) void s.renameSession(session.id, renameText)
                  renameCancelled.current = false
                  setRenamingId(null)
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') {
                    renameCancelled.current = true
                    setRenamingId(null)
                  }
                }}
              />
            ) : (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{session.title}</span>
            )}
            {/* a chat generating in the background says so right on its row */}
            {s.streamingIds.includes(session.id) && s.activeId !== session.id && (
              <span className="side-live" title="Generating in the background" aria-hidden />
            )}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-3)' }}>
              {time(session.updatedAt)}
            </span>
            <IconTrash
              className="icon"
              style={{ opacity: 0.45 }}
              aria-label="Delete chat"
              onMouseDown={(e) => e.stopPropagation()} // keep the outside-click
              onClick={(e) => {
                e.stopPropagation() // dismiss handler from closing the menu
                const r = (e.currentTarget as Element).getBoundingClientRect()
                setMenu(null)
                setDelConfirm((d) =>
                  d && d.id === session.id ? null : { id: session.id, x: r.right + 6, y: r.top - 4 }
                )
              }}
            />
          </div>
        ))}
        {chats.length === 0 && (
          <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-3)' }}>
            {term ? `No chats match “${q}”` : 'No chats yet'}
          </div>
        )}

        {/* archived chats stay one click away */}
        {archivedCount > 0 && (
          <div className="side-item side-archived" onClick={() => setShowArchived((v) => !v)}>
            <IconSquare className="icon" />
            {showArchived ? 'Hide archived' : 'Show archived'}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-3)' }}>
              {archivedCount}
            </span>
          </div>
        )}
      </div>

      {/* right-click menu for a chat row — portaled to <body> to escape the
          sidebar's stacking context: under acrylic .sidebar carries a
          backdrop-filter, so .main-pane paints OVER this fixed menu and its
          own blur turns the panel into an unreadable smudge */}
      {menu &&
        createPortal(
        <div
          className="ctx-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 180),
            top: Math.min(menu.y, Math.max(8, window.innerHeight - 225))
          }}
        >
          <button
            onClick={() => {
              const title = s.sessions.find((x) => x.id === menu.id)?.title ?? ''
              setRenameText(title)
              setMenu(null)
              setRenamingId(menu.id)
            }}
          >
            <IconPencil />
            Rename
          </button>
          <button
            onClick={() => {
              void s.togglePin(menu.id)
              setMenu(null)
            }}
          >
            <IconPin />
            {s.sessions.find((x) => x.id === menu.id)?.pinned ? 'Unpin' : 'Pin to top'}
          </button>
          <button
            onClick={() => {
              void s.duplicateSession(menu.id)
              setMenu(null)
            }}
          >
            <IconDuplicate />
            Duplicate
          </button>
          <button
            onClick={() => {
              void s.exportSession(menu.id)
              setMenu(null)
            }}
          >
            <IconDownload />
            Export .md
          </button>
          <button
            onClick={() => {
              void s.toggleArchive(menu.id)
              setMenu(null)
            }}
          >
            <IconSquare />
            {s.sessions.find((x) => x.id === menu.id)?.archived ? 'Unarchive' : 'Archive'}
          </button>
          <button
            className="danger"
            onClick={() => {
              if (menu.confirmDel) {
                void s.removeSession(menu.id)
                setMenu(null)
              } else {
                setMenu({ ...menu, confirmDel: true })
              }
            }}
          >
            {menu.confirmDel ? <IconAlert /> : <IconX />}
            {menu.confirmDel ? 'Really delete?' : 'Delete'}
          </button>
        </div>,
          document.body
        )}

      {/* confirm menu for the chat row's trash — one click used to hard-delete.
          Portaled to <body> for the same stacking-context reason as above. */}
      {delConfirm &&
        createPortal(
        <div
          className="ctx-menu"
          style={{
            left: Math.min(delConfirm.x, window.innerWidth - 270),
            top: Math.min(delConfirm.y, Math.max(8, window.innerHeight - 140))
          }}
        >
          <div className="ctx-head">Delete this chat?</div>
          <div className="ctx-sub">
            “{s.sessions.find((x) => x.id === delConfirm.id)?.title ?? 'This chat'}” will be
            permanently deleted.
          </div>
          <button
            className="danger"
            onClick={() => {
              void s.removeSession(delConfirm.id)
              setDelConfirm(null)
            }}
          >
            <IconTrash />
            Delete chat
          </button>
          <button onClick={() => setDelConfirm(null)}>
            <IconX />
            Cancel
          </button>
        </div>,
          document.body
        )}

      {/* Drive quick toggle — sits ABOVE the footer line (as sketched) */}
      <div className="drive-fab-row">
        <button
          className={`drive-fab tip-wrap${s.drive.enabled && s.drive.healthy ? ' on' : ''}`}
          aria-label="Google Drive"
          data-tip={
            s.drive.enabled && s.drive.healthy
              ? `Google Drive: synced to ${s.drive.folder} — click to open Settings`
              : s.drive.enabled
                ? 'Google Drive: folder missing — click to open Settings'
                : 'Google Drive: not connected — click to link a folder'
          }
          onClick={() => void s.toggleDrive()}
        >
          <IconDrive style={{ width: 17, height: 17 }} />
        </button>
      </div>

      {/* FOOTER ---------------------------------------------------------- */}
      <div className="side-footer">
        <div className="status-row" title="Ollama connection">
          <span className={`dot ${s.ollama}`} />
          {s.ollama === 'online' ? effModel : s.ollama === 'checking' ? 'Checking…' : 'Ollama offline'}
        </div>

        <div
          className="side-item"
          onClick={() => {
            void window.codezy.app.openTerminal().then((err) => {
              if (err) s.addNotice(err, 'error')
            })
          }}
        >
          <IconTerminal className="icon" />
          Open terminal interface
        </div>

        <div className="side-item" onClick={() => s.setSettingsOpen(true)}>
          <IconUser className="icon" />
          {s.settings?.userName || 'Profile'}
          <IconGear className="icon" style={{ marginLeft: 'auto' }} />
        </div>
      </div>
    </aside>
  )
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-3)',
  border: '1px solid var(--border-strong)',
  borderRadius: 7,
  padding: '6px 8px',
  color: 'var(--text)',
  fontSize: 13,
  outline: 'none'
}

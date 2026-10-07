import { useEffect, useRef, useState } from 'react'
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
  IconTerminal,
  IconTrash,
  IconUser,
  IconX
} from './Icons'

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export default function Sidebar() {
  const s = useApp()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [group, setGroup] = useState('')
  const [rootPath, setRootPath] = useState<string | null>(null)
  // right-click menu on a chat row + inline rename state
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; confirmDel: boolean } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const renameCancelled = useRef(false)

  // close the context menu on outside clicks / Escape
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.ctx-menu')) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // group projects like folders: { Work: [...], University: [...] }
  const groups = new Map<string, typeof s.projects>()
  for (const p of s.projects) {
    const key = p.group || 'General'
    groups.set(key, [...(groups.get(key) ?? []), p])
  }

  const base = s.filterProjectId
    ? s.sessions.filter((x) => x.projectId === s.filterProjectId)
    : s.sessions
  // pinned chats float to the top (stable sort keeps recency inside each group)
  const chats = [...base].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
  // what the active chat will actually run on (per-chat override wins)
  const effModel = s.sessions.find((x) => x.id === s.activeId)?.model ?? s.settings?.activeModel ?? 'Ollama'

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
          {s.filterProjectId && (
            <span style={{ cursor: 'pointer' }} onClick={() => s.setFilter(null)}>
              clear
            </span>
          )}
        </div>
        {chats.map((session) => (
          <div
            key={session.id}
            className={`side-item ${s.activeId === session.id ? 'active' : ''}`}
            onClick={() => {
              if (renamingId !== session.id) s.setActive(session.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setRenamingId(null)
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
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-3)' }}>
              {time(session.updatedAt)}
            </span>
            <IconTrash
              className="icon"
              style={{ opacity: 0.45 }}
              onClick={(e) => {
                e.stopPropagation()
                void s.removeSession(session.id)
              }}
            />
          </div>
        ))}
        {chats.length === 0 && (
          <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-3)' }}>No chats yet</div>
        )}
      </div>

      {/* right-click menu for a chat row */}
      {menu && (
        <div
          className="ctx-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 180),
            top: Math.min(menu.y, window.innerHeight - 185)
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
        </div>
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

import { useEffect } from 'react'
import { useApp } from '../store/app'
import { IconX } from './Icons'

type Row = [label: string, key: string]

const GENERAL: Row[] = [
  ['New chat', 'Ctrl+N'],
  ['Command palette', 'Ctrl+K'],
  ['Show / hide sidebar', 'Ctrl+B'],
  ['Settings', 'Ctrl+,'],
  ['Usage dashboard', 'Ctrl+U'],
  ['This cheat sheet', 'Ctrl+/']
]

const CHAT: Row[] = [
  ['Find in chat', 'Ctrl+F'],
  ['Accept edits (preview open)', 'Ctrl+Enter'],
  ['Close popups / find', 'Esc'],
  ['Rename, pin, export, delete', 'Right-click a chat'],
  ['Copy, quote, branch, edit', 'Hover a message']
]

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="sc-col">
      <h3>{title}</h3>
      {rows.map(([label, key]) => (
        <div key={label} className="sc-row">
          <span>{label}</span>
          <kbd className="sc-key">{key}</kbd>
        </div>
      ))}
    </div>
  )
}

/** Ctrl+/ — one screen with every keyboard shortcut (the palette lists
 *  commands, this lists keys; both close on Esc). */
export default function Shortcuts() {
  const open = useApp((s) => s.shortcutsOpen)
  const toggle = useApp((s) => s.toggleShortcuts)
  const enterSends = useApp((s) => s.settings?.enterSends !== false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, toggle])

  if (!open) return null

  const composer: Row[] = [
    [enterSends ? 'Send' : 'New line', enterSends ? 'Enter' : 'Shift+Enter'],
    [enterSends ? 'New line' : 'Send', enterSends ? 'Shift+Enter' : 'Ctrl+Enter'],
    ['Slash commands', '/'],
    ['Attach a file from the linked folders', '@']
  ]

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) toggle()
      }}
    >
      <div className="modal shortcuts-modal" role="dialog" aria-label="Keyboard shortcuts">
        <div className="sc-head">
          <b>Keyboard shortcuts</b>
          <span className="sc-sub">cheat sheet</span>
          <button className="x" aria-label="Close" onClick={toggle}>
            <IconX style={{ width: 14, height: 14 }} />
          </button>
        </div>
        <div className="sc-grid">
          <Section title="General" rows={GENERAL} />
          <Section title="In a chat" rows={CHAT} />
          <Section title="Composer" rows={composer} />
        </div>
        <div className="kbd-hint">ctrl + / toggles this sheet</div>
      </div>
    </div>
  )
}

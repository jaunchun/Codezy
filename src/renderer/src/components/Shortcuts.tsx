import { useRef } from 'react'
import { useApp } from '../store/app'
import { useFocusTrap } from '../lib/useFocusTrap'
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
  ['Find in files (linked folders)', 'Ctrl+Shift+G'],
  ['Search every chat', 'Ctrl+Shift+F'],
  ['Accept edits (preview open)', 'Ctrl+Enter'],
  ['Close popups / find', 'Esc'],
  ['Rename, pin, export, delete', 'Right-click a chat'],
  ['Copy, quote, branch, edit', 'Hover a message']
]

const COWORK: Row[] = [
  ['Open / close cowork', 'Ctrl+E'],
  ['Go to file (quick open)', 'Ctrl+P'],
  ['Find in the open file', 'Ctrl+F'],
  ['Save', 'Ctrl+S'],
  ['New file / new folder', 'Toolbar'],
  ['Reveal, rename, delete, copy path', 'Right-click a row']
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
  const advanced = useApp((s) => s.settings?.showAdvanced === true)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(open, panelRef, toggle)

  if (!open) return null

  const general = advanced ? GENERAL : GENERAL.filter(([label]) => label !== 'Usage dashboard')
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
      <div className="modal shortcuts-modal" ref={panelRef} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="sc-head">
          <b>Keyboard shortcuts</b>
          <span className="sc-sub">cheat sheet</span>
          <button className="x" aria-label="Close" onClick={toggle}>
            <IconX style={{ width: 14, height: 14 }} />
          </button>
        </div>
        <div className="sc-grid">
          <Section title="General" rows={general} />
          <Section title="In a chat" rows={CHAT} />
          <Section title="Composer" rows={composer} />
          {advanced && <Section title="Cowork editor" rows={COWORK} />}
        </div>
        <div className="kbd-hint">ctrl + / toggles this sheet</div>
      </div>
    </div>
  )
}

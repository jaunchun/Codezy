import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store/app'
import { COMMANDS, THEME_NAMES } from '../../../shared/commands'

interface Entry {
  id: string
  group: 'Actions' | 'Chats' | 'Commands'
  label: string
  hint?: string
  run: () => void
}

const MODES = ['plan', 'build', 'auto'] as const

/** Ctrl+K palette: actions, chats and slash commands in one fuzzy-ish list. */
export default function Palette() {
  const s = useApp()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const open = s.paletteOpen

  // focus the input whenever the palette opens
  useEffect(() => {
    if (open) {
      setQ('')
      setIdx(0)
      requestAnimationFrame(() => input.current?.focus())
    }
  }, [open])

  // Escape closes even when focus drifted out of the input
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        useApp.getState().setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const entries = useMemo<Entry[]>(() => {
    if (!open) return []
    const themeNext =
      THEME_NAMES[(THEME_NAMES.indexOf((s.settings?.theme ?? 'dark') as (typeof THEME_NAMES)[number]) + 1) % THEME_NAMES.length]
    const modeNext = MODES[(MODES.indexOf((s.settings?.mode ?? 'build') as (typeof MODES)[number]) + 1) % 3]

    const actions: Entry[] = [
      { id: 'a-new', group: 'Actions', label: 'New chat', hint: 'Ctrl+N', run: () => void s.newChat() },
      {
        id: 'a-sidebar',
        group: 'Actions',
        label: s.sidebarOpen ? 'Focus mode — hide the sidebar' : 'Show the sidebar',
        hint: 'Ctrl+B',
        run: () => s.toggleSidebar()
      },
      { id: 'a-focus', group: 'Actions', label: 'Focus the composer', hint: 'Esc from here', run: () => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus() },
      { id: 'a-settings', group: 'Actions', label: 'Open settings', hint: 'Ctrl+,', run: () => s.setSettingsOpen(true) },
      { id: 'a-usage', group: 'Actions', label: 'Usage dashboard', hint: 'Ctrl+U', run: () => s.setUsageOpen(true) },
      { id: 'a-keys', group: 'Actions', label: 'Keyboard shortcuts', hint: 'Ctrl+/', run: () => s.toggleShortcuts() },
      {
        id: 'a-export',
        group: 'Actions',
        label: 'Export this chat as markdown',
        run: () => s.activeId && void s.exportSession(s.activeId)
      },
      { id: 'a-clear', group: 'Actions', label: 'Clear the chat', run: () => void s.send('/clear') },
      { id: 'a-theme', group: 'Actions', label: `Switch theme to ${themeNext}`, run: () => void s.updateSettings({ theme: themeNext }) },
      { id: 'a-mode', group: 'Actions', label: `Mode: ${modeNext} (now ${s.settings?.mode ?? 'build'})`, run: () => void s.updateSettings({ mode: modeNext }) }
    ]
    if (s.streaming) actions.push({ id: 'a-stop', group: 'Actions', label: 'Stop generating', run: () => void s.stop() })

    const chats: Entry[] = s.sessions.map((x) => ({
      id: `c-${x.id}`,
      group: 'Chats',
      label: x.title,
      hint: new Date(x.updatedAt).toLocaleString(),
      run: () => s.setActive(x.id)
    }))

    const commands: Entry[] = COMMANDS.map((c) => ({
      id: c.name,
      group: 'Commands',
      label: c.name,
      hint: c.description,
      run: () => void s.send(c.name)
    }))

    return [...actions, ...chats, ...commands]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, s.sessions, s.settings, s.sidebarOpen, s.streaming, s.activeId])

  // substring match, ranked: label prefix > label contains > hint contains
  const matches = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return entries
    return entries
      .map((e) => ({
        e,
        score: e.label.toLowerCase().startsWith(term)
          ? 0
          : e.label.toLowerCase().includes(term)
            ? 1
            : (e.hint ?? '').toLowerCase().includes(term) || e.id.toLowerCase().includes(term)
              ? 2
              : -1
      }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.e)
  }, [entries, q])

  const sel = Math.min(idx, Math.max(0, matches.length - 1))

  function close() {
    s.setPaletteOpen(false)
  }

  function run(e: Entry) {
    close()
    e.run()
  }

  function onKey(k: React.KeyboardEvent<HTMLInputElement>) {
    if (k.key === 'ArrowDown') {
      k.preventDefault()
      setIdx((i) => Math.min(i + 1, matches.length - 1))
    } else if (k.key === 'ArrowUp') {
      k.preventDefault()
      setIdx((i) => Math.max(i - 1, 0))
    } else if (k.key === 'Enter') {
      k.preventDefault()
      const picked = matches[sel]
      if (picked) run(picked)
    } else if (k.key === 'Escape') {
      k.preventDefault()
      close()
    }
  }

  if (!open) return null

  let lastGroup = ''
  return (
    <div className="palette-overlay" onClick={close}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder="Search actions, chats, commands…"
          onChange={(e) => {
            setQ(e.target.value)
            setIdx(0)
          }}
          onKeyDown={onKey}
        />
        <div className="palette-list">
          {matches.length === 0 && <div className="palette-empty">No matches for “{q}”</div>}
          {matches.map((e, i) => {
            const head = e.group !== lastGroup ? ((lastGroup = e.group), e.group) : null
            return (
              <div key={e.id}>
                {head && <div className="palette-group">{head}</div>}
                <button
                  className={`pal-item ${i === sel ? 'sel' : ''}`}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => run(e)}
                >
                  <span className="pal-label">{e.label}</span>
                  {e.hint && <span className="pal-hint">{e.hint}</span>}
                </button>
              </div>
            )
          })}
        </div>
        <div className="palette-foot">↑↓ move · ↵ run · esc close</div>
      </div>
    </div>
  )
}

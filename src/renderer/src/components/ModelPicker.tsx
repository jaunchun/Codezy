import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store/app'
import { buildPickerRows } from './pickerRows'
import type { ModelEntry } from '../../../shared/api'

const fmtSize = (n?: number): string =>
  !n ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`

const meta = (m: ModelEntry): string =>
  [m.parameter, m.quant, fmtSize(m.size)].filter(Boolean).join('  ·  ') || m.providerName

/**
 * Custom model dropdown: searchable, shows parameter size / quantization /
 * file size, grouped by provider, keyboard navigable (↑ ↓ Enter Esc).
 */
export default function ModelPicker() {
  const s = useApp()
  const settings = s.settings
  const session = s.sessions.find((x) => x.id === s.activeId)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const box = useRef<HTMLDivElement>(null)

  // effective model: this chat's override wins, otherwise the global default
  const effModel = session?.model ?? settings?.activeModel
  const effProvider = session?.provider ?? settings?.activeProvider
  const active = s.models.find((m) => m.id === effModel && m.provider === effProvider)

  const query = q.trim().toLowerCase()
  const list = query
    ? s.models.filter((m) => `${m.id} ${m.providerName} ${m.family ?? ''}`.toLowerCase().includes(query))
    : s.models

  // provider group heads, plus an explicit note for connected providers
  // whose models failed to load (an empty gap would read as "no models exist")
  const rows = buildPickerRows(list, settings?.providers, !query)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = (m: ModelEntry) => {
    // with a chat open the pick is per-chat (settings stay the default for
    // new chats); without one it updates the global default directly
    if (s.activeId) void s.setSessionGen(s.activeId, { model: m.id, provider: m.provider })
    else void s.updateSettings({ activeModel: m.id, activeProvider: m.provider })
    setOpen(false)
    setQ('')
    setSel(0)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((i) => Math.min(i + 1, list.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (list[sel]) choose(list[sel])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="picker" ref={box}>
      <button
        className="chip"
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) void s.resync() // pick up anything the TUI connected since init
        }}
        title="Change model"
      >
        <span className="model-dot" />
        <span className="model-name">{active?.id ?? effModel ?? 'model'}</span>
        {session?.model && <span className="model-scope" title="Per-chat model override">•</span>}
        <span className="caret">▾</span>
      </button>

      {open && (
        <div className="picker-panel">
          <input
            autoFocus
            placeholder="Search models…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setSel(0)
            }}
            onKeyDown={onKey}
          />
          <div className="picker-list">
            {rows.map((row, i) =>
              row.type === 'head' ? (
                <div key={`h${i}`} className="picker-head">
                  {row.label}
                </div>
              ) : row.type === 'empty' ? (
                <div key={`e${i}`} className="picker-empty">
                  {row.label}
                </div>
              ) : (
                <button
                  key={`${row.model.provider}::${row.label}`}
                  className={[
                    'picker-item',
                    row.idx === sel ? 'sel' : '',
                    row.model.id === effModel && row.model.provider === effProvider ? 'current' : ''
                  ].join(' ')}
                  title={meta(row.model)}
                  onMouseEnter={() => setSel(row.idx)}
                  onClick={() => choose(row.model)}
                >
                  <span className="pi-name">{row.label}</span>
                  {row.model.parameter || row.model.family ? (
                    <span className="pi-badge">{row.model.parameter || row.model.family}</span>
                  ) : null}
                  {row.model.id === effModel && row.model.provider === effProvider ? (
                    <span className="pi-use current">Current</span>
                  ) : (
                    <span className="pi-use">Use</span>
                  )}
                </button>
              )
            )}
            {list.length === 0 && <div className="picker-empty">No model matches “{q}”</div>}
          </div>
          <div className="picker-foot">
            {session
              ? `${s.models.length} models · pick applies to this chat · settings = default for new chats`
              : `${s.models.length} models · local + connected · ↑↓ Enter`}
          </div>
        </div>
      )}
    </div>
  )
}

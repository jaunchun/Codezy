import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store/app'
import { buildPickerRows } from './pickerRows'
import type { ModelEntry } from '../../../shared/api'

const fmtSize = (n?: number): string =>
  !n ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`

const meta = (m: ModelEntry): string =>
  [m.parameter, m.quant, fmtSize(m.size)].filter(Boolean).join('  ·  ') || m.providerName

/** Identity of a model across providers — ids repeat between endpoints. */
const keyOf = (m: ModelEntry): string => `${m.provider}::${m.id}`

const FAV_KEY = 'codezy.favModels'
const REC_KEY = 'codezy.recentModels'
const REC_MAX = 5

function readKeys(k: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeKeys(k: string, list: string[]): void {
  try {
    if (list.length) localStorage.setItem(k, JSON.stringify(list))
    else localStorage.removeItem(k)
  } catch {
    /* storage unavailable — favourites simply do not persist */
  }
}

type Row =
  | { kind: 'head'; label: string; key: string }
  | { kind: 'empty'; label: string; key: string }
  | { kind: 'model'; model: ModelEntry; idx: number; key: string }

/** Where the panel sits relative to its chip: flips, clamps and caps height. */
interface Geom {
  left: number
  up: boolean
  maxH: number
  width: number
}

const MIN_PANEL = 150

/**
 * Custom model dropdown: searchable, shows parameter size / quantization /
 * file size, grouped by provider, keyboard navigable (↑ ↓ Enter Esc).
 *
 * The panel measures the space around its chip and flips above/below the
 * composer, clamps itself inside the window and caps its height to what is
 * actually free — it used to hang off the bottom edge with no way back.
 * Open and close are animated so the panel visibly retracts instead of
 * popping out of existence.
 */
export default function ModelPicker() {
  const s = useApp()
  const settings = s.settings
  const session = s.sessions.find((x) => x.id === s.activeId)
  const [open, setOpen] = useState(false) // interaction is enabled
  const [mounted, setMounted] = useState(false) // panel is in the DOM
  const [show, setShow] = useState(false) // …and animated into place
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [prov, setProv] = useState<string | null>(null)
  const [geom, setGeom] = useState<Geom | null>(null)
  const [favs, setFavs] = useState<string[]>(() => readKeys(FAV_KEY))
  const [recents, setRecents] = useState<string[]>(() => readKeys(REC_KEY))
  const box = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const closer = useRef<number | null>(null)

  // effective model: this chat's override wins, otherwise the global default
  const effModel = session?.model ?? settings?.activeModel
  const effProvider = session?.provider ?? settings?.activeProvider
  const active = s.models.find((m) => m.id === effModel && m.provider === effProvider)

  const query = q.trim().toLowerCase()

  /** provider chips — every endpoint that actually has models right now */
  const provs = useMemo(() => {
    const seen = new Map<string, string>()
    for (const m of s.models) if (!seen.has(m.provider)) seen.set(m.provider, m.providerName)
    return [...seen.entries()].map(([id, name]) => ({ id, name }))
  }, [s.models])

  const matches = (m: ModelEntry): boolean => {
    if (prov && m.provider !== prov) return false
    if (query && !`${m.id} ${m.providerName} ${m.family ?? ''}`.toLowerCase().includes(query)) return false
    return true
  }

  /** keyboard-flat order: favourites, then recents, then everything else */
  const flat = useMemo<ModelEntry[]>(() => {
    const hit = s.models.filter(matches)
    if (query || prov) return hit
    const favSet = new Set(favs)
    const recSet = new Set(recents)
    const pick = (keys: string[]) =>
      keys
        .map((k) => hit.find((m) => keyOf(m) === k))
        .filter((m): m is ModelEntry => !!m)
    return [
      ...pick(favs),
      ...pick(recents).filter((m) => !favSet.has(keyOf(m))),
      ...hit.filter((m) => !favSet.has(keyOf(m)) && !recSet.has(keyOf(m)))
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.models, q, prov, favs, recents])

  /** rows = flat models + the group heads around them (same order as `flat`) */
  const rows = useMemo<Row[]>(() => {
    const grouped = !query && !prov
    const out: Row[] = []
    let cursor = 0
    if (grouped) {
      const favSet = new Set(favs)
      const recSet = new Set(recents)
      const favModels = flat.filter((m) => favSet.has(keyOf(m)))
      const recModels = flat.filter((m) => recSet.has(keyOf(m)) && !favSet.has(keyOf(m)))
      const push = (label: string, list: ModelEntry[]) => {
        if (!list.length) return
        out.push({ kind: 'head', label, key: `h-${label}` })
        for (const m of list) out.push({ kind: 'model', model: m, idx: cursor++, key: keyOf(m) })
      }
      push('Favorites', favModels)
      push('Recent', recModels)
      const used = new Set([...favModels, ...recModels].map(keyOf))
      const rest = flat.filter((m) => !used.has(keyOf(m)))
      for (const r of buildPickerRows(rest, settings?.providers, true)) {
        if (r.type === 'model') out.push({ kind: 'model', model: r.model, idx: cursor++, key: keyOf(r.model) })
        else out.push({ kind: r.type, label: r.label, key: `${r.type}-${r.label}` })
      }
      return out
    }
    for (const r of buildPickerRows(flat, settings?.providers, false)) {
      if (r.type === 'model') out.push({ kind: 'model', model: r.model, idx: cursor++, key: keyOf(r.model) })
      else out.push({ kind: r.type, label: r.label, key: `${r.type}-${r.label}` })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, q, prov, favs, recents, settings?.providers])

  const at = Math.min(sel, Math.max(0, flat.length - 1))

  // -- placement: flip above/below and clamp into the window ---------------
  const measure = () => {
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (!r.width) return // jsdom / hidden chip — leave the previous geometry
    const width = Math.min(390, Math.max(240, window.innerWidth - 24))
    const margin = 10
    const below = window.innerHeight - r.bottom - margin
    const above = r.top - margin
    const up = below < 340 && above > below
    const avail = Math.max(up ? above : below, MIN_PANEL)
    const left =
      Math.min(Math.max(r.left, 8), Math.max(8, window.innerWidth - width - 8)) - r.left
    setGeom({ left, up, maxH: Math.min(avail, window.innerHeight - 24), width })
  }

  const close = () => {
    if (!open && !mounted) return
    setOpen(false)
    setShow(false)
    if (closer.current) window.clearTimeout(closer.current)
    closer.current = window.setTimeout(() => setMounted(false), 180)
    setQ('')
    setSel(0)
    chip.current?.focus()
  }

  const openPanel = () => {
    if (closer.current) window.clearTimeout(closer.current)
    measure()
    setOpen(true)
    setMounted(true)
    // next frame: the panel is laid out, so the transition has a start state
    requestAnimationFrame(() => requestAnimationFrame(() => setShow(true)))
    void s.resync() // pick up anything the TUI connected since init
  }

  // outside click + Escape close it; the window re-measures it while open
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onMove = () => measure()
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggleFav = (m: ModelEntry) => {
    const k = keyOf(m)
    const next = favs.includes(k) ? favs.filter((x) => x !== k) : [k, ...favs]
    setFavs(next)
    writeKeys(FAV_KEY, next)
  }

  const choose = (m: ModelEntry) => {
    // with a chat open the pick is per-chat (settings stay the default for
    // new chats); without one it updates the global default directly
    if (s.activeId) void s.setSessionGen(s.activeId, { model: m.id, provider: m.provider })
    else void s.updateSettings({ activeModel: m.id, activeProvider: m.provider })
    const k = keyOf(m)
    const next = [k, ...recents.filter((x) => x !== k)].slice(0, REC_MAX)
    setRecents(next)
    writeKeys(REC_KEY, next)
    close()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setSel(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setSel(Math.max(0, flat.length - 1))
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      setSel((i) => Math.min(i + 6, flat.length - 1))
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      setSel((i) => Math.max(i - 6, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (flat[at]) choose(flat[at])
    }
    // Escape is handled by the document listener (works from anywhere)
  }

  const panelStyle: React.CSSProperties = geom
    ? {
        left: geom.left,
        width: geom.width,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: geom.maxH,
        ...(geom.up ? { bottom: 'calc(100% + 8px)' } : { top: 'calc(100% + 8px)', bottom: 'auto' })
      }
    : { left: 0, width: 390 }

  return (
    <div className="picker" ref={box}>
      <button
        ref={chip}
        className="chip"
        onClick={() => (open ? close() : openPanel())}
        title="Change model"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-dot" />
        <span className="model-name">{active?.id ?? effModel ?? 'model'}</span>
        {session?.model && <span className="model-scope" title="Per-chat model override">•</span>}
        <span className="caret">▾</span>
      </button>

      {mounted && (
        <div
          className={`picker-panel${show ? ' show' : ''}${geom?.up ? ' up' : ''}`}
          style={panelStyle}
          role="listbox"
          aria-label="Models"
        >
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

          {/* provider filter — one chip per connected endpoint */}
          {provs.length > 1 && (
            <div className="picker-chips" role="tablist" aria-label="Filter by provider">
              <button
                className={`picker-chip${prov === null ? ' on' : ''}`}
                onClick={() => {
                  setProv(null)
                  setSel(0)
                }}
              >
                all
              </button>
              {provs.map((p) => (
                <button
                  key={p.id}
                  className={`picker-chip${prov === p.id ? ' on' : ''}`}
                  onClick={() => {
                    setProv(prov === p.id ? null : p.id)
                    setSel(0)
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}

          <div className="picker-list">
            {rows.map((row) =>
              row.kind === 'head' ? (
                <div key={row.key} className="picker-head">
                  {row.label}
                </div>
              ) : row.kind === 'empty' ? (
                <div key={row.key} className="picker-empty">
                  {row.label}
                </div>
              ) : (
                <div
                  key={row.key}
                  role="option"
                  aria-selected={row.idx === at}
                  className={[
                    'picker-item',
                    row.idx === at ? 'sel' : '',
                    row.model.id === effModel && row.model.provider === effProvider ? 'current' : ''
                  ].join(' ')}
                  title={meta(row.model)}
                  onMouseEnter={() => setSel(row.idx)}
                  onClick={() => choose(row.model)}
                >
                  <button
                    className={`pi-star${favs.includes(keyOf(row.model)) ? ' on' : ''}`}
                    aria-label={
                      favs.includes(keyOf(row.model)) ? 'Remove from favorites' : 'Add to favorites'
                    }
                    title="Favorite — always listed first"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleFav(row.model)
                    }}
                  >
                    ★
                  </button>
                  <span className="pi-name">{row.model.id}</span>
                  {row.model.parameter || row.model.family ? (
                    <span className="pi-badge">{row.model.parameter || row.model.family}</span>
                  ) : null}
                  {row.model.id === effModel && row.model.provider === effProvider ? (
                    <span className="pi-use current">Current</span>
                  ) : (
                    <span className="pi-use">Use</span>
                  )}
                </div>
              )
            )}
            {flat.length === 0 && (
              <div className="picker-empty">
                {s.models.length === 0
                  ? 'No models yet — start Ollama or connect a provider in Settings'
                  : prov
                    ? `No model matches in this provider${query ? ` for “${q}”` : ''}`
                    : `No model matches “${q}”`}
              </div>
            )}
          </div>

          <div className="picker-foot">
            {session
              ? `${s.models.length} models · pick applies to this chat · settings = default for new chats`
              : `${s.models.length} models · local + connected · ↑↓ Enter`}
            {favs.length ? ` · ★ ${favs.length}` : ''}
          </div>
        </div>
      )}
    </div>
  )
}

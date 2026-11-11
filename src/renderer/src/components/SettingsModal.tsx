import { useEffect, useRef, useState } from 'react'
import { applyTheme, useApp } from '../store/app'
import { themeBase } from '../../../shared/commands'
import { useFocusTrap } from '../lib/useFocusTrap'
import type { ProviderConfig, ThemeName } from '../../../shared/types'
import type { McpStatusEntry } from '../../../shared/api'
import { PROVIDER_PRESETS } from '../../../shared/providers'
import { MODEL_GUIDE } from '../../../shared/models'

const THEMES: { id: ThemeName; label: string; preview: string }[] = [
  { id: 'graphite', label: 'Graphite', preview: 'linear-gradient(135deg,#1d2025 0%,#0b0c0e 70%)' },
  { id: 'paper', label: 'Paper', preview: 'linear-gradient(135deg,#f7f4ec 0%,#e7e2d6 100%)' },
  { id: 'contrast', label: 'Contrast', preview: 'linear-gradient(135deg,#000000 0%,#1a1a1a 100%)' },
  {
    id: 'singularity',
    label: 'Singularity',
    preview:
      'radial-gradient(circle at 50% 50%, #000 0 18%, #ffffff 24%, #bdbdbd 30%, #1a1a1a 44%, #000000 62%), radial-gradient(circle at 50% 50%, rgba(255,255,255,0.5), transparent 52%), #000000'
  }
]

/** accent swatches — the signal colour shared with the terminal /theme */
const ACCENTS = ['#6FA8FF', '#C6F24E', '#FFB454', '#E48BFF']

/** Top-level Settings categories. The old `.settings-section` labels stay in
 *  the DOM inside these panes: tests, the palette jump and deep links all key
 *  off them, while the sidebar keeps the long single scroll from being a maze. */
type SettingsPane = 'general' | 'models' | 'agent' | 'tools' | 'data' | 'about'

const SETTINGS_PANES: {
  id: SettingsPane
  label: string
  note: string
  advanced?: boolean
  sections: { id: string; label: string }[]
}[] = [
  {
    id: 'general',
    label: 'General',
    note: 'Profile, look, window',
    sections: [
      { id: 'set-profile', label: 'Profile' },
      { id: 'set-appearance', label: 'Appearance & window' },
      { id: 'set-input', label: 'Notifications & input' }
    ]
  },
  {
    id: 'models',
    label: 'Models',
    note: 'Endpoints and capabilities',
    sections: [
      { id: 'set-providers', label: 'Providers & endpoint' },
      { id: 'set-model-guide', label: 'Supported models' }
    ]
  },
  {
    id: 'agent',
    label: 'Agent',
    note: 'Approvals and instructions',
    sections: [
      { id: 'set-behavior', label: 'Reply & agent mode' },
      { id: 'set-instructions', label: 'Instructions' }
    ]
  },
  {
    id: 'tools',
    label: 'Tools',
    note: 'Third-party tools',
    advanced: true,
    sections: [{ id: 'set-mcp', label: 'MCP servers' }]
  },
  {
    id: 'data',
    label: 'Data',
    note: 'Storage, memory, backup',
    advanced: true,
    sections: [
      { id: 'set-storage', label: 'Storage' },
      { id: 'set-learning', label: 'Learning & memory' },
      { id: 'set-backup', label: 'Backup' }
    ]
  },
  {
    id: 'about',
    label: 'About',
    note: 'Version and updates',
    sections: [{ id: 'set-about', label: 'About & updates' }]
  }
]

/** Starter .codezy/instructions.md — says what the file is for and hands over
 *  the three sections that cover almost every project. */
const PI_TEMPLATE = [
  '# Project instructions for CODEZY',
  '',
  'Standing orders for THIS project — CODEZY reads this file into every chat',
  'that has this folder linked. Keep it short and imperative; edit freely.',
  '',
  '## Always',
  '',
  '- e.g. run `npm test` before saying a task is done',
  '',
  '## Never',
  '',
  '- e.g. never touch files under dist/',
  '',
  '## Run / test',
  '',
  '- e.g. `npm run dev` · `npm test`',
  ''
].join('\n')

export default function SettingsModal() {
  const s = useApp()
  const settings = s.settings
  const advanced = settings?.showAdvanced === true
  const [memory, setMemory] = useState('')
  const [newProvider, setNewProvider] = useState({ name: '', baseUrl: '', apiKey: '' })
  // hovering a theme swatch previews it; leaving restores the committed one
  const [previewTheme, setPreviewTheme] = useState<ThemeName | null>(null)
  // category sidebar: one pane at a time, the old section labels stay inside
  const [pane, setPane] = useState<SettingsPane>('general')
  const contentRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  useFocusTrap(s.settingsOpen, modalRef, () => s.setSettingsOpen(false))
  // MCP servers (v3) — config from settings, status from a live probe
  const [mcp, setMcp] = useState<McpStatusEntry[] | null>(null)
  const [newMcp, setNewMcp] = useState({ name: '', command: '', args: '' })
  const [mcpProbe, setMcpProbe] = useState<Record<string, string>>({})
  const [mcpBusy, setMcpBusy] = useState(false)
  // project instructions (v3.1) — .codezy/instructions.md, one per linked folder
  const [pi, setPi] = useState<Record<string, 'loading' | 'found' | 'missing'>>({})
  const activeSession = s.sessions.find((x) => x.id === s.activeId)
  const roots = activeSession?.linkedFolders ?? []
  const piPath = (root: string) => `${root.replace(/[\\/]+$/, '')}/.codezy/instructions.md`

  const reloadMcp = async (): Promise<void> => {
    try {
      setMcp(await window.codezy.mcp.list())
    } catch {
      setMcp([]) // the main process never rejects, but never hang the UI either
    }
  }

  useEffect(() => {
    if (s.settingsOpen) {
      void window.codezy.memory.read().then(setMemory)
      void s.resync() // providers the TUI connected must show up without a restart
      void reloadMcp()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.settingsOpen])

  // project instructions (v3.1): while Settings is open, ask main for each
  // linked folder's .codezy/instructions.md — found / not created / checking
  useEffect(() => {
    if (!s.settingsOpen || !activeSession || !roots.length) return
    let alive = true
    const next: Record<string, 'loading' | 'found' | 'missing'> = {}
    for (const r of roots) next[r] = 'loading'
    setPi(next)
    for (const r of roots) {
      void window.codezy.ide
        .read(activeSession.id, piPath(r))
        .then((res) => {
          if (alive) setPi((cur) => ({ ...cur, [r]: res ? 'found' : 'missing' }))
        })
        .catch(() => {
          if (alive) setPi((cur) => ({ ...cur, [r]: 'missing' }))
        })
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.settingsOpen, activeSession?.id, roots.join('|')])

  // The palette can jump straight to a section (e.g. MCP servers). The target
  // may live in another category, so switch the pane first, then scroll and
  // flash. The immediate scroll keeps jsdom/deep-link calls synchronous.
  const jumpSection = s.settingsSection
  useEffect(() => {
    if (!jumpSection) return
    if (!s.settingsOpen) {
      useApp.setState({ settingsSection: null }) // closed before the jump — drop it
      return
    }
    const find = (): HTMLElement | undefined =>
      [...document.querySelectorAll<HTMLElement>('.settings-section')].find((n) => n.textContent === jumpSection)
    const first = find()
    if (!first) {
      useApp.setState({ settingsSection: null })
      return
    }
    setPane((first.dataset.pane as SettingsPane) || 'general')
    first.scrollIntoView({ block: 'start' })
    first.classList.add('flash')
    let clear = 0
    const t = window.setTimeout(() => {
      const fresh = find()
      fresh?.scrollIntoView({ block: 'start' })
      fresh?.classList.add('flash')
      clear = window.setTimeout(() => {
        find()?.classList.remove('flash')
        useApp.setState({ settingsSection: null }) // consumes the request without touching open state
      }, 1700)
    }, 25)
    return () => {
      window.clearTimeout(t)
      if (clear) window.clearTimeout(clear)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.settingsOpen, jumpSection])

  /** Sidebar sub-link: scroll the visible pane to one of its section labels. */
  const scrollToSection = (id: string): void => {
    const el = contentRef.current?.querySelector<HTMLElement>(`#${id}`)
    if (!el) return
    el.scrollIntoView({ block: 'start' })
    el.classList.add('flash')
    window.setTimeout(() => el.classList.remove('flash'), 1700)
  }

  const openPane = (next: SettingsPane): void => {
    setPane(next)
    contentRef.current?.scrollTo({ top: 0 })
  }

  // Advanced panes disappear with the switch - never strand the modal there.
  useEffect(() => {
    if (!advanced && (pane === 'tools' || pane === 'data')) setPane('general')
  }, [advanced, pane])

  /** Write the starter file into the linked folder (confined like any save). */
  const createPi = async (root: string): Promise<void> => {
    if (!activeSession) return
    const target = piPath(root)
    try {
      await window.codezy.ide.write(activeSession.id, target, PI_TEMPLATE)
      setPi((cur) => ({ ...cur, [root]: 'found' }))
      s.addNotice('Created .codezy/instructions.md — its rules are loaded into every chat with this folder linked')
    } catch (e) {
      s.addNotice(`Could not create ${target}: ${e instanceof Error ? e.message : e}`, 'error')
    }
  }

  const openPi = (root: string): void => {
    void window.codezy.files.open(piPath(root)).then((msg) => {
      if (msg) s.addNotice(msg, 'error')
    })
  }

  /** Persist the whole list, then re-read it so the status dots are fresh. */
  const saveMcp = async (list: McpStatusEntry[]): Promise<void> => {
    setMcpBusy(true)
    try {
      await window.codezy.mcp.save(list)
      setMcpProbe({})
      await reloadMcp()
    } finally {
      setMcpBusy(false)
    }
  }

  /** Try a server without saving — one row's status line reports the result. */
  const probeMcp = async (srv: McpStatusEntry): Promise<void> => {
    setMcpProbe({ ...mcpProbe, [srv.name]: 'connecting…' })
    const r = await window.codezy.mcp.probe(srv)
    setMcpProbe({
      ...mcpProbe,
      [srv.name]: r.ok ? `${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}: ${r.tools.slice(0, 6).join(', ')}${r.tools.length > 6 ? '…' : ''}` : r.error ?? 'failed'
    })
  }

  useEffect(() => {
    if (s.settingsOpen) {
      void window.codezy.memory.read().then(setMemory)
      void s.resync() // providers the TUI connected must show up without a restart
    }
  }, [s.settingsOpen])

  // closing the dialog (or committing) must never leave a preview behind
  useEffect(() => {
    if (s.settingsOpen || !previewTheme) return
    setPreviewTheme(null)
    if (settings) applyTheme(settings.theme, settings.accent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.settingsOpen, previewTheme])

  if (!s.settingsOpen || !settings) return null

  // legacy ids (dark/light/acrylic) ring their nearest surface, so an old
  // settings file still shows exactly one active swatch.
  const shownTheme = previewTheme ?? themeBase(settings.theme)
  const preview = (t: ThemeName) => {
    setPreviewTheme(t)
    applyTheme(t, settings.accent)
  }
  const endPreview = () => {
    if (!previewTheme) return
    setPreviewTheme(null)
    applyTheme(settings.theme, settings.accent)
  }
  const commit = (t: ThemeName) => {
    setPreviewTheme(null)
    void s.updateSettings({ theme: t })
  }

  /** Settings → file. Provider keys ride along — the notice says so. */
  const exportSettings = async () => {
    const file = await window.codezy.dialog.saveText('codezy-settings.json', JSON.stringify(settings, null, 2))
    if (file) s.addNotice(`Settings written to ${file} — the file includes your provider API keys.`)
  }

  /** file → Settings. Whitelisted keys only: machine paths never move. */
  const importSettings = async () => {
    const picked = await window.codezy.dialog.pickFiles()
    const f = picked.find((x) => x.path.toLowerCase().endsWith('.json')) ?? picked[0]
    if (!f) return
    try {
      const data = JSON.parse(f.content) as unknown
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a settings object')
      // dataDir/driveFolder are this machine's folders — importing them would
      // point the app at someone else's paths
      const SKIP = new Set(['dataDir', 'driveFolder'])
      // a key the app never wrote here (instructions before it was set once)
      // still counts as known
      const known = new Set([...Object.keys(settings), 'instructions'])
      const patch: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (known.has(k) && !SKIP.has(k)) patch[k] = v
      }
      const n = Object.keys(patch).length
      if (!n) throw new Error('no settings this version understands')
      await s.updateSettings(patch as Partial<typeof settings>)
      s.addNotice(`Imported ${n} setting${n === 1 ? '' : 's'} from ${f.path.split(/[\\/]/).pop()}`)
    } catch (e) {
      s.addNotice(`Import failed: ${e instanceof Error ? e.message : e}`, 'error')
    }
  }

  return (
    <div className="overlay" onClick={() => s.setSettingsOpen(false)}>
      <div
        className="modal settings-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <h2 id="settings-title">Settings &amp; Accounts</h2>
            <p className="settings-lede">Tune the app, models, agent and data. Changes save as you go.</p>
          </div>
          <span className="row" style={{ gap: 6 }}>
            <button
              className="btn ghost"
              title="Show the first-run setup screen again"
              onClick={() => {
                void s.updateSettings({ setupDone: false })
                s.setSettingsOpen(false)
              }}
            >
              Run setup
            </button>
            <button className="btn" onClick={() => s.setSettingsOpen(false)}>
              Close
            </button>
          </span>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings categories">
            {SETTINGS_PANES.filter((group) => advanced || !group.advanced).map((group) => (
              <div className="settings-nav-group" key={group.id}>
                <button
                  className={`settings-nav-btn${pane === group.id ? ' active' : ''}`}
                  aria-current={pane === group.id ? 'page' : undefined}
                  onClick={() => openPane(group.id)}
                >
                  <span>{group.label}</span>
                  <span className="settings-nav-note">{group.note}</span>
                </button>
                {pane === group.id && (
                  <div className="settings-nav-sub">
                    {group.sections.map((sec) => (
                      <button key={sec.id} className="settings-nav-link" onClick={() => scrollToSection(sec.id)}>
                        {sec.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </nav>

          <div className="settings-main" ref={contentRef}>
            <section className="settings-pane" hidden={pane !== 'general'} aria-labelledby="settings-general">
              <div className="settings-pane-head">
                <h3 id="settings-general">General</h3>
                <p>Your name, the interface, the window, and how notifications behave.</p>
              </div>

        {/* profile ------------------------------------------------------- */}
        <div className="settings-section" id="set-profile" data-pane="general">profile</div>
        <div className="field">
          <label>Your name (used in what CODEZY learns about you)</label>
          <input
            type="text"
            value={settings.userName}
            placeholder="e.g. Kajetan"
            onChange={(e) => void s.updateSettings({ userName: e.target.value })}
          />
        </div>

        {/* appearance ----------------------------------------------------- */}
        <div className="settings-section" id="set-appearance" data-pane="general">appearance</div>
        <div className="field">
          <label>
            Advanced features — MCP servers, storage, memory, extra composer controls and the full command
            list. Off keeps the app to the essentials.
          </label>
          <div className="row">
            <button
              className={`btn ${!advanced ? 'primary' : ''}`}
              aria-pressed={!advanced}
              onClick={() => void s.updateSettings({ showAdvanced: false })}
            >
              simple
            </button>
            <button
              className={`btn ${advanced ? 'primary' : ''}`}
              aria-pressed={advanced}
              onClick={() => void s.updateSettings({ showAdvanced: true })}
            >
              advanced
            </button>
          </div>
        </div>
        <div className="field">
          <label>
            Theme — graphite, paper, contrast and singularity (the black-hole surface) · legacy names still resolve
          </label>
          <div className="theme-picker">
            {THEMES.map((t) => (
              <div
                key={t.id}
                className={`theme-swatch ${shownTheme === t.id ? 'active' : ''}`}
                title="Hover to preview · click to keep"
                onMouseEnter={() => preview(t.id)}
                onMouseLeave={endPreview}
                onClick={() => commit(t.id)}
              >
                <div className="theme-preview" style={{ background: t.preview }}>
                  <span className="theme-accent" style={{ background: settings.accent }} />
                </div>
                <span className="theme-name">{t.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="field">
          <label>
            Accent — the signal colour used across the app and shared with the terminal
          </label>
          <div className="accent-row">
            {ACCENTS.map((c) => (
              <button
                key={c}
                className={`accent-swatch${settings.accent === c ? ' active' : ''}`}
                style={{ background: c }}
                title={c}
                aria-label={`Accent ${c}`}
                aria-pressed={settings.accent === c}
                onClick={() => void s.updateSettings({ accent: c })}
              />
            ))}
          </div>
        </div>

        <div className="field">
          <label>Motion — reduce animation (accessibility: kills every transition and animation)</label>
          <div className="row">
            <button
              className={`btn ${settings.reduceMotion ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ reduceMotion: true })}
            >
              reduce motion
            </button>
            <button
              className={`btn ${!settings.reduceMotion ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ reduceMotion: false })}
            >
              full motion
            </button>
          </div>
        </div>

        <div className="field">
          <label>Tray — what the ✕ does (hidden in the tray it stays one click away)</label>
          <div className="row">
            <button
              className={`btn ${settings.minimizeToTray ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ minimizeToTray: true })}
            >
              keep in tray
            </button>
            <button
              className={`btn ${!settings.minimizeToTray ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ minimizeToTray: false })}
            >
              quit on close
            </button>
          </div>
        </div>

        <div className="field">
          <label>Startup — launch CODEZY when you log in</label>
          <div className="row">
            <button
              className={`btn ${settings.openAtLogin ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ openAtLogin: true })}
            >
              launch at login
            </button>
            <button
              className={`btn ${!settings.openAtLogin ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ openAtLogin: false })}
            >
              manual only
            </button>
          </div>
        </div>

        {settings.minimizeToTray && (
          <div className="field">
            <label>
              Start hidden — a login-item launch goes straight to the tray (no window flash)
            </label>
            <div className="row">
              <button
                className={`btn ${settings.startHidden ? 'primary' : ''}`}
                onClick={() => void s.updateSettings({ startHidden: true })}
              >
                start in tray
              </button>
              <button
                className={`btn ${!settings.startHidden ? 'primary' : ''}`}
                onClick={() => void s.updateSettings({ startHidden: false })}
              >
                show the window
              </button>
            </div>
          </div>
        )}

        <div className="field">
          <label>Always on top — keep CODEZY above other windows while you code</label>
          <div className="row">
            <button
              className={`btn ${settings.alwaysOnTop ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ alwaysOnTop: true })}
            >
              on top
            </button>
            <button
              className={`btn ${!settings.alwaysOnTop ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ alwaysOnTop: false })}
            >
              normal
            </button>
          </div>
        </div>

        <div className="field">
          <label>Diagnostics — launch/crash lines live in ~/.codezy/logs</label>
          <div className="row">
            <button
              className="btn"
              onClick={() => {
                void window.codezy.app.openLogs().then((err) => {
                  if (err) s.addNotice(`Could not open logs: ${err}`, 'error')
                })
              }}
            >
              open logs folder
            </button>
          </div>
        </div>

        <div className="field">
          <label>
            Text size — the whole interface scales with it (12–20 px, applied live)
          </label>
          <div className="row">
            <button
              className="btn"
              aria-label="Smaller text"
              onClick={() => void s.updateSettings({ fontSize: Math.max(12, settings.fontSize - 1) })}
            >
              A−
            </button>
            <input
              type="range"
              min={12}
              max={20}
              step={1}
              value={settings.fontSize}
              onChange={(e) => void s.updateSettings({ fontSize: Number(e.target.value) })}
              style={{ flex: 1 }}
              aria-label="Font size in pixels"
            />
            <button
              className="btn"
              aria-label="Bigger text"
              onClick={() => void s.updateSettings({ fontSize: Math.min(20, settings.fontSize + 1) })}
            >
              A+
            </button>
            <span className="chip">{settings.fontSize}px</span>
          </div>
        </div>

        <div className="field">
          <label>Density — how much fits on screen (rows, lists, padding)</label>
          <div className="row">
            <button
              className={`btn ${(settings.density ?? 'cozy') === 'cozy' ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ density: 'cozy' })}
            >
              cozy
            </button>
            <button
              className={`btn ${settings.density === 'compact' ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ density: 'compact' })}
            >
              compact
            </button>
            <button className="btn ghost" onClick={() => s.toggleShortcuts()}>
              keyboard shortcuts
            </button>
          </div>
        </div>

        {/* notifications & input ------------------------------------------ */}
        <div className="settings-section" id="set-input" data-pane="general">
          notifications &amp; input
        </div>
        <div className="field">
          <label>Notifications — OS popup when a reply finishes while the window is unfocused</label>
          <div className="row">
            <button
              className={`btn ${settings.notifyDone ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ notifyDone: true })}
            >
              on
            </button>
            <button
              className={`btn ${!settings.notifyDone ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ notifyDone: false })}
            >
              off
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                try {
                  new Notification('CODEZY', { body: 'This is what a finished reply looks like.' })
                  s.addNotice('Test notification sent.')
                } catch (e) {
                  s.addNotice(`Notification failed: ${e instanceof Error ? e.message : e}`, 'error')
                }
              }}
            >
              send a test
            </button>
          </div>
        </div>

        <div className="field">
          <label>Enter behavior in the composer</label>
          <div className="row">
            <button
              className={`btn ${settings.enterSends !== false ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ enterSends: true })}
            >
              Enter sends
            </button>
            <button
              className={`btn ${settings.enterSends === false ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ enterSends: false })}
            >
              Ctrl+Enter sends
            </button>
          </div>
        </div>
            </section>

            <section className="settings-pane" hidden={pane !== 'models'} aria-labelledby="settings-models">
              <div className="settings-pane-head">
                <h3 id="settings-models">Models</h3>
                <p>One local endpoint or any OpenAI-compatible provider — plus what each model can do.</p>
              </div>

        {/* engines ------------------------------------------------------- */}
        <div className="settings-section" id="set-providers" data-pane="models">models &amp; providers</div>
        <div className="field">
          <label>Ollama URL</label>
          <input
            type="text"
            value={settings.ollamaUrl}
            onChange={(e) => void s.updateSettings({ ollamaUrl: e.target.value })}
          />
        </div>

        <div className="field">
          <label>OpenAI-compatible providers (OpenRouter, DeepSeek, LM Studio…)</label>
          {/* one-click presets: fill name + baseUrl, the API key stays yours */}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.id}
                className="btn"
                title={p.hint}
                onClick={() => setNewProvider({ ...newProvider, name: p.name, baseUrl: p.baseUrl })}
              >
                {p.name}
              </button>
            ))}
          </div>
          {settings.providers.map((p) => (
            <div className="row" key={p.id} style={{ marginBottom: 6 }}>
              <span className="chip">{p.name}</span>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{p.baseUrl}</span>
              <button
                className="btn danger"
                style={{ marginLeft: 'auto', padding: '3px 8px' }}
                onClick={() =>
                  void s.updateSettings({
                    providers: settings.providers.filter((x) => x.id !== p.id),
                    activeProvider:
                      settings.activeProvider === p.id ? 'ollama' : settings.activeProvider
                  })
                }
              >
                remove
              </button>
            </div>
          ))}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="name"
              value={newProvider.name}
              onChange={(e) => setNewProvider({ ...newProvider, name: e.target.value })}
              style={{ flex: 1 }}
            />
            <input
              type="text"
              placeholder="https://api.example.com/v1"
              value={newProvider.baseUrl}
              onChange={(e) => setNewProvider({ ...newProvider, baseUrl: e.target.value })}
              style={{ flex: 2 }}
            />
            <input
              type="password"
              placeholder="api key"
              value={newProvider.apiKey}
              onChange={(e) => setNewProvider({ ...newProvider, apiKey: e.target.value })}
              style={{ flex: 1 }}
            />
            <button
              className="btn"
              onClick={() => {
                if (!newProvider.name || !newProvider.baseUrl) return
                const provider: ProviderConfig = {
                  id: newProvider.name.toLowerCase().replace(/\W+/g, '-'),
                  name: newProvider.name,
                  baseUrl: newProvider.baseUrl,
                  apiKey: newProvider.apiKey || undefined
                }
                void s.updateSettings({ providers: [...settings.providers, provider] })
                setNewProvider({ name: '', baseUrl: '', apiKey: '' })
              }}
            >
              add
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
            quick add fills the URL — paste your API key, hit add, then pick a model in the model picker
            (on Nebius: search “nvidia” for the Nemotron models)
          </div>
        </div>

        {/* supported models — tools are the requirement for agent mode ---- */}
        <div className="field model-guide" id="set-model-guide">
          <label>
            Models that work with agent mode — tool calling is the requirement. Installed models are marked;
            a model marked <b>chat only</b> still works, but edits use the classic blocks.
          </label>
          <div className="mg-rows">
            {MODEL_GUIDE.map((m) => {
              const installed = s.models.some((x) => x.id === m.id || x.id === `${m.id}:latest`)
              return (
                <div className={`mg-row${m.tools ? '' : ' no-tools'}`} key={m.id}>
                  <span className={`mg-dot ${m.tools ? 'ok' : 'no'}`} aria-hidden />
                  <span className="mg-name">{m.label}</span>
                  <span className="mg-use">{m.use}</span>
                  <span className="mg-ram">{m.ram}</span>
                  <span className={`mg-tag ${m.tools ? 'ok' : 'no'}`}>{m.tools ? 'tools' : 'chat only'}</span>
                  <span className="mg-note">{m.note}</span>
                  {installed ? (
                    <span className="mg-installed">installed</span>
                  ) : (
                    <code className="mg-pull">ollama pull {m.id}</code>
                  )}
                </div>
              )
            })}
          </div>
          <div className="mg-foot">
            The picker badges every installed model the same way — <b>tools</b> means agent mode can read,
            search and write. Runtime truth comes from Ollama&apos;s <code>/api/show</code>.
          </div>
        </div>
            </section>

            <section className="settings-pane" hidden={pane !== 'tools'} aria-labelledby="settings-tools">
              <div className="settings-pane-head">
                <h3 id="settings-tools">Tools</h3>
                <p>MCP servers add third-party tools to the agent. They run with your permissions — treat them as code.</p>
              </div>

        {/* MCP (v3) -------------------------------------------------------- */}
        <div className="settings-section" id="set-mcp" data-pane="tools">MCP servers</div>
        <div className="field">
          <label>
            Model Context Protocol servers — external processes whose tools the agent calls as
            mcp__&lt;server&gt;__&lt;tool&gt; (agent mode only, never in plan mode)
          </label>
          {mcp === null ? (
            <div className="hint">connecting…</div>
          ) : mcp.length === 0 ? (
            <div className="hint">
              no servers yet — a stdio server is usually one command, e.g. npx -y
              @modelcontextprotocol/server-filesystem /path/to/folder
            </div>
          ) : (
            mcp.map((srv, i) => (
              <div className={`mcp-row${srv.enabled === false ? ' off' : ''}`} key={`${srv.name}-${i}`}>
                <span className={`mcp-dot ${srv.status}`} title={srv.error ?? srv.status} />
                <span className="chip">{srv.name}</span>
                <span className="mcp-cmd" title={srv.error ?? srv.command}>
                  {srv.command}
                  {srv.args?.length ? ` ${srv.args.join(' ')}` : ''}
                </span>
                <span className="mcp-meta">
                  {srv.status === 'ok' ? `${srv.tools.length} tool${srv.tools.length === 1 ? '' : 's'}` : srv.status}
                </span>
                <button className="btn" disabled={mcpBusy} onClick={() => void probeMcp(srv)}>
                  test
                </button>
                <button
                  className="btn ghost"
                  disabled={mcpBusy}
                  onClick={() =>
                    void saveMcp(
                      mcp.map((x, j) => (j === i ? { ...x, enabled: x.enabled === false ? true : false } : x))
                    )
                  }
                >
                  {srv.enabled === false ? 'enable' : 'disable'}
                </button>
                <button
                  className="btn danger"
                  disabled={mcpBusy}
                  onClick={() => void saveMcp(mcp.filter((_, j) => j !== i))}
                >
                  remove
                </button>
                {mcpProbe[srv.name] && <div className="mcp-probe">{mcpProbe[srv.name]}</div>}
              </div>
            ))
          )}
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <input
              type="text"
              placeholder="name"
              value={newMcp.name}
              onChange={(e) => setNewMcp({ ...newMcp, name: e.target.value })}
              style={{ flex: 1 }}
            />
            <input
              type="text"
              placeholder="command (npx, uvx, an absolute path…)"
              value={newMcp.command}
              onChange={(e) => setNewMcp({ ...newMcp, command: e.target.value })}
              style={{ flex: 2 }}
            />
            <input
              type="text"
              placeholder="args (space separated)"
              value={newMcp.args}
              onChange={(e) => setNewMcp({ ...newMcp, args: e.target.value })}
              style={{ flex: 2 }}
            />
            <button
              className="btn"
              disabled={mcpBusy || !newMcp.name || !newMcp.command}
              onClick={() => {
                const entry: McpStatusEntry = {
                  name: newMcp.name.trim(),
                  command: newMcp.command.trim(),
                  args: newMcp.args.trim() ? newMcp.args.trim().split(/\s+/) : [],
                  status: 'disabled',
                  tools: []
                }
                void saveMcp([...(mcp ?? []), entry])
                setNewMcp({ name: '', command: '', args: '' })
              }}
            >
              add
            </button>
          </div>
          <div className="hint">
            servers start with CODEZY and stay running for the whole session — the dot shows whether
            the last connection answered (green = connected, red = error, grey = disabled)
          </div>
        </div>
            </section>

            <section className="settings-pane" hidden={pane !== 'agent'} aria-labelledby="settings-agent">
              <div className="settings-pane-head">
                <h3 id="settings-agent">Agent</h3>
                <p>How the model plans and edits, and the standing orders it follows in every chat.</p>
              </div>

        {/* instructions -------------------------------------------------- */}
        <div className="settings-section" id="set-instructions" data-pane="agent">instructions</div>
        <div className="field">
          <label>
            Custom instructions — sent with every message: tone, rules, language, things to always or never do
          </label>
          <textarea
            rows={5}
            value={settings.instructions ?? ''}
            placeholder={'e.g. Answer in Polish. Keep replies short. Always add tests before calling a task done.'}
            onChange={(e) => void s.updateSettings({ instructions: e.target.value })}
          />
          <div className="hint">
            Sent right under the system prompt (so a small model can't lose them). Project-specific rules belong
            in a project's context file instead.
          </div>
        </div>

        {/* project instructions (v3.1) --------------------------------------- */}
        <div className="field proj-instr">
          <label>
            Project instructions — <code>.codezy/instructions.md</code> inside the linked folder: standing orders
            for this one project, loaded into every chat that links it
          </label>
          {activeSession && roots.length ? (
            <div className="pi-rows">
              {roots.map((r) => (
                <div className="pi-row" key={r}>
                  <span className={`pi-status ${pi[r] ?? 'loading'}`}>
                    {pi[r] === 'found' ? 'ready' : pi[r] === 'missing' ? 'not created' : 'checking…'}
                  </span>
                  <span className="pi-path" title={piPath(r)}>
                    {piPath(r)}
                  </span>
                  {pi[r] === 'missing' ? (
                    <button className="btn" onClick={() => void createPi(r)}>
                      create it
                    </button>
                  ) : (
                    <button className="btn" onClick={() => openPi(r)} disabled={pi[r] !== 'found'}>
                      open
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="hint">Link a folder to a chat (the folder button in the composer) to use project instructions.</div>
          )}
          <div className="hint">
            separate from your custom instructions above — this file lives in the repo, so the whole team and every
            new chat inherit the same rules (always / never / how to run the tests)
          </div>
        </div>

        {/* behavior -------------------------------------------------------- */}
        <div className="settings-section" id="set-behavior" data-pane="agent">behavior</div>
        <div className="field">
          <label>
            Reply mode — plan: the model only plans · build: proposes edits you accept · auto: applies
            directly (always backed up, /undo reverts)
          </label>
          <div className="row">
            {(['plan', 'build', 'auto'] as const).map((m) => (
              <button
                key={m}
                className={`btn ${settings.mode === m ? 'primary' : ''}`}
                onClick={() => void s.updateSettings({ mode: m })}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Default reasoning effort for new chats (switch per chat with the E badge)</label>
          <div className="row">
            {(['light', 'medium', 'deep'] as const).map((e) => (
              <button
                key={e}
                className={`btn ${settings.effort === e ? 'primary' : ''}`}
                onClick={() => void s.updateSettings({ effort: e })}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>
            Auto-continue — a reply that stops inside an unclosed ``` code fence gets nudged to finish
            (hidden, up to 3 times per message)
          </label>
          <div className="row">
            <button
              className={`btn ${settings.autoContinue !== false ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ autoContinue: true })}
            >
              on
            </button>
            <button
              className={`btn ${settings.autoContinue === false ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ autoContinue: false })}
            >
              off
            </button>
          </div>
        </div>

        {/* agent mode (v2) ------------------------------------------------- */}
        <div className="field">
          <label>
            Agent mode (v2) — on by default over a linked folder: the model reads, searches, writes and runs
            commands itself through the shared harness; every write/command asks for your approval first. A
            model that cannot call tools automatically falls back to edit blocks with your real files.
          </label>
          <div className="row">
            <button
              className={`btn ${settings.v2 ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ v2: true })}
            >
              on
            </button>
            <button
              className={`btn ${!settings.v2 ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ v2: false })}
            >
              off
            </button>
          </div>
        </div>

            </section>

            <section className="settings-pane" hidden={pane !== 'data'} aria-labelledby="settings-data">
              <div className="settings-pane-head">
                <h3 id="settings-data">Data</h3>
                <p>Where sessions live, what CODEZY remembers, and how to move preferences between machines.</p>
              </div>

        {/* storage ------------------------------------------------------- */}
        <div className="settings-section" id="set-storage" data-pane="data">storage</div>
        <div className="field">
          <label>Data folder (sessions, memory, skills)</label>
          <div className="row">
            <input type="text" value={settings.dataDir} readOnly style={{ flex: 1 }} />
            <button
              className="btn"
              onClick={async () => {
                const dir = await window.codezy.dialog.pickFolder('Choose data folder')
                if (!dir) return
                await s.updateSettings({ dataDir: dir })
                location.reload() // store re-roots itself in the backend on save
              }}
            >
              change
            </button>
          </div>
        </div>

        <div className="field">
          <label>Google Drive mirror (optional — pick your Drive folder)</label>
          <div className="row">
            <input
              type="text"
              value={settings.driveFolder ?? ''}
              placeholder="off"
              onChange={(e) => void s.updateSettings({ driveFolder: e.target.value || null })}
              style={{ flex: 1 }}
            />
            <button
              className="btn"
              onClick={async () => {
                const dir = await window.codezy.dialog.pickFolder('Google Drive folder')
                if (dir) await s.updateSettings({ driveFolder: dir })
              }}
            >
              browse
            </button>
            <button className="btn" onClick={() => void s.updateSettings({ driveFolder: null })}>
              off
            </button>
          </div>
        </div>

        {/* learning ------------------------------------------------------ */}
        <div className="settings-section" id="set-learning" data-pane="data">learning &amp; memory</div>
        <div className="field">
          <label>Learning — CODEZY remembers things about you in memory.md</label>
          <div className="row">
            <button
              className={`btn ${settings.learn ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ learn: true })}
            >
              on
            </button>
            <button
              className={`btn ${!settings.learn ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ learn: false })}
            >
              off
            </button>
          </div>
          <textarea
            rows={6}
            value={memory}
            placeholder="What CODEZY knows about you (editable — you're always right)"
            onChange={(e) => setMemory(e.target.value)}
          />
          <div className="row">
            <button className="btn" onClick={() => void window.codezy.memory.write(memory)}>
              save memory
            </button>
            <button
              className="btn danger"
              onClick={() => {
                setMemory('')
                void window.codezy.memory.write('')
              }}
            >
              clear memory
            </button>
          </div>
        </div>

        {/* backup --------------------------------------------------------- */}
        <div className="settings-section" id="set-backup" data-pane="data">backup</div>
        <div className="field">
          <label>Settings backup — save this machine's settings to a file, or load ones exported elsewhere</label>
          <div className="row">
            <button className="btn" onClick={() => void exportSettings()}>
              export settings (.json)
            </button>
            <button className="btn" onClick={() => void importSettings()}>
              import settings…
            </button>
          </div>
          <div className="hint">
            Folders never move between machines — only preferences, models and provider keys are in the file.
          </div>
        </div>
            </section>

            <section className="settings-pane" hidden={pane !== 'about'} aria-labelledby="settings-about">
              <div className="settings-pane-head">
                <h3 id="settings-about">About</h3>
                <p>The build you are running, and where the next one comes from.</p>
              </div>

        {/* about ---------------------------------------------------------- */}
        <div className="settings-section" id="set-about" data-pane="about">about</div>
        <div className="field">
          <div className="row" style={{ gap: 10 }}>
            <span className="chip">CODEZY v{__APP_VERSION__}</span>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
              MIT · local-first · API keys stay in your settings.json
            </span>
          </div>
        </div>
        <div className="field">
          <label>Updates — check GitHub for a newer CODEZY (downloads here and installs in place)</label>
          <div className="row">
            <button
              className={`btn ${settings.autoUpdate !== false ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ autoUpdate: true })}
            >
              check on launch
            </button>
            <button
              className={`btn ${settings.autoUpdate === false ? 'primary' : ''}`}
              onClick={() => void s.updateSettings({ autoUpdate: false })}
            >
              never
            </button>
            <button className="btn ghost" onClick={() => void s.checkForUpdates(false)}>
              check now
            </button>
          </div>
          <div className="hint">
            The update appears as a small pill in the top bar — you choose when it installs.
          </div>
        </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

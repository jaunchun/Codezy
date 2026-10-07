import { useEffect, useState } from 'react'
import { useApp } from '../store/app'
import type { ProviderConfig, ThemeName } from '../../../shared/types'
import { PROVIDER_PRESETS } from '../../../shared/providers'

const THEMES: { id: ThemeName; label: string; preview: string }[] = [
  { id: 'dark', label: 'Dark', preview: '#0b0b12' },
  { id: 'light', label: 'Light', preview: '#f3f3f8' },
  { id: 'acrylic', label: 'Acrylic', preview: 'linear-gradient(135deg,#2b2b3a,#0b0b12)' },
  { id: 'midnight', label: 'Midnight', preview: 'linear-gradient(135deg,#0b0b12 55%,#3d9bff)' },
  { id: 'ember', label: 'Ember', preview: 'linear-gradient(135deg,#0b0b12 55%,#ff8a3d)' },
  { id: 'mint', label: 'Mint', preview: 'linear-gradient(135deg,#0b0b12 55%,#3ddc97)' },
  { id: 'slate', label: 'Slate', preview: 'linear-gradient(135deg,#0b0b12 55%,#a8b3cf)' }
]

/** accent swatches — surface themes follow them, palette themes override */
const ACCENTS = ['#3d9bff', '#7c5cff', '#3ddc97', '#ff8a3d', '#ff5c7a', '#ffd166', '#a8b3cf', '#f0f0f5']

export default function SettingsModal() {
  const s = useApp()
  const settings = s.settings
  const [memory, setMemory] = useState('')
  const [newProvider, setNewProvider] = useState({ name: '', baseUrl: '', apiKey: '' })

  useEffect(() => {
    if (s.settingsOpen) {
      void window.codezy.memory.read().then(setMemory)
      void s.resync() // providers the TUI connected must show up without a restart
    }
  }, [s.settingsOpen])

  if (!s.settingsOpen || !settings) return null

  return (
    <div className="overlay" onClick={() => s.setSettingsOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          Settings & Accounts
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
        </h2>

        {/* profile ------------------------------------------------------- */}
        <div className="settings-section">profile</div>
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
        <div className="settings-section">appearance</div>
        <div className="field">
          <label>
            Theme — dark/light/acrylic are surfaces · midnight/ember/mint/slate are accent palettes shared
            with the terminal
          </label>
          <div className="theme-picker">
            {THEMES.map((t) => (
              <div
                key={t.id}
                className={`theme-swatch ${settings.theme === t.id ? 'active' : ''}`}
                onClick={() => void s.updateSettings({ theme: t.id })}
              >
                <div
                  style={{
                    height: 34,
                    borderRadius: 6,
                    background: t.preview,
                    border: '1px solid var(--border)',
                    marginBottom: 6
                  }}
                />
                {t.label}
              </div>
            ))}
          </div>
        </div>

        <div className="field">
          <label>
            Accent — surface themes follow it · palette themes override it to stay in sync with the terminal
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

        {/* engines ------------------------------------------------------- */}
        <div className="settings-section">models &amp; providers</div>
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

        {/* behavior -------------------------------------------------------- */}
        <div className="settings-section">behavior</div>
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
            Agent mode (v2) — the model reads, searches, writes and runs commands itself through the shared
            harness; every write/command asks for your approval first. Needs a linked folder.
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

        {/* notifications --------------------------------------------------- */}
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
          </div>
        </div>

        {/* enter behavior --------------------------------------------------- */}
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

        {/* storage ------------------------------------------------------- */}
        <div className="settings-section">storage</div>
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
        <div className="settings-section">learning &amp; memory</div>
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

        {/* about ---------------------------------------------------------- */}
        <div className="settings-section">about</div>
        <div className="field">
          <div className="row" style={{ gap: 10 }}>
            <span className="chip">CODEZY v{__APP_VERSION__}</span>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
              MIT · local-first · API keys stay in your settings.json
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

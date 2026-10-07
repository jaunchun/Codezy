import { useState } from 'react'
import { useApp } from '../store/app'
import { PROVIDER_PRESETS, connectPatch } from '../../../shared/providers'
import type { ProviderPreset } from '../../../shared/providers'
import { CubeLogo } from './Icons'

// ---------------------------------------------------------------------------
// SetupScreen — first-run onboarding, shown until settings.setupDone flips.
// Three steps (welcome → connect → ready); every path is skippable and the
// whole thing can be reopened from Settings, so nothing here is destructive:
// it only writes what the user explicitly picks.
// ---------------------------------------------------------------------------

const STEPS = ['01 welcome', '02 connect', '03 ready']

export default function SetupScreen() {
  const s = useApp()
  const settings = s.settings
  const [step, setStep] = useState(0)
  const [preset, setPreset] = useState<ProviderPreset>(PROVIDER_PRESETS[0])
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  if (!settings) return null

  const finish = () => void s.updateSettings({ setupDone: true })

  const needsKey = preset.id !== 'lm-studio' // LM Studio is a local server
  const canConnect = !busy && (!needsKey || !!apiKey.trim())

  const connect = async () => {
    if (!canConnect) return
    setBusy(true)
    setMsg(null)
    try {
      const patch = connectPatch(settings.providers, preset, apiKey.trim(), settings.activeModel)
      await s.updateSettings(patch)
      setMsg({ ok: true, text: `Connected — ${preset.name} · ${patch.activeModel}` })
      setStep(2)
    } catch {
      setMsg({ ok: false, text: 'Could not save that provider — check the key and try again.' })
    } finally {
      setBusy(false)
    }
  }

  const useOllama = async () => {
    setBusy(true)
    try {
      await s.updateSettings({ activeProvider: 'ollama' })
      setStep(2)
    } finally {
      setBusy(false)
    }
  }

  const activeName =
    settings.activeProvider === 'ollama'
      ? 'Ollama (local)'
      : (settings.providers.find((p) => p.id === settings.activeProvider)?.name ??
        settings.activeProvider)

  return (
    <div className="overlay setup-overlay">
      <div className="setup-card" role="dialog" aria-label="Set up CODEZY">
        {/* step rail + skip ---------------------------------------------- */}
        <div className="setup-head">
          <div className="setup-rail">
            {STEPS.map((label, i) => (
              <span
                key={label}
                className={`setup-step${i === step ? ' active' : ''}${i < step ? ' done' : ''}`}
                aria-current={i === step ? 'step' : undefined}
              >
                {label}
              </span>
            ))}
          </div>
          <button className="btn ghost setup-skip" onClick={finish}>
            skip setup
          </button>
        </div>

        {/* 01 · welcome -------------------------------------------------- */}
        {step === 0 && (
          <>
            <div className="setup-body">
              <div className="setup-logo">
                <CubeLogo />
                CODEZY
              </div>
              <p className="setup-tagline">
                Claude Code style chat for your models — local first, cloud ready.
              </p>
              {/* live engine status — the app starts Ollama on launch, so this
                  usually flips to "ready" before you finish reading */}
              <div className={`setup-engine${s.ollama === 'online' ? ' on' : ''}`}>
                <span
                  className={`setup-dot${
                    s.ollama === 'online' ? ' on' : s.ollama === 'offline' ? ' off' : ''
                  }`}
                />
                {s.ollama === 'online'
                  ? 'Ollama ready — local engine detected'
                  : s.ollama === 'offline'
                    ? "waiting for Ollama — CODEZY starts it automatically, or connect a cloud provider next"
                    : 'checking for Ollama…'}
              </div>
              <div className="setup-lines">
                <div className="setup-line">talk to Ollama running on this machine</div>
                <div className="setup-line">or plug in any OpenAI-compatible API</div>
                <div className="setup-line">pick a model, link a folder, start shipping</div>
              </div>
              <div className="setup-note">
                takes under a minute · everything can be changed later in Settings (
                <span className="setup-key">Ctrl+,</span>)
              </div>
            </div>
            <div className="setup-actions">
              {s.ollama === 'online' ? (
                <>
                  {/* autosetup: the engine is already up — one click and you're in */}
                  <button className="btn primary" onClick={() => void useOllama()}>
                    Start with local Ollama
                  </button>
                  <button className="btn ghost" onClick={() => setStep(1)}>
                    Continue
                  </button>
                </>
              ) : (
                <button className="btn primary" onClick={() => setStep(1)}>
                  Continue
                </button>
              )}
            </div>
          </>
        )}

        {/* 02 · connect -------------------------------------------------- */}
        {step === 1 && (
          <>
            <div className="setup-body">
              <div className="setup-label">local models</div>
              <div className="setup-status">
                <span
                  className={`setup-dot${
                    s.ollama === 'online' ? ' on' : s.ollama === 'offline' ? ' off' : ''
                  }`}
                />
                <span className="setup-mono">{settings.ollamaUrl}</span>
                <span>
                  {s.ollama === 'online'
                    ? 'Ollama is running'
                    : s.ollama === 'offline'
                      ? "Ollama isn't running — start it with ollama serve, or connect a cloud provider below"
                      : 'checking…'}
                </span>
              </div>

              <div className="setup-label">cloud provider (optional)</div>
              <div className="setup-chips">
                {PROVIDER_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    className={`setup-chip${preset.id === p.id ? ' active' : ''}`}
                    title={p.hint}
                    onClick={() => {
                      setPreset(p)
                      setMsg(null)
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <div className="field">
                <label htmlFor="setup-key">
                  API key — stored only in your settings file, never anywhere else
                </label>
                <input
                  id="setup-key"
                  type="password"
                  autoComplete="off"
                  placeholder={needsKey ? `${preset.name} API key` : 'no key needed'}
                  value={apiKey}
                  disabled={!needsKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void connect()
                  }}
                />
              </div>
              {msg && <div className={`setup-msg${msg.ok ? '' : ' err'}`}>{msg.text}</div>}
            </div>
            <div className="setup-actions between">
              <button className="btn ghost" onClick={() => setStep(0)} disabled={busy}>
                Back
              </button>
              <span className="setup-actions-right">
                <button className="btn ghost" onClick={() => void useOllama()} disabled={busy}>
                  Use local Ollama
                </button>
                <button className="btn primary" onClick={() => void connect()} disabled={!canConnect}>
                  {busy ? 'connecting…' : 'Connect & continue'}
                </button>
              </span>
            </div>
          </>
        )}

        {/* 03 · ready ---------------------------------------------------- */}
        {step === 2 && (
          <>
            <div className="setup-body">
              <div className="setup-label">you&apos;re set</div>
              <div className="setup-summary">
                <div className="setup-row">
                  <span className="k">provider</span>
                  <span className="v">{activeName}</span>
                </div>
                <div className="setup-row">
                  <span className="k">model</span>
                  <span className="v">{settings.activeModel}</span>
                </div>
                <div className="setup-row">
                  <span className="k">data folder</span>
                  <span className="v setup-truncate">{settings.dataDir}</span>
                </div>
              </div>
              <div className="setup-note">
                swap the model any time from the picker · <span className="setup-key">Ctrl+,</span>{' '}
                reopens Settings, including <strong>Run setup</strong>
              </div>
            </div>
            <div className="setup-actions">
              <button className="btn primary" onClick={finish}>
                Open CODEZY
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

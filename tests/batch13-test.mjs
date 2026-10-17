// Batch 13 — beta-readiness round (first-run setup + window hardening).
// Runs ENTIRELY inside the project: scratch under tests/.tmp, and a faked
// USERPROFILE so the main store's default data dir can never point at the
// real profile — the earlier version of this test re-rooted into %USERPROFILE%
// and clobbered the live settings file. Two belts: fake home + dataDir pinned
// in every fixture settings file.
//
//  1. shared connectPatch (esbuild): the setup screen's provider upsert —
//     activates + defaults the model, re-keys without duplicating, keeps
//     other providers intact, keeps the current model for presets that
//     have no known-good one.
//  2. main store: fresh install → setupDone false (screen shows); a file
//     written WITHOUT the key (TUI-style) → still false; patch flips it.
//  3. renderer store (mocked bridge): updateSettings({setupDone}) sends a
//     patch-only payload both ways (finish + Settings' "Run setup").
//  4. client render (jsdom): click through welcome → connect → ready → finish,
//     the skip path, and Settings' "Run setup" reopen.
//  5. source tripwires: will-navigate lockdown + http(s)-only openExternal
//     in main, App.tsx setup gate present.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const require = createRequire(path.join(PROJ, 'package.json'))
const { build } = require('esbuild')

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

// --- confinement: scratch + homedir both live under the project --------------
const OUT = path.join(PROJ, 'tests', '.tmp', `b13-${Date.now()}`)
const FAKE_HOME = path.join(OUT, 'fake-home')
fs.mkdirSync(FAKE_HOME, { recursive: true })
process.env.USERPROFILE = FAKE_HOME // os.homedir() → fake (batch12 proves env wins)
process.env.HOME = FAKE_HOME

process.on('exit', () => {
  try {
    fs.rmSync(OUT, { recursive: true, force: true })
  } catch {}
})

const NEBIUS = {
  id: 'nebius',
  name: 'Nebius Token Factory',
  baseUrl: 'https://api.tokenfactory.nebius.com/v1',
  apiKey: 'nk-b13'
}

// --- 1. shared connectPatch ---------------------------------------------------
await build({
  entryPoints: [path.join(PROJ, 'src/shared/providers.ts')],
  outfile: path.join(OUT, 'providers.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
{
  const { PROVIDER_PRESETS, connectPatch } = await import(pathToFileURL(path.join(OUT, 'providers.mjs')).href)
  const nebius = PROVIDER_PRESETS.find((p) => p.id === 'nebius')
  const openrouter = PROVIDER_PRESETS.find((p) => p.id === 'openrouter')
  const lmstudio = PROVIDER_PRESETS.find((p) => p.id === 'lm-studio')

  const a = connectPatch([], nebius, 'nk-new', 'qwen2.5-coder:7b')
  check(
    'connectPatch: fresh connect appends + activates + defaults model',
    a.providers.length === 1 &&
      a.providers[0].apiKey === 'nk-new' &&
      a.activeProvider === 'nebius' &&
      a.activeModel === 'nvidia/Nemotron-3_5-Lightning',
    JSON.stringify({ n: a.providers.length, p: a.activeProvider, m: a.activeModel })
  )

  const other = { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or-old' }
  const b = connectPatch([other, { ...NEBIUS }], nebius, 'nk-rekeyed', 'old-model')
  check(
    'connectPatch: re-key replaces in place, others stay',
    b.providers.length === 2 &&
      b.providers.find((p) => p.id === 'nebius')?.apiKey === 'nk-rekeyed' &&
      b.providers.find((p) => p.id === 'openrouter')?.apiKey === 'or-old',
    JSON.stringify(b.providers.map((p) => `${p.id}:${p.apiKey}`))
  )

  const c = connectPatch([other], openrouter, 'or-new', 'qwen2.5-coder:7b')
  check(
    'connectPatch: preset without defaultModel keeps current model',
    c.activeProvider === 'openrouter' && c.activeModel === 'qwen2.5-coder:7b',
    JSON.stringify({ p: c.activeProvider, m: c.activeModel })
  )

  const d = connectPatch([], lmstudio, '', 'qwen2.5-coder:7b')
  check('connectPatch: lm-studio connects keyless', d.activeProvider === 'lm-studio' && d.providers[0].apiKey === '', JSON.stringify(d))
}

// --- 2. main store: setupDone default + patch ---------------------------------
fs.writeFileSync(
  path.join(OUT, 'electron-stub.mjs'),
  'export const app = { getPath: () => "" }\nexport default { app }\n'
)
await build({
  entryPoints: [path.join(PROJ, 'src/main/store.ts')],
  outfile: path.join(OUT, 'store.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { electron: path.join(OUT, 'electron-stub.mjs') },
  logLevel: 'silent'
})
{
  const store = await import(pathToFileURL(path.join(OUT, 'store.mjs')).href)
  const TDIR = path.join(OUT, 'data')
  store.initStore(TDIR)

  const fresh = store.getSettings()
  check('store: fresh install → setupDone false', fresh.setupDone === false, `setupDone=${fresh.setupDone}`)
  check(
    'guard: homedir is faked inside the project',
    os.homedir().replace(/\\/g, '/').includes('/tests/.tmp/'),
    os.homedir()
  )

  // a settings file written by something that never heard of setupDone (TUI).
  // dataDir is pinned to TDIR: without it the merged default (homedir/.codezy)
  // would make saveSettings re-root the store outside the fixture.
  fs.writeFileSync(
    path.join(TDIR, 'settings.json'),
    JSON.stringify(
      { dataDir: TDIR, ollamaUrl: 'http://127.0.0.1:11434', activeProvider: 'ollama', activeModel: 'qwen2.5-coder:7b', providers: [] },
      null,
      2
    )
  )
  const legacy = store.getSettings()
  check('store: legacy file without setupDone → screen shows once', legacy.setupDone === false, `setupDone=${legacy.setupDone}`)

  const { saved } = store.patchSettings({ setupDone: true })
  const disk = JSON.parse(fs.readFileSync(path.join(TDIR, 'settings.json'), 'utf8'))
  check(
    'store: finishing setup persists setupDone',
    saved.setupDone === true && disk.setupDone === true && disk.dataDir === TDIR,
    `disk=${disk.setupDone}`
  )
}

// --- 3. renderer store: setupDone patch payload -------------------------------
let setCalls = []
let diskState = {
  theme: 'dark',
  accent: '#3d9bff',
  dataDir: 'tests/.tmp/batch13-renderer',
  driveFolder: null,
  ollamaUrl: 'http://127.0.0.1:11434',
  providers: [],
  activeProvider: 'ollama',
  activeModel: 'qwen2.5-coder:7b',
  effort: 'medium',
  userName: 'dev',
  learn: true,
  fontSize: 14,
  mode: 'build',
  setupDone: false
}
const mock = {
  settings: {
    get: async () => ({ ...diskState }),
    set: async (patch) => {
      setCalls.push(patch)
      diskState = { ...diskState, ...patch }
      return { ...diskState }
    }
  },
  health: { ollama: async () => 'online', drive: async () => 'ok' },
  memory: { read: async () => '', write: async () => true },
  skills: { list: async () => [] },
  sessions: { save: async (s) => s },
  models: { list: async () => [] }
}
globalThis.window = { codezy: mock }

await build({
  entryPoints: [path.join(PROJ, 'src/renderer/src/store/app.ts')],
  outfile: path.join(OUT, 'app.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent'
})
const { useApp } = await import(pathToFileURL(path.join(OUT, 'app.mjs')).href)
useApp.setState({ settings: { ...diskState }, sessions: [], activeId: null, notices: [], ready: true })
{
  await useApp.getState().updateSettings({ setupDone: true })
  check(
    'renderer: finishing setup sends setupDone patch only',
    setCalls.length === 1 && Object.keys(setCalls[0]).length === 1 && setCalls[0].setupDone === true && useApp.getState().settings.setupDone === true,
    JSON.stringify(setCalls[0])
  )

  setCalls = []
  await useApp.getState().updateSettings({ setupDone: false }) // Settings → "Run setup"
  check(
    'renderer: Run setup reopens the screen',
    setCalls.length === 1 && setCalls[0].setupDone === false && useApp.getState().settings.setupDone === false,
    JSON.stringify(setCalls[0])
  )
}

// --- 4. client render (jsdom): click through the setup screen ----------------
// renderToString can't see this state: zustand v5's SERVER snapshot returns
// the initial state (settings null). A real client render exercises the same
// react-dom path the app uses — and lets us actually click through the flow.
{
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true
  })
  const defineGlobal = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  defineGlobal('window', dom.window)
  defineGlobal('document', dom.window.document)
  defineGlobal('navigator', dom.window.navigator) // Node 21+ ships a getter — define over it
  defineGlobal('HTMLElement', dom.window.HTMLElement)
  defineGlobal('HTMLInputElement', dom.window.HTMLInputElement)
  defineGlobal('Event', dom.window.Event)
  defineGlobal('MouseEvent', dom.window.MouseEvent)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.codezy = mock

  const entry = path.join(OUT, 'entry.tsx')
  fs.writeFileSync(
    entry,
    [
      `export { default as SetupScreen } from '${PROJ}/src/renderer/src/components/SetupScreen'`,
      `export { default as SettingsModal } from '${PROJ}/src/renderer/src/components/SettingsModal'`,
      `export { useApp } from '${PROJ}/src/renderer/src/store/app'`,
      `export { createRoot } from 'react-dom/client'`,
      `export { act } from 'react'`,
      `export { createElement } from 'react'`
    ].join('\n')
  )
  await build({
    entryPoints: [entry],
    outfile: path.join(OUT, 'ui.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    define: { __APP_VERSION__: JSON.stringify('0.0.0-test') },
    logLevel: 'silent'
  })
  const ui = await import(pathToFileURL(path.join(OUT, 'ui.mjs')).href)
  ui.useApp.setState({ settings: { ...diskState, setupDone: false }, ollama: 'online', sessions: [], activeId: null, notices: [], ready: true })

  const root = ui.createRoot(document.getElementById('root'))
  const html = () => document.getElementById('root').innerHTML
  const findBtn = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t)
  const click = async (t) => {
    const el = findBtn(t)
    if (!el) throw new Error(`no button "${t}" — visible: ${[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' | ')}`)
    await ui.act(async () => {
      el.click()
    })
    return el
  }
  const type = async (sel, value) => {
    const el = document.querySelector(sel)
    if (!el) throw new Error(`no input ${sel}`)
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(el, value)
    await ui.act(async () => {
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
  const st = () => ui.useApp.getState()

  await ui.act(async () => {
    root.render(ui.createElement(ui.SetupScreen))
  })

  // step 0 — welcome
  check('setup ui: step rail present', ['01 welcome', '02 connect', '03 ready'].every((t) => html().includes(t)), html().slice(0, 120))
  check('setup ui: wordmark + tagline', html().includes('CODEZY') && html().includes('Claude Code style chat'), '')
  check('setup ui: current step marked', html().includes('aria-current="step"'), '')
  check('setup ui: welcome bullet lines', html().includes('talk to Ollama running on this machine'), '')
  check('setup ui: continue + skip actions', !!findBtn('Continue') && !!findBtn('skip setup'), '')

  // step 1 — connect
  await click('Continue')
  check(
    'setup ui: connect step shows ollama + presets',
    html().includes('http://127.0.0.1:11434') && html().includes('Nebius Token Factory') && !!document.querySelector('#setup-key'),
    ''
  )
  check('setup ui: Connect disabled until key entered', findBtn('Connect & continue')?.disabled === true, '')
  await type('#setup-key', 'nk-live')
  check('setup ui: Connect enabled after key entered', findBtn('Connect & continue')?.disabled === false, '')

  // connect → ready
  await click('Connect & continue')
  check(
    'setup ui: ready step summarizes provider + model',
    html().includes('Nebius Token Factory') && html().includes('nvidia/Nemotron-3_5-Lightning'),
    ''
  )
  check(
    'setup ui: connecting actually activated the provider',
    st().settings.activeProvider === 'nebius' && st().settings.providers.find((p) => p.id === 'nebius')?.apiKey === 'nk-live',
    JSON.stringify({ p: st().settings.activeProvider, keys: st().settings.providers.map((x) => x.id) })
  )

  // finish
  await click('Open CODEZY')
  check('setup ui: Open CODEZY persists setupDone', st().settings.setupDone === true, `setupDone=${st().settings.setupDone}`)

  // skip path on a fresh screen
  await ui.act(async () => {
    ui.useApp.setState({ settings: { ...st().settings, setupDone: false } })
  })
  await ui.act(async () => {
    root.render(ui.createElement(ui.SetupScreen))
  })
  await click('skip setup')
  check('setup ui: skip setup finishes too', st().settings.setupDone === true, `setupDone=${st().settings.setupDone}`)

  // Settings dialog → Run setup reopens the screen
  await ui.act(async () => {
    ui.useApp.setState({ settings: { ...st().settings, setupDone: true }, settingsOpen: true })
    root.render(ui.createElement(ui.SettingsModal))
  })
  check('settings ui: Run setup button rendered', !!findBtn('Run setup'), '')
  await click('Run setup')
  check(
    'settings ui: Run setup reopens + closes dialog',
    st().settings.setupDone === false && st().settingsOpen === false,
    JSON.stringify({ done: st().settings.setupDone, open: st().settingsOpen })
  )
}

// --- 5. source tripwires: window hardening + setup gate -----------------------
{
  const main = fs.readFileSync(path.join(PROJ, 'src/main/index.ts'), 'utf8')
  check('main: will-navigate lockdown present', /on\('will-navigate'/.test(main) && /e\.preventDefault\(\)/.test(main), '')
  check(
    'main: openExternal is http(s)-only in both places',
    (main.match(/startsWith\('http:\/\/'\) \|\| url\.startsWith\('https:\/\/'\)/g) ?? []).length >= 2,
    ''
  )
  const app = fs.readFileSync(path.join(PROJ, 'src/renderer/src/App.tsx'), 'utf8')
  check('App: setup gate + mount', app.includes('setupDone !== true') && app.includes('<SetupScreen />'), '')
}

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

// Batch 14 — settings expansion + UI face-lift:
//  1. main store: reduceMotion default false (fresh install).
//  2. renderer store (jsdom + mocked bridge): custom accent applies inline
//     (--accent / --accent-2), palette themes WIN over the custom accent,
//     reduce motion flips html[data-motion], every change is a patch payload.
//  3. UI (client render): Settings shows its 7 mono sections, the 8 accent
//     swatches (click → applies + persists), mode + effort rows, the motion
//     switch, the about chip with the build-time version, and the title bar
//     version chip.
// Scratch lives under tests/.tmp and USERPROFILE is faked into it, so the
// run never leaves the project.
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

const OUT = path.join(PROJ, 'tests', '.tmp', `b14-${Date.now()}`)
const FAKE_HOME = path.join(OUT, 'fake-home')
fs.mkdirSync(FAKE_HOME, { recursive: true })
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME
process.on('exit', () => {
  try {
    fs.rmSync(OUT, { recursive: true, force: true })
  } catch {}
})

// --- 1. main store defaults ---------------------------------------------------
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
  store.initStore(path.join(OUT, 'data'))
  const fresh = store.getSettings()
  check('store: reduceMotion defaults to false', fresh.reduceMotion === false, `reduceMotion=${fresh.reduceMotion}`)
  check('store: setupDone still defaults to false', fresh.setupDone === false, `setupDone=${fresh.setupDone}`)
}

// --- jsdom + mocked bridge ----------------------------------------------------
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
})
const defineGlobal = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
defineGlobal('window', dom.window)
defineGlobal('document', dom.window.document)
defineGlobal('navigator', dom.window.navigator)
defineGlobal('HTMLElement', dom.window.HTMLElement)
defineGlobal('HTMLInputElement', dom.window.HTMLInputElement)
defineGlobal('Event', dom.window.Event)
defineGlobal('MouseEvent', dom.window.MouseEvent)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let setCalls = []
let diskState = {
  theme: 'dark',
  accent: '#3d9bff',
  dataDir: 'tests/.tmp/batch14',
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
  setupDone: true,
  reduceMotion: false
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
  models: { list: async () => [] },
  win: { minimize: () => {}, maximize: () => {}, close: () => {} }
}
dom.window.codezy = mock

// --- one bundle: store + components + react -----------------------------------
const entry = path.join(OUT, 'entry.tsx')
fs.writeFileSync(
  entry,
  [
    `export { default as SettingsModal } from '${PROJ}/src/renderer/src/components/SettingsModal'`,
    `export { default as TitleBar } from '${PROJ}/src/renderer/src/components/TitleBar'`,
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
const st = () => ui.useApp.getState()
ui.useApp.setState({ settings: { ...diskState }, sessions: [], activeId: null, notices: [], ready: true })

// --- 2. accent / motion application -------------------------------------------
{
  await st().updateSettings({ accent: '#7c5cff' })
  const root = document.documentElement
  check(
    'accent: applies inline --accent + derived --accent-2',
    root.style.getPropertyValue('--accent').trim() === '#7c5cff' && root.style.getPropertyValue('--accent-2').includes('#7c5cff'),
    `accent=${root.style.getPropertyValue('--accent')} a2=${root.style.getPropertyValue('--accent-2')}`
  )
  check(
    'accent: patch payload is only the changed key',
    setCalls.length === 1 && Object.keys(setCalls[0]).length === 1 && setCalls[0].accent === '#7c5cff',
    JSON.stringify(setCalls[0])
  )

  // palette THEMES own the accent (terminal parity) — custom accent steps aside
  await st().updateSettings({ theme: 'ember', accent: '#3ddc97' })
  check(
    'accent: palette theme wins over the custom accent',
    root.dataset.palette === 'ember' && root.style.getPropertyValue('--accent') === '' && st().settings.accent === '#3ddc97',
    `accent="${root.style.getPropertyValue('--accent')}" palette=${root.dataset.palette}`
  )

  // switching back to a surface theme re-applies it (derived palette attr is
  // 'midnight' for surfaces — the inline value still wins over that rule)
  await st().updateSettings({ theme: 'dark' })
  check(
    'accent: surface theme re-applies the custom accent',
    root.dataset.palette === 'midnight' && root.style.getPropertyValue('--accent').trim() === '#3ddc97',
    `palette="${root.dataset.palette}" accent="${root.style.getPropertyValue('--accent')}"`
  )

  await st().updateSettings({ reduceMotion: true })
  check(
    'motion: reduce turns the attribute off (CSS hooks on it)',
    root.dataset.motion === 'off' && st().settings.reduceMotion === true && diskState.reduceMotion === true,
    `motion=${root.dataset.motion}`
  )
  await st().updateSettings({ reduceMotion: false })
  check('motion: full motion restores', root.dataset.motion === 'on' && st().settings.reduceMotion === false, `motion=${root.dataset.motion}`)
}

// --- 3. Settings UI -----------------------------------------------------------
const root = ui.createRoot(document.getElementById('root'))
const html = () => document.getElementById('root').innerHTML
const findBtn = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t)
const click = async (t) => {
  const el = findBtn(t)
  if (!el) throw new Error(`no button "${t}" — visible: ${[...document.querySelectorAll('button')].map((b) => b.textContent.trim().slice(0, 30)).join(' | ')}`)
  await ui.act(async () => {
    el.click()
  })
}
{
  await ui.act(async () => {
    ui.useApp.setState({ settingsOpen: true })
    root.render(ui.createElement(ui.SettingsModal))
  })

  const SECTIONS = ['profile', 'appearance', 'models & providers', 'behavior', 'storage', 'learning & memory', 'about']
  const labels = [...document.querySelectorAll('.settings-section')].map((n) => n.textContent.trim())
  check('settings ui: all 7 mono sections render', SECTIONS.every((s) => labels.includes(s)), JSON.stringify(labels))

  const swatches = [...document.querySelectorAll('.accent-swatch')]
  check(
    'settings ui: 8 accent swatches, current one marked',
    swatches.length === 8 && swatches.filter((s) => s.classList.contains('active')).length === 1,
    `n=${swatches.length}`
  )
  await ui.act(async () => {
    swatches[1].click() // #7c5cff — index 1
  })
  check(
    'settings ui: clicking a swatch applies + persists the accent',
    st().settings.accent === '#7c5cff' && diskState.accent === '#7c5cff' && document.documentElement.style.getPropertyValue('--accent').trim() === '#7c5cff',
    `accent=${st().settings.accent}`
  )

  await click('reduce motion')
  check(
    'settings ui: reduce-motion switch flips state + attribute',
    st().settings.reduceMotion === true && document.documentElement.dataset.motion === 'off',
    `motion=${document.documentElement.dataset.motion}`
  )

  await click('auto')
  check('settings ui: reply-mode row persists mode', st().settings.mode === 'auto' && diskState.mode === 'auto', `mode=${st().settings.mode}`)
  await click('deep')
  check('settings ui: effort row persists effort', st().settings.effort === 'deep' && diskState.effort === 'deep', `effort=${st().settings.effort}`)

  check('settings ui: about chip shows build version', html().includes('CODEZY v0.0.0-test'), '')

  // title bar version chip
  await ui.act(async () => {
    root.render(ui.createElement(ui.TitleBar, { title: 'A chat' }))
  })
  check('titlebar ui: version chip rendered', html().includes('v0.0.0-test'), html().slice(0, 140))
}

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

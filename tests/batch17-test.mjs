// Batch 17 — v2.3.0: "switching chats says thinking, I can't stop" + the
// startup logo + the autosetup welcome:
//  1. per-session streaming: a background chat's reply still lands in ITS own
//     session, its deltas never leak into the visible chat, and switching
//     chats swaps the composer's thinking/stop state correctly.
//  2. stop: aborts the session that's actually generating, and a dead stream
//     (Ollama crashed mid-reply) can never fake a thinking composer forever.
//  3. error events refresh the engine status dot (and re-arm the watcher).
//  4. BootSplash: logo renders while init runs, flies away once ready.
//  5. Setup welcome: live engine pill + one-click "Start with local Ollama".
//  6. static: seg-fab popover (no row expansion), boot CSS, main spawns
//     `ollama serve` windowless on launch.
// Scratch lives under tests/.tmp and USERPROFILE is faked into it.
import fs from 'node:fs'
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

const OUT = path.join(PROJ, 'tests', '.tmp', `b17-${Date.now()}`)
const FAKE_HOME = path.join(OUT, 'fake-home')
fs.mkdirSync(FAKE_HOME, { recursive: true })
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME
process.on('exit', () => {
  try {
    fs.rmSync(OUT, { recursive: true, force: true })
  } catch {}
})

// --- 1. static: css + main-process ollama auto-start --------------------------
{
  const css = fs.readFileSync(path.join(PROJ, 'src/renderer/src/styles/global.css'), 'utf8')
  check('css: effort/mode pills no longer expand in-flow', !/max-width:\s*320px/.test(css))
  check('css: the segmented control is a floating popover', /\.seg-fab \.segmented\s*\{[^}]*position:\s*absolute/.test(css))
  check('css: right badge anchors inward', /\.seg-fab-right \.segmented\s*\{[^}]*right:\s*0/.test(css))
  check('css: boot splash exists', /\.boot \{/.test(css) && /@keyframes bootIn/.test(css) && /\.boot-mark \{/.test(css))

  const main = fs.readFileSync(path.join(PROJ, 'src/main/index.ts'), 'utf8')
  check('main: launch starts Ollama when it is down', /ensureOllama\(\)/.test(main))
  check('main: spawn is detached + windowless', /spawn\('ollama', \['serve'\], \{ detached: true, stdio: 'ignore', windowsHide: true \}\)/.test(main))
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
defineGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
defineGlobal('localStorage', dom.window.localStorage)
defineGlobal(
  'requestAnimationFrame',
  typeof dom.window.requestAnimationFrame === 'function'
    ? dom.window.requestAnimationFrame.bind(dom.window)
    : (cb) => setTimeout(cb, 0)
)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let diskState = {
  theme: 'dark',
  accent: '#3d9bff',
  dataDir: 'tests/.tmp/batch17',
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
  reduceMotion: false,
  autoContinue: true
}
let eventHandler = null
let healthStatus = 'online'
const chatSends = []
const aborts = []
const mock = {
  settings: {
    get: async () => ({ ...diskState }),
    set: async (patch) => {
      diskState = { ...diskState, ...patch }
      return { ...diskState }
    }
  },
  projects: { list: async () => [] },
  sessions: {
    list: async () => [sessionA(), sessionB()],
    create: async () => ({ id: 'new', title: 'New chat', messages: [], createdAt: 1, updatedAt: 1 }),
    save: async (s) => s,
    delete: async () => {}
  },
  chat: {
    onEvent: (cb) => {
      eventHandler = cb
    },
    send: async (id) => {
      chatSends.push(id)
    },
    abort: async (id) => {
      aborts.push(id)
    }
  },
  health: { ollama: async () => healthStatus, drive: async () => 'ok' },
  models: { list: async () => [] },
  memory: { read: async () => '', write: async () => true },
  skills: { list: async () => [] },
  edits: { apply: async (_id, edits) => ({ applied: edits.map((e) => ({ path: e.path })), errors: [] }) },
  dialog: { pickFolder: async () => null, pickFiles: async () => [] },
  images: { dataUrl: async () => 'data:image/gif;base64,' },
  files: { list: async () => [], read: async () => null },
  ide: { tree: async () => [], read: async () => '', write: async () => {}, create: async (_id, p) => p },
  win: { minimize: () => {}, maximize: () => {}, close: () => {} }
}
const sessionA = () => ({ id: 's1', title: 'one', messages: [], createdAt: 1, updatedAt: 1, linkedFolders: [] })
const sessionB = () => ({ id: 's2', title: 'two', messages: [], createdAt: 1, updatedAt: 1, linkedFolders: [] })
dom.window.codezy = mock

// --- one bundle: store + components + react -----------------------------------
const entry = path.join(OUT, 'entry.tsx')
fs.writeFileSync(
  entry,
  [
    `export { default as BootSplash } from '${PROJ}/src/renderer/src/components/BootSplash'`,
    `export { default as SetupScreen } from '${PROJ}/src/renderer/src/components/SetupScreen'`,
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

await st().init()
check('init: two chats, first one active', st().activeId === 's1' && st().sessions.length === 2, `active=${st().activeId}`)

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

// --- 2. per-session streaming -------------------------------------------------
{
  await st().send('hello from s1')
  check(
    'stream: sending marks THIS session as streaming',
    st().streaming === true && st().streamingIds.includes('s1') && chatSends.length === 1,
    JSON.stringify(st().streamingIds)
  )

  st().setActive('s2')
  check('stream: switching chats shows a normal composer there', st().streaming === false, `streaming=${st().streaming}`)

  eventHandler({ sessionId: 's1', type: 'delta', text: 'secret background text' })
  check('stream: background deltas never leak into the visible chat', st().streamText === '', JSON.stringify(st().streamText))

  eventHandler({
    sessionId: 's1',
    type: 'done',
    message: { id: 'r1', role: 'assistant', content: 'reply for s1', ts: 2 }
  })
  await flush()
  const s1 = st().sessions.find((x) => x.id === 's1')
  check('stream: a background reply still lands in its own chat', !!s1?.messages.some((m) => m.id === 'r1'), JSON.stringify(s1?.messages.map((m) => m.id)))
  check(
    'stream: the turn is fully released everywhere',
    st().streamingIds.length === 0 && st().streaming === false,
    JSON.stringify(st().streamingIds)
  )
  const s2 = st().sessions.find((x) => x.id === 's2')
  check('stream: the other chat is untouched', !s2?.messages.some((m) => m.id === 'r1'))
}

// --- 3. aborted for a background session never steals visible text ------------
{
  st().setActive('s2')
  ui.useApp.setState({ streamingIds: ['s1'], streamText: 'text of the visible chat' })
  eventHandler({ sessionId: 's1', type: 'aborted' })
  await flush()
  const s1 = st().sessions.find((x) => x.id === 's1')
  check('aborted: no partial from another chat is saved', !s1?.messages.some((m) => /\(stopped\)/.test(m.content)), JSON.stringify(s1?.messages))
  check('aborted: visible chat keeps its own state', st().streamText === 'text of the visible chat' && st().streamingIds.length === 0, JSON.stringify(st().streamingIds))
}

// --- 4. stop: correct target + no phantom thinking ----------------------------
{
  st().setActive('s1')
  ui.useApp.setState({ streamingIds: ['s1'], streaming: true, streamText: 'partial…' })
  await st().stop()
  check('stop: aborts the session that is generating', aborts.includes('s1'), JSON.stringify(aborts))
  check(
    'stop: a dead stream is force-cleared — no eternal "thinking"',
    st().streamingIds.length === 0 && st().streaming === false && st().streamText === '',
    JSON.stringify({ ids: st().streamingIds, streaming: st().streaming, text: st().streamText })
  )

  const before = aborts.length
  st().setActive('s2')
  ui.useApp.setState({ streamingIds: ['s1'], streaming: false })
  await st().stop()
  check('stop: from a quiet chat it aborts nothing', aborts.length === before, `aborts=${aborts.length}`)
  ui.useApp.setState({ streamingIds: [] })
}

// --- 5. error events refresh the engine status --------------------------------
{
  healthStatus = 'offline'
  eventHandler({ sessionId: 's2', type: 'error', message: 'connection refused' })
  await flush()
  check('error: the status dot re-checks reality', st().ollama === 'offline', `ollama=${st().ollama}`)
  check('error: the failure is surfaced as a notice', st().notices.some((n) => /connection refused/.test(n.text)), JSON.stringify(st().notices))
}

// --- 6. BootSplash: pops in, then flies away ----------------------------------
const root = ui.createRoot(document.getElementById('root'))
{
  await ui.act(async () => {
    root.render(ui.createElement(ui.BootSplash, { ready: false }))
  })
  const mark = document.querySelector('.boot-mark')
  check('boot: logo renders while init runs', !!mark && /CODEZY/.test(mark.textContent ?? ''), mark?.textContent ?? 'missing')

  await ui.act(async () => {
    root.render(ui.createElement(ui.BootSplash, { ready: true }))
  })
  check('boot: splash stays for the fly animation', !!document.querySelector('.boot.flying'))
  await ui.act(async () => {
    await new Promise((r) => setTimeout(r, 850))
  })
  check('boot: splash removes itself after landing', !document.querySelector('.boot'))
}

// --- 7. setup welcome: live engine pill + one-click autosetup -----------------
{
  await ui.act(async () => {
    ui.useApp.setState({
      settings: { ...diskState, setupDone: false },
      ollama: 'online',
      settingsOpen: false
    })
    root.render(ui.createElement(ui.SetupScreen))
  })
  const html = () => document.getElementById('root').innerHTML
  check('setup: welcome shows the live engine pill', html().includes('Ollama ready — local engine detected'))
  const findBtn = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t)
  check('setup: one-click local start offered when the engine is up', !!findBtn('Start with local Ollama'))
  check('setup: classic path still available', !!findBtn('Continue') && !!findBtn('skip setup'))
  await ui.act(async () => {
    findBtn('Start with local Ollama')?.click()
  })
  check('setup: autosetup lands on the ready step', !!findBtn('Open CODEZY'), html().includes('set') ? '' : 'no ready step')
  check('setup: local engine selected', st().settings.activeProvider === 'ollama', st().settings.activeProvider)
  await ui.act(async () => {
    findBtn('Open CODEZY')?.click()
  })
  check('setup: finishing persists setupDone', st().settings.setupDone === true, String(st().settings.setupDone))
}

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

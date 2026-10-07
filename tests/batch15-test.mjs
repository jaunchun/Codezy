// Batch 15 — the two v2.3.0 features the release added:
//  1. main store: autoContinue defaults to true.
//  2. auto-continue: a reply that stops inside an unclosed ``` fence gets a
//     hidden "Continue exactly…" nudge — capped at 3 per human turn, the
//     counter resets on every real user message, and the setting turns it off.
//  3. model cursor events: v2tool write_file and applied chat edits publish
//     aiWrite so the cowork editor knows where the model is working.
//  4. cowork UI (jsdom): open a file, fire aiWrite → live reload + blinking
//     overlay cursor + tree dot + "model writing" chip; a dirty buffer is
//     never clobbered by the reload.
//  5. Settings UI: the auto-continue row flips the persisted setting.
// Scratch lives under tests/.tmp and USERPROFILE is faked into it, so the
// run never leaves the project.
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

const OUT = path.join(PROJ, 'tests', '.tmp', `b15-${Date.now()}`)
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
  check('store: autoContinue defaults to true', fresh.autoContinue === true, `autoContinue=${fresh.autoContinue}`)
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
  dataDir: 'tests/.tmp/batch15',
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
const chatSends = []
let readContent = 'const a = 1'
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
    list: async () => [sessionRef()],
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
    abort: async () => {}
  },
  health: { ollama: async () => 'online', drive: async () => 'ok' },
  models: { list: async () => [] },
  memory: { read: async () => '', write: async () => true },
  skills: { list: async () => [] },
  edits: {
    apply: async (_id, edits) => ({ applied: edits.map((e) => ({ path: e.path })), errors: [] })
  },
  dialog: { pickFolder: async () => null },
  images: { dataUrl: async () => 'data:image/gif;base64,' },
  ide: {
    tree: async () => [
      {
        path: '/W',
        name: 'W',
        dir: true,
        children: [{ path: '/W/src.ts', name: 'src.ts' }]
      }
    ],
    read: async () => readContent,
    write: async () => {},
    create: async (id, p) => p
  },
  win: { minimize: () => {}, maximize: () => {}, close: () => {} }
}
const EDIT_MSG =
  'Fixed:\n\n===FILE: src/a.ts\n===SEARCH\nfoo\n===REPLACE\nbar\n===END\n'
const baseSession = () => ({
  id: 's1',
  title: 'T',
  messages: [{ id: 'm-edit', role: 'assistant', content: EDIT_MSG, ts: 1 }],
  createdAt: 1,
  updatedAt: 1,
  linkedFolders: ['/W']
})
let sessionRef = baseSession
dom.window.codezy = mock

// --- one bundle: store + components + react -----------------------------------
const entry = path.join(OUT, 'entry.tsx')
fs.writeFileSync(
  entry,
  [
    `export { default as SettingsModal } from '${PROJ}/src/renderer/src/components/SettingsModal'`,
    `export { default as IdePane } from '${PROJ}/src/renderer/src/components/IdePane'`,
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
check('bridge: init captured the chat event handler', typeof eventHandler === 'function')
check('init: active session is the mocked one', st().activeId === 's1', `activeId=${st().activeId}`)

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}
const session = () => st().sessions.find((x) => x.id === 's1')
const hiddenCount = () => session().messages.filter((m) => m.hidden).length
const fireDone = async (id, content) => {
  eventHandler({ sessionId: 's1', type: 'done', message: { id, role: 'assistant', content, ts: Date.now() } })
  await flush()
}

// --- 2. auto-continue ---------------------------------------------------------
{
  await fireDone('d1', '```ts\nlet x =') // cut mid-code
  check('auto-continue: odd fence → nudged once', st().autoContinuations === 1, `n=${st().autoContinuations}`)
  const last = session().messages[session().messages.length - 1]
  check(
    'auto-continue: the nudge is a hidden user message',
    last.role === 'user' && last.hidden === true && /^Continue exactly where you stopped/.test(last.content),
    JSON.stringify({ role: last.role, hidden: !!last.hidden, head: last.content.slice(0, 24) })
  )
  check('auto-continue: the model was re-asked', chatSends.length === 1, `sends=${chatSends.length}`)

  await fireDone('d2', '```ts\nlet y = 1\n```') // balanced → nothing to fix
  check('auto-continue: balanced fences are left alone', st().autoContinuations === 1, `n=${st().autoContinuations}`)
  check('auto-continue: balanced reply added no hidden message', hiddenCount() === 1, `hidden=${hiddenCount()}`)

  for (let i = 0; i < 5; i++) await fireDone(`d3-${i}`, 'still\n```py\nx')
  check('auto-continue: hard cap at 3 per turn', st().autoContinuations === 3, `n=${st().autoContinuations}`)
  check('auto-continue: cap means exactly 3 nudges', hiddenCount() === 3, `hidden=${hiddenCount()}`)

  await st().send('hello human', [], false)
  check('auto-continue: a human message resets the budget', st().autoContinuations === 0, `n=${st().autoContinuations}`)

  await st().updateSettings({ autoContinue: false })
  await fireDone('d4', '```js\nnope')
  check(
    'auto-continue: setting off → never nudges',
    st().autoContinuations === 0 && hiddenCount() === 3 && diskState.autoContinue === false,
    `n=${st().autoContinuations} hidden=${hiddenCount()}`
  )
}

// --- 3. model-cursor events ---------------------------------------------------
{
  eventHandler({ sessionId: 's1', type: 'v2tool', name: 'write_file', args: { path: '/W/src/deep.ts' }, outcome: 'ok', iteration: 1 })
  check('aiWrite: agent write_file publishes the path', st().aiWrite?.path === '/W/src/deep.ts', JSON.stringify(st().aiWrite))
  ui.useApp.setState({ aiWrite: null })
  eventHandler({ sessionId: 's1', type: 'v2tool', name: 'read_file', args: { path: '/W/other.ts' }, outcome: 'ok', iteration: 2 })
  check('aiWrite: reads are not writes', st().aiWrite === null, JSON.stringify(st().aiWrite))

  await st().acceptEdits('m-edit')
  check('aiWrite: applied chat edits publish too', st().aiWrite?.path === 'src/a.ts', JSON.stringify(st().aiWrite))
}

// --- 5. Settings UI: auto-continue row ---------------------------------------
const root = ui.createRoot(document.getElementById('root'))
const html = () => document.getElementById('root').innerHTML
const findBtn = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t)
const clickBtn = async (el, what) => {
  if (!el) throw new Error(`no button ${what}`)
  await ui.act(async () => {
    el.click()
  })
}
{
  await ui.act(async () => {
    ui.useApp.setState({ settingsOpen: true })
    root.render(ui.createElement(ui.SettingsModal))
  })
  const fields = [...document.querySelectorAll('.field')]
  const acField = fields.find((f) => f.textContent.includes('Auto-continue'))
  check('settings ui: auto-continue row rendered', !!acField, '')
  const on = [...(acField?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'on')
  await clickBtn(on, 'on')
  check('settings ui: toggling on persists', st().settings.autoContinue === true && diskState.autoContinue === true, `v=${diskState.autoContinue}`)
  const off = [...(acField?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'off')
  await clickBtn(off, 'off')
  check('settings ui: toggling off persists', st().settings.autoContinue === false && diskState.autoContinue === false, `v=${diskState.autoContinue}`)
}

// --- 4. cowork UI: the model's cursor -----------------------------------------
{
  await ui.act(async () => {
    ui.useApp.setState({ ideOpen: true, aiWrite: null, autoContinuations: 0 })
    root.render(ui.createElement(ui.IdePane))
  })
  const fileBtn = document.querySelector('.ide-file')
  check('ide ui: linked tree renders the file', !!fileBtn && fileBtn.title === '/W/src.ts', fileBtn?.title)
  await clickBtn(fileBtn, 'src.ts')
  const ta = document.querySelector('.ide-ta-wrap textarea')
  check('ide ui: opening loads the file into the textarea', !!ta && ta.value === 'const a = 1', JSON.stringify(ta?.value))

  readContent = 'const a = 1\nconst b = 2' // the agent rewrote the file on disk
  await ui.act(async () => {
    ui.useApp.setState({ aiWrite: { path: '/W/src.ts' } })
    await new Promise((r) => setTimeout(r, 0))
  })
  const ta2 = document.querySelector('.ide-ta-wrap textarea')
  check('ide ui: agent write live-reloads the open file', ta2?.value === 'const a = 1\nconst b = 2', JSON.stringify(ta2?.value))
  check(
    'ide ui: blinking overlay cursor parks at the end',
    !!document.querySelector('.ide-ai-cursor') &&
      Number.isFinite(parseFloat(document.querySelector('.ide-ai-cursor').style.left)) &&
      Number.isFinite(parseFloat(document.querySelector('.ide-ai-cursor').style.top)),
    document.querySelector('.ide-ai-cursor')?.getAttribute('style') ?? 'missing'
  )
  check('ide ui: path bar shows the writing chip', !!document.querySelector('.ide-path .ide-ai-chip'), '')
  check('ide ui: tree node gets the blinking dot', !!document.querySelector('.ide-file .ide-ai-dot'), '')

  // your unsaved typing must never be clobbered by a background reload
  const proto = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')
  proto.set.call(ta2, 'const a = 1 // mine')
  await ui.act(async () => {
    ta2.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await ui.act(async () => {
    ui.useApp.setState({ aiWrite: { path: '/W/src.ts' } })
    await new Promise((r) => setTimeout(r, 0))
  })
  const ta3 = document.querySelector('.ide-ta-wrap textarea')
  check(
    'ide ui: dirty buffer survives the agent write',
    ta3?.value === 'const a = 1 // mine' && ta3.value !== readContent,
    JSON.stringify(ta3?.value)
  )
}

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

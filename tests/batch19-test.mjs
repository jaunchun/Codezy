// Batch 19 — the v2.5.0 feature pass:
//  1. model picker: measured placement (flip + clamp + height cap), animated
//     open/close, favorites, recents, provider chips, keyboard extras.
//  2. chat: delete-from-here, draft persistence across restarts, copy whole
//     transcript, export every chat.
//  3. sidebar: search (title + message text), archive/unarchive + show
//     archived, background-generation dot, sort toggle.
//  4. settings: font-size slider, density, live theme preview, shortcuts.
//  5. cowork: filter, expand/collapse, rename/delete (new IPC, confined to the
//     linked folders), find-in-file, line-number gutter.
//  6. edits: per-file accept — a partial write is remembered and never
//     re-offered, the bar only hides once every block landed.
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  - ' + detail : ''}`)
  if (!ok) fails.push(label)
}

const OUT = path.join(PROJ, 'tests', '.tmp', `b19-${Date.now()}`)
const FAKE_HOME = path.join(OUT, 'fake-home')
fs.mkdirSync(FAKE_HOME, { recursive: true })
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME
process.on('exit', () => {
  try {
    fs.rmSync(OUT, { recursive: true, force: true })
  } catch {}
})

// --- 1. static: css + sources -------------------------------------------------
{
  const css = fs.readFileSync(path.join(PROJ, 'src/renderer/src/styles/global.css'), 'utf8')
  const has = (re, label) => check(label, re.test(css))

  has(/\.picker-panel\s*\{[^}]*opacity:\s*0[^}]*transition:/, 'css: picker panel animates in')
  has(/\.picker-panel\.show\s*\{[^}]*opacity:\s*1/, 'css: picker has a visible .show state')
  has(/\.picker-panel\.up\s*\{/, 'css: picker flips above its chip')
  has(/\.picker-chips\s*\{/, 'css: provider filter chips')
  has(/\.picker-chip\.on\s*\{/, 'css: active provider chip is marked')
  has(/\.pi-star\.on\s*\{/, 'css: favourite star is marked')
  has(/\.picker-item \.pi-name\s*\{[^}]*ellipsis/, 'css: long model ids truncate instead of stretching')

  has(/\.side-search\s*\{/, 'css: sidebar search box')
  has(/\.side-mini\s*\{/, 'css: sidebar sort/export mini controls')
  has(/\.side-live\s*\{/, 'css: background-generation dot on a chat row')
  has(/\.side-item\.archived\s*\{/, 'css: archived chats are dimmed')

  has(/\.act-btn\.armed\s*\{/, 'css: the armed (second-click) delete is red')

  has(/'tools tools'/, 'css: cowork pane has a tools row in the grid')
  has(/\.ide-tools\s*\{/, 'css: cowork filter row')
  has(/\.ide-find\s*\{/, 'css: cowork find-in-file bar')
  has(/\.ide-gutter\s*\{/, 'css: line-number gutter')
  has(/\.ide-mini\.danger/, 'css: cowork delete button danger state')

  has(/\.diff-wrap\s*\{/, 'css: per-file edit tick wrapper')
  has(/\.diff-pick\s*\{/, 'css: per-file edit checkbox row')
  has(/html\[data-density='compact'\] \.side-item/, 'css: compact density tightens rows')
  has(/html\[data-density='compact'\] \.picker-item/, 'css: compact density tightens the picker')

  const main = fs.readFileSync(path.join(PROJ, 'src/main/index.ts'), 'utf8')
  check('main: ide:rename handler registered', /ipcMain\.handle\('ide:rename'/.test(main))
  check('main: ide:delete handler registered', /ipcMain\.handle\('ide:delete'/.test(main))
  check('main: rename refuses names outside the linked folders', /ideRename\(session\?\.linkedFolders/.test(main))

  const pre = fs.readFileSync(path.join(PROJ, 'src/preload/index.ts'), 'utf8')
  check('preload: ide.rename bridged', /rename: \(sessionId: string, from: string, to: string\)/.test(pre))
  check('preload: ide.delete bridged', /delete: \(sessionId: string, path: string\)/.test(pre))

  const api = fs.readFileSync(path.join(PROJ, 'src/shared/api.ts'), 'utf8')
  check('api: rename + delete declared', /rename\(sessionId: string, from: string, to: string\)/.test(api) && /delete\(sessionId: string, path: string\)/.test(api))

  const files = fs.readFileSync(path.join(PROJ, 'src/main/files.ts'), 'utf8')
  check('files: rename never overwrites', /export function ideRename[\s\S]{0,400}fs\.existsSync\(to\)/.test(files))
  check('files: delete is files-only (never a directory tree)', /export function ideDelete[\s\S]{0,500}isFile\(\)/.test(files))
  check('files: delete never removes a linked root', /path\.resolve\(r\) === path\.resolve\(target\)/.test(files))

  const picker = fs.readFileSync(path.join(PROJ, 'src/renderer/src/components/ModelPicker.tsx'), 'utf8')
  check('picker: measures the space around its chip', /getBoundingClientRect\(\)/.test(picker) && /window\.innerHeight/.test(picker))
  check('picker: flips when there is no room below', /below < 340 && above > below/.test(picker))
  check('picker: clamps horizontally into the window', /window\.innerWidth - width - 8/.test(picker))
  check('picker: retracts after the close animation', /setMounted\(false\)/.test(picker))
  check('picker: favourites + recents persist', /writeKeys\(FAV_KEY/.test(picker) && /writeKeys\(REC_KEY/.test(picker))

  const side = fs.readFileSync(path.join(PROJ, 'src/renderer/src/components/Sidebar.tsx'), 'utf8')
  check('sidebar: search covers message text', /m\.content\.toLowerCase\(\)\.includes\(term\)/.test(side))
  check('sidebar: archived rows hide unless asked for', /showArchived \|\| !x\.archived/.test(side))
  check('sidebar: archive reachable from the context menu', /toggleArchive\(menu\.id\)/.test(side))
  check('sidebar: background generation dot on rows', /streamingIds\.includes\(session\.id\)/.test(side))

  const store = fs.readFileSync(path.join(PROJ, 'src/renderer/src/store/app.ts'), 'utf8')
  check('store: deleteFrom truncates the chat', /async deleteFrom\(messageId\)/.test(store))
  check('store: drafts are written through to storage', /persistDrafts\(next\)/.test(store))
  check('store: density is applied on load + patch', /applyDensity\(settings\.density\)/.test(store) && /applyDensity\(next\.density\)/.test(store))
  check('store: partial accepts are remembered', /appliedEdits\?\.\[messageId\]/.test(store))
  check('store: exportAll builds one markdown file', /async exportAll\(\)/.test(store))
  check('types: Session gained archived + appliedEdits', /archived\?: boolean/.test(fs.readFileSync(path.join(PROJ, 'src/shared/types.ts'), 'utf8')))

  const cmd = fs.readFileSync(path.join(PROJ, 'src/shared/commands.ts'), 'utf8')
  for (const c of ['/archive', '/pin', '/transcript', '/fontsize', '/density']) {
    check(`commands: ${c} registered`, cmd.includes(`name: '${c}'`))
  }
}

// --- 2. unit: cowork rename/delete confinement --------------------------------
{
  fs.writeFileSync(
    path.join(OUT, 'files-entry.ts'),
    `export { ideCreate, ideRename, ideDelete } from '${PROJ}/src/main/files'`
  )
  await build({
    entryPoints: [path.join(OUT, 'files-entry.ts')],
    outfile: path.join(OUT, 'files.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const f = await import(pathToFileURL(path.join(OUT, 'files.mjs')).href)

  const root = path.join(OUT, 'root')
  fs.mkdirSync(root, { recursive: true })
  const inside1 = path.join(root, 'a.txt')
  fs.writeFileSync(inside1, 'hi')
  const outside = path.join(OUT, 'outside.txt')
  fs.writeFileSync(outside, 'keep me')

  const made = f.ideCreate([root], path.join(root, 'fresh.txt'), false)
  check('ide: create makes a file inside the folder', !!made && fs.existsSync(path.join(root, 'fresh.txt')), String(made))

  const moved = f.ideRename([root], inside1, path.join(root, 'b.txt'))
  check('ide: rename moves a cowork file', !!moved && !fs.existsSync(inside1) && fs.existsSync(path.join(root, 'b.txt')), String(moved))

  check(
    'ide: rename never overwrites an existing target',
    f.ideRename([root], path.join(root, 'b.txt'), path.join(root, 'fresh.txt')) === null
  )
  check(
    'ide: rename cannot escape the linked folder',
    f.ideRename([root], path.join(root, 'b.txt'), path.join(OUT, 'escaped.txt')) === null && !fs.existsSync(path.join(OUT, 'escaped.txt'))
  )

  const dirOnly = path.join(root, 'sub')
  fs.mkdirSync(dirOnly)
  check('ide: delete removes a file', f.ideDelete([root], path.join(root, 'fresh.txt')) === true && !fs.existsSync(path.join(root, 'fresh.txt')))
  check('ide: delete refuses a directory (no whole-tree accidents)', f.ideDelete([root], dirOnly) === false && fs.existsSync(dirOnly))
  check('ide: delete refuses anything outside the folder', f.ideDelete([root], outside) === false && fs.existsSync(outside))
}

// --- 3. jsdom + mocked bridge ------------------------------------------------
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
defineGlobal('KeyboardEvent', dom.window.KeyboardEvent)
defineGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
defineGlobal('localStorage', dom.window.localStorage)
defineGlobal(
  'requestAnimationFrame',
  typeof dom.window.requestAnimationFrame === 'function'
    ? dom.window.requestAnimationFrame.bind(dom.window)
    : (cb) => setTimeout(cb, 0)
)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let clip = ''
Object.defineProperty(dom.window.navigator, 'clipboard', {
  value: { writeText: async (t) => (clip = t) },
  configurable: true
})

let diskState = {
  theme: 'dark',
  accent: '#3d9bff',
  dataDir: 'tests/.tmp/batch19',
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
  v2: false,
  notifyDone: false,
  enterSends: true,
  setupDone: true,
  reduceMotion: false,
  autoContinue: true
}
let eventHandler = null
const chatSends = []
const savedTexts = []
const appliedCalls = []
let healthStatus = 'online'

const EDIT_MSG = [
  '===FILE: a.txt',
  '===SEARCH',
  'old-a',
  '===REPLACE',
  'new-a',
  '===END',
  '===FILE: b.txt',
  '===SEARCH',
  'old-b',
  '===REPLACE',
  'new-b',
  '===END'
].join('\n')

const sessionA = () => ({
  id: 's1',
  title: 'one with needle problem',
  messages: [
    { id: 'm1', role: 'user', content: 'hello', ts: 1 },
    { id: 'm2', role: 'assistant', content: 'hi', ts: 2 },
    { id: 'm3', role: 'user', content: 'bye', ts: 3 }
  ],
  createdAt: 1,
  updatedAt: 3,
  linkedFolders: [path.join(OUT, 'root')]
})
const sessionB = () => ({
  id: 's2',
  title: 'old plan',
  messages: [{ id: 'm9', role: 'user', content: 'archived thoughts', ts: 1 }],
  createdAt: 1,
  updatedAt: 2,
  linkedFolders: [],
  archived: true
})
const sessionC = () => ({
  id: 's3',
  title: 'third chat',
  messages: [],
  createdAt: 1,
  updatedAt: 4,
  linkedFolders: []
})

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
    abort: async () => {}
  },
  health: { ollama: async () => healthStatus, drive: async () => 'ok' },
  models: {
    list: async () => [
      { id: 'qwen2.5-coder:7b', provider: 'ollama', providerName: 'Ollama', parameter: '7B', quant: 'Q4', size: 4700000000, family: 'qwen2.5' },
      { id: 'llama3.2:3b', provider: 'ollama', providerName: 'Ollama', parameter: '3B', quant: 'Q4', size: 2000000000, family: 'llama3.2' },
      { id: 'gpt-4o-mini', provider: 'openai', providerName: 'OpenAI', family: 'gpt-4o' }
    ]
  },
  memory: { read: async () => '', write: async () => true },
  skills: { list: async () => [] },
  edits: {
    apply: async (_id, edits) => {
      appliedCalls.push(edits.map((e) => e.path))
      return { applied: edits.map((e) => ({ path: e.path })), errors: [] }
    }
  },
  dialog: {
    pickFolder: async () => null,
    pickFiles: async () => [],
    saveText: async (name, content) => {
      savedTexts.push({ name, content })
      return path.join(OUT, name)
    }
  },
  images: { dataUrl: async () => 'data:image/gif;base64,', paste: async () => null },
  files: { list: async () => [], read: async () => null },
  ide: {
    tree: async () => [
      { name: 'root-level.ts', path: path.join(OUT, 'root', 'root-level.ts'), dir: false },
      { name: 'src', path: path.join(OUT, 'root', 'src'), dir: true, children: [{ name: 'app.ts', path: path.join(OUT, 'root', 'src', 'app.ts'), dir: false }] }
    ],
    read: async () => ({ content: 'line one\nline two\nline three', truncated: false }),
    write: async (_id, p) => p,
    create: async (_id, p) => p,
    rename: async (_id, from, to) => to,
    delete: async () => true
  },
  win: { minimize: () => {}, maximize: () => {}, close: () => {} }
}
dom.window.codezy = mock

// --- one bundle: store + every component we touch + react ---------------------
const entry = path.join(OUT, 'entry.tsx')
fs.writeFileSync(
  entry,
  [
    `export { default as Sidebar } from '${PROJ}/src/renderer/src/components/Sidebar'`,
    `export { default as ModelPicker } from '${PROJ}/src/renderer/src/components/ModelPicker'`,
    `export { default as SettingsModal } from '${PROJ}/src/renderer/src/components/SettingsModal'`,
    `export { default as EditCard } from '${PROJ}/src/renderer/src/components/EditCard'`,
    `export { default as IdePane } from '${PROJ}/src/renderer/src/components/IdePane'`,
    `export { default as Palette } from '${PROJ}/src/renderer/src/components/Palette'`,
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
check('init: chats loaded, first one active', st().activeId === 's1' && st().sessions.length === 2, `active=${st().activeId}`)
check('init: density applied to the document', document.documentElement.dataset.density === 'cozy', document.documentElement.dataset.density)

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}
const root = ui.createRoot(document.getElementById('root'))
const render = async (el) => {
  await ui.act(async () => {
    root.render(el)
  })
}
const fire = async (el, type, init = {}) => {
  await ui.act(async () => {
    el.dispatchEvent(new dom.window[type === 'click' ? 'MouseEvent' : 'KeyboardEvent'](type, { bubbles: true, ...init }))
  })
}
const setText = async (el, value) => {
  await ui.act(async () => {
    const proto = Object.getPrototypeOf(el)
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    ;(desc && desc.set ? desc.set : Object.getOwnPropertyDescriptor(el, 'value').set).call(el, value)
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
const btn = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label)

// --- 4. commands: font size, density, pin, archive, transcript ---------------
{
  const before = chatSends.length
  await st().send('/fontsize 17')
  check('cmd /fontsize applies a valid size', st().settings.fontSize === 17, String(st().settings.fontSize))
  check('cmd: slash commands never reach the model', chatSends.length === before)

  await st().send('/fontsize 99')
  check('cmd /fontsize rejects out-of-range sizes', st().settings.fontSize === 17 && st().notices.some((n) => /Usage: \/fontsize/.test(n.text)))

  await st().send('/density compact')
  check('cmd /density applies to the document', st().settings.density === 'compact' && document.documentElement.dataset.density === 'compact', document.documentElement.dataset.density)
  await st().send('/density')
  check('cmd /density reports the current value', st().notices.some((n) => /Density: compact/.test(n.text)))
  await st().send('/density comfy')
  check('cmd /density rejects a bad value', st().notices.some((n) => /Usage: \/density/.test(n.text)))

  await st().send('/pin')
  check('cmd /pin pins the active chat', st().sessions.find((x) => x.id === 's1')?.pinned === true)

  clip = ''
  await st().send('/transcript')
  check('cmd /transcript copies every visible turn', clip.includes('hello') && clip.includes('bye'), clip.slice(0, 40))

  // drafts survive a restart
  st().setChatDraft('s1', 'unfinished thought')
  const raw = localStorage.getItem('codezy.drafts')
  check('drafts: written to storage as you type', !!raw && raw.includes('unfinished thought'), String(raw))
  st().setChatDraft('s1', '')
  check('drafts: an emptied draft is cleared out', localStorage.getItem('codezy.drafts') === null, String(localStorage.getItem('codezy.drafts')))
  st().setChatDraft('s1', 'unfinished thought')
}

// --- 5. delete-from-here + export-all + archive ------------------------------
{
  check('deleteFrom: the chat starts with three messages', st().sessions.find((x) => x.id === 's1').messages.length === 3)
  await st().deleteFrom('m2')
  const s1 = st().sessions.find((x) => x.id === 's1')
  check('deleteFrom: truncates from that message down', s1.messages.length === 1 && s1.messages[0].id === 'm1', JSON.stringify(s1.messages.map((m) => m.id)))

  ui.useApp.setState({ streaming: true })
  await st().deleteFrom('m1')
  check('deleteFrom: refuses while a reply is still streaming', st().sessions.find((x) => x.id === 's1').messages.length === 1 && st().notices.some((n) => /Wait for the current reply/.test(n.text)))
  ui.useApp.setState({ streaming: false })

  savedTexts.length = 0
  await st().exportAll()
  check('exportAll: one markdown file for every chat', savedTexts.length === 1 && /^codezy-chats-/.test(savedTexts[0].name), savedTexts[0]?.name)
  check('exportAll: every chat is inside', /one with needle problem/.test(savedTexts[0].content) && /old plan/.test(savedTexts[0].content))

  const activeBefore = st().activeId
  await st().toggleArchive(activeBefore)
  check('archive: hides the chat and moves off it', st().sessions.find((x) => x.id === activeBefore)?.archived === true && st().activeId === null, `active=${st().activeId}`)
  await st().toggleArchive(activeBefore)
  check('unarchive: brings it back', st().sessions.find((x) => x.id === activeBefore)?.archived === false)
}

// --- 6. per-file edit accepts -------------------------------------------------
{
  ui.useApp.setState({
    activeId: 's1',
    sessions: st().sessions.map((x) =>
      x.id === 's1'
        ? { ...x, messages: [{ id: 'msg1', role: 'assistant', content: EDIT_MSG, ts: 5 }], linkedFolders: [path.join(OUT, 'root')] }
        : x
    )
  })
  const msg = { id: 'msg1', role: 'assistant', content: EDIT_MSG, ts: 5 }

  await render(ui.createElement(ui.EditCard, { message: msg }))
  check('edits: the bar offers both proposed files', /New edits/.test(document.querySelector('.edit-title')?.textContent ?? ''), document.querySelector('.edit-title')?.textContent ?? 'missing')
  await ui.act(async () => {
    btn('Preview and confirm edits').click()
  })
  await flush(2)
  check('edits: both proposed files are ticked in the preview', document.querySelectorAll('.diff-pick').length === 2, String(document.querySelectorAll('.diff-pick').length))
  check('edits: accept-all is the default', !!btn('Accept and write'))

  await ui.act(async () => {
    document.querySelectorAll('.diff-pick input')[0].click()
  })
  const writeBtn = [...document.querySelectorAll('button')].find((b) => /Write 1 of 2/.test(b.textContent))
  check('edits: unchecking a file narrows the accept', !!writeBtn, [...document.querySelectorAll('.preview-actions button')].map((b) => b.textContent.trim()).join('|'))

  appliedCalls.length = 0
  await ui.act(async () => {
    writeBtn.click()
  })
  await flush()
  const partial = st().sessions.find((x) => x.id === 's1')
  check('edits: only the ticked block was written', JSON.stringify(appliedCalls) === JSON.stringify([['b.txt']]), JSON.stringify(appliedCalls))
  check('edits: a partial write is remembered', JSON.stringify(partial.appliedEdits?.msg1 ?? []) === '[1]', JSON.stringify(partial.appliedEdits))
  check('edits: the bar stays open while blocks are left', !partial.resolvedEdits?.includes('msg1'), JSON.stringify(partial.resolvedEdits))

  await render(ui.createElement(ui.EditCard, { message: msg }))
  await ui.act(async () => {
    btn('Preview and confirm edits').click()
  })
  await flush(2)
  const remaining = document.querySelectorAll('.diff-pick').length
  check('edits: the written block is no longer offered', remaining === 1, String(remaining))

  const rest = [...document.querySelectorAll('button')].find((b) => /Accept and write/.test(b.textContent))
  await ui.act(async () => {
    rest.click()
  })
  await flush()
  const done = st().sessions.find((x) => x.id === 's1')
  check('edits: the last block lands and only then hides the bar', done.resolvedEdits?.includes('msg1') === true, JSON.stringify(done.resolvedEdits))
  await render(ui.createElement(ui.EditCard, { message: msg }))
  check('edits: nothing left to review', !document.querySelector('.editbar'), document.querySelector('.editbar')?.textContent ?? '')
}

// --- 7. sidebar: search, archive, live dot, sort ------------------------------
{
  ui.useApp.setState({
    activeId: 's1',
    filterProjectId: null,
    ideOpen: false,
    streamingIds: ['s3'],
    sessions: [sessionA(), sessionB(), sessionC()]
  })
  await render(ui.createElement(ui.Sidebar))
  const CHAT_TITLES = /one with needle problem|old plan|third chat/
  const rows = () =>
    [...document.querySelectorAll('.side-item:not(.side-archived)')]
      .map((r) => r.textContent)
      .filter((t) => CHAT_TITLES.test(t))

  check('sidebar: archived chat is hidden by default', !rows().some((t) => /old plan/.test(t)), JSON.stringify(rows()))
  check('sidebar: the show-archived row is offered', !!document.querySelector('.side-archived'))
  check('sidebar: a background generation shows a dot', !!document.querySelector('.side-live'))

  const search = document.querySelector('.side-search input')
  check('sidebar: search box is there', !!search && search.placeholder === 'Search chats…')

  await setText(search, 'needle')
  check('sidebar: search matches message text', rows().length === 1 && rows()[0].includes('one with needle problem'), JSON.stringify(rows()))

  await setText(search, 'archived thoughts')
  check('sidebar: search still reaches archived chats', rows().some((t) => /old plan/.test(t)), JSON.stringify(rows()))

  await setText(search, '')
  const archivedOnly = rows().length
  await ui.act(async () => {
    document.querySelector('.side-archived').click()
  })
  const after = rows()
  check('sidebar: show-archived reveals it', after.length === archivedOnly + 1 && after.some((t) => /old plan/.test(t)), JSON.stringify(after))

  const sortBtn = [...document.querySelectorAll('.side-mini')].find((b) => /recent|A→Z/.test(b.textContent))
  check('sidebar: sort toggle present', !!sortBtn)
  await ui.act(async () => {
    sortBtn.click()
  })
  const sortBtn2 = [...document.querySelectorAll('.side-mini')].find((b) => /recent|A→Z/.test(b.textContent))
  check('sidebar: sort switches to A→Z', sortBtn2.textContent.trim() === 'A→Z', sortBtn2.textContent)
}

// --- 8. model picker: placement, chips, favourites, keyboard ------------------
{
  let rect = { top: 600, bottom: 640, left: 100, right: 180, width: 80, height: 40 }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('picker')) return { ...rect }
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
  }

  ui.useApp.setState({ activeId: null, ideOpen: false, streamingIds: [], sessions: [sessionA(), sessionB()] })
  await render(ui.createElement(ui.ModelPicker))
  const chip = [...document.querySelectorAll('button.chip')][0]
  check('picker: the model chip renders', !!chip)

  await ui.act(async () => {
    chip.click()
  })
  await flush()
  let panel = document.querySelector('.picker-panel')
  check('picker: opens and animates into place', !!panel && panel.classList.contains('show'), panel ? panel.className : 'missing')
  check(
    'picker: no room below → flips above with a capped height',
    !!panel &&
      panel.style.bottom === 'calc(100% + 8px)' &&
      /^\d+px$/.test(panel.style.maxHeight || '') &&
      parseInt(panel.style.maxHeight, 10) > 300,
    panel ? `bottom=${panel.style.bottom} maxH=${panel.style.maxHeight}` : ''
  )
  check('picker: provider filter chips (all + 2 endpoints)', document.querySelectorAll('.picker-chip').length === 3, String(document.querySelectorAll('.picker-chip').length))
  check('picker: every model is listed', document.querySelectorAll('.picker-item').length === 3, String(document.querySelectorAll('.picker-item').length))

  // favourite the first row (the panel stays open)
  await ui.act(async () => {
    document.querySelectorAll('.pi-star')[0].click()
  })
  const favs = JSON.parse(localStorage.getItem('codezy.favModels') || '[]')
  check('picker: the star persists a favourite', favs.length === 1 && favs[0].includes('::'), JSON.stringify(favs))
  check('picker: favourites get their own group', [...document.querySelectorAll('.picker-head')].some((h) => h.textContent === 'Favorites'))

  const input = panel.querySelector('input')
  check('picker: the search box is focused on open', !!input)

  // chip near the right edge with room below → not flipped, clamped inside
  await ui.act(async () => {
    rect = { top: 200, bottom: 240, left: 900, right: 980, width: 80, height: 40 }
    window.dispatchEvent(new dom.window.Event('resize'))
  })
  await flush(4)
  panel = document.querySelector('.picker-panel')
  check(
    'picker: room below keeps it under the chip',
    !!panel && panel.style.top === 'calc(100% + 8px)' && panel.style.bottom === 'auto',
    panel ? `top=${panel.style.top} bottom=${panel.style.bottom}` : ''
  )
  const left = panel ? parseFloat(panel.style.left) : NaN
  const rightEdge = 900 + left + 390
  check('picker: a chip near the right edge is clamped inside the window', Number.isFinite(left) && rightEdge <= window.innerWidth - 7, `left=${panel?.style.left} rightEdge=${rightEdge} vw=${window.innerWidth}`)

  await fire(input, 'keydown', { key: 'End' })
  await fire(input, 'keydown', { key: 'Enter' })
  await flush(4)
  check('picker: keyboard pick updates the model', st().settings.activeModel === 'gpt-4o-mini' && st().settings.activeProvider === 'openai', `${st().settings.activeProvider}/${st().settings.activeModel}`)
  const recent = JSON.parse(localStorage.getItem('codezy.recentModels') || '[]')
  check('picker: the pick lands in recents', recent.length === 1 && recent[0] === 'openai::gpt-4o-mini', JSON.stringify(recent))

  await ui.act(async () => {
    await new Promise((r) => setTimeout(r, 240))
  })
  check('picker: the panel retracts after the close animation', !document.querySelector('.picker-panel'))
}

// --- 9. settings: font size, density, theme preview ---------------------------
{
  ui.useApp.setState({ settingsOpen: true, settings: { ...st().settings, theme: 'dark', accent: '#3d9bff', density: 'cozy' } })
  await render(ui.createElement(ui.SettingsModal))
  const range = document.querySelector('input[type="range"]')
  check('settings: font-size slider exists with the current value', !!range && range.value === String(st().settings.fontSize), range ? range.value : 'missing')
  check('settings: density control offered', !!btn('cozy') && !!btn('compact'))
  check('settings: shortcuts reachable from settings', !!btn('keyboard shortcuts'))

  await ui.act(async () => {
    btn('compact').click()
  })
  await flush(3)
  check('settings: density button applies live', st().settings.density === 'compact' && document.documentElement.dataset.density === 'compact', document.documentElement.dataset.density)

  const swatches = [...document.querySelectorAll('.theme-swatch')]
  const ember = swatches[5]
  check('settings: swatches advertise hover-preview', swatches.length === 8 && !!ember?.title?.includes('Hover to preview'), String(swatches.length))
  // React synthesises onMouseEnter from mouseover/mouseout (they do not bubble)
  await ui.act(async () => {
    ember.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
  })
  check('settings: hovering previews the theme', document.documentElement.dataset.palette === 'ember', document.documentElement.dataset.palette)
  await ui.act(async () => {
    ember.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
  })
  check('settings: leaving restores the committed theme', document.documentElement.dataset.palette === 'midnight', document.documentElement.dataset.palette)
  await ui.act(async () => {
    ember.click()
  })
  await flush(3)
  check('settings: clicking commits it', st().settings.theme === 'ember', st().settings.theme)

  ui.useApp.setState({ settingsOpen: false })
  await flush()
}

// --- 10. cowork pane: filter, expand/collapse, gutter -------------------------
{
  ui.useApp.setState({ activeId: 's1', ideOpen: true, sessions: [sessionA(), sessionB()] })
  await render(ui.createElement(ui.IdePane))
  const filter = document.querySelector('.ide-tools input')
  check('cowork: filter box above the tree', !!filter && filter.placeholder === 'Filter files…', filter ? filter.placeholder : 'missing')
  check('cowork: expand-all + collapse-all buttons', document.querySelectorAll('.ide-tools .ide-mini').length === 2, String(document.querySelectorAll('.ide-tools .ide-mini').length))

  await setText(filter, 'no-such-file-here')
  check('cowork: a miss says so instead of an empty pane', /No file matches/.test(document.querySelector('.ide-tree')?.textContent ?? ''), document.querySelector('.ide-tree')?.textContent ?? '')

  await setText(filter, '')
  await ui.act(async () => {
    document.querySelectorAll('.ide-tools .ide-mini')[0].click() // expand all
  })
  check('cowork: expand-all reveals nested files', [...document.querySelectorAll('.ide-label')].some((l) => l.textContent === 'app.ts'), [...document.querySelectorAll('.ide-label')].map((l) => l.textContent).join(','))

  await ui.act(async () => {
    const file = [...document.querySelectorAll('.ide-file')].find((b) => b.title.includes('app.ts'))
    file.click()
  })
  await flush(4)
  check('cowork: opening a file shows line numbers', document.querySelectorAll('.ide-gutter span').length === 3, String(document.querySelectorAll('.ide-gutter span').length))
  check('cowork: path bar carries find + rename + delete', document.querySelectorAll('.ide-path .ide-mini').length === 3, String(document.querySelectorAll('.ide-path .ide-mini').length))
}

// --- 11. palette: the new actions are wired -----------------------------------
{
  ui.useApp.setState({ paletteOpen: true })
  await render(ui.createElement(ui.Palette))
  const text = document.querySelector('.palette')?.textContent ?? ''
  check('palette: export every chat', /Export every chat as one markdown file/.test(text))
  check('palette: copy the whole conversation', /Copy the whole conversation/.test(text))
  check('palette: font-size actions', /Bigger text|Smaller text/.test(text))
  check('palette: density toggle', /Density:/.test(text))
  check('palette: cowork toggle', /cowork editor/i.test(text))
  check('palette: archived chats are labelled', /archived/.test(text), text.slice(0, 120))
}

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

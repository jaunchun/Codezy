// Batch 16 — v2.3.0: "the effort bar in code mode" + "i have it picked, it doesn't know"
//  1. composer tools row: in code mode the chat rail is a fixed 420px — the row
//     must wrap and never flex-shrink its children (the collapsed/empty E+M
//     pills), while .grow keeps flex: 1.
//  2. cowork file mirror: IdePane publishes the open file (path + live content,
//     unsaved edits included) into store.ideFile; an image clears it.
//  3. composer: a chip shows the picked cowork file while the pane is open, and
//     submit() attaches it to the outgoing message (message.files → expandMessage
//     in main/prompt.ts feeds it to the model). Closing the pane stops it.
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

const OUT = path.join(PROJ, 'tests', '.tmp', `b16-${Date.now()}`)
const FAKE_HOME = path.join(OUT, 'fake-home')
fs.mkdirSync(FAKE_HOME, { recursive: true })
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME
process.on('exit', () => {
  try {
    fs.rmSync(OUT, { recursive: true, force: true })
  } catch {}
})

// --- 1. css: the tools row survives the narrow code-mode rail ------------------
{
  const css = fs.readFileSync(path.join(PROJ, 'src/renderer/src/styles/global.css'), 'utf8')
  check('css: tools row wraps instead of overflowing', /\.composer-tools\s*\{[^}]*flex-wrap:\s*wrap/.test(css))
  check('css: tool children hold their natural size', /\.composer-tools > \*\s*\{[^}]*flex:\s*none/.test(css))
  check('css: the grow spacer still takes the slack', /\.composer-tools \.grow\s*\{[^}]*flex:\s*1/.test(css))
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
defineGlobal('KeyboardEvent', dom.window.KeyboardEvent)
defineGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
defineGlobal('localStorage', dom.window.localStorage)
defineGlobal(
  'requestAnimationFrame',
  typeof dom.window.requestAnimationFrame === 'function'
    ? dom.window.requestAnimationFrame.bind(dom.window)
    : (cb) => setTimeout(cb, 0)
)
dom.window.confirm = () => true // "discard unsaved changes?" prompts
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let diskState = {
  theme: 'dark',
  accent: '#3d9bff',
  dataDir: 'tests/.tmp/batch16',
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
const saves = []
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
    save: async (s) => {
      saves.push(s)
      return s
    },
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
  dialog: { pickFolder: async () => null, pickFiles: async () => [] },
  images: { dataUrl: async () => 'data:image/gif;base64,' },
  files: { list: async () => [], read: async () => null },
  ide: {
    tree: async () => [
      {
        path: '/W',
        name: 'W',
        dir: true,
        children: [
          { path: '/W/src.ts', name: 'src.ts' },
          { path: '/W/pic.png', name: 'pic.png' }
        ]
      }
    ],
    read: async () => readContent,
    write: async () => {},
    create: async (id, p) => p
  },
  win: { minimize: () => {}, maximize: () => {}, close: () => {} }
}
const baseSession = () => ({
  id: 's1',
  title: 'T',
  messages: [{ id: 'm-hi', role: 'user', content: 'hi', ts: 1 }],
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
    `export { default as IdePane } from '${PROJ}/src/renderer/src/components/IdePane'`,
    `export { default as Composer } from '${PROJ}/src/renderer/src/components/Composer'`,
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
const root = ui.createRoot(document.getElementById('root'))
const clickEl = async (el, what) => {
  if (!el) throw new Error(`no element ${what}`)
  await ui.act(async () => {
    el.click()
  })
}
const byText = (sel, t) => [...document.querySelectorAll(sel)].find((b) => b.textContent.trim() === t)
const byTitle = (sel, t) => [...document.querySelectorAll(sel)].find((b) => b.title === t)

// --- 2. cowork file mirror ----------------------------------------------------
{
  await ui.act(async () => {
    ui.useApp.setState({ ideOpen: true })
    root.render(ui.createElement(ui.IdePane))
  })
  await clickEl(byTitle('.ide-file', '/W/src.ts'), 'src.ts')
  check(
    'mirror: opening a file publishes path + content',
    st().ideFile?.path === '/W/src.ts' && st().ideFile?.content === 'const a = 1',
    JSON.stringify(st().ideFile)
  )

  // unsaved typing must mirror too — that's what the user is looking at
  const ta = document.querySelector('.ide-ta-wrap textarea')
  const proto = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')
  proto.set.call(ta, 'const a = 1 // mine')
  await ui.act(async () => {
    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  check('mirror: unsaved edits ride along', st().ideFile?.content === 'const a = 1 // mine', JSON.stringify(st().ideFile?.content))
}

// --- 3. composer: chip + attachment -------------------------------------------
{
  await ui.act(async () => {
    root.render(ui.createElement(ui.Composer))
  })
  const chip = byText('.ide-chip', 'src.ts')
  check(
    'composer: the picked cowork file shows as a chip',
    !!chip && /included with your next message/.test(chip.title ?? ''),
    chip?.title ?? 'missing'
  )

  const sendMsg = async (text) => {
    const taEl = document.querySelector('.composer textarea')
    await ui.act(async () => {
      const proto2 = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')
      proto2.set.call(taEl, text)
      taEl.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await ui.act(async () => {
      document.querySelector('.composer-tools button.send')?.click()
      await flush()
    })
    await flush()
  }

  const before = saves.length
  await sendMsg('improve this file')
  check('composer: send persisted a message', saves.length === before + 1, `saves=${saves.length}`)
  const sent = [...(saves[saves.length - 1]?.messages ?? [])].reverse().find((m) => m.role === 'user')
  check(
    'composer: submit attaches the picked file with live content',
    sent?.files?.length === 1 && sent.files[0].path === '/W/src.ts' && sent.files[0].content === 'const a = 1 // mine',
    JSON.stringify(sent?.files)
  )
  check('composer: the turn was handed to the backend', chatSends.length === 1, `sends=${chatSends.length}`)

  await ui.act(async () => {
    ui.useApp.setState({ streaming: false, streamText: '' })
  })
}

// --- 4. an image in cowork clears the mirror ----------------------------------
{
  await ui.act(async () => {
    root.render(ui.createElement(ui.IdePane))
  })
  await clickEl(byTitle('.ide-file', '/W/pic.png'), 'pic.png')
  check('mirror: an image clears the picked file', st().ideFile === null, JSON.stringify(st().ideFile))
  await clickEl(byTitle('.ide-file', '/W/src.ts'), 'src.ts')
  check(
    'mirror: back to a text file republishes it',
    st().ideFile?.path === '/W/src.ts' && st().ideFile?.content === 'const a = 1',
    JSON.stringify(st().ideFile)
  )
}

// --- 5. closing cowork stops the attachment -----------------------------------
{
  await ui.act(async () => {
    ui.useApp.setState({ ideOpen: false })
    root.render(ui.createElement(ui.Composer))
  })
  if (document.querySelector('.ide-chip')) {
    console.log('DEBUG root html:', document.getElementById('root').innerHTML.slice(0, 400))
    console.log('DEBUG ideOpen/ideFile:', JSON.stringify({ ideOpen: st().ideOpen, ideFile: st().ideFile }))
  }
  check('composer: pane closed → chip hidden', !document.querySelector('.ide-chip'))

  const taEl = document.querySelector('.composer textarea')
  await ui.act(async () => {
    const proto2 = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')
    proto2.set.call(taEl, 'now without context')
    taEl.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await ui.act(async () => {
    document.querySelector('.composer-tools button.send')?.click()
    await flush()
  })
  await flush()
  const sent = [...(saves[saves.length - 1]?.messages ?? [])].reverse().find((m) => m.role === 'user')
  check('composer: pane closed → no file attached', sent?.content === 'now without context' && sent.files === undefined, JSON.stringify(sent?.files))
}

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

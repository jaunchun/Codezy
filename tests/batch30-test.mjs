// Batch 30 — v3.1 background tasks panel:
//  A. v2.ts: the registry cache is an LRU of workspaces (eviction kills the
//     victim's leftover children first), listV2Tasks/stopV2Task export the
//     harness's task maps with root-namespaced uids and a capped output tail.
//  B. wiring: main handlers → preload channels → api group + TaskInfo, store
//     state/setters + the run_command refresh hook, palette a-tasks, the
//     ChatView mount and the composer chip.
//  C. dynamic (real harness): a background task starts, lists, and dies on
//     kill; a fresh v2 module reports no tasks and refuses unknown uids.
//  D. jsdom (ChatView + TasksPanel + store): chip count → open → rows with
//     status/exit output tail → kill → expand → Escape → empty state, and a
//     run_command tool event refreshes the composer count.
// Deterministic: no network; background children are `node -e` sleepers.
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

// OUT must live INSIDE the project so esbuild resolves node_modules.
const OUT = path.join(PROJ, 'tests', '.tmp', `b30-${Date.now() % 100000}`)
fs.mkdirSync(OUT, { recursive: true })
const rd = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8')

const bundle = async (entryContent, outName, opts = {}) => {
  const entry = path.join(OUT, `${outName}.entry.mjs`)
  fs.writeFileSync(entry, entryContent)
  const out = path.join(OUT, outName)
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    ...opts
  })
  return import(pathToFileURL(out).href)
}

// --- A. v2.ts: LRU registry cache + task exports (static) -----------------------
{
  const v2 = rd('src/main/v2.ts')
  check('A the cache is an LRU of workspaces', /REG_CACHE_MAX = \d+/.test(v2) && /regCache: RegEntry\[\] = \[\]/.test(v2))
  check('A cache hits bump the LRU stamp', v2.includes('hit.used = ++regClock'))
  check(
    'A eviction kills the victim leftover children first',
    v2.includes('for (const t of tasks.values()) killProc(t)') &&
      /while \(regCache\.length > REG_CACHE_MAX\)/.test(v2)
  )
  check(
    'A the kill takes the whole tree (Windows)',
    v2.includes("spawnSync('taskkill', ['/pid', String(t.proc.pid), '/T', '/F']")
  )
  check('A listV2Tasks is exported', /export function listV2Tasks\(\): TaskInfo\[\]/.test(v2))
  check('A the output tail is capped', v2.includes('TASK_OUT_TAIL = 6000') && v2.includes('t.out.slice(-TASK_OUT_TAIL)'))
  check('A the panel learns the full size too', v2.includes('outTotal: t.out.length'))
  check(
    'A uids namespace ids by workspace root',
    v2.includes('uid: `${workspace}:${t.id}`') && v2.includes('`${workspace}:${t.id}` === uid')
  )
  check('A stopV2Task is exported + kill-by-uid', /export function stopV2Task\(uid: string\): boolean/.test(v2))
  check('A the list runs newest-first', v2.includes('Number(b.running) - Number(a.running)'))
  check('A runV2 goes through the cache (no single entry)', v2.includes('cachedRegistry(key, roots, () => makeRegistry'))
  const dts = rd('cli/lib/harness.d.mts')
  check('A the harness task state declares started + proc', /started\?: number/.test(dts) && /proc\?: \{ pid\?: number/.test(dts))
}

// --- B. wiring across the layers (static) ----------------------------------------
{
  const main = rd('src/main/index.ts')
  check('B main handles tasks:list', main.includes("ipcMain.handle('tasks:list', () => listV2Tasks())"))
  check('B main handles tasks:stop', main.includes("ipcMain.handle('tasks:stop', (_e, uid: string) => stopV2Task(String(uid)))"))
  check('B main imports both exports', /import \{[^}]*\blistV2Tasks\b[^}]*\brunV2\b[^}]*\bstopV2Task\b[^}]*\} from '\.\/v2'/.test(main))

  const pre = rd('src/preload/index.ts')
  check(
    'B preload bridges the two channels',
    pre.includes("tasks: {\n    list: () => ipcRenderer.invoke('tasks:list'),\n    stop: (uid: string) => ipcRenderer.invoke('tasks:stop', uid)\n  }")
  )

  const api = rd('src/shared/api.ts')
  check('B api declares the tasks group', /tasks: \{\n\s+\/\*\*[\s\S]*?list\(\): Promise<TaskInfo\[\]>\n\s+\/\*\*[\s\S]*?stop\(uid: string\): Promise<boolean>/.test(api))
  check(
    'B TaskInfo carries uid/exit/tail/workspace',
    /export interface TaskInfo \{[\s\S]*?uid: string[\s\S]*?code: number \| string \| null[\s\S]*?outTotal: number[\s\S]*?workspace: string/.test(api)
  )

  const app = rd('src/renderer/src/store/app.ts')
  check('B store: tasksOpen + taskCount state', /tasksOpen: boolean\n\s+taskCount: number/.test(app))
  check('B store: opening refreshes the list', app.includes('setTasksOpen(v) {\n      set({ tasksOpen: v })\n      if (v) void get().refreshTasks()'))
  check('B store: refreshTasks counts the running ones', app.includes('set({ taskCount: tasks.filter((t) => t.running).length })'))
  check(
    'B store: every run_command event refreshes the count',
    app.includes("if (String(payload.name) === 'run_command') void get().refreshTasks()")
  )

  const pal = rd('src/renderer/src/components/Palette.tsx')
  check('B palette has a-tasks', pal.includes("id: 'a-tasks'") && pal.includes('label: \'Background tasks\''))

  const cv = rd('src/renderer/src/components/ChatView.tsx')
  check('B ChatView mounts the panel when open', cv.includes('{tasksOpen && <TasksPanel />}'))

  const comp = rd('src/renderer/src/components/Composer.tsx')
  check(
    'B the composer chip keys on taskCount and opens the panel',
    comp.includes('{s.taskCount > 0 && (') && comp.includes('onClick={() => s.setTasksOpen(true)}')
  )

  const css = rd('src/renderer/src/styles/global.css')
  check('B css block 34 exists', css.includes('block 34 — v3.1 batch30: background tasks panel'))
  check('B css styles the panel + rows + kill', /\.tasks-panel \{/.test(css) && /\.task-row \{/.test(css) && /\.task-kill:hover \{/.test(css))
  check('B css pulses the running dot (motion-off aware)', css.includes('@keyframes taskPulse') && css.includes("html[data-motion='off'] .task-dot.run"))
}

// --- C. the real harness + a fresh v2 module (dynamic) ----------------------------
{
  const v2m = await bundle(
    [
      `export { listV2Tasks, stopV2Task } from '${PROJ}/src/main/v2'`,
      `export { runAgent, makeRegistry } from '${PROJ}/cli/lib/harness.mjs'`
    ].join('\n'),
    'v2.mjs',
    { platform: 'node' }
  )
  check('C a fresh module reports no tasks', v2m.listV2Tasks().length === 0, `got ${v2m.listV2Tasks().length}`)
  check('C unknown uid refuses to kill', v2m.stopV2Task('nope:1') === false)

  // the harness machinery behind the panel: start → list → kill → close
  const registry = v2m.makeRegistry({ roots: [OUT] })
  const started = await registry.run_command.run({
    command: 'node -e "setTimeout(() => {}, 20000)"',
    background: true
  })
  check('C a background task starts with an id', /started background task #1:/.test(started), started.slice(0, 80))
  const state = registry.task_status.state
  const task = state.tasks.get(1)
  check(
    'C the task record carries id/command/started',
    !!task && task.running === true && typeof task.started === 'number' && task.command.includes('node -e'),
    task ? `id=${task.id} running=${task.running}` : 'no record'
  )
  const listed = await registry.task_status.run({})
  check('C task_status lists it running', /#1 running: node -e/.test(listed), listed.slice(0, 60))
  await registry.task_status.run({ id: 1, kill: true })
  await new Promise((r) => setTimeout(r, 600))
  check('C the kill flips it to exited', task.running === false, `running=${task.running} code=${task.code}`)
}

// --- jsdom + fake bridge -----------------------------------------------------------
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
dom.window.matchMedia =
  dom.window.matchMedia ||
  (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
// jsdom has no scrollIntoView — ChatView and the panel callers use it
dom.window.HTMLElement.prototype.scrollIntoView = function () {}
// ChatView reads CSS.highlights at import (find bar detection)
defineGlobal('CSS', {})
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// fake bridge — batch17 shape + the batch30 tasks group
let diskState = {
  theme: 'dark',
  accent: '#3d9bff',
  dataDir: path.join(OUT, 'data'),
  driveFolder: null,
  ollamaUrl: 'http://127.0.0.1:11434',
  providers: [],
  activeProvider: 'ollama',
  activeModel: 'qwen2.5-coder:7b',
  effort: 'medium',
  userName: 'dev',
  learn: false,
  fontSize: 14,
  mode: 'build',
  v2: false,
  setupDone: true,
  reduceMotion: false,
  autoUpdate: true,
  enterSends: true,
  mcpServers: []
}
let eventHandler = null
const stops = []
let TASKS = [
  {
    uid: 'C:/ws/alpha:1',
    id: 1,
    command: 'node -e "setTimeout(() => {}, 20000)"',
    running: true,
    code: null,
    out: 'booting…',
    outTotal: 9,
    started: Date.now() - 65_000,
    workspace: 'C:/ws/alpha'
  },
  {
    uid: 'C:/ws/alpha:2',
    id: 2,
    command: 'npm run build',
    running: false,
    code: 1,
    out: 'error TS2345: nope',
    outTotal: 19,
    started: Date.now() - 300_000,
    workspace: 'C:/ws/alpha'
  }
]
const session1 = () => ({ id: 's1', title: 'one', messages: [], createdAt: 1, updatedAt: 1, linkedFolders: [] })
const mock = {
  settings: {
    get: async () => ({ ...diskState }),
    set: async (patch) => ({ ...diskState, ...patch })
  },
  projects: { list: async () => [] },
  sessions: {
    list: async () => [session1()],
    create: async () => ({ id: 'new', title: 'New chat', messages: [], createdAt: 1, updatedAt: 1 }),
    save: async (s) => s,
    delete: async () => {},
    search: async () => []
  },
  chat: {
    onEvent: (cb) => {
      eventHandler = cb
    },
    send: async () => {},
    abort: async () => {},
    v2decision: async () => {}
  },
  health: { ollama: async () => 'online', drive: async () => ({ enabled: false, folder: null, healthy: false }) },
  models: { list: async () => [] },
  memory: { read: async () => '', write: async () => true },
  skills: { list: async () => [] },
  edits: { apply: async (_id, edits) => ({ applied: edits.map((e) => ({ path: e.path })), errors: [] }) },
  dialog: { pickFolder: async () => null, pickFiles: async () => [] },
  images: { dataUrl: async () => 'data:image/gif;base64,' },
  files: { list: async () => [], read: async () => null, ingest: async () => ({ files: [], dirs: [], skipped: 0 }) },
  ide: { tree: async () => [], read: async () => ({ content: '', truncated: false }), write: async () => {} },
  notify: { send: async () => {} },
  update: { check: async () => ({ ok: false }) },
  tasks: {
    list: async () => TASKS.map((t) => ({ ...t })),
    stop: async (uid) => {
      stops.push(uid)
      return true
    }
  },
  win: { minimize: () => {}, maximize: () => {}, close: () => {} }
}
dom.window.codezy = mock
defineGlobal('codezy', mock)

const ui = await bundle(
  [
    `export { default as ChatView } from '${PROJ}/src/renderer/src/components/ChatView'`,
    `export { default as Composer } from '${PROJ}/src/renderer/src/components/Composer'`,
    `export { default as TasksPanel } from '${PROJ}/src/renderer/src/components/TasksPanel'`,
    `export { useApp } from '${PROJ}/src/renderer/src/store/app'`,
    `export { createRoot } from 'react-dom/client'`,
    `export { act } from 'react'`,
    `export { createElement, Fragment } from 'react'`
  ].join('\n'),
  'renderer.mjs',
  { platform: 'browser', jsx: 'automatic', define: { __APP_VERSION__: JSON.stringify('0.0.0-test') } }
)
const { createElement: h } = ui
const st = () => ui.useApp.getState()
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
const root = ui.createRoot(document.getElementById('root'))
/** App renders the Composer as a sibling of ChatView — mirror that shell. */
const screen = () => h(ui.Fragment, null, h(ui.ChatView), h(ui.Composer))
const renderInto = async (el) => {
  await ui.act(async () => {
    root.render(el)
    await settle()
  })
}
const click = async (el) => {
  await ui.act(async () => {
    el.click()
    await settle()
  })
}

// --- D. chip → panel → rows → kill → expand → Escape ----------------------------
{
  await st().init()
  check('D init: one chat, engine fine', st().activeId === 's1' && st().tasksOpen === false)

  await renderInto(screen())
  check('D the chip stays hidden at count 0', !document.querySelector('.task-chip'))

  await ui.act(async () => {
    ui.useApp.setState({ taskCount: 2 })
    root.render(screen())
    await settle()
  })
  const chip = document.querySelector('.task-chip')
  check(
    'D the chip appears with the running count',
    !!chip && chip.textContent.includes('2'),
    chip?.textContent ??
      (document.querySelector('.composer')
        ? `no chip (taskCount=${st().taskCount})`
        : `NO COMPOSER — body=${document.body.innerHTML.slice(0, 160)}`)
  )

  await click(chip)
  check('D chip click opens the panel', st().tasksOpen === true)
  const rows = [...document.querySelectorAll('.task-row')]
  check('D the panel lists every task', rows.length === 2, `rows=${rows.length}`)
  check('D the running row pulses', !!document.querySelector('.task-dot.run'))
  check('D the failed row is marked bad', !!document.querySelector('.task-dot.bad'))
  check('D the finished row shows its exit code', [...document.querySelectorAll('.task-meta')].some((m) => m.textContent.includes('exit 1')))
  const kills = [...document.querySelectorAll('.task-kill')]
  check('D only the running row gets a stop button', kills.length === 1, `kill buttons=${kills.length}`)

  await click(kills[0])
  await ui.act(async () => {
    await new Promise((r) => setTimeout(r, 300)) // the panel's post-kill re-pull
  })
  check('D stop targets the task uid', stops.length === 1 && stops[0] === 'C:/ws/alpha:1', JSON.stringify(stops))

  const lines = [...document.querySelectorAll('.task-line')]
  await click(lines[1])
  check('D clicking a row expands its output', (document.querySelector('.task-out')?.textContent ?? '').includes('error TS2345'))

  await ui.act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
    await settle()
  })
  check('D Escape closes the panel', st().tasksOpen === false && !document.querySelector('.tasks-panel'))

  // empty state
  TASKS = []
  await ui.act(async () => {
    ui.useApp.setState({ taskCount: 0 })
    st().setTasksOpen(true)
    await settle()
  })
  check(
    'D an empty list explains how tasks happen',
    (document.querySelector('.tasks-empty')?.textContent ?? '').includes('No background tasks') &&
      !document.querySelector('.task-chip'),
    document.querySelector('.tasks-empty')?.textContent?.slice(0, 40) ?? 'none'
  )
  await ui.act(async () => {
    st().setTasksOpen(false)
    await settle()
  })

  // the store hook: a run_command tool event refreshes the composer count
  TASKS = [
    { uid: 'C:/ws/alpha:3', id: 3, command: 'npm test', running: true, code: null, out: '', outTotal: 0, started: Date.now(), workspace: 'C:/ws/alpha' }
  ]
  await ui.act(async () => {
    eventHandler?.({
      sessionId: 's1',
      type: 'v2tool',
      iteration: 1,
      name: 'run_command',
      args: { command: 'npm test', background: true },
      outcome: 'ok'
    })
    await settle()
  })
  check('D a run_command event refreshes the count', st().taskCount === 1, `taskCount=${st().taskCount}`)
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS')
// explicit exit: the store's background health poll keeps the loop alive
process.exit(fails.length ? 1 : 0)

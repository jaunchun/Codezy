// Batch 27 — v3.1 project instructions file (.codezy/instructions.md):
//  A. buildMessages: the file lands in the system prompt right after the
//     CODEZY.md context (missing file → silent, oversized → capped with a
//     marker, agent mode (v2) gets it too, tree still described).
//  B. the TUI reads the same file (parity) with the same cap.
//  C. Settings ▸ instructions (jsdom): one .pi-row per linked folder —
//     ready/not-created state, open launches the file, create writes the
//     starter template and flips the state, unlinked chats get a hint.
//  D. wiring/static: exports, markers, CSS block 31.
// Deterministic: fixture folders under tests/.tmp, fake bridge, no model.
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
const OUT = path.join(PROJ, 'tests', '.tmp', `b27-${Date.now() % 100000}`)
fs.mkdirSync(OUT, { recursive: true })
const rd = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8')

// electron stub for bundles that pull main/store.ts (batch12/24 pattern)
fs.writeFileSync(
  path.join(OUT, 'electron-stub.mjs'),
  'export const app = { getPath: () => "" }\nexport default { app }\n'
)
const ELECTRON_ALIAS = { electron: path.join(OUT, 'electron-stub.mjs') }

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

// --- fixtures ------------------------------------------------------------------------
const WITH = path.join(OUT, 'project-with')
fs.mkdirSync(path.join(WITH, '.codezy'), { recursive: true })
fs.mkdirSync(path.join(WITH, 'src'), { recursive: true })
fs.writeFileSync(path.join(WITH, 'src', 'app.ts'), 'export {}\n', 'utf8')
fs.writeFileSync(path.join(WITH, 'CODEZY.md'), 'Use tabs, never spaces.', 'utf8')
fs.writeFileSync(
  path.join(WITH, '.codezy', 'instructions.md'),
  'Always run `npm test` before saying a task is done.\nNever touch files under dist/.',
  'utf8'
)
const BARE = path.join(OUT, 'project-bare')
fs.mkdirSync(BARE, { recursive: true })
const HUGE = path.join(OUT, 'project-huge')
fs.mkdirSync(path.join(HUGE, '.codezy'), { recursive: true })
fs.writeFileSync(path.join(HUGE, '.codezy', 'instructions.md'), 'RULE '.repeat(1250), 'utf8') // 5000 chars

// --- A. the system prompt -------------------------------------------------------------
const m = await bundle(
  `export { buildMessages, readProjectInstructions, fileTree } from '${PROJ}/src/main/prompt'`,
  'prompt.mjs',
  { platform: 'node', alias: ELECTRON_ALIAS }
)
{
  const session = (folders) => ({
    id: 's1',
    messages: [{ id: 'm1', role: 'user', content: 'hi', ts: 1 }],
    linkedFolders: folders,
    goal: '',
    notes: [],
    skill: ''
  })
  const settings = { mode: 'build', v2: false, instructions: '', learn: false, effort: 'medium' }
  const sysOf = (sess, extra = {}) =>
    m.buildMessages(sess, null, { ...settings, ...extra }).find((x) => x.role === 'system')

  const sys = sysOf(session([WITH]))
  check('A the project instructions reach the system prompt', sys.content.includes('.codezy/instructions.md (project instructions'), sys.content.slice(-220))
  check('A the rules themselves are in there', sys.content.includes('Always run `npm test` before saying a task is done.') && sys.content.includes('Never touch files under dist/.'))
  const iCtx = sys.content.indexOf('CODEZY.md (project context):')
  const iPi = sys.content.indexOf('.codezy/instructions.md (project instructions')
  check('A instructions sit right after the CODEZY.md context', iCtx > 0 && iPi > iCtx, `${iCtx}/${iPi}`)
  check('A the file tree is still described', sys.content.includes('src/app.ts') && sys.content.includes(path.join(OUT, 'project-with').replace(/\\/g, '/')) || sys.content.includes('project-with'))

  const bare = sysOf(session([BARE]))
  check('A a folder without the file stays silent', !bare.content.includes('.codezy/instructions.md (project instructions'))

  const huge = sysOf(session([HUGE]))
  const piStart = huge.content.indexOf('.codezy/instructions.md (project instructions')
  const piBody = huge.content.slice(piStart)
  check('A an oversized file is capped with a marker', piBody.includes('[project instructions truncated]') && piBody.length < 4600, String(piBody.length))
  const seeds = (piBody.match(/RULE/g) ?? []).length
  check('A the cap keeps the body near 4000 chars', seeds >= 780 && seeds <= 801, String(seeds))

  const v2 = sysOf(session([WITH]), { v2: true })
  check('A agent mode gets the same file', v2.content.includes('.codezy/instructions.md (project instructions') && v2.content.includes('## Tools'))

  check('A readProjectInstructions reads the file', m.readProjectInstructions(WITH).includes('Always run `npm test`'))
  check('A readProjectInstructions is quiet on a missing file', m.readProjectInstructions(BARE) === '' && m.readProjectInstructions(path.join(OUT, 'nope')) === '')
  check('A readProjectInstructions caps the body', m.readProjectInstructions(HUGE).length <= 4000 + 60, String(m.readProjectInstructions(HUGE).length))
}

// --- B. TUI parity ----------------------------------------------------------------------
{
  const tui = rd('cli/codezy.mjs')
  check('B the TUI reads .codezy/instructions.md', tui.includes("path.join(linkFolder, '.codezy', 'instructions.md')"))
  check('B the TUI uses the same marker line', tui.includes('.codezy/instructions.md (project instructions — standing rules for THIS project'))
  check('B the TUI caps the file at 4000 chars', tui.includes('project instructions truncated'))
  check('B the TUI block cap raised with it', tui.includes('slice(0, 16000)'))
}

// --- jsdom: Settings ▸ instructions -------------------------------------------------------
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// --- fake bridge: memory/mcp/resync + a real-fs ide + files.open -------------------------
const piWrites = []
const openCalls = []
const SETTINGS = {
  theme: 'dark',
  accent: '#3d9bff',
  dataDir: path.join(OUT, 'data'),
  driveFolder: null,
  ollamaUrl: 'http://127.0.0.1:11434',
  providers: [],
  activeProvider: 'ollama',
  activeModel: 'm',
  effort: 'medium',
  userName: 'dev',
  learn: false,
  fontSize: 14,
  mode: 'build',
  v2: false,
  setupDone: true,
  reduceMotion: false,
  density: 'cozy',
  autoUpdate: true,
  notifyDone: false,
  enterSends: true,
  mcpServers: []
}
const mock = {
  settings: { get: async () => SETTINGS, set: async (patch) => ({ ...SETTINGS, ...patch }) },
  models: { list: async () => [] },
  memory: { read: async () => '' },
  mcp: { list: async () => [], probe: async () => ({ ok: false, tools: [] }), save: async () => {} },
  ide: {
    read: async (_sid, p) => (fs.existsSync(p) ? { content: fs.readFileSync(p, 'utf8'), truncated: false } : null),
    write: async (_sid, p, content) => {
      piWrites.push([p, content])
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content, 'utf8')
      return p
    }
  },
  files: {
    open: async (p) => {
      openCalls.push(p)
      return ''
    }
  },
  notify: { send: async () => {} }
}
dom.window.codezy = mock
defineGlobal('codezy', mock)

const ui = await bundle(
  [
    `export { default as SettingsModal } from '${PROJ}/src/renderer/src/components/SettingsModal'`,
    `export { useApp } from '${PROJ}/src/renderer/src/store/app'`,
    `export { createRoot } from 'react-dom/client'`,
    `export { act } from 'react'`,
    `export { createElement } from 'react'`
  ].join('\n'),
  'renderer.mjs',
  { platform: 'browser', jsx: 'automatic', define: { __APP_VERSION__: JSON.stringify('0.0.0-test') } }
)
const { createElement: h } = ui

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
const root = ui.createRoot(document.getElementById('root'))
// one act window per interaction: the click AND the promise-driven setStates
// it triggers (ide.write → setPi) land together (batch24 pattern)
const render = async (el) => {
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
const piField = () => document.querySelector('.proj-instr')
const piBtn = (label) => [...(piField()?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === label)
const mkSession = (id, folders) => ({
  id,
  projectId: null,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  linkedFolders: folders,
  messages: []
})

// --- C. the Settings UI -------------------------------------------------------------------
{
  const sWith = mkSession('s-with', [WITH])
  const sBare = mkSession('s-bare', [BARE])
  const sNone = mkSession('s-none', [])
  ui.useApp.setState({ settings: SETTINGS, settingsOpen: true, sessions: [sWith, sBare, sNone], activeId: 's-with', notices: [] })
  await render(h(ui.SettingsModal))

  check('C project instructions block rendered', piField() != null)
  const row = document.querySelector('.pi-row')
  check('C one row for the linked folder', row != null, String(document.querySelectorAll('.pi-row').length))
  check('C the full path is shown', row?.querySelector('.pi-path')?.textContent.endsWith('.codezy/instructions.md'), row?.querySelector('.pi-path')?.textContent)
  check('C an existing file reads as ready', row?.querySelector('.pi-status')?.textContent === 'ready' && row?.classList.contains('pi-row'), row?.querySelector('.pi-status')?.textContent)
  check('C ready rows offer open', piBtn('open') != null && !piBtn('open')?.disabled)

  await click(piBtn('open'))
  check('C open launches the file', openCalls.length === 1 && openCalls[0].endsWith('.codezy/instructions.md'), JSON.stringify(openCalls))

  // a folder without the file → not created + create writes the template
  await ui.act(async () => {
    ui.useApp.setState({ activeId: 's-bare' })
    await settle()
  })
  await render(h(ui.SettingsModal))
  const row2 = document.querySelector('.pi-row')
  check('C a missing file reads as not created', row2?.querySelector('.pi-status')?.textContent === 'not created', row2?.querySelector('.pi-status')?.textContent)
  check('C missing rows offer create it', piBtn('create it') != null)
  await click(piBtn('create it'))
  check('C create writes the starter template', piWrites.length === 1 && piWrites[0][0].endsWith('.codezy/instructions.md') && piWrites[0][1].includes('# Project instructions for CODEZY'), JSON.stringify(piWrites[0]?.[0]))
  check('C the file now exists on disk', fs.readFileSync(path.join(BARE, '.codezy', 'instructions.md'), 'utf8').includes('Standing orders for THIS project'))
  check('C the state flips to ready after creating', document.querySelector('.pi-row .pi-status')?.textContent === 'ready', document.querySelector('.pi-row .pi-status')?.textContent)
  const notices = ui.useApp.getState().notices
  check('C creating announces what happens next', notices.at(-1)?.text.includes('Created .codezy/instructions.md — its rules are loaded into every chat'), notices.at(-1)?.text)

  // no linked folder → the hint explains how to get one
  await ui.act(async () => {
    ui.useApp.setState({ activeId: 's-none' })
    await settle()
  })
  await render(h(ui.SettingsModal))
  check('C an unlinked chat gets the linking hint', piField()?.textContent.includes('Link a folder to a chat'), piField()?.textContent.slice(0, 80))
  check('C no rows without folders', document.querySelectorAll('.pi-row').length === 0)
}

// --- D. wiring / static ---------------------------------------------------------------------
{
  const prompt = rd('src/main/prompt.ts')
  check('D readProjectInstructions exported', prompt.includes('export function readProjectInstructions'))
  check('D the marker line exists', prompt.includes('.codezy/instructions.md (project instructions — standing rules for THIS project'))
  check('D section cap raised to fit it', prompt.includes('slice(0, 16000)'))
  const sm = rd('src/renderer/src/components/SettingsModal.tsx')
  check('D Settings renders the proj-instr block', sm.includes('className="field proj-instr"') && sm.includes('pi-rows'))
  check('D the starter template lives in the modal', sm.includes('PI_TEMPLATE') && sm.includes('create it'))
  check('D reads and writes go through the ide bridge', /window\.codezy\.ide\s*\.read/.test(sm) && sm.includes('window.codezy.ide.write'))
  const css = rd('src/renderer/src/styles/global.css')
  check('D css block 31 after 30', css.includes('31 — v3.1 project instructions') && css.indexOf('31 — v3.1') > css.indexOf('30 — v3.1'))
  check('D .pi-row / .pi-status.found styles', css.includes('.pi-row') && css.includes('.pi-status.found'))
}

// --- cleanup + summary ---------------------------------------------------------------------
try {
  fs.rmSync(OUT, { recursive: true, force: true })
} catch {
  /* best effort */
}

console.log('')
console.log(fails.length ? `${fails.length} FAIL:\n  ${fails.join('\n  ')}` : 'ALL PASS')
process.exitCode = fails.length ? 1 : 0
// jsdom keeps handles open — exit explicitly so the suite doesn't hang
process.exit(fails.length ? 1 : 0)

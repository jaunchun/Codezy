// Batch 28 — v3.1 chat search across sessions:
//  A. searchSessions (main): case-insensitive scan, newest session first,
//     newest message first, hidden notes skipped, 1-char queries refused,
//     limits honoured, snippets single-line with context + ellipses, a
//     corrupt session file never breaks the scan.
//  B. store: runSearch (debounced contract, stale-response guard) +
//     openSearchHit (jump + scroll target + overlay close).
//  C. SearchOverlay (jsdom): empty state, typing → debounced hits with <mark>,
//     arrow/Enter picking, no-results text, Esc closes.
//  D. ChatView: data-mid rows, the picked hit scrolls into view and flashes,
//     then the target clears.
//  E. wiring/static: IPC, preload, api type, palette/cheat-sheet entries,
//     CSS block 32.
// Deterministic: fixture sessions under tests/.tmp, scripted bridge, no model.
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
const OUT = path.join(PROJ, 'tests', '.tmp', `b28-${Date.now() % 100000}`)
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

// --- A. the main-side scanner -------------------------------------------------------
const TDIR = path.join(OUT, 'data')
const SDIR = path.join(TDIR, 'sessions')
fs.mkdirSync(SDIR, { recursive: true })
const long = `${'x'.repeat(300)} deploy ${'y'.repeat(300)}`
const writeSession = (file, obj) => fs.writeFileSync(path.join(SDIR, file), JSON.stringify(obj), 'utf8')
writeSession('s-new.json', {
  id: 's-new',
  projectId: null,
  title: 'The new chat',
  createdAt: 100,
  updatedAt: 3000,
  linkedFolders: [],
  messages: [
    { id: 'a1', role: 'user', content: long, ts: 10 },
    { id: 'a2', role: 'assistant', content: 'The DEPLOY pipeline:\n  1. build\n  2. push', ts: 20 },
    { id: 'a3', role: 'user', content: 'hidden deploy note', ts: 30, hidden: true }
  ]
})
writeSession('s-old.json', {
  id: 's-old',
  projectId: null,
  title: 'The old chat',
  createdAt: 50,
  updatedAt: 2000,
  linkedFolders: [],
  messages: [
    { id: 'b1', role: 'user', content: 'another deploy mention here', ts: 5 },
    { id: 'b2', role: 'user', content: 'no match at all', ts: 6 }
  ]
})
writeSession('s-empty.json', { id: 's-empty', title: 'Empty', createdAt: 1, updatedAt: 1000, linkedFolders: [], messages: [] })
fs.writeFileSync(path.join(SDIR, 'junk.json'), '{ this is not json', 'utf8')

const M = await bundle(
  `export { searchSessions, initStore } from '${PROJ}/src/main/store'`,
  'store.mjs',
  { platform: 'node', alias: ELECTRON_ALIAS }
)
M.initStore(TDIR)
{
  const hits = M.searchSessions('deploy')
  check('A finds the matches across sessions', hits.length === 3, String(hits.length))
  check('A newest session first', hits[0].sessionId === 's-new' && hits[2].sessionId === 's-old', hits.map((h) => h.sessionId).join(','))
  check('A newest message first within a session', hits[0].messageId === 'a2' && hits[1].messageId === 'a1', hits.slice(0, 2).map((h) => h.messageId).join(','))
  check('A hidden messages are never searched', !hits.some((h) => h.messageId === 'a3'))
  check('A case-insensitive', M.searchSessions('DEPLOY').length === 3 && M.searchSessions('DePlOY').length === 3)
  check('A one-character queries refuse', M.searchSessions('d').length === 0 && M.searchSessions('  ').length === 0 && M.searchSessions('').length === 0)
  check('A the limit is honoured', M.searchSessions('deploy', 2).length === 2)
  const a1 = hits.find((h) => h.messageId === 'a1')
  check('A snippets are single-line with context + ellipses', !a1.snippet.includes('\n') && a1.snippet.startsWith('…') && a1.snippet.endsWith('…') && a1.snippet.includes('deploy'), a1.snippet.slice(0, 40))
  const a2 = hits.find((h) => h.messageId === 'a2')
  check('A the snippet carries the match as written', a2.snippet.includes('DEPLOY') && !a2.snippet.includes('\n'), a2.snippet)
  check('A hits carry where to jump', a2.sessionTitle === 'The new chat' && a2.role === 'assistant' && typeof a2.ts === 'number', JSON.stringify({ t: a2.sessionTitle, r: a2.role }))
  check('A a corrupt session file never breaks the scan', M.searchSessions('nothing-matches-this-anyway').length === 0)
}

// --- jsdom + scripted bridge -----------------------------------------------------------
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
// jsdom has no scrollIntoView — ChatView's jump + flash effects call it
const scrollSpans = []
dom.window.HTMLElement.prototype.scrollIntoView = function (opts) {
  scrollSpans.push({ el: this, opts })
}
// ChatView reads CSS.highlights at import (find bar detection)
defineGlobal('CSS', {})
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const searchCalls = []
let searchImpl = async () => []
const mock = {
  sessions: { search: (q) => searchImpl(q) },
  settings: { get: async () => ({}), set: async (p) => p },
  models: { list: async () => [] },
  chat: { v2decision: async () => {} },
  memory: { read: async () => '' }
}
dom.window.codezy = mock
defineGlobal('codezy', mock)
mock.sessions.search = (q) => {
  searchCalls.push(q)
  return searchImpl(q)
}

const ui = await bundle(
  [
    `export { default as SearchOverlay } from '${PROJ}/src/renderer/src/components/SearchOverlay'`,
    `export { default as ChatView } from '${PROJ}/src/renderer/src/components/ChatView'`,
    `export { useApp } from '${PROJ}/src/renderer/src/store/app'`,
    `export { createRoot } from 'react-dom/client'`,
    `export { act } from 'react'`,
    `export { createElement } from 'react'`
  ].join('\n'),
  'renderer.mjs',
  { platform: 'browser', jsx: 'automatic', define: { __APP_VERSION__: JSON.stringify('0.0.0-test') } }
)
const { createElement: h } = ui
const st = () => ui.useApp.getState()

const wait = async (ms) => {
  await ui.act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
const root = ui.createRoot(document.getElementById('root'))
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
const type = async (el, v) => {
  await ui.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await settle()
  })
}
const key = async (el, k) => {
  await ui.act(async () => {
    el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }))
    await settle()
  })
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const HIT = (id, mid, snippet = 'the deploy pipeline explained') => ({
  sessionId: id,
  sessionTitle: id === 's-new' ? 'The new chat' : 'The old chat',
  messageId: mid,
  ts: 1730000000000,
  role: 'assistant',
  snippet
})

// --- B. the store contract ---------------------------------------------------------------
{
  // one-character queries never reach the bridge
  await st().runSearch('d')
  check('B tiny queries clear the hits without a call', searchCalls.length === 0 && st().searchHits.length === 0)

  // a normal query round-trips
  searchImpl = async () => [HIT('s-new', 'm9')]
  await st().runSearch('deploy')
  check('B a real query reaches the bridge and lands', searchCalls[0] === 'deploy' && st().searchHits.length === 1, JSON.stringify(searchCalls))

  // stale-response guard: the SLOW first query must never overwrite the newer one
  const first = deferred()
  const second = deferred()
  const order = [first, second]
  searchImpl = () => order.shift().promise
  const t1 = st().runSearch('first')
  const t2 = st().runSearch('second')
  second.resolve([HIT('s-new', 'fresh')])
  await wait(20)
  first.resolve([HIT('s-old', 'stale')])
  await wait(20)
  await Promise.all([t1, t2])
  check('B a stale response lands in the void', st().searchHits.length === 1 && st().searchHits[0].messageId === 'fresh', st().searchHits.map((x) => x.messageId).join(','))
  check('B the query shown is the newest one', st().searchQuery === 'second', st().searchQuery)

  // openSearchHit: jump + flash target + overlay closed + results reset
  ui.useApp.setState({ searchOpen: true, searchHits: [HIT('s-old', 'b1')], searchQuery: 'deploy', scrollTarget: null })
  const sessions = [
    { id: 's-old', projectId: null, title: 'The old chat', createdAt: 1, updatedAt: 1, linkedFolders: [], messages: [] },
    { id: 's-new', projectId: null, title: 'The new chat', createdAt: 1, updatedAt: 2, linkedFolders: [], messages: [] }
  ]
  ui.useApp.setState({ sessions, activeId: 's-new' })
  st().openSearchHit(HIT('s-old', 'b1'))
  check('B picking a hit switches to its chat', st().activeId === 's-old', st().activeId)
  check('B picking a hit sets the flash target', st().scrollTarget?.sessionId === 's-old' && st().scrollTarget?.messageId === 'b1', JSON.stringify(st().scrollTarget))
  check('B the overlay closes and the results clear', st().searchOpen === false && st().searchHits.length === 0 && st().searchQuery === '')
}

// --- C. the overlay ----------------------------------------------------------------------
{
  searchImpl = async () => [HIT('s-new', 'a1', 'how do I deploy this to prod?')]
  await ui.act(async () => {
    ui.useApp.setState({ searchOpen: true, searchHits: [], searchQuery: '', scrollTarget: null })
  })
  await render(h(ui.SearchOverlay))

  const input = document.querySelector('.search-head input')
  check('C the overlay renders an input', input != null && input.placeholder === 'Search every chat…', input?.placeholder)
  // closed → nothing in the DOM
  await ui.act(async () => {
    ui.useApp.setState({ searchOpen: false })
  })
  await render(h(ui.SearchOverlay))
  check('C a closed overlay renders nothing', document.querySelector('.search-overlay') == null)
  await ui.act(async () => {
    ui.useApp.setState({ searchOpen: true })
  })
  await render(h(ui.SearchOverlay))
  const input2 = document.querySelector('.search-head input')
  check('C reopening renders it again', input2 != null)
  check('C the empty state explains the minimum', document.querySelector('.search-empty')?.textContent.includes('at least two characters'), document.querySelector('.search-empty')?.textContent.slice(0, 60))
  await wait(30)
  check('C the input takes focus', document.activeElement === input2, document.activeElement?.tagName)

  // type → debounce (180 ms) → hits
  const callsBefore = searchCalls.length
  await type(input2, 'deploy')
  check('C typing alone does not fire immediately', searchCalls.length === callsBefore, JSON.stringify(searchCalls.slice(callsBefore)))
  await wait(260)
  const hit = document.querySelector('.search-hit')
  check('C the debounced search shows hits', hit != null && document.querySelectorAll('.search-hit').length === 1, String(document.querySelectorAll('.search-hit').length))
  check('C the hit carries chat + role + snippet', hit?.querySelector('.hit-chat')?.textContent === 'The new chat' && hit?.querySelector('.hit-role')?.textContent === 'assistant' && hit?.querySelector('.hit-text')?.textContent.includes('deploy'))
  check('C the match is marked up', hit?.querySelector('mark')?.textContent?.toLowerCase() === 'deploy', hit?.querySelector('mark')?.textContent)
  check('C the hit count is shown', document.querySelector('.search-count')?.textContent.includes('1 hit'), document.querySelector('.search-count')?.textContent)

  // arrows move the highlight, Enter picks
  await key(input2, 'ArrowDown')
  await key(input2, 'ArrowUp')
  check('C arrows keep exactly one row highlighted', document.querySelectorAll('.search-hit.on').length === 1, String(document.querySelectorAll('.search-hit.on').length))
  await key(input2, 'Enter')
  check('C Enter opens the hit', st().activeId === 's-new' && st().scrollTarget?.messageId === 'a1' && st().searchOpen === false, JSON.stringify({ a: st().activeId, t: st().scrollTarget }))

  // no results → the miss message; Esc closes
  searchImpl = async () => []
  await ui.act(async () => {
    ui.useApp.setState({ searchOpen: true })
  })
  await render(h(ui.SearchOverlay))
  await type(document.querySelector('.search-head input'), 'zz-nothing')
  await wait(260)
  check('C a miss says so', document.querySelector('.search-empty')?.textContent.includes('No message matches'), document.querySelector('.search-empty')?.textContent)
  await key(document.querySelector('.search-head input'), 'Escape')
  check('C Esc closes the overlay', st().searchOpen === false)
}

// --- D. ChatView: the flash ---------------------------------------------------------------
{
  const session = {
    id: 's-chat',
    projectId: null,
    title: 'Flash chat',
    createdAt: 1,
    updatedAt: 1,
    linkedFolders: [],
    messages: [
      { id: 'm1', role: 'user', content: 'how do I deploy this?', ts: 10 },
      { id: 'm2', role: 'assistant', content: 'Run `npm run deploy` — it builds and pushes.', ts: 20 }
    ]
  }
  scrollSpans.length = 0
  await ui.act(async () => {
    ui.useApp.setState({ sessions: [session], activeId: 's-chat', scrollTarget: { sessionId: 's-chat', messageId: 'm2' }, streaming: false, streamText: '' })
  })
  await render(h(ui.ChatView))

  const rows = [...document.querySelectorAll('[data-mid]')]
  check('D message rows carry data-mid', rows.length === 2 && rows.some((r) => r.getAttribute('data-mid') === 'm2'), rows.map((r) => r.getAttribute('data-mid')).join(','))
  check('D the picked row flashes', document.querySelector('[data-mid="m2"]')?.classList.contains('flash'), document.querySelector('[data-mid="m2"]')?.className)
  check('D the other row does not', !document.querySelector('[data-mid="m1"]')?.classList.contains('flash'))
  check('D the row was scrolled into view', scrollSpans.some((s) => s.el.getAttribute?.('data-mid') === 'm2' && s.opts?.block === 'center'), JSON.stringify(scrollSpans.map((s) => s.el.className).slice(0, 6)))

  await wait(650)
  check('D the target clears after the jump', st().scrollTarget === null, JSON.stringify(st().scrollTarget))
  check('D the flash survives the clear', document.querySelector('[data-mid="m2"]')?.classList.contains('flash'))
  await wait(2300)
  check('D the flash fades on its own', !document.querySelector('[data-mid="m2"]')?.classList.contains('flash'), document.querySelector('[data-mid="m2"]')?.className)
}

// --- E. wiring / static --------------------------------------------------------------------
{
  const api = rd('src/shared/api.ts')
  check('E ChatSearchHit type defined (no name clash)', api.includes('export interface ChatSearchHit') && api.split('export interface SearchHit').length === 2)
  check('E sessions.search in the api type', api.includes('search(q: string): Promise<ChatSearchHit[]>'))
  const preload = rd('src/preload/index.ts')
  check('E preload bridges sessions:search', preload.includes("ipcRenderer.invoke('sessions:search'"))
  const index = rd('src/main/index.ts')
  check('E IPC handler registered', index.includes("ipcMain.handle('sessions:search'") && index.includes('searchSessions('))
  const store = rd('src/main/store.ts')
  check('E searchSessions exported', store.includes('export function searchSessions'))
  const app = rd('src/renderer/src/App.tsx')
  check('E App mounts the overlay', app.includes('<SearchOverlay />') && app.includes('components/SearchOverlay'))
  check('E Ctrl+Shift+F toggles it', app.includes("e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f'") && app.includes('setSearchOpen(!useApp.getState().searchOpen)'))
  const palette = rd('src/renderer/src/components/Palette.tsx')
  check('E palette entry', palette.includes('Search every chat — full-text across sessions') && palette.includes("hint: 'Ctrl+Shift+F'"))
  const keys = rd('src/renderer/src/components/Shortcuts.tsx')
  check('E cheat-sheet row', keys.includes("['Search every chat', 'Ctrl+Shift+F']"))
  const chat = rd('src/renderer/src/components/ChatView.tsx')
  check('E rows carry data-mid', (chat.match(/data-mid=\{m\.id\}/g) ?? []).length === 2, String((chat.match(/data-mid=\{m\.id\}/g) ?? []).length))
  check('E the flash class + scroll effect', chat.includes('flashId === m.id') && chat.includes('scrollIntoView({ block:') && chat.includes('clearScrollTarget()'))
  const css = rd('src/renderer/src/styles/global.css')
  check('E css block 32 after 31', css.includes('32 — v3.1 chat search') && css.indexOf('32 — v3.1') > css.indexOf('31 — v3.1'))
  check('E overlay + flash styles', css.includes('.search-overlay') && css.includes('.search-hit mark') && css.includes('@keyframes rowFlash'))
  check('E motion-off keeps a static ring', css.includes("html[data-motion='off'] .msg-row.flash .msg"))
}

// --- cleanup + summary -----------------------------------------------------------------------
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

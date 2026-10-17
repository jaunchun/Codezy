// Batch 26 — v3.1 code-block actions:
//  A. applyCodeBlock (main): full-overwrite of an existing file goes through
//     applyEdits — backup written, /undo restores the old content; new files
//     land with prev=null (undo deletes them); ../ and absolute-outside paths
//     refused; binary files refused; no linked folders refused.
//  B. CodeBlock UI (jsdom): header shows lang/lines/bytes, copy works, save
//     opens the save dialog with snippet.<ext> and reports a notice, apply
//     appears only for sessions with a linked folder, the inline path row
//     writes via files.applyBlock, errors land as error notices.
//  C. wiring/static: IPC handler + preload + api type, exports, CSS block 30.
// Deterministic: fixture files under tests/.tmp, fake bridge, no model.
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
const OUT = path.join(PROJ, 'tests', '.tmp', `b26-${Date.now() % 100000}`)
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
    platform: 'node',
    logLevel: 'silent',
    ...opts
  })
  return import(pathToFileURL(out).href)
}

// --- A. applyCodeBlock (main) ----------------------------------------------------
// ONE bundle so edits.ts and store.ts share module state (initStore moves the
// backup dir into tests/.tmp — nothing may ever land outside the project).
const TDIR = path.join(OUT, 'data')
const ROOT = path.join(OUT, 'proj')
fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'src', 'app.ts'), 'let a = 1\n', 'utf8')
fs.writeFileSync(path.join(ROOT, 'bin.dat'), Buffer.from([0x00, 0x01, 0xff, 0x41]))
const E = await bundle(
  [
    `export { applyCodeBlock, applyEdits, undoLast } from '${PROJ}/src/main/edits'`,
    `export { initStore } from '${PROJ}/src/main/store'`
  ].join('\n'),
  'edits.mjs',
  { alias: ELECTRON_ALIAS, platform: 'node' }
)
E.initStore(TDIR)
const S = { id: 's26', linkedFolders: [ROOT] }

{
  // full overwrite: the whole old file is the search text
  const out = E.applyCodeBlock(S, 'src/app.ts', 'let a = 2 // edited\n')
  check('A overwrite writes the new content', fs.readFileSync(path.join(ROOT, 'src', 'app.ts'), 'utf8') === 'let a = 2 // edited\n')
  check('A overwrite returns a backup id', out.backupId != null && typeof out.saved === 'string', JSON.stringify(out))
  // /undo puts the old content back
  const undo = E.undoLast('s26')
  check('A /undo restores the previous content', undo.restored === 1 && fs.readFileSync(path.join(ROOT, 'src', 'app.ts'), 'utf8') === 'let a = 1\n', undo.message)

  // new file (nested) → created, undo DELETES it again
  const out2 = E.applyCodeBlock(S, 'docs/deep/new.md', '# fresh\n')
  check('A new file created through the engine', fs.readFileSync(path.join(ROOT, 'docs', 'deep', 'new.md'), 'utf8') === '# fresh\n', JSON.stringify(out2))
  const undo2 = E.undoLast('s26')
  check('A undoing a new file removes it', undo2.restored === 1 && !fs.existsSync(path.join(ROOT, 'docs', 'deep', 'new.md')), undo2.message)

  // confinement: traversal + absolute-outside + absolute drive path
  const refused = (fn) => {
    try {
      fn()
      return ''
    } catch (e) {
      return e.message
    }
  }
  check('A ../ traversal refused', refused(() => E.applyCodeBlock(S, '../evil.txt', 'x')).includes('inside the linked folder'))
  check('A backslash traversal refused', refused(() => E.applyCodeBlock(S, '..\\evil.txt', 'x')).includes('inside the linked folder'))
  check('A absolute outside refused', refused(() => E.applyCodeBlock(S, 'C:/Windows/win.ini', 'x')).includes('inside the linked folder'))
  check('A empty path refused', refused(() => E.applyCodeBlock(S, '   ', 'x')).includes('inside the linked folder'))

  // binary guard — a non-UTF-8 file is never overwritten
  check('A binary file refused', refused(() => E.applyCodeBlock(S, 'bin.dat', 'text')).includes('UTF-8'), refused(() => E.applyCodeBlock(S, 'bin.dat', 'text')))

  // no linked folder → refuses before touching anything
  check('A no linked folder refused', refused(() => E.applyCodeBlock({ id: 's0', linkedFolders: [] }, 'a.txt', 'x')).includes('Link a folder'))

  // relative path resolves inside the root's subfolder too
  E.applyCodeBlock(S, 'src/util/helper.ts', 'export {}\n')
  check('A deep relative path lands in the folder', fs.existsSync(path.join(ROOT, 'src', 'util', 'helper.ts')))
  E.undoLast('s26')
}

// --- jsdom: the CodeBlock UI -------------------------------------------------------
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
// ChatView reads CSS.highlights at import (find bar feature detection) —
// jsdom has no CSS object; an empty one flips supportsFind off cleanly
defineGlobal('CSS', {})
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// --- fake bridge --------------------------------------------------------------------
const saveCalls = []
const applyCalls = []
let applyImpl = async (sid, p, content) => {
  applyCalls.push([sid, p, content])
  return { saved: p, backupId: '123' }
}
const mock = {
  dialog: {
    saveText: async (name, content) => {
      saveCalls.push([name, content])
      return `C:/Downloads/${name}`
    }
  },
  files: { applyBlock: (...a) => applyImpl(...a) },
  ide: { read: async () => null },
  edits: { apply: async () => ({ applied: [], errors: [] }) },
  sessions: { save: async (s) => s },
  chat: { v2decision: async () => {} },
  settings: { get: async () => ({}), set: async (p) => p }
}
dom.window.codezy = mock
defineGlobal('codezy', mock)

// copy button → clipboard must exist on the jsdom navigator
const clipCalls = []
Object.defineProperty(dom.window.navigator, 'clipboard', {
  value: { writeText: async (t) => clipCalls.push(t) },
  configurable: true
})

const ui = await bundle(
  [
    `export { CodeBlock } from '${PROJ}/src/renderer/src/components/ChatView'`,
    `export { useApp } from '${PROJ}/src/renderer/src/store/app'`,
    `export { createRoot } from 'react-dom/client'`,
    `export { act } from 'react'`,
    `export { createElement } from 'react'`
  ].join('\n'),
  'ui.mjs',
  { platform: 'browser', jsx: 'automatic', define: { __APP_VERSION__: JSON.stringify('0.0.0-test') } }
)
const { createElement: h } = ui
const st = () => ui.useApp.getState()

const settle = async (n = 6) => {
  await ui.act(async () => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
  })
}
const root = ui.createRoot(document.getElementById('root'))
const render = async (el) => {
  await ui.act(async () => {
    root.render(el)
  })
  await settle()
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
const btnByTitle = (t) => [...document.querySelectorAll('button')].find((b) => b.title === t)
const btn = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label)
const lastNotice = () => st().notices.at(-1)

// the store the block reads for linked folders
ui.useApp.setState({
  sessions: [
    {
      id: 's1',
      projectId: null,
      title: 't',
      createdAt: 1,
      updatedAt: 1,
      linkedFolders: ['C:/fake-project'],
      messages: []
    },
    { id: 's-empty', projectId: null, title: 'e', createdAt: 1, updatedAt: 1, linkedFolders: [], messages: [] }
  ],
  activeId: 's1',
  notices: []
})

const CODE = ['const x = 1', 'const y = 2', 'console.log(x, y)'].join('\n')

// --- B. CodeBlock UI -----------------------------------------------------------------
{
  await render(h(ui.CodeBlock, { lang: 'ts', code: CODE, sessionId: 's1' }))
  const head = document.querySelector('.codeblock header span')?.textContent ?? ''
  check('B header shows lang, lines and bytes', head.includes('TS') && head.includes('3 lines') && head.includes('B'), head)

  await click(btnByTitle('Copy the whole block'))
  check('B copy sends the block to the clipboard', clipCalls.length === 1 && clipCalls[0] === CODE, JSON.stringify(clipCalls))
  check('B copy shows feedback', btn('copied') != null)

  await click(btnByTitle('Save the block as a file…'))
  check('B save opens the dialog with snippet.<ext>', saveCalls.length === 1 && saveCalls[0][0] === 'snippet.ts' && saveCalls[0][1] === CODE, JSON.stringify(saveCalls[0]?.[0]))
  check('B save reports the path in a notice', (lastNotice()?.text ?? '').includes('Saved the block to C:/Downloads/snippet.ts'), lastNotice()?.text)

  // apply: visible with a linked folder, inline row prefilled with the name
  check('B apply button present for a linked session', btnByTitle('Write the block into the linked folder — backed up like every edit, /undo reverts it') != null)
  await click(btnByTitle('Write the block into the linked folder — backed up like every edit, /undo reverts it'))
  const input = document.querySelector('.code-apply input')
  check('B inline path row opens prefilled with snippet.ts', input != null && input.value === 'snippet.ts', input?.value)
  await type(input, 'src/deep.ts')
  await click(btn('write'))
  check('B write calls files.applyBlock', applyCalls.length === 1 && applyCalls[0][0] === 's1' && applyCalls[0][1] === 'src/deep.ts' && applyCalls[0][2] === CODE, JSON.stringify(applyCalls[0]?.slice(0, 2)))
  check('B write success notice mentions /undo', (lastNotice()?.text ?? '').includes('Wrote src/deep.ts') && (lastNotice()?.text ?? '').includes('/undo'), lastNotice()?.text)
  check('B inline row closes after writing', document.querySelector('.code-apply') == null)

  // error path → error notice, row stays open for a fix
  applyImpl = async () => {
    throw new Error('outside the linked folders — refused.')
  }
  await click(btnByTitle('Write the block into the linked folder — backed up like every edit, /undo reverts it'))
  await click(btn('write'))
  const err = lastNotice()
  check('B write failure lands as an error notice', err?.kind === 'error' && err.text.includes('Could not write snippet.ts') && err.text.includes('outside the linked folders'), JSON.stringify(err))
  check('B failed write keeps the row open', document.querySelector('.code-apply') != null)
  applyImpl = async (sid, p, content) => {
    applyCalls.push([sid, p, content])
    return { saved: p, backupId: '124' }
  }
  await click(btn('✕'))
  check('B cancel closes the row', document.querySelector('.code-apply') == null)

  // apply hidden without a folder / without a session
  await render(h(ui.CodeBlock, { lang: 'ts', code: CODE, sessionId: 's-empty' }))
  check('B no apply button without a linked folder', [...document.querySelectorAll('button')].every((b) => !b.title.startsWith('Write the block into')))
  await render(h(ui.CodeBlock, { lang: 'ts', code: CODE, sessionId: null }))
  check('B no apply button without a session', [...document.querySelectorAll('button')].every((b) => !b.title.startsWith('Write the block into')))
  // save/copy still work without a session
  const before = saveCalls.length
  await click(btnByTitle('Save the block as a file…'))
  check('B save works without a session', saveCalls.length === before + 1)

  // single-line block: no "lines" suffix, no line gutter
  await render(h(ui.CodeBlock, { lang: 'py', code: 'print(1)', sessionId: null }))
  const head2 = document.querySelector('.codeblock header span')?.textContent ?? ''
  check('B single-line block says PY without a line count', head2.includes('PY') && !head2.includes('lines'), head2)
  check('B single-line block has no gutter', document.querySelector('.line-nums') == null)
}

// --- C. wiring / static ----------------------------------------------------------------
{
  const index = rd('src/main/index.ts')
  check('C IPC handler files:applyBlock', index.includes("ipcMain.handle('files:applyBlock'"))
  check('C handler delegates to applyCodeBlock', index.includes('applyCodeBlock(session, target, content)') && index.includes("from './edits'"))
  const edits = rd('src/main/edits.ts')
  check('C applyCodeBlock exported from edits.ts', edits.includes('export function applyCodeBlock'))
  check('C applyCodeBlock shares the backup machinery', edits.includes('applyEdits(session, [{ path: rel, search'))
  const api = rd('src/shared/api.ts')
  check('C api type has files.applyBlock', api.includes('applyBlock(sessionId: string, path: string, content: string)'))
  const preload = rd('src/preload/index.ts')
  check('C preload wires files:applyBlock', preload.includes("ipcRenderer.invoke('files:applyBlock'"))
  const chat = rd('src/renderer/src/components/ChatView.tsx')
  check('C CodeBlock exported for tests', chat.includes('export function CodeBlock'))
  check('C save + apply buttons in the header', chat.includes('Save the block as a file…') && chat.includes('files.applyBlock'))
  check('C AssistantText threads the sessionId', chat.includes('<CodeBlock lang={lang} code={raw} sessionId={sessionId} />'))
  const css = rd('src/renderer/src/styles/global.css')
  check('C css block 30 after 29', css.includes('30 — v3.1 code-block actions') && css.indexOf('30 — v3.1') > css.indexOf('29 — v3'))
  check('C .code-apply styles present', css.includes('.code-apply input'))
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

// Batch 23 — v3 review-first editing:
//  A. shared hunk engine: toHunks grouping (distant changes split, nearby
//     merge, context bounds) + composeHunks (keep all = new text, keep none =
//     old text, subset = the rest exactly as it was) + changeCounts.
//  B. DiffFile review UI (jsdom): hunk toolbar counts, per-hunk toggles dim
//     skipped hunks, composed text reported upward (null = all kept).
//  C. ApproveModal real diffs (jsdom): write_file reads the current file and
//     shows the delta, edit_file diffs old/new, background run_command gets
//     its own description, raw args collapse under a <details>.
//  D. store acceptEdits overrides: a composed replace is what gets written,
//     every hunk off writes nothing, no override = old behaviour intact.
//  E. wiring/static: CSS block 27, DiffFile export, modal reuse, store gate.
// Deterministic: fake bridge, scripted resolve, no model, no network.
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

// --- bundle the renderer pieces (same pattern as batch21) ----------------------
// OUT must live INSIDE the project so esbuild resolves react/node_modules by
// walking up from the entry file.
const OUT = path.join(PROJ, 'tests', '.tmp', `b23-${Date.now() % 100000}`)
fs.mkdirSync(OUT, { recursive: true })

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

// --- fake bridge ----------------------------------------------------------------
const applyCalls = []
const saveCalls = []
let ideReadImpl = async () => null
const mock = {
  ide: { read: (...a) => ideReadImpl(...a) },
  edits: {
    apply: async (_sid, edits) => {
      applyCalls.push(edits)
      return { applied: edits.map((e) => ({ path: e.path })), errors: [] }
    }
  },
  sessions: {
    save: async (s) => {
      saveCalls.push(s)
      return s
    }
  },
  chat: { v2decision: async () => {} },
  settings: { get: async () => ({}), set: async (p) => p }
}
dom.window.codezy = mock
defineGlobal('codezy', mock)

const entry = path.join(OUT, 'entry.tsx')
fs.writeFileSync(
  entry,
  [
    `export { DiffFile } from '${PROJ}/src/renderer/src/components/EditCard'`,
    `export { default as ApproveModal } from '${PROJ}/src/renderer/src/components/ApproveModal'`,
    `export { useApp } from '${PROJ}/src/renderer/src/store/app'`,
    `export { diffLines, toHunks, composeHunks, parseEdits, changeCounts } from '${PROJ}/src/shared/edits'`,
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
const { createElement: h } = ui

const flush = async (n = 6) => {
  // inside act so promise-driven setStates (e.g. the modal's file read)
  // land without React act() warnings
  await ui.act(async () => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
  })
}
const root = ui.createRoot(document.getElementById('root'))
const render = async (el) => {
  await ui.act(async () => {
    root.render(el)
  })
  await flush()
}
const click = async (el) => {
  await ui.act(async () => {
    el.click()
  })
  await flush()
}
const btn = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label)

// A two-hunk edit: line 1 and line 10 change, everything between is context.
const SEARCH = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'].join('\n') + '\n'
const REPLACE = ['ALPHA', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'KAPPA'].join('\n') + '\n'
const BLOCK = `===FILE: notes.txt\n===SEARCH\n${SEARCH}===REPLACE\n${REPLACE}===END`

// --- A. the hunk engine ----------------------------------------------------------
{
  const diff = ui.diffLines(SEARCH, REPLACE)
  const hunks = ui.toHunks(diff)
  check('A distant changes split into 2 hunks', hunks.length === 2, JSON.stringify(hunks.map((x) => [x.added, x.removed])))
  check('A each hunk is +1/-1', hunks.every((x) => x.added === 1 && x.removed === 1))
  check(
    'A hunk carries context lines',
    hunks[0].lines.some((l) => l.type === 'ctx') && hunks[1].lines.some((l) => l.type === 'ctx')
  )
  check('A keep-all equals the new text', ui.composeHunks(diff, hunks, [0, 1]) === REPLACE)
  check('A keep-none equals the old text', ui.composeHunks(diff, hunks, []) === SEARCH)
  const keepFirst = ui.composeHunks(diff, hunks, [0])
  check('A subset keeps only the ticked hunk', keepFirst === REPLACE.replace('KAPPA', 'kappa'), JSON.stringify(keepFirst.slice(-12)))
  const keepLast = ui.composeHunks(diff, hunks, [1])
  check('A subset works the other way too', keepLast === REPLACE.replace('ALPHA', 'alpha'))

  // nearby changes (2 context lines apart) merge into one hunk
  const nearDiff = ui.diffLines('a\nb\nc\nd\ne\n', 'A\nb\nC\nd\ne\n')
  check('A nearby changes merge into 1 hunk', ui.toHunks(nearDiff).length === 1, JSON.stringify(ui.toHunks(nearDiff)))

  // brand-new file: every line is an addition, one hunk, keep-none = ""
  const newDiff = ui.diffLines('', 'fresh\nfile\n')
  const newHunks = ui.toHunks(newDiff)
  // "fresh", "file" and the trailing empty line from the final \n → 3 adds
  check('A new file is one all-add hunk', newHunks.length === 1 && newHunks[0].added === 3 && newHunks[0].removed === 0, JSON.stringify(newHunks.map((x) => [x.added, x.removed])))
  check('A new file keep-none = nothing', ui.composeHunks(newDiff, newHunks, []) === '')

  const counts = ui.changeCounts(SEARCH, keepFirst)
  check('A changeCounts reflects the composed text', counts.added === 1 && counts.removed === 1, JSON.stringify(counts))
}

// --- B. DiffFile review UI ---------------------------------------------------------
{
  const edit = ui.parseEdits(BLOCK)[0]
  check('B parseEdits feeds the card', !!edit && edit.path === 'notes.txt', edit?.path)
  let lastCompose = 'unset'
  await render(
    h(ui.DiffFile, {
      edit,
      review: { onCompose: (t) => (lastCompose = t) }
    })
  )
  const hunks = () => [...document.querySelectorAll('.diff-hunk')]
  check('B renders one block per hunk', hunks().length === 2, String(hunks().length))
  check('B toolbar counts the selection', document.querySelector('.hunk-count')?.textContent.includes('2 of 2'), document.querySelector('.hunk-count')?.textContent)
  check('B all-kept reports no override (null)', lastCompose === null, String(lastCompose))

  const boxes = [...document.querySelectorAll('.hunk-pick input')]
  check('B every hunk gets a toggle', boxes.length === 2, String(boxes.length))
  await click(boxes[1])
  check('B skipping a hunk dims its block', document.querySelectorAll('.diff-hunk.off').length === 1)
  const expectedDiff = ui.diffLines(edit.search, edit.replace)
  const expected = ui.composeHunks(expectedDiff, ui.toHunks(expectedDiff), [0])
  check(
    'B composed text reported for the subset',
    lastCompose === expected && lastCompose !== null,
    JSON.stringify({ got: String(lastCompose).slice(0, 24), exp: String(expected).slice(0, 24) })
  )

  await click(btn('none'))
  check('B none = the file exactly as it was', lastCompose === edit.search, JSON.stringify(String(lastCompose).slice(0, 12)))
  check('B none dims every hunk', document.querySelectorAll('.diff-hunk.off').length === 2)
  await click(btn('all'))
  check('B all restores the full proposal', lastCompose === null && document.querySelectorAll('.diff-hunk.off').length === 0)

  // read-only DiffFile (no review prop) has no toggles at all
  await render(h(ui.DiffFile, { edit }))
  check('B read-only card has no hunk toggles', document.querySelectorAll('.hunk-pick input').length === 0)
}

// --- C. ApproveModal real diffs ------------------------------------------------------
{
  ideReadImpl = async () => ({ content: SEARCH, truncated: false })
  // the modal reads the current file through the ACTIVE session's folders —
  // without an activeId it treats every write as a brand-new file. setState
  // goes through act because the modal may already be mounted.
  const setAsk = async (v2Ask) => {
    await ui.act(async () => {
      ui.useApp.setState({ v2Ask, activeId: 's1' })
    })
    await flush()
  }

  // write_file over an existing file → the delta against the real content
  await setAsk({ id: 'q1', name: 'write_file', args: { path: 'notes.txt', content: REPLACE } })
  await render(h(ui.ApproveModal))
  check('C write_file shows a diff card', !!document.querySelector('.approve-diff .diff-file'))
  const adds = [...document.querySelectorAll('.approve-diff .diff-line.add')].map((d) => d.textContent)
  const dels = [...document.querySelectorAll('.approve-diff .diff-line.del')].map((d) => d.textContent)
  check('C the delta is real (ALPHA in, alpha out)', adds.some((t) => t.includes('ALPHA')) && dels.some((t) => t.includes('alpha')), JSON.stringify({ adds, dels }))
  const rawKeys = [...document.querySelectorAll('.approve-raw .approve-arg b')].map((b) => b.textContent)
  check('C raw args collapse and drop the bulky keys', !!document.querySelector('.approve-raw') && !rawKeys.includes('content') && rawKeys.includes('path'), rawKeys.join(','))

  // write_file of a NEW file → all-add diff
  ideReadImpl = async () => null
  await setAsk({ id: 'q2', name: 'write_file', args: { path: 'brand-new.txt', content: 'hello\n' } })
  await render(h(ui.ApproveModal))
  check('C a new file diffs against nothing', document.querySelectorAll('.approve-diff .diff-line.del').length === 0 && document.querySelectorAll('.approve-diff .diff-line.add').length > 0)

  // edit_file → the fragments themselves become the diff
  await setAsk({ id: 'q3', name: 'edit_file', args: { path: 'notes.txt', old: 'const a = 1\n', new: 'const a = 2\n' } })
  await render(h(ui.ApproveModal))
  check('C edit_file shows its old/new diff', !!document.querySelector('.approve-diff .diff-file') && document.querySelector('.approve-diff .diff-line.add')?.textContent.includes('const a = 2'))

  // background command gets its own description and no diff
  await setAsk({ id: 'q4', name: 'run_command', args: { command: 'npm run dev', background: true } })
  await render(h(ui.ApproveModal))
  check('C background task described as such', document.querySelector('.approve-modal h2')?.textContent.includes('start this background task'), document.querySelector('.approve-modal h2')?.textContent)
  check('C commands never get a diff card', !document.querySelector('.approve-diff'))

  await setAsk(null)
  await render(h(ui.ApproveModal))
  check('C no ask → no dialog', !document.querySelector('.approve-modal'))
}

// --- D. store acceptEdits overrides ----------------------------------------------------
{
  const mkSession = (id) => ({
    id,
    projectId: null,
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    linkedFolders: ['C:/fake-project'],
    messages: [{ id: `m-${id}`, role: 'assistant', content: BLOCK, ts: 1 }]
  })
  const boot = async (id) => {
    applyCalls.length = 0
    saveCalls.length = 0
    ui.useApp.setState({ sessions: [mkSession(id)], activeId: id })
    return `m-${id}`
  }
  const composedKeepFirst = REPLACE.replace('KAPPA', 'kappa')

  // an override writes the COMPOSED text — the ticked hunk only
  const mid = await boot('sA')
  await st().acceptEdits(mid, undefined, { 0: composedKeepFirst })
  check('D override reaches the write engine', applyCalls.length === 1 && applyCalls[0][0].replace === composedKeepFirst, JSON.stringify(applyCalls[0]?.[0]?.replace?.slice(-12)))
  check('D counts recomputed for the composed text', applyCalls[0][0].added === 1 && applyCalls[0][0].removed === 1, JSON.stringify({ a: applyCalls[0][0].added, r: applyCalls[0][0].removed }))
  const savedA = saveCalls.at(-1)
  check('D message marked resolved after the partial write', savedA?.resolvedEdits?.includes(mid), JSON.stringify({ re: savedA?.resolvedEdits, ae: savedA?.appliedEdits }))

  // every hunk off → nothing is written at all
  const midB = await boot('sB')
  await st().acceptEdits(midB, undefined, { 0: SEARCH })
  check('D all hunks off writes nothing', applyCalls.length === 0, String(applyCalls.length))

  // no override → the proposal lands exactly as the model wrote it
  const midC = await boot('sC')
  await st().acceptEdits(midC)
  check('D no override keeps old behaviour', applyCalls.length === 1 && applyCalls[0][0].replace === REPLACE)

  // a mixed batch: one file overridden, one untouched
  const midD = await boot('sD')
  const s = st().sessions[0]
  s.messages[0].content = BLOCK + '\n' + BLOCK.replace('notes.txt', 'notes2.txt')
  ui.useApp.setState({ sessions: [{ ...s }] })
  await st().acceptEdits(midD, undefined, { 1: composedKeepFirst })
  check('D mixed batch: only the ticked file is composed', applyCalls.length === 1 && applyCalls[0].length === 2 && applyCalls[0][0].replace === REPLACE && applyCalls[0][1].replace === composedKeepFirst, JSON.stringify(applyCalls[0]?.map((e) => e.path)))
}

// --- E. wiring / static --------------------------------------------------------------
{
  const css = fs.readFileSync(path.join(PROJ, 'src/renderer/src/styles/global.css'), 'utf8')
  check('E css block 27 present after 26b', css.includes('27 — v3 review-first editing') && css.indexOf('27 — v3') > css.indexOf('26b — v2.6'))
  check('E hunk + approve-diff styles', css.includes('.diff-hunk') && css.includes('.approve-diff') && css.includes('.hunk-pick'))
  const editCard = fs.readFileSync(path.join(PROJ, 'src/renderer/src/components/EditCard.tsx'), 'utf8')
  check('E DiffFile is exported for reuse', /export function DiffFile/.test(editCard))
  check('E EditCard composes overrides', /composeHunks/.test(editCard))
  const modal = fs.readFileSync(path.join(PROJ, 'src/renderer/src/components/ApproveModal.tsx'), 'utf8')
  check('E modal reuses DiffFile', modal.includes("from './EditCard'") && modal.includes('approve-diff'))
  const store = fs.readFileSync(path.join(PROJ, 'src/renderer/src/store/app.ts'), 'utf8')
  check('E store gates on overrides', store.includes('overrides?.[i]') && store.includes('changeCounts'))
}

// --- cleanup + summary -------------------------------------------------------------------
try {
  fs.rmSync(OUT, { recursive: true, force: true })
} catch { /* best effort */ }

console.log('')
console.log(fails.length ? `${fails.length} FAIL:\n  ${fails.join('\n  ')}` : 'ALL PASS')
process.exitCode = fails.length ? 1 : 0
// jsdom keeps handles open — exit explicitly so the suite doesn't hang
process.exit(fails.length ? 1 : 0)

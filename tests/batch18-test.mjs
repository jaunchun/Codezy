// ---------------------------------------------------------------------------
// batch18 — the AI-quality + safety fixes from the v2.4 bug-hunt pass:
//   1. harness (direct import): repairJson (quotes/comments/auto-close),
//      parseTextToolCall (gate, multi-call, dedupe, cap, known filter)
//   2. fitContext: shrink-never-drop, recent tool rounds stay whole, idempotent
//   3. runAgent (mocked model): id pairing — given API ids survive, missing
//      ids get assigned, tool_call_id always set
//   4. registry: read_file offset/limit paging + head/tail truncation ending
//      in `…[truncated]`, list_dir dirs-first natural order, traversal refusal
//   5. main edits.ts (esbuild): backup BEFORE write (refusal ⇒ nothing
//      changed), non-UTF-8 refusal, CRLF kept, traversal refused, undo
//      dedupe-keeps-earliest + partial-undo stays retryable
//   6. store.ts (esbuild): boot pointer, saveSettings re-root patch, corrupt
//      file moved aside
//   7. files.ts (esbuild): ideRead {content, truncated} + ideSaveWouldTruncate
//   8. TUI edits.mjs (direct import): the same four safety rules terminal-side
//
// Everything (bundles, fixtures, fake HOME) lives under tests/.tmp.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJ = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

// The bundles bake os.homedir() into DEFAULT_DATA_DIR at import time — the
// fake HOME must be set BEFORE anything is imported, so no test can ever
// touch the real ~/.codezy.
const HOME18 = path.join(__dirname, '.tmp', `b18-home-${Date.now()}`)
const OUT = path.join(__dirname, '.tmp', `b18-${Date.now()}`)
fs.mkdirSync(HOME18, { recursive: true })
fs.mkdirSync(OUT, { recursive: true })
process.env.USERPROFILE = HOME18
process.env.HOME = HOME18

process.on('exit', () => {
  for (const d of [OUT, HOME18]) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

// -- fixtures ----------------------------------------------------------------
const ROOT = path.join(OUT, 'harness-root') // registry root
const ROOT_M = path.join(OUT, 'main-root') // main edits.ts root
const ROOT_T = path.join(OUT, 'tui-root') // TUI edits.mjs root
for (const d of [ROOT, ROOT_M, ROOT_T]) fs.mkdirSync(d, { recursive: true })

const pagedLines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`)
fs.writeFileSync(path.join(ROOT, 'paged.txt'), pagedLines.join('\n'), 'utf8')
const bigLines = Array.from({ length: 4000 }, (_, i) => `L${i} ${'x'.repeat(45)}`)
fs.writeFileSync(path.join(ROOT, 'big.txt'), bigLines.join('\n'), 'utf8')
for (const dir of ['zdir', 'adir2', 'bdir10', 'bdir9']) fs.mkdirSync(path.join(ROOT, dir))
for (const f of ['10.txt', '2.txt', 'aaa.txt']) fs.writeFileSync(path.join(ROOT, f), 'x', 'utf8')
fs.writeFileSync(path.join(OUT, 'outside.txt'), 'secret', 'utf8') // traversal bait

const alphaContent = 'alpha beta gamma\n'
fs.writeFileSync(path.join(ROOT_M, 'alpha.txt'), alphaContent, 'utf8')
fs.writeFileSync(path.join(ROOT_M, 'crlf.txt'), 'line1\r\nline2\r\nline3\r\n', 'utf8')
const latin1Bytes = Buffer.from([0x61, 0x62, 0xc9, 0x63, 0x0a]) // é as Latin-1 — invalid UTF-8
fs.writeFileSync(path.join(ROOT_M, 'latin1.txt'), latin1Bytes)
fs.writeFileSync(path.join(ROOT_T, 'alpha.txt'), alphaContent, 'utf8')
fs.writeFileSync(path.join(ROOT_T, 'crlf.txt'), 'line1\r\nline2\r\nline3\r\n', 'utf8')
const latin1BytesT = Buffer.from([0x61, 0x62, 0xc9, 0x63, 0x0a])
fs.writeFileSync(path.join(ROOT_T, 'latin1.txt'), latin1BytesT)

// -- builds (esbuild, electron stubbed — same pattern as batch12) ------------
const stub = path.join(OUT, 'electron-stub.mjs')
fs.writeFileSync(stub, 'export const app = { getPath: () => "" }\nexport default { app }\n')
const { build } = require('esbuild')
const bundle = (entry, out) =>
  build({
    entryPoints: [path.join(PROJ, 'src', 'main', entry)],
    outfile: path.join(OUT, 'dist', out),
    bundle: true,
    format: 'esm',
    platform: 'node',
    alias: { electron: stub },
    logLevel: 'silent'
  })
await Promise.all([bundle('store.ts', 'store.mjs'), bundle('edits.ts', 'edits.mjs'), bundle('files.ts', 'files.mjs')])

// -- 1+2+3. harness: repair / parse / fitContext / runAgent ------------------
const harness = await import(pathToFileURL(path.join(PROJ, 'cli', 'lib', 'harness.mjs')).href)
const KNOWN = new Set(['list_dir', 'read_file', 'write_file', 'grep_search'])

{
  // smart quotes as delimiters
  const j1 = JSON.parse(harness.repairJson('{\u201Cname\u201D: \u201Clist_dir\u201D, \u201Carguments\u201D: {\u201Cpath\u201D: \u201C.\u201D}}'))
  check('repair: smart quotes become JSON', j1.name === 'list_dir' && j1.arguments.path === '.', JSON.stringify(j1))

  // single quotes + line comment + trailing comma in one blob
  const j2 = JSON.parse(
    harness.repairJson("{\n  'name': 'read_file', // the tool\n  'arguments': {'path': 'a.txt',},\n}")
  )
  check('repair: single quotes + comment + trailing comma', j2.name === 'read_file' && j2.arguments.path === 'a.txt', JSON.stringify(j2))

  // `//` inside a STRING must survive the comment stripper
  const j3 = JSON.parse(harness.repairJson('{"path": "src//lib", "n": 1,}'))
  check('repair: // inside a string is not a comment', j3.path === 'src//lib' && j3.n === 1, JSON.stringify(j3))

  // reply cut off mid-object → auto-close everything
  const j4 = JSON.parse(harness.repairJson('{"name": "write_file", "arguments": {"path": "a.txt", "content": "hel'))
  check('repair: truncated reply auto-closes', j4.name === 'write_file' && j4.arguments.path === 'a.txt' && j4.arguments.content === 'hel', JSON.stringify(j4))

  const j5 = JSON.parse(harness.repairJson('{"a": /* block */ 1}'))
  check('repair: block comment stripped', j5.a === 1, JSON.stringify(j5))
}

{
  const single = harness.parseTextToolCall("Sure: {'name': 'list_dir', 'arguments': {'path': '.'}}", KNOWN)
  check('text-call: single-quoted keys accepted by the gate', single.length === 1 && single[0].function.name === 'list_dir' && single[0].function.arguments.path === '.', JSON.stringify(single))

  const smart = harness.parseTextToolCall('Reply: {\u201Cname\u201D: \u201Cread_file\u201D, \u201Carguments\u201D: {\u201Cpath\u201D: \u201Cb.txt\u201D}}', KNOWN)
  check('text-call: smart-quoted object accepted', smart.length === 1 && smart[0].function.name === 'read_file' && smart[0].function.arguments.path === 'b.txt', JSON.stringify(smart))

  const two = harness.parseTextToolCall(
    'First {"name": "list_dir", "arguments": {"path": "."}} then {"name": "read_file", "arguments": {"path": "paged.txt"}}.',
    KNOWN
  )
  check('text-call: TWO calls in one reply', two.length === 2 && two[0].function.name === 'list_dir' && two[1].function.name === 'read_file', JSON.stringify(two.map((c) => c.function.name)))

  const obj = '{"name": "read_file", "arguments": {"path": "a.txt"}}'
  const deduped = harness.parseTextToolCall('```json\n' + obj + '\n```\nprose echoes ' + obj + ' again', KNOWN)
  check('text-call: fence + prose echo deduped', deduped.length === 1, `len=${deduped.length}`)

  const nine = Array.from({ length: 9 }, (_, i) => `{"name": "read_file", "arguments": {"path": "f${i}.txt"}}`).join(' and ')
  const capped = harness.parseTextToolCall(nine, KNOWN)
  check('text-call: capped at 7', capped.length === 7, `len=${capped.length}`)

  const filtered = harness.parseTextToolCall(
    '{"name": "codezy", "version": "1.0"} and {"name": "list_dir", "arguments": {"path": "."}}',
    KNOWN
  )
  check('text-call: unknown names filtered out', filtered.length === 1 && filtered[0].function.name === 'list_dir', JSON.stringify(filtered))

  const argsAlias = harness.parseTextToolCall("{'name': 'read_file', 'args': {'path': 'x'}}", KNOWN)
  check('text-call: `args` alias maps to arguments', argsAlias.length === 1 && argsAlias[0].function.arguments.path === 'x', JSON.stringify(argsAlias))
}

const mkMsgs = () => [
  { id: 'm0', role: 'system', content: 'SYSTEM'.padEnd(200, '.') },
  { id: 'm1', role: 'user', content: 'do the thing' },
  ...Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, role: 'tool', tool_call_id: `call_${i}`, content: 'Y'.repeat(6000) })),
  { id: 'm9', role: 'assistant', content: 'final answer' }
]
{
  const msgs = mkMsgs()
  const rolesBefore = msgs.map((m) => m.role).join(',')
  const recent2 = [msgs[6].content, msgs[7].content] // the two newest tool rounds
  const out = harness.fitContext(msgs)
  check('fitContext: never drops messages', out.length === msgs.length && out.map((m) => m.role).join(',') === rolesBefore, `len=${out.length}`)
  const tools = out.filter((m) => m.role === 'tool')
  check(
    'fitContext: old tool rounds shrink, newest 2 stay whole',
    tools.slice(0, 4).every((m) => m.content.length < 4100 && m.content.includes('trimmed to fit')) &&
      tools[4].content === recent2[0] &&
      tools[5].content === recent2[1],
    tools.map((m) => m.content.length).join('/')
  )
  check('fitContext: ids and tool_call_ids survive', out.every((m) => m.id) && out.filter((m) => m.role === 'tool').every((m) => m.tool_call_id), '')
  const first = JSON.stringify(out.map((m) => m.content))
  const again = JSON.stringify(harness.fitContext(msgs).map((m) => m.content))
  check('fitContext: idempotent (second run is a no-op)', first === again, '')
  check('fitContext: returns the array itself', out === msgs, '')

  const tight = [
    { id: 's', role: 'system', content: 'S' },
    { id: 'u', role: 'user', content: 'U'.repeat(50000) },
    { id: 't1', role: 'tool', tool_call_id: 'c1', content: 'Z'.repeat(3000) },
    { id: 't2', role: 'tool', tool_call_id: 'c2', content: 'Z'.repeat(3000) }
  ]
  harness.fitContext(tight, { budget: 40000 })
  const total = tight.reduce((n, m) => n + m.content.length, 0)
  check('fitContext: overshoot budget → halves oldest, total fits', total < 40000 && tight[1].content.includes('trimmed to fit') && tight.length === 4, `total=${total}`)
}

{
  const reg = harness.makeRegistry({ roots: [ROOT] })

  const full = await reg.read_file.run({ path: 'paged.txt' })
  check('read_file: small file comes back whole', full === pagedLines.join('\n'), `len=${full.length}`)

  const page = await reg.read_file.run({ path: 'paged.txt', offset: 10, limit: 5 })
  check(
    'read_file: offset/limit paging header + slice',
    page.startsWith('lines 10–14 of 50 (more after — next offset=15)') && page.includes('line-10') && page.includes('line-14') && !page.includes('line-15'),
    page.split('\n')[0]
  )

  const beyond = await reg.read_file.run({ path: 'paged.txt', offset: 99, limit: 5 })
  check('read_file: offset past EOF says so', beyond === '(file has only 50 lines)', beyond)

  const wholePage = await reg.read_file.run({ path: 'paged.txt', offset: 1, limit: 50 })
  check('read_file: first page with everything = no header', wholePage === pagedLines.join('\n'), `len=${wholePage.length}`)

  const big = await reg.read_file.run({ path: 'big.txt' })
  check(
    'read_file: big file → head+tail, ends with …[truncated] (TUI keys on it)',
    big.includes('L0 ') && big.includes('L3999') && big.endsWith('…[truncated]') && big.length < 31000 && big.includes('…[file has 4000 lines'),
    `len=${big.length}`
  )

  const escape = await reg.read_file.check({ path: '../outside.txt' })
  check('read_file: traversal outside the root refused', typeof escape === 'string' && escape.length > 0, String(escape))

  const listed = await reg.list_dir.run({ path: '.' })
  const expected = ['adir2/', 'bdir9/', 'bdir10/', 'zdir/', '2.txt', '10.txt', 'aaa.txt', 'big.txt', 'paged.txt'].join('\n')
  check('list_dir: folders first, natural (numeric) order', listed === expected, JSON.stringify(listed))

  // runAgent with a mocked model: id pairing for tool calls
  const calls = [
    { function: { name: 'list_dir', arguments: { path: '.' } } }, // API sent NO id
    { id: 'call_7', function: { name: 'read_file', arguments: { path: 'paged.txt' } } } // API id must survive
  ]
  let round = 0
  const res = await harness.runAgent({
    messages: [{ role: 'user', content: 'hi' }],
    registry: reg,
    callModel: async () => (round++ === 0 ? { content: '', tool_calls: calls } : { content: 'DONE' }),
    maxIter: 4
  })
  const asst = res.messages.find((m) => m.role === 'assistant' && m.tool_calls)
  const toolMsgs = res.messages.filter((m) => m.role === 'tool')
  check('runAgent: finishes with text', res.status === 'text' && res.text === 'DONE', `${res.status}/${res.text}`)
  check(
    'runAgent: given API id kept, missing id assigned',
    asst?.tool_calls?.length === 2 && asst.tool_calls[1].id === 'call_7' && typeof asst.tool_calls[0].id === 'string' && asst.tool_calls[0].id.length > 0,
    JSON.stringify(asst?.tool_calls?.map((c) => c.id))
  )
  check(
    'runAgent: every tool message pairs with its tool_call_id',
    toolMsgs.length === 2 && toolMsgs.every((m) => asst.tool_calls.some((c) => c.id === m.tool_call_id)),
    JSON.stringify(toolMsgs.map((m) => m.tool_call_id))
  )
}

// -- 5. main edits.ts --------------------------------------------------------
const mainEdits = await import(pathToFileURL(path.join(OUT, 'dist', 'edits.mjs')).href)
const BACKUPS = path.join(HOME18, '.codezy', 'backups')
const sess = (id) => ({ id, linkedFolders: [ROOT_M] })
const edit = (path, search, replace, isNew = false) => ({ path, search, replace, isNew })

{
  const res = mainEdits.applyEdits(sess('b18e1'), [edit('alpha.txt', 'beta', 'BETA')])
  const after = fs.readFileSync(path.join(ROOT_M, 'alpha.txt'), 'utf8')
  const backupFile = res.backupId ? path.join(BACKUPS, 'b18e1', `${res.backupId}.json`) : null
  const backupOk = backupFile && fs.existsSync(backupFile) && JSON.parse(fs.readFileSync(backupFile, 'utf8')).entries[0].prev === alphaContent
  check('edits: happy path writes + backup holds the original', res.applied.length === 1 && res.errors.length === 0 && after.includes('BETA') && backupOk, JSON.stringify(res.errors))

  const undo = mainEdits.undoLast('b18e1')
  check(
    'edits: undo restores the original and drops the backup',
    undo.restored === 1 && fs.readFileSync(path.join(ROOT_M, 'alpha.txt'), 'utf8') === alphaContent && !fs.existsSync(path.join(BACKUPS, 'b18e1', `${res.backupId}.json`)),
    undo.message
  )

  // backup refuses (backups/<sid> exists as a FILE) → NOTHING may be applied
  fs.mkdirSync(BACKUPS, { recursive: true })
  fs.writeFileSync(path.join(BACKUPS, 'b18e2'), 'not a directory', 'utf8')
  const refused = mainEdits.applyEdits(sess('b18e2'), [edit('alpha.txt', 'beta', 'NO')])
  check(
    'edits: backup failure ⇒ nothing applied',
    refused.applied.length === 0 && refused.backupId === null && refused.errors.some((e) => e.includes('safety backup')) && fs.readFileSync(path.join(ROOT_M, 'alpha.txt'), 'utf8') === alphaContent,
    JSON.stringify(refused.errors)
  )

  const bin = mainEdits.applyEdits(sess('b18e3'), [edit('latin1.txt', 'ab', 'AB')])
  const binAfter = fs.readFileSync(path.join(ROOT_M, 'latin1.txt'))
  check(
    'edits: non-UTF-8 file refused, bytes untouched',
    bin.applied.length === 0 && bin.errors.some((e) => e.includes('not UTF-8')) && Buffer.compare(binAfter, latin1Bytes) === 0,
    JSON.stringify(bin.errors)
  )

  const crlf = mainEdits.applyEdits(sess('b18e4'), [edit('crlf.txt', 'line2', 'LINE2')])
  const crlfAfter = fs.readFileSync(path.join(ROOT_M, 'crlf.txt'), 'utf8')
  check(
    'edits: CRLF endings preserved (no bare \\n introduced)',
    crlf.applied.length === 1 && !crlfAfter.replace(/\r\n/g, '').includes('\n') && crlfAfter.includes('line1\r\nLINE2\r\nline3'),
    JSON.stringify(crlfAfter)
  )

  const esc = mainEdits.applyEdits(sess('b18e4'), [edit('../escape.txt', 'x', 'y')])
  check(
    'edits: ../ traversal refused',
    esc.applied.length === 0 && esc.errors.some((e) => e.includes('outside the linked folders')) && !fs.existsSync(path.join(OUT, 'escape.txt')),
    JSON.stringify(esc.errors)
  )

  // undo keeps the EARLIEST entry when one region was edited twice
  const dupFile = path.join(ROOT_M, 'dup.txt')
  fs.writeFileSync(dupFile, 'whatever', 'utf8')
  fs.mkdirSync(path.join(BACKUPS, 'b18e5'), { recursive: true })
  fs.writeFileSync(
    path.join(BACKUPS, 'b18e5', '1.json'),
    JSON.stringify({ ts: 1, entries: [{ path: dupFile, prev: 'FIRST' }, { path: dupFile, prev: 'SECOND' }] }),
    'utf8'
  )
  const dedupe = mainEdits.undoLast('b18e5')
  check('edits: undo of a twice-edited file restores the TRUE original', dedupe.restored === 1 && fs.readFileSync(dupFile, 'utf8') === 'FIRST', dedupe.message)

  // partial undo: one target became a directory → stays in the backup for retry
  const g = path.join(ROOT_M, 'g.txt')
  const d = path.join(ROOT_M, 'isdir')
  fs.writeFileSync(g, 'G1', 'utf8')
  fs.mkdirSync(d)
  fs.mkdirSync(path.join(BACKUPS, 'b18e6'), { recursive: true })
  fs.writeFileSync(
    path.join(BACKUPS, 'b18e6', '1.json'),
    JSON.stringify({ ts: 1, entries: [{ path: g, prev: 'ORIG-G' }, { path: d, prev: 'x' }] }),
    'utf8'
  )
  const partial = mainEdits.undoLast('b18e6')
  const keptFile = path.join(BACKUPS, 'b18e6', '1.json')
  const kept = JSON.parse(fs.readFileSync(keptFile, 'utf8'))
  check(
    'edits: partial undo restores what it can, keeps the rest retryable',
    partial.restored === 1 && partial.message.includes('could not be written') && fs.readFileSync(g, 'utf8') === 'ORIG-G' && kept.entries.length === 1 && kept.entries[0].path === d,
    partial.message
  )
  fs.rmdirSync(d)
  const retry = mainEdits.undoLast('b18e6')
  check('edits: /undo retry finishes the job and clears the backup', retry.restored === 1 && !fs.existsSync(keptFile) && fs.readFileSync(d, 'utf8') === 'x', retry.message)
}

// -- 6. store.ts: boot pointer + re-root patch + corrupt file ----------------
const store = await import(pathToFileURL(path.join(OUT, 'dist', 'store.mjs')).href)
const DEFAULT_DIR = path.join(HOME18, '.codezy')
const POINTER_FILE = path.join(DEFAULT_DIR, 'settings.json')

{
  const tdirA = path.join(OUT, 'dataA')
  fs.mkdirSync(DEFAULT_DIR, { recursive: true })
  fs.writeFileSync(POINTER_FILE, JSON.stringify({ dataDir: tdirA, fontSize: 21 }), 'utf8')
  store.initStore() // boot with no explicit dir → must honour the pointer
  check('store: boot honours the persisted dataDir pointer', store.getDataDir() === tdirA && fs.existsSync(path.join(tdirA, 'sessions')), store.getDataDir())

  const tdirB = path.join(OUT, 'dataB')
  store.saveSettings({ ...store.DEFAULT_SETTINGS, dataDir: tdirB }) // live re-root A → B
  const pointer = JSON.parse(fs.readFileSync(POINTER_FILE, 'utf8'))
  const rooted = JSON.parse(fs.readFileSync(path.join(tdirB, 'settings.json'), 'utf8'))
  check('store: saveSettings re-roots the default-location pointer too', pointer.dataDir === tdirB && rooted.dataDir === tdirB && store.getDataDir() === tdirB, JSON.stringify({ pointer: pointer.dataDir, rooted: rooted.dataDir }))

  store.initStore() // simulated relaunch
  check('store: relaunch follows the updated pointer', store.getDataDir() === tdirB, store.getDataDir())

  // corrupt settings must be moved aside, not silently overwritten
  store.initStore(path.join(OUT, 'dataC'))
  const cFile = path.join(OUT, 'dataC', 'settings.json')
  fs.writeFileSync(cFile, '{definitely not json', 'utf8')
  const s = store.getSettings()
  check('store: corrupt settings moved to .corrupt, defaults returned', fs.existsSync(`${cFile}.corrupt`) && !fs.existsSync(cFile) && !!s.theme, JSON.stringify(s.theme))
}

// -- 7. files.ts: editor read cap --------------------------------------------
const filesMod = await import(pathToFileURL(path.join(OUT, 'dist', 'files.mjs')).href)
{
  const small = path.join(ROOT_M, 'small.txt')
  fs.writeFileSync(small, 'hello editor', 'utf8')
  const sRes = filesMod.ideRead([ROOT_M], small)
  check('ide: small file → full content, not truncated', sRes && sRes.content === 'hello editor' && sRes.truncated === false, JSON.stringify(sRes))

  const big = path.join(ROOT_M, 'ide-big.txt')
  fs.writeFileSync(big, 'x'.repeat(1_000_050), 'utf8')
  const bRes = filesMod.ideRead([ROOT_M], big)
  check('ide: 1 MB file → capped content, truncated flag set', bRes && bRes.content.length === 1_000_000 && bRes.truncated === true, bRes ? `len=${bRes.content.length}/trunc=${bRes.truncated}` : 'null')

  check('ide: outside the roots → null', filesMod.ideRead([ROOT_M], path.join(OUT, 'outside.txt')) === null, '')
  check('ide: save guard trips on a truncated buffer', filesMod.ideSaveWouldTruncate(big, bRes.content) === true, '')
  check('ide: full rewrite of a big file passes the guard', filesMod.ideSaveWouldTruncate(big, 'y'.repeat(1_000_001)) === false, '')
  check('ide: small file never trips the guard', filesMod.ideSaveWouldTruncate(small, 'anything') === false, '')
}

// -- 8. TUI edits.mjs: same safety rules terminal-side -----------------------
const tui = await import(pathToFileURL(path.join(PROJ, 'cli', 'lib', 'edits.mjs')).href)
{
  const bdir1 = path.join(OUT, 'tui-backups-1')
  const res = tui.applyEdits([ROOT_T], [edit('alpha.txt', 'beta', 'BETA')], bdir1)
  const backupFile = res.backupId ? path.join(bdir1, `${res.backupId}.json`) : null
  check(
    'tui edits: happy path writes + backup-first',
    res.applied.length === 1 && res.errors.length === 0 && fs.readFileSync(path.join(ROOT_T, 'alpha.txt'), 'utf8').includes('BETA') && backupFile && fs.existsSync(backupFile),
    JSON.stringify(res.errors)
  )
  const undo = tui.undoLast(bdir1)
  check('tui edits: undo restores + clears backup', undo.restored === 1 && fs.readFileSync(path.join(ROOT_T, 'alpha.txt'), 'utf8') === alphaContent && fs.readdirSync(bdir1).length === 0, undo.message)

  const blocked = path.join(OUT, 'tui-backups-blocked')
  fs.writeFileSync(blocked, 'not a directory', 'utf8')
  const refused = tui.applyEdits([ROOT_T], [edit('alpha.txt', 'beta', 'NO')], blocked)
  check(
    'tui edits: backup failure ⇒ nothing applied',
    refused.applied.length === 0 && refused.backupId === null && refused.errors.some((e) => e.includes('safety backup')) && fs.readFileSync(path.join(ROOT_T, 'alpha.txt'), 'utf8') === alphaContent,
    JSON.stringify(refused.errors)
  )

  const bin = tui.applyEdits([ROOT_T], [edit('latin1.txt', 'ab', 'AB')], path.join(OUT, 'tui-backups-bin'))
  check(
    'tui edits: non-UTF-8 file refused, bytes untouched',
    bin.applied.length === 0 && bin.errors.some((e) => e.includes('not UTF-8')) && Buffer.compare(fs.readFileSync(path.join(ROOT_T, 'latin1.txt')), latin1BytesT) === 0,
    JSON.stringify(bin.errors)
  )

  const crlf = tui.applyEdits([ROOT_T], [edit('crlf.txt', 'line2', 'LINE2')], path.join(OUT, 'tui-backups-crlf'))
  const crlfAfter = fs.readFileSync(path.join(ROOT_T, 'crlf.txt'), 'utf8')
  check('tui edits: CRLF preserved', crlf.applied.length === 1 && !crlfAfter.replace(/\r\n/g, '').includes('\n') && crlfAfter.includes('line1\r\nLINE2'), JSON.stringify(crlfAfter))

  const bdirNew = path.join(OUT, 'tui-backups-new')
  const created = tui.applyEdits([ROOT_T], [edit('fresh.txt', 'EMPTY', 'brand new', true)], bdirNew)
  check('tui edits: new file created + backed up as prev=null', created.applied.length === 1 && fs.readFileSync(path.join(ROOT_T, 'fresh.txt'), 'utf8') === 'brand new', JSON.stringify(created.errors))
  const undoNew = tui.undoLast(bdirNew)
  check('tui edits: undo deletes a file this batch created', undoNew.restored === 1 && !fs.existsSync(path.join(ROOT_T, 'fresh.txt')), undoNew.message)

  // undo dedupe: earliest entry wins (crafted backup, one region twice)
  const dupT = path.join(ROOT_T, 'dup.txt')
  fs.writeFileSync(dupT, 'whatever', 'utf8')
  const bdirDup = path.join(OUT, 'tui-backups-dup')
  fs.mkdirSync(bdirDup, { recursive: true })
  fs.writeFileSync(path.join(bdirDup, '1.json'), JSON.stringify({ ts: 1, entries: [{ path: dupT, prev: 'FIRST' }, { path: dupT, prev: 'SECOND' }] }), 'utf8')
  const dedupe = tui.undoLast(bdirDup)
  check('tui edits: undo keeps the TRUE original on a double-edit', dedupe.restored === 1 && fs.readFileSync(dupT, 'utf8') === 'FIRST', dedupe.message)

  // partial undo stays retryable
  const gT = path.join(ROOT_T, 'g.txt')
  const dT = path.join(ROOT_T, 'isdir')
  fs.writeFileSync(gT, 'G1', 'utf8')
  fs.mkdirSync(dT)
  const bdirPart = path.join(OUT, 'tui-backups-part')
  fs.mkdirSync(bdirPart, { recursive: true })
  fs.writeFileSync(path.join(bdirPart, '1.json'), JSON.stringify({ ts: 1, entries: [{ path: gT, prev: 'ORIG-G' }, { path: dT, prev: 'x' }] }), 'utf8')
  const partial = tui.undoLast(bdirPart)
  const keptT = JSON.parse(fs.readFileSync(path.join(bdirPart, '1.json'), 'utf8'))
  check(
    'tui edits: partial undo keeps the failed entry for retry',
    partial.restored === 1 && partial.message.includes('could not be written') && fs.readFileSync(gT, 'utf8') === 'ORIG-G' && keptT.entries.length === 1 && keptT.entries[0].path === dT,
    partial.message
  )
}

if (fails.length) {
  console.log(`\n${fails.length} FAILED:`)
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\nALL PASS')

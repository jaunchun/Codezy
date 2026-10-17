// Batch 20 — the cowork feature pass + the tree bug fix:
//  1. tree: file caps never eat folders again — directories are always walked,
//     caps apply to file rows only, and every cut is explained by a marker row
//     (`more`) — tree-wide, per folder, and at the depth limit. `showIgnored`
//     hides everything except .git / node_modules.
//  2. git: `git status` per linked root (badges in the tree), a non-repo is a
//     plain no-op, and a stray C:\.git can never trigger a whole-drive status.
//  3. edits: /history lists every pre-edit safety copy (newest first) and a
//     restore is confined to the linked folders, snapshots first, never
//     corrupts a binary.
//  4. prompt: your standing instructions sit above memory/project context.
//  5. renderer: the cowork pane (marker rows, git/ignored chips, badges,
//     Ctrl+P quick-open, Ln/Col status bar, row menu, new file/folder), the
//     quick follow-ups under the last reply, /history modal, settings
//     export/import + test notification, palette entry.
// Scratch lives under tests/.tmp and USERPROFILE is faked into it.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
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

const OUT = path.join(PROJ, 'tests', '.tmp', `b20-${Date.now()}`)
const FAKE_HOME = path.join(OUT, 'fake-home')
fs.mkdirSync(FAKE_HOME, { recursive: true })
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME
process.on('exit', () => {
  try {
    fs.rmSync(OUT, { recursive: true, force: true })
  } catch {}
})
const read = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8')

// --- 1. static: the wiring ----------------------------------------------------
{
  const files = read('src/main/files.ts')
  check('tree: IdeNode carries the marker field', /more\?: number/.test(files))
  check('tree: ideTree takes tree options', /export function ideTree\(roots: string\[\], opts\?: IdeTreeOptions\)/.test(files))
  check('tree: showIgnored is an option', /showIgnored\?: boolean/.test(files))
  check('tree: per-tree and per-folder file caps', /maxFiles\?: number/.test(files) && /maxFilesPerDir\?: number/.test(files))
  check('tree: showIgnored still hides .git + node_modules', /opts\?\.showIgnored \? new Set\(\['\.git', 'node_modules'\]\) : SKIP_DIRS/.test(files))
  check('tree: marker rows for the per-folder cap', /\\u0000more`/.test(files))
  check('tree: marker rows for the tree cap', /\\u0000more-tree`/.test(files))
  check('tree: marker rows for the depth limit', /\\u0000deep`/.test(files))
  check('tree: caps have named defaults', /MAX_TREE_FILES/.test(files) && /MAX_FILES_PER_DIR/.test(files))
  check('tree: new file/folder helpers exist', /export function ideCreate\(/.test(files))

  const git = read('src/main/git.ts')
  check('git: porcelain status per folder', /'--porcelain=1'/.test(git))
  check('git: a short timeout (a blocked git never freezes the window)', /2500/.test(git))
  check('git: spawned hidden', /windowsHide: true/.test(git))
  check('git: a volume root is never a worktree (stray C:\\.git)', /path\.dirname\(dir\) === dir/.test(git))

  const edits = read('src/main/edits.ts')
  check('edits: listBackups exported', /export function listBackups\(sessionId: string\): BackupInfo\[\]/.test(edits))
  check('edits: restoreBackup exported', /export function restoreBackup\(session: Session, backupId: string\)/.test(edits))
  check('edits: only numeric backup ids are accepted', /!\/\^\\d\+\$\/\.test\(backupId\)/.test(edits))
  check('edits: a backup outside the folders is refused', edits.includes('every entry is outside the linked folders'))
  check('edits: the current files are snapshotted BEFORE restoring', /entries: snap/.test(edits) && edits.indexOf('entries: snap') < edits.lastIndexOf('fs.writeFileSync(e.path'))
  check('edits: binaries are never overwritten by a text restore', /txt\.includes\('\\0'\)/.test(edits))
  check('edits: the list is newest-first', /out\.sort\(\(a, b\) => b\.ts - a\.ts\)/.test(edits))

  const prompt = read('src/main/prompt.ts')
  const iInstr = prompt.indexOf('## Instructions from you')
  const iMem = prompt.indexOf('## What you know about the user')
  const iProj = prompt.indexOf('## Project:')
  check('prompt: your instructions have their own section', iInstr > 0)
  check('prompt: instructions come BEFORE what CODEZY learned', iInstr > -1 && iMem > iInstr, `${iInstr}/${iMem}`)
  check('prompt: instructions come BEFORE the project context', iProj > iInstr, `${iInstr}/${iProj}`)
  check('prompt: BASE_INSTRUCTIONS only mentions the heading in passing', prompt.indexOf('## Linked folders" section') > -1)

  const cmd = read('src/shared/commands.ts')
  check('commands: /history registered', cmd.includes(`name: '/history'`))
  check('commands: /history describes restoring', /\/history', args: '', description: 'Every backup taken before an edit — restore any point'/.test(cmd))

  const main = read('src/main/index.ts')
  check('main: ide:tree passes showIgnored through', /ipcMain\.handle\('ide:tree'[\s\S]{0,220}showIgnored/.test(main))
  check('main: git:status is confined to the linked folders', /ipcMain\.handle\('git:status'/.test(main) && /if \(!linked\) return \{ ok: false/.test(main))
  check('main: edits:list registered', /ipcMain\.handle\('edits:list'/.test(main))
  check('main: edits:restore registered', /ipcMain\.handle\('edits:restore'/.test(main))
  check('main: save dialog picks a filter by extension', /ipcMain\.handle\('dialog:saveText'/.test(main) && /json \? 'JSON' : 'Markdown'/.test(main))

  const pre = read('src/preload/index.ts')
  check('preload: tree takes showIgnored', /tree: \(sessionId: string, showIgnored\?: boolean\)/.test(pre))
  check('preload: git.status bridged', /status: \(sessionId: string, folder: string\)/.test(pre))
  check('preload: edits.list + edits.restore bridged', /list: \(sessionId: string\)/.test(pre) && /restore: \(sessionId: string, backupId: string\)/.test(pre))
  check('preload: dialog.saveText bridged', /saveText: \(defaultName: string, content: string\)/.test(pre))

  const api = read('src/shared/api.ts')
  check('api: BackupInfo type', /interface BackupInfo \{/.test(api))
  check('api: restore returns a count + a message', /restore\(sessionId: string, backupId: string\): Promise<\{ restored: number; message: string \}>/.test(api))

  const ide = read('src/renderer/src/components/IdePane.tsx')
  check('pane: marker rows render as a plain span', /if \(node\.more !== undefined\)/.test(ide) && /className="ide-more"/.test(ide))
  check('pane: git badges carry data-st', /className="ide-badge" data-st=\{st\}/.test(ide))
  check('pane: git + ignored toggle chips', />\s*git\s*</.test(ide) && />\s*ignored\s*</.test(ide))
  check('pane: Ctrl+P quick-open', /key\.toLowerCase\(\) === 'p'/.test(ide) && /className="ide-quick"/.test(ide))
  check('pane: quick-open skips marker rows', /if \(n\.more !== undefined\) continue/.test(ide))
  check('pane: status bar shows Ln/Col', /Ln \{caret\.line\}, Col \{caret\.col\}/.test(ide))
  check('pane: the row menu survives a press inside it', /closest\('\.ide-ctx'\)/.test(ide))
  check('pane: new file / new folder head buttons', /aria-label="New file"/.test(ide) && /aria-label="New folder"/.test(ide))
  check('pane: git badges read at most three roots', /roots\.slice\(0, 3\)/.test(ide))

  const chat = read('src/renderer/src/components/ChatView.tsx')
  for (const l of ['Continue', 'Explain', 'Review it', 'Add tests']) {
    check(`chat: quick follow-up "${l}"`, chat.includes(`label: '${l}'`))
  }
  check('chat: only under the newest reply, never while streaming', /m\.id === lastAssistantId && !streaming && m\.content\.trim\(\)/.test(chat))

  const hist = read('src/renderer/src/components/HistoryModal.tsx')
  check('history: panel + tab', /className="usage-panel hist-panel"/.test(hist) && hist.includes('Edit history'))
  check('history: rows carry time/files/count', /hist-time/.test(hist) && /hist-files/.test(hist) && /hist-count/.test(hist))
  check('history: restore + undo-newest controls', /Restore/.test(hist) && /Undo newest/.test(hist))
  check('history: empty state explains when backups appear', hist.includes('No backups for this chat yet'))

  const set = read('src/renderer/src/components/SettingsModal.tsx')
  check('settings: export + import buttons', set.includes('export settings (.json)') && set.includes('import settings…'))
  check('settings: folders never travel with the export', set.includes('Folders never move between machines'))
  check('settings: send a test notification', set.includes('send a test'))
  check('settings: custom instructions field', set.includes('Custom instructions — sent with every message'))

  const store = read('src/renderer/src/store/app.ts')
  check('store: /history opens the modal', /case '\/history':/.test(store) && /historyOpen: true/.test(store))
  check('store: undoLast action', /async undoLast\(\)/.test(store))
  check('store: bumpIdeTick tells cowork to refresh', /bumpIdeTick\(\)/.test(store))
  check('store: setHistoryOpen action', /setHistoryOpen\(v: boolean\)/.test(store))

  const pal = read('src/renderer/src/components/Palette.tsx')
  check('palette: history entry', pal.includes('Edit history — restore a backup'))

  const css = read('src/renderer/src/styles/global.css')
  const has = (re, label) => check(label, re.test(css))
  has(/26 —/, 'css: the batch-20 design block exists')
  has(/\.ide-more\s*\{/, 'css: tree cap marker row')
  has(/\.ide-badge\s*\{/, 'css: git badge')
  has(/\.ide-chip\s*\{/, 'css: git/ignored chips')
  has(/\.ide-quick\s*\{/, 'css: Ctrl+P quick-open')
  has(/\.ide-pos\s*\{/, 'css: Ln/Col status')
  has(/\.hist-row\s*\{/, 'css: history rows')
  has(/\.followup\s*\{/, 'css: quick follow-up buttons')
}

// --- 2. unit: tree, git, backups, prompt (main process, electron stubbed) -----
const stub = path.join(OUT, 'electron-stub.mjs')
fs.writeFileSync(stub, 'export const app = { getPath: () => "" }\nexport default { app }\n')
fs.writeFileSync(
  path.join(OUT, 'main-entry.ts'),
  [
    `export { ideTree } from '${PROJ}/src/main/files'`,
    `export { gitStatus } from '${PROJ}/src/main/git'`,
    `export { listBackups, restoreBackup } from '${PROJ}/src/main/edits'`,
    `export { initStore, p } from '${PROJ}/src/main/store'`,
    `export { buildMessages } from '${PROJ}/src/main/prompt'`
  ].join('\n')
)
await build({
  entryPoints: [path.join(OUT, 'main-entry.ts')],
  outfile: path.join(OUT, 'main.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { electron: stub },
  logLevel: 'silent'
})
const m = await import(pathToFileURL(path.join(OUT, 'main.mjs')).href)

const walkAll = (nodes, out = []) => {
  for (const n of nodes) {
    out.push(n)
    if (n.children) walkAll(n.children, out)
  }
  return out
}

// -- 2a. the tree: folders are never lost to a file cap -------------------------
{
  const root = path.join(OUT, 'tree')
  for (const d of ['src', 'dist', '.git', 'node_modules', '.vscode', 'venv']) fs.mkdirSync(path.join(root, d), { recursive: true })
  for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(root, f), 'x')
  for (const f of ['app.ts', 'util.ts']) fs.writeFileSync(path.join(root, 'src', f), 'x')
  fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'x')
  fs.writeFileSync(path.join(root, '.git', 'config'), 'x')
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'x')
  fs.writeFileSync(path.join(root, '.vscode', 's.json'), 'x')
  fs.writeFileSync(path.join(root, 'venv', 'py'), 'x')

  const names = walkAll(m.ideTree([root])).map((n) => n.name)
  check('tree: the root renders', names.includes('tree'), names.join(','))
  check('tree: folders and their files show by default', names.includes('src') && names.includes('app.ts'))
  check('tree: junk folders are hidden by default', !['dist', '.git', 'node_modules', '.vscode', 'venv'].some((d) => names.includes(d)), names.join(','))

  const shown = walkAll(m.ideTree([root], { showIgnored: true })).map((n) => n.name)
  check('tree: showIgnored reveals dist/.vscode/venv', ['dist', '.vscode', 'venv'].every((d) => shown.includes(d)), shown.join(','))
  check('tree: showIgnored STILL hides .git and node_modules', !shown.includes('.git') && !shown.includes('node_modules'), shown.join(','))

  const capped = walkAll(m.ideTree([root], { maxFiles: 2 }))
  const fileRows = capped.filter((n) => !n.dir && n.more === undefined)
  const markers = capped.filter((n) => n.more !== undefined)
  check('tree: a tree cap limits FILE rows only', fileRows.length === 2, String(fileRows.length))
  check('tree: every folder survives the tree cap', capped.some((n) => n.name === 'src'), capped.map((n) => n.name).join(','))
  check('tree: the cut is explained by a marker row', markers.some((n) => /more file/.test(n.name) && /tree cap reached/.test(n.name)), JSON.stringify(markers.map((n) => n.name)))
  check('tree: a marker row is never a file or a folder', markers.every((n) => n.dir === false && n.more > 0), JSON.stringify(markers))

  const perDir = walkAll(m.ideTree([root], { maxFilesPerDir: 1 }))
  const perDirMarker = perDir.find((n) => n.more !== undefined && /in this folder/.test(n.name))
  check('tree: a per-folder cap has its own marker', !!perDirMarker, JSON.stringify(perDir.map((n) => n.name)))
  const rootKids = m.ideTree([root], { maxFilesPerDir: 1 })[0].children ?? []
  check('tree: the per-folder marker sits inside that folder', rootKids.some((n) => n.more !== undefined))

  const dirsFirst = m.ideTree([root])[0].children ?? []
  const firstFileIdx = dirsFirst.findIndex((n) => !n.dir)
  const anyDirAfterFile = dirsFirst.slice(Math.max(0, firstFileIdx)).some((n) => n.dir)
  check('tree: folders always sort before files', firstFileIdx > -1 && !anyDirAfterFile, dirsFirst.map((n) => n.name).join(','))

  // depth limit: a chain deep enough to hit MAX_TREE_DEPTH
  let deep = path.join(OUT, 'deep')
  fs.mkdirSync(deep, { recursive: true })
  for (let i = 0; i < 46; i++) {
    deep = path.join(deep, 'd')
    fs.mkdirSync(deep, { recursive: true })
  }
  const deepFlat = walkAll(m.ideTree([path.join(OUT, 'deep')]))
  const depthMarker = deepFlat.find((n) => n.more !== undefined && /deeper folders are hidden/.test(n.name))
  check('tree: the depth limit is announced, not silent', !!depthMarker && depthMarker.more === 0, deepFlat.map((n) => n.name).slice(-4).join(','))
}

// -- 2b. git: status badges, no-repo no-op, volume-root guard -------------------
{
  const gitDir = path.join(OUT, 'gitdir')
  fs.mkdirSync(gitDir, { recursive: true })
  const noRepo = m.gitStatus(gitDir)
  check('git: a folder that is not a repo answers ok:false', noRepo.ok === false && Array.isArray(noRepo.files), JSON.stringify(noRepo))

  const vol = m.gitStatus('C:\\')
  check('git: a volume root never runs a whole-drive status', vol.ok === false, JSON.stringify(vol))

  const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0
  if (hasGit) {
    const repo = path.join(OUT, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    spawnSync('git', ['-C', repo, 'init'], { encoding: 'utf8', windowsHide: true })
    fs.writeFileSync(path.join(repo, 'new.txt'), 'hi')
    const st = m.gitStatus(repo)
    check('git: ok:true with the porcelain lines of a real repo', st.ok === true && st.files.some((f) => f.includes('new.txt')), JSON.stringify(st))
  } else {
    check('git: (git not on PATH — live status skipped)', true)
  }
}

// -- 2c. /history: list + a confined restore -----------------------------------
{
  m.initStore(path.join(OUT, 'data'))
  const root = path.join(OUT, 'edits-root')
  fs.mkdirSync(root, { recursive: true })
  const file = path.join(root, 'a.txt')
  fs.writeFileSync(file, 'original')

  const bdir = path.join(OUT, 'data', 'backups', 's1')
  fs.mkdirSync(bdir, { recursive: true })
  fs.writeFileSync(path.join(bdir, '1700000000000.json'), JSON.stringify({ ts: 1700000000000, entries: [{ path: file, prev: 'original' }] }))
  fs.writeFileSync(path.join(bdir, '1600000000000.json'), JSON.stringify({ ts: 1600000000000, entries: [{ path: path.join(root, 'b.txt'), prev: 'old-b' }] }))
  fs.writeFileSync(path.join(bdir, 'notes.json'), 'not a backup')
  fs.writeFileSync(path.join(bdir, '1500000000000.json'), '{broken json')

  const rows = m.listBackups('s1')
  check('history: every numeric backup is listed', rows.length === 2, JSON.stringify(rows.map((r) => r.id)))
  check('history: newest first', rows[0].ts === 1700000000000, String(rows[0]?.ts))
  check('history: rows carry the file names', JSON.stringify(rows[0].files) === '["a.txt"]', JSON.stringify(rows[0].files))
  check('history: junk and unreadable files are skipped', !rows.some((r) => r.id === 'notes' || r.id === '1500000000000'), JSON.stringify(rows.map((r) => r.id)))
  check('history: an unknown chat simply has none', m.listBackups('no-such-chat').length === 0)

  fs.writeFileSync(file, 'edited by the model')
  const session = { id: 's1', linkedFolders: [root] }
  const res = m.restoreBackup(session, '1700000000000')
  check('restore: puts the original back', res.restored === 1 && fs.readFileSync(file, 'utf8') === 'original', JSON.stringify(res))
  check('restore: the message says what happened', /^Restored 1 file/.test(res.message) && /\/undo steps back/.test(res.message), res.message)
  const after = m.listBackups('s1')
  check('restore: snapshots the current files FIRST (pressing twice is safe)', after.length === 3 && after[0].ts > 1700000000000, JSON.stringify(after.map((r) => r.id)))

  check('restore: a non-numeric id is refused', /Unknown backup/.test(m.restoreBackup(session, '../../etc').message))
  check('restore: an unlinked chat is told to link one', /Link a folder/.test(m.restoreBackup({ id: 's1', linkedFolders: [] }, '1700000000000').message))
  check('restore: a missing backup reports unreadable', /Backup unreadable/.test(m.restoreBackup(session, '123456789').message))

  const outside = path.join(OUT, 'outside.txt')
  fs.writeFileSync(outside, 'keep me')
  fs.writeFileSync(path.join(bdir, '1690000000000.json'), JSON.stringify({ ts: 1690000000000, entries: [{ path: outside, prev: 'overwritten' }] }))
  const escaped = m.restoreBackup(session, '1690000000000')
  check('restore: a backup pointing outside the folders writes nothing', escaped.restored === 0 && /every entry is outside/.test(escaped.message) && fs.readFileSync(outside, 'utf8') === 'keep me', JSON.stringify(escaped))

  const bin = path.join(root, 'bin.dat')
  fs.writeFileSync(bin, Buffer.from([0x7f, 0x45, 0x00, 0x01]))
  fs.writeFileSync(path.join(bdir, '1680000000000.json'), JSON.stringify({ ts: 1680000000000, entries: [{ path: bin, prev: 'clean text' }] }))
  const binRes = m.restoreBackup(session, '1680000000000')
  check('restore: a binary in the way stops the whole restore', binRes.restored === 0 && /Nothing could be restored safely/.test(binRes.message), JSON.stringify(binRes))
  check('restore: the binary is untouched', fs.readFileSync(bin).equals(Buffer.from([0x7f, 0x45, 0x00, 0x01])))
}

// -- 2d. prompt: instructions outrank memory and project context ----------------
{
  const session = {
    id: 's1',
    messages: [{ id: 'm1', role: 'user', content: 'hello', ts: 1 }],
    linkedFolders: [path.join(OUT, 'tree')],
    goal: 'ship batch20',
    notes: [],
    skill: ''
  }
  const project = { id: 'p1', name: 'demo', context: 'Use tabs, never spaces.' }
  const settings = { mode: 'build', v2: false, instructions: '  Always answer in Polish.  ', learn: false, effort: 'medium' }

  const sys = m.buildMessages(session, project, settings).find((x) => x.role === 'system')
  check('prompt: the system message exists', !!sys, sys ? '' : 'missing')
  const iInstr = sys.content.indexOf('## Instructions from you')
  const iProj = sys.content.indexOf('## Project: demo')
  const iGoal = sys.content.indexOf('## Current goal')
  const iFolders = sys.content.indexOf('## Linked folders\n') // not the mention in BASE_INSTRUCTIONS
  check('prompt: your instructions are in the system message', iInstr > 0 && sys.content.includes('Always answer in Polish.'), sys.content.slice(0, 80))
  check('prompt: instructions are trimmed', !/## Instructions from you\n /.test(sys.content))
  check('prompt: instructions come before the project context', iInstr > -1 && iProj > iInstr, `${iInstr}/${iProj}`)
  check('prompt: instructions come before the current goal', iGoal > iInstr, `${iInstr}/${iGoal}`)
  check('prompt: linked folders still describe the tree', iFolders > iProj && sys.content.includes(path.join(OUT, 'tree')), String(iFolders))

  const plan = m.buildMessages(session, project, { ...settings, mode: 'plan', instructions: '' }).find((x) => x.role === 'system')
  check('prompt: plan mode forbids edit blocks up front', plan.content.includes('## Mode: PLAN'))
  const v2 = m.buildMessages(session, null, { ...settings, v2: true, instructions: '' }).find((x) => x.role === 'system')
  check('prompt: agent mode names its tools', v2.content.includes('## Tools') && v2.content.includes('web_search'))
  const bare = m.buildMessages(session, null, { ...settings, instructions: '' }).find((x) => x.role === 'system')
  check('prompt: nothing empty is pushed', !/## Instructions from you\n\n/.test(bare.content), String(bare.content.includes('## Instructions from you')))
}

// --- 3. jsdom + mocked bridge --------------------------------------------------
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
defineGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement)
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
defineGlobal(
  'Notification',
  class {
    constructor(title, opts) {
      ;(globalThis.__notifications ??= []).push({ title, opts })
    }
  }
)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.__notifications = []
// ChatView reads CSS.highlights at module scope — jsdom has no CSS Typed OM
defineGlobal('CSS', Object.assign(dom.window.CSS ?? {}, { highlights: undefined }))
dom.window.HTMLElement.prototype.scrollIntoView = function () {}
dom.window.confirm = () => true

let clip = ''
Object.defineProperty(dom.window.navigator, 'clipboard', {
  value: { writeText: async (t) => (clip = t) },
  configurable: true
})

let diskState = {
  theme: 'dark',
  accent: '#3d9bff',
  dataDir: 'tests/.tmp/batch20',
  driveFolder: null,
  ollamaUrl: 'http://127.0.0.1:11434',
  providers: [],
  activeProvider: 'ollama',
  activeModel: 'qwen.2.5-coder:7b',
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
  autoContinue: true,
  autoUpdate: false
}
const chatSends = []
const savedSessions = []
const savedTexts = []
const createCalls = []
const restoreCalls = []
const treeCalls = []
let historyRows = []

const ROOT = path.join(OUT, 'ide-root')
fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true })
const treeNodes = () => [
  {
    name: 'ide-root',
    path: ROOT,
    dir: true,
    children: [
      { name: 'a.txt', path: path.join(ROOT, 'a.txt'), dir: false },
      { name: 'b.txt', path: path.join(ROOT, 'b.txt'), dir: false },
      { name: '… 12 more files (tree cap reached)', path: `${ROOT}\u0000more`, dir: false, more: 12 },
      { name: 'src', path: path.join(ROOT, 'src'), dir: true, children: [{ name: 'app.ts', path: path.join(ROOT, 'src', 'app.ts'), dir: false }] }
    ]
  }
]

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
    list: async () => [
      {
        id: 's1',
        title: 'one with a reply',
        messages: [
          { id: 'm1', role: 'user', content: 'hello', ts: 1 },
          { id: 'm2', role: 'assistant', content: 'done and done', ts: 2 }
        ],
        createdAt: 1,
        updatedAt: 2,
        linkedFolders: [ROOT]
      }
    ],
    create: async () => ({ id: 'new', title: 'New chat', messages: [], createdAt: 1, updatedAt: 1 }),
    save: async (s) => {
      savedSessions.push(s)
      return s
    },
    delete: async () => {}
  },
  chat: {
    onEvent: () => {},
    send: async (...args) => {
      chatSends.push(args)
    },
    abort: async () => {}
  },
  health: { ollama: async () => 'online', drive: async () => 'ok' },
  models: { list: async () => [{ id: 'qwen.2.5-coder:7b', provider: 'ollama', providerName: 'Ollama', parameter: '7B', quant: 'Q4', size: 1, family: 'qwen' }] },
  memory: { read: async () => '', write: async () => true },
  skills: { list: async () => [] },
  edits: {
    apply: async () => ({ applied: [], errors: [] }),
    list: async () => historyRows,
    undo: async () => ({ message: 'Reverted 1 file.' }),
    restore: async (_id, backupId) => {
      restoreCalls.push(backupId)
      return { restored: 1, message: 'Restored 1 file. /undo steps back to the state you just left.' }
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
    tree: async (_id, showIgnored) => {
      treeCalls.push(!!showIgnored)
      return treeNodes()
    },
    read: async () => ({ content: 'line one\nline two\nline three', truncated: false }),
    write: async (_id, p) => p,
    create: async (_id, target, dir) => {
      createCalls.push({ target, dir })
      return target
    },
    rename: async (_id, from, to) => to,
    delete: async () => true
  },
  git: {
    status: async (_id, folder) => ({ ok: true, folder, files: [' M a.txt', '?? b.txt'] }),
    diff: async () => ({ ok: false, error: 'no repo', folder: '', branch: '', files: [], stat: '', body: '' })
  },
  win: { minimize: () => {}, maximize: () => {}, close: () => {} },
  update: {
    check: async () => ({ ok: true, current: '2.5.0', available: false, release: null }),
    download: async () => ({ error: 'not tested here' }),
    apply: async () => ({ ok: true }),
    onProgress: () => () => {},
    openRelease: async () => {}
  }
}
dom.window.codezy = mock

const entry = path.join(OUT, 'entry.tsx')
fs.writeFileSync(
  entry,
  [
    `export { default as IdePane } from '${PROJ}/src/renderer/src/components/IdePane'`,
    `export { default as ChatView } from '${PROJ}/src/renderer/src/components/ChatView'`,
    `export { default as HistoryModal } from '${PROJ}/src/renderer/src/components/HistoryModal'`,
    `export { default as SettingsModal } from '${PROJ}/src/renderer/src/components/SettingsModal'`,
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
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}
const rootNode = ui.createRoot(document.getElementById('root'))
const render = async (el) => {
  await ui.act(async () => {
    rootNode.render(el)
  })
}
const btn = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label)
const click = async (el) => {
  if (!el) return
  await ui.act(async () => {
    el.click()
  })
  await flush(3)
}
const setText = async (el, value) => {
  if (!el) return // a missing node is reported by the check before this
  await ui.act(async () => {
    // the value setter lives on the prototype (React reads through it)
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value') ?? Object.getOwnPropertyDescriptor(el, 'value')
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
const key = async (el, init) => {
  if (!el) return
  await ui.act(async () => {
    el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, ...init }))
  })
  await flush(3)
}

// --- 3a. cowork pane -----------------------------------------------------------
{
  ui.useApp.setState({ ideOpen: true, activeId: 's1', ideTick: 0 })
  await render(ui.createElement(ui.IdePane))
  await flush(4)

  check('pane: opens for the linked chat', !!document.querySelector('.ide-pane'), document.querySelector('.ide-pane')?.className ?? 'missing')
  check('pane: scope says one folder', document.querySelector('.ide-scope')?.textContent === '1 folder', document.querySelector('.ide-scope')?.textContent)

  const marker = document.querySelector('.ide-more')
  check('pane: a tree-cap marker row is shown', !!marker && /12 more files/.test(marker.textContent), marker?.textContent ?? 'missing')
  check('pane: the marker explains its title', marker?.title === 'Files left out by the tree cap', marker?.title ?? '')
  check('pane: the marker is not clickable', !!marker && marker.tagName === 'SPAN' && !marker.closest('button'))

  const gitChip = [...document.querySelectorAll('.ide-chip')].find((b) => b.textContent.trim() === 'git')
  const ignChip = [...document.querySelectorAll('.ide-chip')].find((b) => b.textContent.trim() === 'ignored')
  check('pane: git + ignored chips offered', !!gitChip && !!ignChip)
  check('pane: chips carry aria-pressed', gitChip?.getAttribute('aria-pressed') === 'true' && ignChip?.getAttribute('aria-pressed') === 'false', `${gitChip?.getAttribute('aria-pressed')}/${ignChip?.getAttribute('aria-pressed')}`)

  await flush(4)
  const badges = [...document.querySelectorAll('.ide-badge')]
  check('pane: git letters land on the right rows', badges.some((b) => b.dataset.st === 'M' && b.textContent === 'M') && badges.some((b) => b.dataset.st === '?'), JSON.stringify(badges.map((b) => b.dataset.st)))
  check('pane: a badge explains itself on hover', badges.find((b) => b.dataset.st === 'M')?.title === 'Modified (git)', badges.find((b) => b.dataset.st === 'M')?.title)

  await click(gitChip)
  check('pane: switching git off clears the badges', document.querySelectorAll('.ide-badge').length === 0, String(document.querySelectorAll('.ide-badge').length))
  await click(gitChip)
  await flush(4)
  check('pane: switching git back on repaints them', document.querySelectorAll('.ide-badge').length > 0)

  const beforeIgnored = treeCalls.length
  await click(ignChip)
  await flush(4)
  check('pane: the ignored chip re-reads the tree with showIgnored', treeCalls.length > beforeIgnored && treeCalls.at(-1) === true, JSON.stringify(treeCalls))
  check('pane: the ignored chip marks itself on', ignChip.getAttribute('aria-pressed') === 'true', ignChip.getAttribute('aria-pressed'))
  await click(ignChip)
  await flush(4)

  // Ctrl+P quick-open
  await key(document, { key: 'p', ctrlKey: true })
  const quick = document.querySelector('.ide-quick')
  check('pane: Ctrl+P opens quick-open', !!quick && !!quick.querySelector('input'), quick ? quick.className : 'missing')
  const quickInput = quick?.querySelector('input')
  check('pane: quick-open placeholder explains the keys', quickInput?.placeholder === 'Go to file — type, Enter opens, Esc closes', quickInput?.placeholder)
  const rows = () => [...document.querySelectorAll('.ide-quick-row')].map((r) => r.textContent)
  check('pane: every FILE is listed, marker rows are not', rows().length === 3 && rows().every((t) => !/more files/.test(t)), JSON.stringify(rows()))
  await setText(quickInput, 'app')
  check('pane: typing filters to the match', rows().length === 1 && /app\.ts/.test(rows()[0]), JSON.stringify(rows()))
  await setText(quickInput, 'zzz-nothing')
  check('pane: a miss says so', !!document.querySelector('.ide-quick-empty'), document.querySelector('.ide-quick-empty')?.textContent ?? '')
  await key(quickInput, { key: 'Escape' })
  check('pane: Escape closes it', !document.querySelector('.ide-quick'))

  // open a file → status bar with Ln/Col + wrap
  const file = [...document.querySelectorAll('.ide-file')].find((b) => b.title.includes('a.txt'))
  await click(file)
  await flush(4)
  const pos = document.querySelector('.ide-pos')
  check('pane: opening a file shows the caret position', !!pos && pos.textContent.replace(/\s+/g, ' ').trim() === 'Ln 1, Col 1', pos?.textContent ?? 'missing')
  const ta = document.querySelector('.ide-editor textarea')
  check('pane: the editor holds the file', !!ta && ta.value.startsWith('line one'), ta ? ta.value.slice(0, 20) : 'missing')
  await ui.act(async () => {
    ta.focus()
    ta.setSelectionRange(10, 10) // second line, second column
    ta.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true }))
  })
  await flush(2)
  check('pane: moving the caret updates Ln/Col', pos.textContent.replace(/\s+/g, ' ').trim() === 'Ln 2, Col 2', pos.textContent)

  const wrapChip = [...document.querySelectorAll('.ide-status .ide-chip')].find((b) => b.textContent.trim() === 'wrap')
  check('pane: a wrap toggle sits in the status bar', !!wrapChip && wrapChip.getAttribute('aria-pressed') === 'false', wrapChip?.getAttribute('aria-pressed') ?? 'missing')
  await click(wrapChip)
  check('pane: wrap persists', wrapChip.getAttribute('aria-pressed') === 'true' && localStorage.getItem('codezy.ideWrap') === '1', String(localStorage.getItem('codezy.ideWrap')))

  // new file / new folder
  const newFileBtn = document.querySelector('[aria-label="New file"]')
  check('pane: head has a New file button', !!newFileBtn)
  await click(newFileBtn)
  const newInput = document.querySelector('.ide-new input') // .ide-new is the wrapper
  check(
    'pane: the new-file bar explains Enter',
    !!newInput && /Enter creates/.test(newInput.placeholder),
    newInput?.placeholder ??
      `missing; ide-new-in-html=${document.body.innerHTML.includes('ide-new')} labels=[${[...document.querySelectorAll('[aria-label]')]
        .map((x) => x.getAttribute('aria-label'))
        .join('|')}]`
  )
  await setText(newInput, 'fresh.txt')
  await key(newInput, { key: 'Enter' })
  await flush(4)
  check('pane: Enter creates the file at the root', createCalls.length === 1 && createCalls[0].target === `${ROOT}/fresh.txt` && createCalls[0].dir === false, JSON.stringify(createCalls))

  const newDirBtn = document.querySelector('[aria-label="New folder"]')
  await click(newDirBtn)
  const dirInput = document.querySelector('.ide-new input')
  check('pane: the new-folder bar asks for a folder name', !!dirInput && /Enter creates the folder/.test(dirInput.placeholder), dirInput?.placeholder ?? `missing; html=${document.body.innerHTML.includes('ide-new')}`)
  await setText(dirInput, 'sub')
  await key(dirInput, { key: 'Enter' })
  await flush(4)
  check('pane: Enter creates a folder, not a file', createCalls.length === 2 && createCalls[1].dir === true && createCalls[1].target.endsWith('/sub'), JSON.stringify(createCalls))

  // the row menu: opens on right-click, survives a press inside, closes outside
  const target = [...document.querySelectorAll('.ide-file')].find((b) => b.title.includes('b.txt'))
  await ui.act(async () => {
    target.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }))
  })
  await flush(3)
  let menu = document.querySelector('.ide-ctx')
  check('pane: right-click opens the row menu', !!menu, menu ? menu.className : 'missing')
  check('pane: the menu offers the row actions', !!menu && ['Copy path', 'Rename', 'Delete'].every((t) => [...menu.querySelectorAll('button')].some((b) => b.textContent.trim() === t)), menu ? [...menu.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|') : '')

  await ui.act(async () => {
    menu.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
  })
  await flush(3)
  menu = document.querySelector('.ide-ctx')
  check('pane: pressing INSIDE the menu keeps it open', !!menu, menu ? 'open' : 'closed')

  await ui.act(async () => {
    document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
  })
  await flush(3)
  check('pane: pressing outside closes it', !document.querySelector('.ide-ctx'))

  await ui.act(async () => {
    target.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }))
  })
  await flush(3)
  const copy = [...document.querySelectorAll('.ide-ctx button')].find((b) => b.textContent.trim() === 'Copy path')
  await click(copy)
  check('pane: Copy path lands in the clipboard', clip.includes('b.txt'), clip)
}

// --- 3b. quick follow-ups under the last reply ---------------------------------
{
  ui.useApp.setState({ ideOpen: false, activeId: 's1', streaming: false })
  await render(ui.createElement(ui.ChatView))
  await flush(4)
  const chips = [...document.querySelectorAll('.followup')].map((b) => b.textContent.trim())
  check('chat: four quick follow-ups under the last reply', chips.length === 4, JSON.stringify(chips))
  check('chat: the expected four labels', JSON.stringify(chips) === JSON.stringify(['Continue', 'Explain', 'Review it', 'Add tests']), JSON.stringify(chips))

  const sendsBefore = chatSends.length
  const savesBefore = savedSessions.length
  await click(btn('Explain'))
  const saved = savedSessions.slice(savesBefore)
  check(
    'chat: a chip sends its prompt',
    chatSends.length > sendsBefore && saved.some((s) => JSON.stringify(s.messages).includes('Explain what you just did')),
    JSON.stringify({ sends: chatSends.slice(savesBefore), saved: saved.map((s) => s.messages?.map((m) => m.content)) })
  )

  await ui.act(async () => {
    ui.useApp.setState({ streaming: true })
  })
  await flush(3)
  check('chat: nothing is offered while a reply streams', document.querySelectorAll('.followup').length === 0, String(document.querySelectorAll('.followup').length))
  await ui.act(async () => {
    ui.useApp.setState({ streaming: false })
  })
}

// --- 3c. /history + the history modal ------------------------------------------
{
  await st().send('/history')
  check('cmd /history opens the history', st().historyOpen === true, String(st().historyOpen))

  historyRows = [
    { id: '1700000000002', ts: Date.now(), files: ['a.txt', 'b.txt'] },
    { id: '1700000000001', ts: Date.now() - 60000, files: ['c.txt'] }
  ]
  await render(ui.createElement(ui.HistoryModal))
  await flush(4)
  const panel = document.querySelector('.hist-panel')
  check('history: the panel is up', !!panel && panel.getAttribute('aria-label') === 'Edit history', panel ? panel.getAttribute('aria-label') : 'missing')
  check('history: one row per backup', document.querySelectorAll('.hist-row').length === 2, String(document.querySelectorAll('.hist-row').length))
  const firstRow = document.querySelector('.hist-row')
  check('history: a row shows time, files and a count', !!firstRow.querySelector('.hist-time') && /a\.txt/.test(firstRow.querySelector('.hist-files').textContent) && /2 files?$/.test(firstRow.querySelector('.hist-count').textContent.trim()), firstRow.textContent.slice(0, 70))
  check('history: every row can be restored', document.querySelectorAll('.hist-row button').length === 2)
  check('history: undo-newest sits in the head', !!btn('Undo newest'))

  restoreCalls.length = 0
  await click(document.querySelectorAll('.hist-row button')[0])
  check('history: Restore asks main to put that point back', restoreCalls.length === 1 && restoreCalls[0] === '1700000000002', JSON.stringify(restoreCalls))

  historyRows = []
  await ui.act(async () => {
    ui.useApp.setState({ historyOpen: false })
  })
  await flush(2)
  await ui.useApp.setState({ historyOpen: true })
  await render(ui.createElement(ui.HistoryModal))
  await flush(4)
  check('history: an empty chat says when backups appear', /No backups for this chat yet/.test(document.querySelector('.hist-panel')?.textContent ?? ''), (document.querySelector('.hist-panel')?.textContent ?? '').slice(0, 60))
  await ui.act(async () => {
    ui.useApp.setState({ historyOpen: false })
  })
}

// --- 3d. settings: backup export/import + test notification --------------------
{
  await ui.useApp.setState({ settingsOpen: true, settings: { ...st().settings } })
  await render(ui.createElement(ui.SettingsModal))
  const exportBtn = btn('export settings (.json)')
  const importBtn = btn('import settings…')
  check('settings: export + import offered', !!exportBtn && !!importBtn, [...document.querySelectorAll('.settings-section')].map((s) => s.textContent).join('|'))
  savedTexts.length = 0
  await click(exportBtn)
  check('settings: export writes a JSON file', savedTexts.length === 1 && savedTexts[0].name === 'codezy-settings.json' && savedTexts[0].content.includes('"theme"'), JSON.stringify(savedTexts.map((s) => s.name)))
  check('settings: the export notice mentions the keys', st().notices.some((n) => /includes your provider API keys/.test(n.text)), JSON.stringify(st().notices.map((n) => n.text)))

  const instructions = [...document.querySelectorAll('textarea')].find((t) => /Answer in Polish/.test(t.placeholder))
  check('settings: custom instructions field with an example', !!instructions, instructions ? '' : 'missing')
  if (instructions) {
    await setText(instructions, 'Never use emoji.')
    await flush(3)
    check('settings: instructions save as you type', st().settings.instructions === 'Never use emoji.', String(st().settings.instructions))
  }

  globalThis.__notifications.length = 0
  await click(btn('send a test'))
  check('settings: a test notification is fired', globalThis.__notifications.length === 1 && globalThis.__notifications[0].title === 'CODEZY', JSON.stringify(globalThis.__notifications))
  check('settings: and it says it was sent', st().notices.some((n) => /Test notification sent/.test(n.text)), JSON.stringify(st().notices.map((n) => n.text)))
  await ui.act(async () => {
    ui.useApp.setState({ settingsOpen: false })
  })
}

// --- 3e. palette: the history + update entries ---------------------------------
{
  await ui.useApp.setState({ paletteOpen: true, historyOpen: false })
  await render(ui.createElement(ui.Palette))
  await flush(3)
  const text = document.querySelector('.palette')?.textContent ?? ''
  check('palette: history entry present', text.includes('Edit history — restore a backup'), text.slice(0, 140))
  const historyEntry = [...document.querySelectorAll('.pal-item')].find((b) => /Edit history/.test(b.textContent))
  await ui.useApp.setState({ historyOpen: false })
  await click(historyEntry)
  check('palette: the history entry opens the history', st().historyOpen === true, String(st().historyOpen))

  await ui.useApp.setState({ paletteOpen: true })
  await flush(2)
  const input = document.querySelector('.palette input')
  await setText(input, 'update')
  const labels = [...document.querySelectorAll('.pal-label')].map((l) => l.textContent)
  check('palette: /update is searchable', labels.includes('/update'), JSON.stringify(labels))
}

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)




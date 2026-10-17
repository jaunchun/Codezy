// Batch 10 — desktop mirror + style pass:
//  1. shared/commands (esbuild-bundled): /rewind /fast /doctor /cost /add-dir
//     registered, helpText lists them, parseInput handles hyphen commands and
//     the "#fact" remember kind.
//  2. store/app (esbuild-bundled, real dispatch): every new handler runs
//     through send() against a mocked window.codezy — no window is opened,
//     settings.json and memory.md on disk are never touched.
//  3. global.css: design layer still delimited + last, terminal notices
//     (toast) in the mono stack with a short strong ease-out enter.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const require = createRequire(path.join(PROJ, 'package.json'))
const { build } = require('esbuild')

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const OUT = path.join(os.tmpdir(), `codezy-batch10-${Date.now()}`)
fs.mkdirSync(OUT, { recursive: true })
process.on('exit', () => {
  try {
    fs.rmSync(OUT, { recursive: true, force: true })
  } catch {}
})

// --- 1. shared/commands ------------------------------------------------------
await build({
  entryPoints: [path.join(PROJ, 'src/shared/commands.ts')],
  outfile: path.join(OUT, 'commands.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { COMMANDS, helpText, parseInput } = await import(pathToFileURL(path.join(OUT, 'commands.mjs')).href)

const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]))
for (const n of ['/rewind', '/fast', '/doctor', '/cost', '/add-dir']) {
  check(`commands: ${n} registered`, !!byName[n], JSON.stringify(byName[n]))
}
check('commands: /rewind args [n]', byName['/rewind']?.args === '[n]', byName['/rewind']?.args)
check('commands: /add-dir args <folder>', byName['/add-dir']?.args === '<folder>', byName['/add-dir']?.args)

const help = helpText()
check('help lists all five', ['/rewind', '/fast', '/doctor', '/cost', '/add-dir'].every((n) => help.includes(n)))
check('help keeps older commands', ['/copy', '/goal', '/theme', '/review'].every((n) => help.includes(n)))

check(
  'parseInput /rewind 2',
  eq(parseInput('/rewind 2'), { kind: 'command', name: '/rewind', args: '2' }),
  JSON.stringify(parseInput('/rewind 2'))
)
check('parseInput /fast', parseInput('/fast').kind === 'command' && parseInput('/fast').name === '/fast')
check('parseInput /doctor', parseInput('/doctor').name === '/doctor' && parseInput('/doctor').kind === 'command')
check('parseInput /cost', parseInput('/cost').name === '/cost' && parseInput('/cost').kind === 'command')
check(
  'parseInput /add-dir (hyphen command)',
  eq(parseInput('/add-dir C:/proj'), { kind: 'command', name: '/add-dir', args: 'C:/proj' }),
  JSON.stringify(parseInput('/add-dir C:/proj'))
)
check('parseInput unknown /usr/local stays chat', parseInput('/usr/local/bin').kind === 'chat')
check(
  'parseInput #fact → remember',
  eq(parseInput('#ship it tomorrow'), { kind: 'remember', fact: 'ship it tomorrow' }),
  JSON.stringify(parseInput('#ship it tomorrow'))
)
check('parseInput bare # stays chat', parseInput('#').kind === 'chat')
check('parseInput plain chat', eq(parseInput('hello there'), { kind: 'chat', text: 'hello there' }))

// --- 2. store/app — real dispatch with a mocked bridge ------------------------
let MEM = '# What CODEZY knows about you\n- likes vi keybindings\n'
const mock = {
  settings: {
    // main merges the patch over what's on disk (patchSettings)
    set: async (patch) => ({ ...useApp.getState().settings, ...patch })
  },
  health: { ollama: async () => 'online', drive: async () => ({ folder: null }) },
  memory: { read: async () => MEM, write: async (t) => { MEM = t; return true } },
  skills: { list: async () => ['refactor', 'release-notes'] },
  sessions: { save: async (s) => s },
  models: { list: async () => [] }
}
globalThis.window = { codezy: mock }

await build({
  entryPoints: [path.join(PROJ, 'src/renderer/src/store/app.ts')],
  outfile: path.join(OUT, 'app.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent'
})
const { useApp } = await import(pathToFileURL(path.join(OUT, 'app.mjs')).href)

const now = Date.now()
const msgs = [0, 1, 2, 3].map((i) => ({
  id: `m${i}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `message number ${i} with some words`,
  ts: now + i
}))
const session = {
  id: 's1',
  projectId: null,
  title: 'batch10',
  createdAt: now,
  updatedAt: now,
  messages: msgs,
  linkedFolders: []
}
const settings = {
  theme: 'dark',
  accent: '#3d9bff',
  dataDir: 'C:/tmp/batch10',
  driveFolder: null,
  ollamaUrl: 'http://127.0.0.1:11434',
  providers: [],
  activeProvider: 'ollama',
  activeModel: 'qwen2.5-coder:7b',
  effort: 'medium',
  userName: 'dev',
  learn: true,
  fontSize: 14,
  mode: 'build'
}
useApp.setState({ settings, sessions: [session], activeId: 's1', notices: [], ready: true })

const st = () => useApp.getState()
const last = () => st().notices[st().notices.length - 1]
const send = async (t) => st().send(t, [], false)
const s1 = () => st().sessions.find((x) => x.id === 's1')

// /fast — effort toggle both directions
await send('/fast')
check('fast ON', last()?.text === 'Fast mode ON — effort light.' && st().settings.effort === 'light', `${last()?.text} / effort=${st().settings.effort}`)
await send('/fast')
check('fast OFF', last()?.text === 'Fast mode OFF — effort medium.' && st().settings.effort === 'medium', `${last()?.text} / effort=${st().settings.effort}`)

// /cost — transcript estimate
await send('/cost')
const cost = last()?.text ?? ''
check('cost header', cost.startsWith('qwen2.5-coder:7b · medium'), cost.split('\n')[0])
check('cost turns row', /turns\s+2 user · 2 assistant · 4 messages/.test(cost), cost.split('\n')[2])
check('cost transcript row', /transcript\s+\d+(\.\d+)? (B|kB|MB) of text — about \d+ tokens/.test(cost), cost.split('\n')[3])
check('cost local line', cost.includes('local model — no per-call cost'))

// /rewind — listing → invalid → applied
await send('/rewind')
check('rewind listing', (last()?.text ?? '').includes('4 messages in this chat — /rewind <n> drops that many'), (last()?.text ?? '').slice(0, 80))
await send('/rewind 9')
check('rewind invalid', (last()?.text ?? '').startsWith('Usage: /rewind <1..4>') && last()?.kind === 'error', `${last()?.kind}: ${last()?.text}`)
await send('/rewind 1')
check('rewind applied', s1()?.messages.length === 3 && (last()?.text ?? '').includes('Rewound 1 message — 3 left.'), `${s1()?.messages.length} msgs · ${last()?.text}`)

// /add-dir — new + duplicate
await send('/add-dir C:/proj')
check('add-dir linked', s1()?.linkedFolders.join() === 'C:/proj' && (last()?.text ?? '').startsWith('Linked folder: C:/proj'), JSON.stringify(s1()?.linkedFolders))
await send('/add-dir C:/proj')
check('add-dir duplicate', last()?.text === 'Already linked: C:/proj', last()?.text)

// /doctor — rows with marks
await send('/doctor')
const doc = last()?.text ?? ''
check('doctor model row', /✓\s+model\s+qwen2\.5-coder:7b/.test(doc), doc.split('\n')[0])
check('doctor endpoint row', /✓\s+endpoint\s+Ollama online/.test(doc), doc.split('\n')[1])
check('doctor folder row', /✓\s+folder\s+C:\/proj/.test(doc), doc.split('\n')[2])
check('doctor memory row', /✓\s+memory\s+on · \d/.test(doc), doc.split('\n')[3])
check('doctor skills row', doc.includes('2 installed'), doc.split('\n')[4])
check('doctor fix hint', doc.includes('first ✗ above is the thing to fix'))

// "#fact" — straight into memory through /remember
const memBefore = MEM
await send('#use tabs for indentation')
check('#fact written to memory', MEM !== memBefore && MEM.includes('- use tabs for indentation'), JSON.stringify(MEM.slice(-60)))
check('#fact notice', (last()?.text ?? '').startsWith('Remembered: use tabs for indentation'), last()?.text)

// /help through the real path still lists the new commands
await send('/help')
check('store /help lists /add-dir', (last()?.text ?? '').includes('/add-dir'))

// --- 3. global.css design layer ----------------------------------------------
const css = fs.readFileSync(path.join(PROJ, 'src/renderer/src/styles/global.css'), 'utf8')
const marker = 'CODEZY v2 · DESIGN LAYER'
const mi = css.indexOf(marker)
check('css: design layer marker', mi > 0, `at ${mi}`)
check('css: layer is last, file closes cleanly', mi > css.indexOf('.dump-list') && css.trimEnd().endsWith('}'))
const layer = css.slice(mi)
check('css: toast mono typography in layer', layer.includes('.toast {') && layer.includes('font-family: var(--mono)') && layer.includes('font-variant-numeric: tabular-nums'))
check('css: snappy enter (200ms strong ease-out)', layer.includes('animation-duration: 0.2s') && layer.includes('cubic-bezier(0.23, 1, 0.32, 1)'))
check('css: toast action keeps ui font', layer.includes('.toast .toast-action') && layer.includes('font-family: var(--font)'))
check('css: no transition: all anywhere', !/transition:[^;]*\ball\b/.test(css))
check('css: reduced motion still present', (css.match(/prefers-reduced-motion/g) ?? []).length >= 2)
check('css: palettes carried in layer', ['midnight', 'ember', 'mint', 'slate'].every((p) => layer.includes(`data-palette='${p}'`)))
check('css: composer accent edge in layer', layer.includes('.composer:focus-within'))

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

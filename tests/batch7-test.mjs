// Batch 7 — TUI input & quick actions (headless):
//  A. piped: /help rows, !shell prefix (card + context push), #fact + /remember
//     (memory.md append + card), /fast toggle (settings), /vim usage+persist,
//     /rewind card + numbered rewind + empty notice.
//  B1. CODEZY_TTY=1: cursor editing (left arrow + insert in the middle).
//  B2. CODEZY_TTY=1: /vim → esc · x · dd (band really changes), mode tag in the
//      status line, /vim off, Esc Esc → rewind picker → cancel.
//  Restores settings.json (effort, vim) and memory.md on exit.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const TUI = path.join(PROJ, 'cli/codezy.mjs')
const HOME = path.join(os.homedir(), '.codezy')

const readJson = (f, fb) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fb
  }
}
const settingsFile = path.join(HOME, 'settings.json')
const settings = readJson(settingsFile, {})
const DATA = settings.dataDir && settings.dataDir !== HOME ? settings.dataDir : HOME
const memFile = path.join(DATA, 'memory.md')

const memBefore = fs.existsSync(memFile) ? fs.readFileSync(memFile, 'utf8') : null
const effortBefore = settings.effort ?? 'medium'
const vimBefore = settings.vim
const restore = () => {
  // memory.md: drop exactly the lines this test appended
  if (fs.existsSync(memFile)) {
    const kept = fs
      .readFileSync(memFile, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !/^- b7-\d/.test(l))
    if (memBefore !== null) fs.writeFileSync(memFile, kept.join('\n'))
    else if (kept.some(Boolean)) fs.writeFileSync(memFile, kept.join('\n'))
    else fs.rmSync(memFile, { force: true })
  }
  const s = readJson(settingsFile, {})
  s.effort = effortBefore
  if (vimBefore === undefined) delete s.vim
  else s.vim = vimBefore
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2))
}
process.on('exit', restore)

const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '\n')

/** Every input-band text drawn so far, trimmed (bands may share a line). */
const bands = (raw) =>
  (strip(raw).match(/▌ [^▌]*/g) ?? []).map((m) => m.trim()).filter((m) => m.length > 2)

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}
const MARK = `b7-${Date.now() % 100000}`

function run(args, keys, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TUI], {
      cwd: PROJ,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.tty ? { CODEZY_TTY: '1' } : {}) }
    })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    const kill = setTimeout(() => {
      try {
        p.kill()
      } catch {}
    }, opts.total ?? 60000)
    for (const [ms, buf] of keys) setTimeout(() => p.stdin.write(buf), ms)
    if (opts.end) setTimeout(() => p.stdin.end(), opts.end)
    p.on('close', (code) => {
      clearTimeout(kill)
      resolve({ out, code })
    })
  })
}

// --- A. piped ------------------------------------------------------------------
const A = await run(
  null,
  [
    [900, '/help\r'],
    [1750, `!echo ${MARK}-shell\r`],
    [2600, `#${MARK}-fact\r`],
    [3450, `/remember ${MARK}-rem\r`],
    [4300, '/remember\r'],
    [5150, '/fast\r'],
    [6000, '/fast\r'],
    [6850, '/vim on\r'],
    [7700, '/vim badarg\r'],
    [8550, '/vim off\r'],
    [9400, '/rewind\r'],
    [10250, '/rewind 1\r'],
    [11100, '/rewind\r'],
    [11950, '/quit\r']
  ],
  { end: 13200 }
)
{
  const s = strip(A.out)
  check('A exit 0', A.code === 0, `code=${A.code}`)
  check('A /help lists /vim', s.includes('/vim'))
  check('A /help lists /rewind', s.includes('/rewind'))
  check('A /help lists /remember', s.includes('/remember'))
  check('A /help lists /fast', s.includes('/fast'))
  check('A help ! row', s.includes('! cmd run a shell command'))
  check('A help # row', s.includes('# fact'))
  check('A help esc esc row', s.includes('esc esc'))
  check('A ! card title', s.includes(`! echo ${MARK}-shell`))
  check('A ! output shown', s.includes(`${MARK}-shell`))
  check('A ! exit + context', s.includes('exit 0 · output added to context'))
  check('A #fact remembered', s.includes(`remembered — "${MARK}-fact"`))
  const mem = fs.existsSync(memFile) ? fs.readFileSync(memFile, 'utf8') : ''
  check('A memory.md has #fact', mem.includes(`- ${MARK}-fact`))
  check('A /remember remembered', s.includes(`remembered — "${MARK}-rem"`))
  check('A memory.md has /remember', mem.includes(`- ${MARK}-rem`))
  check('A /remember shows card', /╭─ memory/.test(s))
  check('A /fast ON', s.includes('fast mode ON — effort light'))
  check('A /fast OFF', s.includes('fast mode OFF — effort medium'))
  check('A /vim on notice', s.includes('vim mode on — esc normal'))
  check('A /vim bad usage', s.includes('usage: /vim <on|off>'))
  check('A /vim off notice', s.includes('vim mode off'))
  check(
    'A settings persisted',
    readJson(settingsFile, {}).effort === 'medium' && readJson(settingsFile, {}).vim === false,
    `effort=${readJson(settingsFile, {}).effort} vim=${readJson(settingsFile, {}).vim}`
  )
  check('A /rewind card', /╭─ rewind/.test(s) && s.includes('Ran in the terminal'))
  check('A /rewind 1 works', s.includes('rewound 1 message — 0 left'))
  check('A /rewind empty', s.includes('nothing to rewind'))
}

// --- B1. cursor editing (fresh buffer, no submit) -------------------------------
const B1 = await run(
  null,
  [
    [1700, 'ab'],
    [2100, '\x1b[D'],
    [2450, 'X'],
    [2950, '\x03'],
    [3250, '\x03']
  ],
  { tty: true, total: 15000 }
)
{
  const b = bands(B1.out)
  check('B1 exit 0', B1.code === 0, `code=${B1.code}`)
  check('B1 left-arrow insert → aXb', b.includes('▌ aXb'), `bands=${JSON.stringify(b.slice(-4))}`)
}

// --- B2. vim keys + esc esc (chat mode via !echo — no model call) ----------------
const B2 = await run(
  null,
  [
    [1700, '/vim on\r'],
    [2600, `!echo ${MARK}-tty\r`],
    [3500, 'zzq'],
    [3900, '\x1b'],
    [4250, 'x'],
    [4650, 'dd'],
    [5100, 'i'],
    [5450, '/vim off\r'],
    [6300, '\x1b'],
    [6550, '\x1b'],
    [7500, '\x1b'],
    [8100, '\x03'],
    [8400, '\x03'],
    [8700, '\x03']
  ],
  { tty: true, total: 25000 }
)
{
  const s = strip(B2.out)
  const b = bands(B2.out)
  check('B2 exit 0', B2.code === 0, `code=${B2.code}`)
  check('B2 /vim on accepted', s.includes('vim mode on — esc normal'))
  check('B2 insert mode band', b.includes('▌ zzq'), `bands=${JSON.stringify(b.slice(0, 12))}`)
  check('B2 esc + x → zz', b.includes('▌ zz'), `bands=${JSON.stringify(b.slice(0, 12))}`)
  check('B2 dd clears the line', b.includes('▌ Ask anything... "explain this function"'))
  check('B2 mode tag in status', s.includes('-- INSERT --'))
  check('B2 ! tty ran in chat', /╭─ ! echo b7-\d+-tty/.test(s))
  check('B2 ! output shown', s.includes(`${MARK}-tty`))
  check('B2 esc esc opens rewind', s.includes('rewind · 1 turns · pick to jump back'))
  check('B2 esc cancels picker', s.includes('rewind cancelled'))
}

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

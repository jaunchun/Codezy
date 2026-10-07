// Batch 2 headless check: ctrl+p palette, ctrl+r history, @file autocomplete
// (splash + chat mode), and status-bar hint while a palette is open.
import { spawn } from 'node:child_process'

const TUI = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy/cli/codezy.mjs'
const CWD = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '\n')

function spawnTui() {
  const p = spawn(process.execPath, [TUI], {
    cwd: CWD,
    env: { ...process.env, CODEZY_TTY: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  p.out = ''
  p.stdout.on('data', (d) => (p.out += d))
  p.stderr.on('data', (d) => (p.out += d))
  return p
}

function finish(p, ms) {
  return new Promise((resolve) => {
    let done = false
    const end = () => {
      if (done) return
      done = true
      resolve({ out: p.out, code: p.exitCode })
    }
    p.on('close', end)
    setTimeout(() => {
      try {
        p.kill()
      } catch {}
      setTimeout(end, 200)
    }, ms)
  })
}

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

// --- A: splash palette → accept /model → run it → @files + tab → quit ---
const pa = spawnTui()
const when = (ms, s) => new Promise((r) => setTimeout(() => (pa.stdin.write(s), r()), ms))
await when(1000, '\x10') // ctrl+p
await when(1300, 'hel') // filter
await when(1700, '\r') // accept '/help'
await when(2100, '\r') // run it (splash command)
await when(3800, 'test @cli') // @ opens the file list
await when(4200, '\t') // tab accepts the first match
await when(4500, '\x03') // ctrl+c wipes the line
await when(4800, '\x12') // ctrl+r — history overlay (holds '/model ')
await when(5200, '\x1b') // esc closes it
await when(5500, '/quit\r')
const a = await finish(pa, 7500)
const linesA = strip(a.out).split('\n')
console.log('=== A: tail of splash run ===')
linesA.slice(-14).forEach((l) => console.log('| ' + l))
console.log('')

check('A exit 0', a.code === 0, `code=${a.code}`)
check('A palette header shown', linesA.some((l) => l.includes('commands ·')))
check('A /help selected first', linesA.some((l) => l.includes('▶ /help')))
check('A box took /help value', linesA.some((l) => l.includes('▌ /help')))
check('A /help card ran', linesA.some((l) => l.includes('this list')))
check('A @files header shown', linesA.some((l) => l.includes('@files ·')))
const acc = linesA.filter((l) => l.includes('test @') && l.includes('/'))
check('A tab accepted a path', acc.length > 0, acc[acc.length - 1] ?? '')
const lastBox = linesA.map((l, i) => (l.includes('Ask anything') ? i : -1)).filter((i) => i >= 0).pop()
const lastTyped = linesA.map((l, i) => (l.includes('test @') ? i : -1)).filter((i) => i >= 0).pop()
check('A ctrl+c wiped the line', lastBox > lastTyped, `box=${lastBox} typed=${lastTyped}`)
check('A ctrl+r history header', linesA.some((l) => l.includes('history ·')))
const histIdx = linesA.findIndex((l) => l.includes('history ·'))
check(
  'A history lists the /help entry',
  histIdx >= 0 && linesA.slice(histIdx).some((l) => l.includes('▶ /help')),
  linesA.slice(histIdx, histIdx + 4).join(' | ')
)

// --- B: chat mode — palette above input, status still below ---
const pb = spawnTui()
await new Promise((r) => setTimeout(r, 1000)) // let the REPL reach its first prompt
pb.stdin.write('hi\r')
// wait until the reply finished (status shows 2 msgs → back at the prompt)
await new Promise((resolve) => {
  const t = setInterval(() => {
    if (pb.out.includes('2 msgs')) {
      clearInterval(t)
      resolve()
    }
  }, 150)
  setTimeout(() => {
    clearInterval(t)
    resolve()
  }, 15000)
})
pb.stdin.write('\x10')
await new Promise((r) => setTimeout(r, 500))
pb.stdin.write('comp')
await new Promise((r) => setTimeout(r, 1500))
const b = await finish(pb, 500)

const frames = b.out.split('\x1b[H\x1b[2J')
const rows = strip(frames[frames.length - 1])
  .split('\n')
  .filter((l, i, arr) => !(l === '' && i === arr.length - 1))
console.log('=== B: last chat frame (tail rows) ===')
rows.slice(-14).forEach((l) => console.log('| ' + l))
console.log('')

const cmdIdx = rows.findIndex((l) => l.includes('commands ·'))
const selIdx = rows.findIndex((l) => l.includes('▶ /compact'))
const inpIdx = rows.findIndex((l) => l.includes('▌ comp'))
const stIdx = rows.findIndex((l) => l.includes('select ·'))
check('B reply arrived (2 msgs)', b.out.includes('2 msgs'))
check('B palette rows in frame', cmdIdx !== -1, `cmdIdx=${cmdIdx}`)
check('B filtered to /compact', selIdx !== -1, `selIdx=${selIdx}`)
check('B overlay above input', cmdIdx < inpIdx && selIdx < inpIdx, `cmd=${cmdIdx} sel=${selIdx} inp=${inpIdx}`)
check('B status still below input', stIdx > inpIdx, `inp=${inpIdx} status=${stIdx}`)
check('B status shows palette hint', (rows[stIdx] ?? '').includes('esc close'), rows[stIdx] ?? '')

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

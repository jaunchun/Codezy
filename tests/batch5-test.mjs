// Batch 5 headless check: proposal confirm keys (d = unified diff, a = always),
// /copy (explicit text → clipboard roundtrip + last-reply path), image attach
// (path in message → 📷 marker), and the /help listing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const TUI = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy/cli/codezy.mjs'
const CWD = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const SAVE = path.join(os.homedir(), '.codezy', 'terminal', 'batch5-fixture.json')
const PROJ = path.join(os.tmpdir(), `batch5-proj-${Date.now()}`)
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ps = (cmd, input) => {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      input
    })
    return r.status === 0 ? (r.stdout ?? '').trim() : null
  } catch {
    return null
  }
}

const cleanup = () => {
  try {
    fs.rmSync(SAVE, { force: true })
    fs.rmSync(PROJ, { recursive: true, force: true })
  } catch {}
}
process.on('exit', cleanup)

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

// fixtures
fs.mkdirSync(PROJ, { recursive: true })
fs.mkdirSync(path.dirname(SAVE), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'pixel.png'), Buffer.from(PNG_B64, 'base64'))
fs.writeFileSync(
  SAVE,
  JSON.stringify({
    id: 'batch5save',
    title: 'batch5 fixture save',
    savedAt: Date.now(),
    history: [
      { role: 'user', content: 'fixture hello', ts: 1 },
      { role: 'assistant', content: 'fixture hi', ts: 2 }
    ],
    notes: [],
    effort: 'medium',
    mode: 'build',
    linkFolder: PROJ,
    pending: [
      {
        path: 'hello.txt',
        isNew: true,
        search: 'EMPTY',
        replace: 'hello from proposal\nline two\n',
        added: 3,
        removed: 0
      }
    ]
  })
)

const clip0 = ps('Get-Clipboard -Raw')

// --- B first (fast, no model): /help lists /copy, /copy with no reply ---
{
  const pb = spawnTui()
  const when = (ms, s) => new Promise((r) => setTimeout(() => (pb.stdin.write(s), r()), ms))
  await when(1000, '/help\r')
  await when(1600, '/copy\r')
  await when(2100, '/quit\r')
  const b = await finish(pb, 4500)
  const linesB = strip(b.out).split('\n')
  check('B exit 0', b.code === 0, `code=${b.code}`)
  check('B /help lists /copy', linesB.some((l) => l.includes('/copy') && l.includes('clipboard')))
  check('B /copy empty notice', linesB.some((l) => l.includes('nothing to copy yet')))
}

// --- A: resume → /apply → d diff → a always → reply → /copy x2 → image ---
const pa = spawnTui()
const when = (ms, s) => new Promise((r) => setTimeout(() => (pa.stdin.write(s), r()), ms))
await when(1200, '/resume\r') // picker (splash DSR hop +250ms)
await when(2100, '\r') // pick the fixture (pending proposal + linkFolder)
await when(2800, '/apply\r') // confirm card + y/n/a/d/s/r loop
await when(3400, 'd\r') // unified diff of the proposal
await when(4000, 'a\r') // always → auto mode + apply
await when(4800, 'say exactly: PONG42\r')
await new Promise((resolve) => {
  const t = setInterval(() => {
    if (pa.out.includes('4 msgs')) {
      clearInterval(t)
      resolve()
    }
  }, 150)
  setTimeout(() => {
    clearInterval(t)
    resolve()
  }, 15000)
})
await when(600, '/copy clipboard probe 42\r')
await when(900, '/copy\r')
await when(1400, `what is this? ${path.join(PROJ, 'pixel.png')}\r`)
await sleep(4000)
pa.stdin.write('/quit\r')
for (let i = 0; i < 10 && pa.exitCode === null; i++) {
  await sleep(700)
  if (pa.exitCode === null) pa.stdin.write(i % 2 === 0 ? '\x1b' : '/quit\r')
}
const a = await finish(pa, 3000)
const linesA = strip(a.out).split('\n')
// debug aid: the untouched stream, so wrapped/missing lines can be inspected
try {
  fs.writeFileSync(path.join(CWD, 'tests', '.tmp', 'batch5-raw-A.log'), a.out)
} catch {}
console.log('=== A: notable lines ===')
linesA
  .filter((l) => /─ resume|resumed "|y apply|hello.txt|hello from proposal|auto-approve|copied |📷|wrote /.test(l))
  .slice(0, 18)
  .forEach((l) => console.log('| ' + l.slice(0, 150)))
console.log('')

check('A exit 0', a.code === 0, `code=${a.code}`)
check('A resume picker', linesA.some((l) => l.includes('─ resume ·')))
check('A fixture picked', linesA.some((l) => l.includes('resumed "batch5 fixture save"')))
check('A proposal pending noted', a.out.includes('proposal pending'))
check('A confirm hint has a/d', linesA.some((l) => l.includes('y apply · n decline · a always · d diff')))
check('A diff header', linesA.some((l) => l.includes('hello.txt') && l.includes('new file')))
check('A diff green additions', a.out.includes('\x1b[38;2;120;220;150m+hello from proposal'))
check('A always → auto notice', linesA.some((l) => l.includes('auto-approve on for this session')))
check('A proposal applied', linesA.some((l) => l.includes('✓ wrote') && l.includes('hello.txt')))
let written = ''
try {
  written = fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8')
} catch {}
check('A file on disk', written.includes('hello from proposal'), JSON.stringify(written.slice(0, 40)))
check('A reply arrived', a.out.includes('4 msgs'))
check('A /copy explicit notice', linesA.some((l) => /copied \d+ chars to the clipboard/.test(l)))
check('A /copy last-reply notice', linesA.some((l) => l.includes('(last reply)')))
check('A image marker in bubble', linesA.some((l) => l.includes('📷 1 image attached')))
const clip1 = ps('Get-Clipboard -Raw')
if (clip1 !== null) {
  // the second /copy (no args) overwrote the probe — last reply must be there
  check('A clipboard = last reply', clip1.includes('PONG42'), clip1.slice(0, 60))
} else {
  console.log('SKIP  A clipboard readback (clipboard unavailable in this session)')
}
if (clip0 !== null) ps('$v = [Console]::In.ReadToEnd(); Set-Clipboard -Value $v', clip0)

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

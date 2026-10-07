// Batch 3 headless check: interactive pickers (/effort /theme /settings),
// persistence to the shared settings.json, theme swap mid-session, piped
// fallback to plain output, and a chat-mode picker frame.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const TUI = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy/cli/codezy.mjs'
const CWD = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const SETTINGS = path.join(os.homedir(), '.codezy', 'settings.json')
const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '\n')

// snapshot the shared config so the test can put it back exactly as it was
let origSettings = null
try {
  origSettings = fs.readFileSync(SETTINGS, 'utf8')
} catch {}
const restoreSettings = () => {
  try {
    if (origSettings !== null) fs.writeFileSync(SETTINGS, origSettings)
    else fs.rmSync(SETTINGS, { force: true })
  } catch {}
}

function spawnTui(tty = true) {
  const p = spawn(process.execPath, [TUI], {
    cwd: CWD,
    env: tty ? { ...process.env, CODEZY_TTY: '1' } : process.env,
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

try {
  // --- C: piped mode keeps plain output (no pickers, no TTY) ---
  const pc = spawnTui(false)
  pc.stdin.write('/effort\r\n/theme\r\n/quit\r\n')
  const c = await finish(pc, 4000)
  const linesC = strip(c.out).split('\n')
  check('C piped exit 0', c.code === 0, `code=${c.code}`)
  check('C /effort prints plain line', linesC.some((l) => l.includes('effort: ')))
  check('C /theme prints card', linesC.some((l) => l.includes('theme')))
  check('C no picker header', !linesC.some((l) => l.includes('· type to filter')))

  // --- A: splash pickers — effort deep, theme ember, settings info ---
  const pa = spawnTui()
  const when = (ms, s) => new Promise((r) => setTimeout(() => (pa.stdin.write(s), r()), ms))
  await when(1200, '/effort\r') // opens the effort picker (DSR hop +250ms)
  await when(2400, '\x1b[B') // light → medium
  await when(2700, '\x1b[B') // → deep
  await when(3100, '\r') // pick deep → save + notice
  await when(4000, '/theme\r') // opens the theme picker
  await when(5200, '\x1b[B') // midnight → ember
  await when(5600, '\r') // apply + save + notice
  await when(6400, '/settings\r') // opens the settings picker
  await when(7600, 'config') // filter → config file
  await when(8000, '\r') // info notice with the path
  await when(8700, '/quit\r')
  const a = await finish(pa, 10500)
  const linesA = strip(a.out).split('\n')
  console.log('=== A: notable lines ===')
  linesA
    .filter((l) => /─ (effort|theme|settings)|▶ |effort →|theme →|config file:/.test(l))
    .slice(0, 14)
    .forEach((l) => console.log('| ' + l.slice(0, 150)))
  console.log('')

  check('A exit 0', a.code === 0, `code=${a.code}`)
  check('A effort picker header', linesA.some((l) => l.includes('─ effort · ')))
  check('A deep row highlighted', linesA.some((l) => l.includes('▶ deep')))
  check('A effort saved notice', linesA.some((l) => l.includes('effort → deep')))
  check('A theme picker header', linesA.some((l) => l.includes('─ theme · ')))
  check('A ember row highlighted', linesA.some((l) => l.includes('▶ ember')))
  check('A theme applied notice', linesA.some((l) => l.includes('theme → ember · accent #ff8a3d')))
  const themeAt = a.out.indexOf('theme → ember')
  check(
    'A ember band color used after swap',
    themeAt >= 0 && a.out.slice(themeAt).includes('\x1b[48;2;48;38;34m')
  )
  check('A settings picker header', linesA.some((l) => l.includes('─ settings · settings.json')))
  check('A config file info', linesA.some((l) => l.includes('config file: ')))

  let saved = null
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
  } catch {}
  check('A settings.json has effort deep', saved?.effort === 'deep', `effort=${saved?.effort}`)
  check('A settings.json has theme ember', saved?.theme === 'ember', `theme=${saved?.theme}`)

  // --- B: chat-mode picker + round-trip (boots with run A's saved effort) ---
  const pb = spawnTui()
  await new Promise((r) => setTimeout(r, 1000))
  pb.stdin.write('hi\r')
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
  pb.stdin.write('/effort\r')
  await new Promise((r) => setTimeout(r, 700))
  pb.stdin.write('\x1b[B') // light → medium (effort is deep on this boot)
  await new Promise((r) => setTimeout(r, 500))
  pb.stdin.write('\r')
  await new Promise((r) => setTimeout(r, 900))
  pb.stdin.write('/quit\r')
  const b = await finish(pb, 3500)

  const linesB = strip(b.out).split('\n')
  check('B exit 0', b.code === 0, `code=${b.code}`)
  check('B reply arrived', b.out.includes('2 msgs'))
  check('B picker shows persisted effort', linesB.some((l) => l.includes('─ effort · deep')), 'round-trip from run A')
  check('B medium highlighted', linesB.some((l) => l.includes('▶ medium')))
  check('B effort → medium notice', linesB.some((l) => l.includes('effort → medium')))

  let savedB = null
  try {
    savedB = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
  } catch {}
  check('B persistence written again', savedB?.effort === 'medium', `effort=${savedB?.effort}`)
} finally {
  restoreSettings()
  console.log(
    origSettings === null ? 'settings.json restored (removed)' : 'settings.json restored (original content)'
  )
}

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

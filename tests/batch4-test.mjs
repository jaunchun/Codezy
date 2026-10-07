// Batch 4 headless check: /diff (git overview + colored content + path arg),
// /open and /resume pickers (TTY, no args), git branch in the status bar and
// on the splash meta row. Fixtures (save + app chat + temp repo) are created
// and removed again — the user's real ~/.codezy data is left untouched.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const TUI = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy/cli/codezy.mjs'
const CWD = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const HOME = path.join(os.homedir(), '.codezy')
const TERM_DIR = path.join(HOME, 'terminal')
const SESS_DIR = path.join(HOME, 'sessions')
const FIX_SAVE = path.join(TERM_DIR, 'batch4-fixture-save.json')
const FIX_APP = path.join(SESS_DIR, 'batch4-fixture-app.json')

const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '\n')

// --- fixtures ----------------------------------------------------------------
const repo = path.join(os.tmpdir(), `batch4-repo-${Date.now()}`)
const git = (...argv) =>
  spawnSync('git', ['-C', repo, ...argv], { encoding: 'utf8', timeout: 10000, windowsHide: true })

const cleanup = () => {
  try {
    fs.rmSync(FIX_SAVE, { force: true })
    fs.rmSync(FIX_APP, { force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  } catch {}
}
process.on('exit', cleanup) // runs even on process.exit below

{
  fs.mkdirSync(repo, { recursive: true })
  git('init')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'line1\nline2\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'line1\nline2 changed\nline3')
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n')
  const branch = git('branch', '--show-current').stdout.trim()

  fs.mkdirSync(TERM_DIR, { recursive: true })
  fs.mkdirSync(SESS_DIR, { recursive: true })
  fs.writeFileSync(
    FIX_SAVE,
    JSON.stringify({
      id: 'batch4save',
      title: 'batch4 fixture save',
      savedAt: Date.now(),
      history: [
        { role: 'user', content: 'resume hello', ts: 1 },
        { role: 'assistant', content: 'resume hi', ts: 2 }
      ],
      notes: [],
      effort: 'medium',
      mode: 'build'
    })
  )
  fs.writeFileSync(
    FIX_APP,
    JSON.stringify({
      id: 'batch4app',
      title: 'batch4 fixture app',
      updatedAt: Date.now(),
      messages: [
        { role: 'user', content: 'app hello', ts: 1 },
        { role: 'assistant', content: 'app hi', ts: 2 }
      ]
    })
  )

  function spawnTui(cwd = CWD) {
    const p = spawn(process.execPath, [TUI], {
      cwd,
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

  // --- A: /diff without a repo, /link, /diff (+path), /open, /resume pickers ---
  const pa = spawnTui()
  const when = (ms, s) => new Promise((r) => setTimeout(() => (pa.stdin.write(s), r()), ms))
  await when(1200, '/diff\r') // cwd is not a repo → notice
  await when(2000, `/link ${repo}\r`)
  await when(2800, '/diff\r') // stat + colored body + untracked note
  await when(3600, `/diff file.txt\r`) // path narrowing
  await when(4400, '/open\r') // picker (splash, DSR hop +250ms)
  await when(5050, '\r') // pick the fixture app chat → chat mode
  await when(5900, '/resume\r') // picker (chat mode)
  await when(6300, '\r') // pick the fixture save
  await when(7000, '/quit\r')
  const a = await finish(pa, 9500)
  const linesA = strip(a.out).split('\n')
  console.log('=== A: notable lines ===')
  linesA
    .filter((l) => /not a git|changed file|untracked|─ (open|resume)|loaded "|resumed "|file\.txt/.test(l))
    .slice(0, 16)
    .forEach((l) => console.log('| ' + l.slice(0, 150)))
  console.log('')

  check('A exit 0', a.code === 0, `code=${a.code}`)
  check('A /diff without repo', linesA.some((l) => l.includes('is not a git repository')))
  check('A /diff summary', linesA.some((l) => /changed files? vs HEAD/.test(l)))
  check('A /diff stat lists file', linesA.some((l) => l.includes('file.txt') && l.includes('|')))
  check('A /diff green additions', a.out.includes('\x1b[38;2;120;220;150m+line3'))
  check('A /diff red deletions', a.out.includes('\x1b[38;2;255;90;90m-line2'))
  check('A /diff untracked note', linesA.some((l) => l.includes('1 untracked (not in diff)')))
  check('A /diff <path> narrowed', a.out.split('\x1b[38;2;120;220;150m+line3').length >= 3)
  check('A /open picker header', linesA.some((l) => l.includes('─ open ·')))
  check('A /open fixture listed', linesA.some((l) => l.includes('batch4 fixture app')))
  check('A /open loaded notice', linesA.some((l) => l.includes('loaded "batch4 fixture app"')))
  check('A /resume picker header', linesA.some((l) => l.includes('─ resume ·')))
  check('A /resume fixture listed', linesA.some((l) => l.includes('batch4 fixture save')))
  check('A /resume loaded notice', linesA.some((l) => l.includes('resumed "batch4 fixture save"')))

  // --- B: git branch in the chat status bar after /link ---
  const pb = spawnTui()
  await new Promise((r) => setTimeout(r, 1000))
  pb.stdin.write(`/link ${repo}\r`)
  await new Promise((r) => setTimeout(r, 900))
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
    }, 16000)
  })
  await new Promise((r) => setTimeout(r, 600))
  pb.stdin.write('/quit\r')
  const b = await finish(pb, 3500)
  const linesB = strip(b.out).split('\n')
  check('B exit 0', b.code === 0, `code=${b.code}`)
  check('B reply arrived', b.out.includes('2 msgs'))
  check(
    'B status shows branch',
    linesB.some((l) => l.includes(`${branch} · `)),
    `branch=${branch}`
  )

  // --- C: launched inside the repo → splash meta row carries the branch ---
  const pc = spawnTui(repo)
  await new Promise((r) => setTimeout(r, 1400))
  pc.stdin.write('/quit\r')
  const cOut = await finish(pc, 3500)
  const linesC = strip(cOut.out).split('\n')
  check('C exit 0', cOut.code === 0, `code=${cOut.code}`)
  check(
    'C meta row shows branch',
    linesC.some((l) => l.includes('chat ·') && l.includes(` · ${branch}`)),
    linesC.find((l) => l.includes('chat ·')) ?? ''
  )

  console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
  process.exit(fails.length ? 1 : 0)
}

// Batch 1 headless check: splash line layout + status-below-input in chat mode.
import { spawn } from 'node:child_process'

const TUI = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy/cli/codezy.mjs'
const CWD = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

function run(steps, ms) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TUI], {
      cwd: CWD,
      env: { ...process.env, CODEZY_TTY: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(out)
    }
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', finish)
    for (const [t, s] of steps) setTimeout(() => p.stdin.write(s), t)
    setTimeout(() => {
      try { p.kill() } catch {}
      finish()
    }, ms)
  })
}

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

// --- A: splash dump (commands run, then /quit) ---
const outA = await run([[1000, '/help\r'], [1600, '/quit\r']], 3500)
const linesA = strip(outA).split(/\r?\n/)
console.log('=== A: splash (first 20 stripped lines) ===')
linesA.slice(0, 20).forEach((l, i) => console.log(String(i + 1).padStart(2) + '| ' + l))
console.log('')

const wmIdx = linesA.findIndex((l) => l.includes('██████'))
const boxIdx = linesA.findIndex((l) => l.includes('Ask anything'))
const metaIdx = linesA.findIndex((l) => l.includes('chat ·'))
const hintIdx = linesA.findIndex((l) => l.includes('↑ history'))
const tipIdx = linesA.findIndex((l) => l.includes('Tip'))
const footIdx = linesA.findIndex((l) => /\d+\.\d+\.\d+/.test(l))
check('wordmark row 2 (blank first)', wmIdx === 1, `wmIdx=${wmIdx}`)
check('6 wordmark rows + 2 blanks above box', boxIdx - wmIdx === 8, `gap=${boxIdx - wmIdx}`)
check('meta row directly under box', metaIdx === boxIdx + 1, `metaIdx=${metaIdx}`)
check('hints 3 rows under box', hintIdx === boxIdx + 3, `hintIdx=${hintIdx}`)
check('tip 5 rows under box', tipIdx === boxIdx + 5, `tipIdx=${tipIdx}`)
check('footer (version) 7 rows under box', footIdx === boxIdx + 7, `footIdx=${footIdx}`)
check('placeholder full text, no ▊/▐', linesA[boxIdx]?.includes('Ask anything... "explain this function"'))
check('hints advertise ctrl+p', linesA[hintIdx]?.includes('ctrl+p'))
check('/help card printed below footer', linesA.some((l) => l.includes('╭─') && l.includes('commands')))

// --- B: live chat frame (Ollama) ---
const outB = await run([[1000, 'say just: ok\r']], 12000)
const frames = outB.split('\x1b[H\x1b[2J')
const rows = strip(frames[frames.length - 1]).split('\r\n')
console.log('\n=== B: last chat frame (tail rows) ===')
rows.slice(-8).forEach((l, i) => console.log(String(rows.length - 8 + i + 1).padStart(2) + '| ' + l))
console.log('')

const inpIdx = rows.findIndex((l) => l.includes('Ask anything'))
const stIdx = rows.findIndex((l) => l.includes('/help · ctrl+c exit'))
check('chat frame has input box', inpIdx !== -1, `inpIdx=${inpIdx}`)
check('status bar sits BELOW input', stIdx > inpIdx, `inp=${inpIdx} status=${stIdx}`)
check('status shows model+effort+msgs+ctx', /qwen2\.5-coder:7b.*medium.*msgs.*ctx/.test(rows[stIdx] ?? ''), rows[stIdx] ?? '')
check('model reply arrived', outB.includes('ok'), '')

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

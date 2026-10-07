// Batch 8 — TUI meta commands + headless JSON output (all model-free except
// the -p output-format calls, which use the live local Ollama):
//  A. piped TUI: /help rows, /export (empty notice + real file with # CODEZY
//     session / ## You / transcript), /cost card, /doctor card (node, endpoint,
//     git, terminal, fix-hint).
//  B. CLI: -p --output-format json parses (model/reply/duration/tokens),
//     stream-json = NDJSON lines ending in {type:result}, bogus format → exit 2,
//     text mode stays plain, exec (v2 agent) --output-format json parses,
//     --help documents the flag.
//  Restores nothing: settings/memory untouched by this batch.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const TUI = path.join(PROJ, 'cli/codezy.mjs')
const CLI = path.join(PROJ, 'cli/index.mjs')
const HOME = path.join(os.homedir(), '.codezy')

const readJson = (f, fb) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fb
  }
}
const settings = readJson(path.join(HOME, 'settings.json'), {})
const local = (settings.activeProvider ?? 'ollama') === 'ollama'

const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '\n')

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}
const MARK = `b8-${Date.now() % 100000}`
const EXP = path.join(os.tmpdir(), `codezy-${MARK}-export.md`)

function run(cmd, args, inputLines, gap = 1000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: PROJ, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    const kill = setTimeout(() => {
      try {
        p.kill()
      } catch {}
    }, 90000)
    let t = 900
    for (const l of inputLines ?? []) {
      setTimeout(() => p.stdin.write(l + '\r'), t)
      t += gap
    }
    if (inputLines) setTimeout(() => p.stdin.end(), t + gap)
    p.on('close', (code) => {
      clearTimeout(kill)
      resolve({ out, code })
    })
  })
}

// --- A. TUI piped ---------------------------------------------------------------
const A = await run(process.execPath, [TUI], [
  '/help',
  '/export',
  `!echo ${MARK}-shell`,
  `/export ${EXP}`,
  '/cost',
  '/doctor',
  '/quit'
])
{
  const s = strip(A.out)
  check('A exit 0', A.code === 0, `code=${A.code}`)
  check('A help /export', s.includes('/export'))
  check('A help /doctor', s.includes('/doctor'))
  check('A help /cost', s.includes('/cost'))
  check('A /export empty notice', s.includes('nothing to export yet'))
  check('A /export wrote file', fs.existsSync(EXP))
  if (fs.existsSync(EXP)) {
    const exp = fs.readFileSync(EXP, 'utf8')
    check('A export header', exp.startsWith('# CODEZY session'))
    check('A export turns', exp.includes('## You'))
    check('A export has transcript', exp.includes(`${MARK}-shell`))
    check('A export notice', s.includes(`exported 1 messages →`))
    fs.rmSync(EXP, { force: true })
  }
  check('A /cost card', /╭─ cost ─/.test(s))
  check('A /cost transcript row', /transcript\s+[\d.]+ \S+ of text — about \d+ tokens/.test(s))
  check('A /cost last call', s.includes('last call'))
  check(
    'A /cost provider line',
    local ? s.includes('local model — no per-call cost') : s.includes('billed by'),
    `provider=${settings.activeProvider}`
  )
  check('A /cost /usage pointer', s.includes('/usage shows the full 12-week history'))
  check('A /doctor card', /╭─ doctor ─/.test(s))
  check('A doctor node', /✓\s+node\s+v\d+/.test(s))
  check('A doctor endpoint', local ? s.includes('Ollama at') : s.includes('endpoint'), `provider=${settings.activeProvider}`)
  check('A doctor git', /✓\s+git\s+git /.test(s))
  check('A doctor model row', /✓\s+model\s+\S+/.test(s))
  check('A doctor terminal row', /· terminal\s+\d+ cols/.test(s))
  check('A doctor fix hint', s.includes('first ✗ above is the thing to fix'))
}

// --- B. CLI output formats ------------------------------------------------------
// B1: json
const B1 = await run(process.execPath, [CLI, '-p', `reply with exactly: ${MARK}`, '--output-format', 'json'], [], 0)
{
  check('B1 exit 0', B1.code === 0, `code=${B1.code}`)
  let j = null
  try {
    j = JSON.parse(B1.out.trim())
  } catch {}
  check('B1 stdout is JSON', !!j, B1.out.slice(0, 120))
  if (j) {
    check('B1 has model', typeof j.model === 'string' && j.model.length > 0, `model=${j.model}`)
    check('B1 has reply', typeof j.reply === 'string' && j.reply.includes(MARK), `reply=${JSON.stringify(j.reply).slice(0, 60)}`)
    check('B1 has duration_ms', typeof j.duration_ms === 'number')
    check(
      'B1 has tokens',
      j.tokens && typeof j.tokens.prompt === 'number',
      JSON.stringify(j.tokens)
    )
    check('B1 no type field (plain object)', j.type === undefined)
  }
}

// B2: stream-json
const B2 = await run(process.execPath, [CLI, '-p', 'say hello', '--output-format', 'stream-json'], [], 0)
{
  check('B2 exit 0', B2.code === 0, `code=${B2.code}`)
  const lines = B2.out.split('\n').filter((l) => l.trim())
  const parsed = []
  let bad = ''
  for (const l of lines) {
    try {
      parsed.push(JSON.parse(l))
    } catch {
      bad = l.slice(0, 60)
    }
  }
  check('B2 all lines JSON', !bad, bad || `${parsed.length} lines`)
  check('B2 has text events', parsed.some((p) => p.type === 'text' && typeof p.text === 'string'))
  const last = parsed[parsed.length - 1]
  check('B2 last is result', last?.type === 'result' && typeof last.reply === 'string', JSON.stringify(last).slice(0, 80))
}

// B3: bogus format → exit 2
const B3 = await run(process.execPath, [CLI, '-p', 'x', '--output-format', 'yaml'], [], 0)
check('B3 bogus format exit 2', B3.code === 2, `code=${B3.code}`)
check('B3 usage message', B3.out.includes('must be text, json or stream-json'), B3.out.slice(0, 100))

// B4: text mode stays plain
const B4 = await run(process.execPath, [CLI, '-p', 'say hello'], [], 0)
check('B4 exit 0', B4.code === 0, `code=${B4.code}`)
check('B4 plain text', !B4.out.trim().startsWith('{') && B4.out.trim().length > 0, B4.out.slice(0, 60))

// B5: v2 agent one-shot json
const B5 = await run(process.execPath, [CLI, 'exec', `reply with exactly ${MARK} and nothing else`, '--output-format', 'json'], [], 0)
{
  check('B5 exit 0', B5.code === 0, `code=${B5.code}`)
  let j = null
  try {
    j = JSON.parse(B5.out.trim())
  } catch {}
  check('B5 stdout is JSON', !!j, B5.out.slice(0, 120))
  if (j) {
    check('B5 has reply', typeof j.reply === 'string' && j.reply.length > 0)
    check('B5 has status+iterations', typeof j.status === 'string' && typeof j.iterations === 'number')
    check('B5 tool_events array', Array.isArray(j.tool_events), JSON.stringify(j.tool_events).slice(0, 60))
  }
}

// B6: --help documents it
const B6 = await run(process.execPath, [CLI, '--help'], [], 0)
check('B6 help documents --output-format', B6.out.includes('--output-format'))

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

// Batch 35 — the harness & agent upgrade wave (model-free everywhere):
//  A. parallel tools: a read-only prefix runs CONCURRENTLY, tool messages keep
//     wireCalls order no matter which call finishes first, and a write in the
//     batch demotes everything after it to a strictly sequential tail.
//  B. retry: transient model errors back off and succeed (retry events fired);
//     permanent errors fail fast; isTransient classifier shapes.
//  C. stop + usage: abort → status "stopped", chain intact, no dangling
//     assistant message; usage totals sum across every model call.
//  D. v2 REPL piped: /usage · /compact guard · /resume list + restore roundtrip
//     (isolated temp USERPROFILE) · -c via index routes to the agent and loads
//     the newest save · /export writes the restored chain · /help lists it all.
//  E. source pins: tools-ternary ×2 (batch29), SIGINT interrupt wiring,
//     a=always approval, autosave after every turn, PARALLEL_SAFE set, the
//     -c flag in --help.
// Restores nothing: no settings touched, no network beyond 127.0.0.1.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// portable root: this file lives in <root>/tests → its parent is the project
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI_DIR = path.join(PROJ, 'cli')
const CLI = path.join(CLI_DIR, 'index.mjs')
const V2 = path.join(CLI_DIR, 'codezy-v2.mjs')
const TMP = path.join(PROJ, 'tests', '.tmp', 'b35')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(cmd, args, inputLines, gap = 250, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: PROJ, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    const kill = setTimeout(() => {
      try {
        p.kill()
      } catch {}
    }, 60000)
    let t = 800
    for (const l of inputLines ?? []) {
      setTimeout(() => p.stdin.write(l + '\r'), t)
      t += gap
    }
    setTimeout(() => p.stdin.end(), t + 400)
    p.on('close', (code) => {
      clearTimeout(kill)
      resolve({ code, out })
    })
  })
}

const { runAgent, makeRegistry, PARALLEL_SAFE, isTransient } = await import(
  pathToFileURL(path.join(CLI_DIR, 'lib', 'harness.mjs')).href
)

// -- A. parallel read prefix, ordered messages, sequential tail ----------------
{
  const log = []
  const registry = {
    read_file: {
      run: async (a) => {
        const tag = a.path
        log.push(`${tag}-start`)
        await sleep(tag === 'slow' ? 250 : tag === 'mid' ? 120 : 30)
        log.push(`${tag}-end`)
        return `content of ${tag}`
      }
    },
    write_file: {
      run: async () => {
        log.push('w-start')
        await sleep(30)
        log.push('w-end')
        return 'wrote x'
      }
    }
  }
  const calls = [
    { id: 'c1', function: { name: 'read_file', arguments: { path: 'slow' } } }, // 250ms
    { id: 'c2', function: { name: 'read_file', arguments: { path: 'mid' } } }, // 120ms
    { id: 'c3', function: { name: 'write_file', arguments: { path: 'x' } } }, // demotes the tail
    { id: 'c4', function: { name: 'read_file', arguments: { path: 'fast' } } } // after write → serial
  ]
  const res = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry,
    needsApproval: (n) => n === 'write_file',
    approve: async () => true,
    callModel: async ({ messages }) => {
      if (messages.filter((m) => m.role === 'tool').length >= 4) {
        return { content: 'DONE', stats: { promptTokens: 11, completionTokens: 7 } }
      }
      return { content: '', tool_calls: calls }
    },
    onEvent: () => {}
  })
  const toolMsgs = res.messages.filter((m) => m.role === 'tool')
  check('A 4 tool messages in wireCalls order', toolMsgs.length === 4 && toolMsgs.map((m) => m.tool_call_id).join(',') === 'c1,c2,c3,c4', toolMsgs.map((m) => m.tool_call_id).join(','))
  const iMid = log.indexOf('mid-start')
  const iSlowEnd = log.indexOf('slow-end')
  check('A reads ran concurrently (mid started before slow ended)', iMid !== -1 && iSlowEnd !== -1 && iMid < iSlowEnd, `mid@${iMid} slowEnd@${iSlowEnd}`)
  const iW = log.indexOf('w-start')
  const iFast = log.indexOf('fast-start')
  check('A tail is sequential (write before post-write read)', iW !== -1 && iFast !== -1 && iW < iFast, `w@${iW} fast@${iFast}`)
  const gated = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: {
      read_file: { run: async (a) => `read ${a.path}` },
      grep_search: { run: async () => 'grep result' }
    },
    needsApproval: (n, args) => n === 'read_file' && args.path === 'guarded',
    approve: async () => true,
    callModel: async ({ messages }) => {
      if (messages.filter((m) => m.role === 'tool').length >= 3) return { content: 'DONE' }
      return {
        content: '',
        tool_calls: [
          { id: 'g1', function: { name: 'read_file', arguments: { path: 'guarded' } } },
          { id: 'g2', function: { name: 'read_file', arguments: { path: 'plain' } } },
          { id: 'g3', function: { name: 'grep_search', arguments: { pattern: 'x' } } }
        ]
      }
    },
    onEvent: () => {}
  })
  const gMsgs = gated.messages.filter((m) => m.role === 'tool')
  check('A gated read at index 0 → all three still answered in order', gMsgs.length === 3 && gMsgs.map((m) => m.tool_call_id).join(',') === 'g1,g2,g3', gMsgs.map((m) => m.tool_call_id).join(','))
  check('A PARALLEL_SAFE keeps reads, never writes', PARALLEL_SAFE.has('read_file') && PARALLEL_SAFE.has('grep_search') && !PARALLEL_SAFE.has('write_file') && !PARALLEL_SAFE.has('run_command'), [...PARALLEL_SAFE].join(','))
}

// -- B. transient retry / permanent fail-fast ----------------------------------
{
  let attempts = 0
  const retries = []
  const res = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: {},
    retries: 2,
    retryDelayMs: 0,
    callModel: async () => {
      attempts++
      if (attempts === 1) throw new Error('Ollama error 503: server busy')
      if (attempts === 2) throw new Error('fetch failed')
      return { content: 'ok-after-retry' }
    },
    onEvent: (e) => {
      if (e.type === 'retry') retries.push(e)
    }
  })
  check('B two transient failures then success', res.status === 'text' && res.text === 'ok-after-retry' && attempts === 3, `attempts=${attempts}`)
  check('B retry events fired', retries.length === 2 && retries[0].attempt === 1 && retries[1].attempt === 2, JSON.stringify(retries.map((r) => r.attempt)))

  let perma = 0
  let threw = null
  try {
    await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      registry: {},
      retries: 2,
      retryDelayMs: 0,
      callModel: async () => {
        perma++
        throw new Error('model "nope" not found')
      },
      onEvent: () => {}
    })
  } catch (e) {
    threw = e
  }
  check('B permanent error fails fast (1 attempt)', perma === 1 && /not found/.test(String(threw?.message)), `attempts=${perma}`)
  check(
    'B isTransient shapes',
    isTransient(new Error('API error 429')) &&
      isTransient(new Error('Ollama error 500')) &&
      isTransient(new Error('connect ETIMEDOUT 1.2.3.4:11434')) &&
      !isTransient(new Error('API error 400')) &&
      !isTransient(new Error('model "x" not found')) &&
      !isTransient(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  )
}

// -- C. abort → stopped, chain intact; usage totals ---------------------------
{
  const ctl = new AbortController()
  const res = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: {},
    signal: ctl.signal,
    callModel: async () => {
      ctl.abort()
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      throw e
    },
    onEvent: () => {}
  })
  check('C abort → status stopped', res.status === 'stopped', String(res.status))
  check('C chain intact, no dangling assistant', res.messages.length === 1 && res.messages.every((m) => m.role !== 'assistant'), `${res.messages.length} msgs`)
  check('C usage returned on stop too', !!res.usage && res.usage.calls === 0, JSON.stringify(res.usage))

  const u = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: {},
    callModel: async () => ({ content: 'hi', stats: { promptTokens: 5, completionTokens: 3 } }),
    onEvent: () => {}
  })
  check('C usage sums on the text path', u.usage.promptTokens === 5 && u.usage.completionTokens === 3 && u.usage.calls === 1, JSON.stringify(u.usage))
}

// -- D. v2 REPL over a pipe + isolated home ------------------------------------
{
  const HOME = path.join(TMP, 'home')
  const AGENT = path.join(HOME, '.codezy', 'agent')
  fs.mkdirSync(AGENT, { recursive: true })
  const seeded = {
    id: 'a1seed',
    title: 'seeded session',
    savedAt: Date.now(),
    model: 'test-model',
    roots: [TMP],
    history: [
      { role: 'user', content: 'hello from seed' },
      { role: 'assistant', content: 'hi back from seed' }
    ]
  }
  fs.writeFileSync(path.join(AGENT, 'a1seed.json'), JSON.stringify(seeded, null, 2), 'utf8')
  const env = { USERPROFILE: HOME, HOME }
  const exported = path.join(TMP, 'resume-export.md')

  const h = await run(process.execPath, [V2], ['/help', '/exit'], 250, env)
  check('D /help lists the new commands', h.code === 0 && h.out.includes('/compact') && h.out.includes('/resume [n]') && h.out.includes('/usage'), `code=${h.code}`)

  const usage = await run(process.execPath, [V2], ['/usage', '/exit'], 250, env)
  check('D /usage prints a zeroed session line', usage.code === 0 && /usage · 0 prompt \+ 0 completion tokens · 0 model call\(s\)/.test(usage.out), usage.out.split('\n')[0] ?? '')

  const comp = await run(process.execPath, [V2], ['/compact', '/exit'], 250, env)
  check('D /compact guard on a short chain', comp.code === 0 && comp.out.includes('nothing to compact yet'), comp.out.split('\n')[0] ?? '')

  const list = await run(process.execPath, [V2], ['/resume', '/exit'], 250, env)
  check('D /resume lists the seeded save', list.code === 0 && list.out.includes('seeded session') && list.out.includes('2 msgs'), list.out.split('\n').find((l) => l.includes('seeded')) ?? '')

  const bad = await run(process.execPath, [V2], ['/resume 99', '/exit'], 250, env)
  check('D /resume bad index is refused', bad.code === 0 && bad.out.includes('no saved session matching "99"'), '')

  const rt = await run(process.execPath, [V2], ['/resume 1', `/export ${exported}`, '/exit'], 300, env)
  check('D /resume restores the chain', rt.code === 0 && rt.out.includes('resumed "seeded session" — 2 messages'), rt.out.split('\n').find((l) => l.includes('resumed')) ?? '')
  const md = fs.existsSync(exported) ? fs.readFileSync(exported, 'utf8') : ''
  check('D restored chain exports (roundtrip)', md.includes('## You') && md.includes('hello from seed') && md.includes('hi back from seed'), `${md.length} bytes`)

  const cont = await run(process.execPath, [CLI, '-c'], ['/usage', '/exit'], 300, env)
  check('D -c routes to the agent and resumes at startup', cont.code === 0 && cont.out.includes('resumed "seeded session" — 2 messages'), cont.out.split('\n')[0] ?? '')

  const fresh = path.join(TMP, 'home2')
  fs.mkdirSync(fresh, { recursive: true })
  const contNone = await run(process.execPath, [CLI, '-c'], ['/exit'], 300, { USERPROFILE: fresh, HOME: fresh })
  check('D -c with no saves says so, exits 0', contNone.code === 0 && contNone.out.includes('no saved agent session'), contNone.out.split('\n')[0] ?? '')

  // a turn-less /clear must not clobber the save: history is only saved when a
  // real turn ran — the seeded file must still exist untouched after all runs
  const still = fs.existsSync(path.join(AGENT, 'a1seed.json'))
  check('D saves survive a piped session untouched', still)
}

// -- E. source pins ------------------------------------------------------------
{
  const v2src = fs.readFileSync(V2, 'utf8')
  const ternary = 'tools: mcp?.schemas?.length ? [...TOOLS, ...mcp.schemas] : undefined'
  check('E tools-ternary pin (batch29) still exactly ×2', v2src.split(ternary).length - 1 === 2, `${v2src.split(ternary).length - 1}`)
  check('E SIGINT interrupts the chain', v2src.includes("wire?.on('SIGINT'") && v2src.includes('abortCtl.abort()'))
  check('E approval a=always', v2src.includes('a=always') && v2src.includes('always.add(name)'))
  check('E autosave after every finished chain', v2src.includes('autosave() // every finished (or stopped) chain lands on disk immediately'))
  check('E approval previews changes, not names', v2src.includes('function approvalView') && v2src.includes("red('−')"))
  check('E spinner shows elapsed seconds', v2src.includes('secs >= 2'))
  const { helpText } = await import(pathToFileURL(path.join(CLI_DIR, 'lib', 'cli.mjs')).href)
  check('E --help documents -c/--continue', helpText().includes('-c, --continue'))
  const idx = fs.readFileSync(CLI, 'utf8')
  check('E index routes -c to the agent', idx.includes("A.present.has('continue') || A.present.has('c')"))
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} FAIL(S)`)
  process.exit(1)
}
console.log('ALL PASS')
process.exit(0)

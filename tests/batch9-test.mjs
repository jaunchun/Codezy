// Batch 9 — harness: todo_write tool, hooks (exit-2 block), ⎿ tool lines.
//  A. deterministic: fake callModel, no model needed — todo schema/happy path/
//     validation/state, loadHooks shape, before_tool BLOCK (stderr → model,
//     approval never asked, file not written, stdin carries {tool,args}),
//     tool filter, after_tool failure note.
//  B. live: v2 one-shot shows the ⎿ line for a list_dir step.
//  C. v2 REPL piped: /help lists /todos, /todos empty notice.
//  Nothing touches settings.json or memory.md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const { TOOLS, makeRegistry, runAgent, loadHooks } = await import(
  pathToFileURL(path.join(PROJ, 'cli', 'lib', 'harness.mjs')).href
)

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}
const MARK = `b9-${Date.now() % 100000}`
const ROOT = path.join(os.tmpdir(), `codezy-${MARK}`)
const HOOKS_DIR = path.join(ROOT, '.codezy')
const HOOK = path.join(ROOT, 'hook.js')
const LOG = path.join(ROOT, 'hook-stdin.log')

fs.mkdirSync(HOOKS_DIR, { recursive: true })
fs.writeFileSync(path.join(ROOT, 'file.txt'), 'hello b9\nline two\nline three\n')
// one hook script for every case: writes stdin payload to LOG, then exits
// with the code the test asks for (2 → block, 0 → pass)
fs.writeFileSync(
  HOOK,
  "const fs = require('fs')\n" +
    "let s = ''\n" +
    "process.stdin.on('data', (d) => (s += d))\n" +
    "process.stdin.on('end', () => {\n" +
    '  try { fs.writeFileSync(process.argv[2], s) } catch {}\n' +
    '  const code = Number(process.argv[3]) || 0\n' +
    '  if (code !== 0) process.stderr.write("b9 hook refused the action\\n")\n' +
    '  process.exit(code)\n' +
    '})\n'
)
const refuseCmd = `node "${HOOK}" "${LOG}" 2`
const passCmd = `node "${HOOK}" "${LOG}" 0`
const setHooks = (cfg) => fs.writeFileSync(path.join(HOOKS_DIR, 'hooks.json'), JSON.stringify(cfg))

/** Feeds a scripted conversation to runAgent. */
async function run(registry, answers, extra = {}) {
  const events = []
  let i = 0
  const res = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry,
    callModel: async () => answers[i++],
    onEvent: (e) => events.push(e),
    ...extra
  })
  return { res, events, tool: events.find((e) => e.type === 'tool') }
}
const toolCall = (name, args) => ({ content: '', tool_calls: [{ function: { name, arguments: args } }] })
const endTurn = (text) => ({ content: text, tool_calls: [] })

// --- A1. schema ------------------------------------------------------------------
{
  const names = TOOLS.map((t) => t.function?.name)
  check('A1 todo_write in TOOLS', names.includes('todo_write'), names.join(','))
  const st = TOOLS.find((t) => t.function?.name === 'todo_write')?.function?.parameters?.properties?.items?.items
    ?.properties?.status
  check('A1 status enum', Array.isArray(st?.enum) && st.enum.length === 3 && st.enum.includes('done'), JSON.stringify(st?.enum))
}

// --- A2. todo happy path ----------------------------------------------------------
{
  const reg = makeRegistry({ roots: [ROOT] })
  const { res, tool } = await run(reg, [
    toolCall('todo_write', {
      items: [
        { text: 'first step', status: 'pending' },
        { text: 'second step', status: 'in_progress' }
      ]
    }),
    endTurn('plan saved')
  ])
  check('A2 reply + iterations', res.status === 'text' && res.text === 'plan saved' && res.iterations === 2, `text=${res.text} iter=${res.iterations}`)
  check('A2 tool event ok', tool?.name === 'todo_write' && tool.outcome === 'ok', JSON.stringify({ n: tool?.name, o: tool?.outcome }))
  check('A2 summary', /saved 2 todos \(0 done\)/.test(tool?.result ?? ''), tool?.result?.split('\n')[0])
  const todos = reg.todo_write.state.todos
  check('A2 state stored', todos.length === 2 && todos[0].text === 'first step' && todos[1].status === 'in_progress', JSON.stringify(todos))
}

// --- A3. validation ---------------------------------------------------------------
{
  const reg = makeRegistry({ roots: [ROOT] })
  const { tool } = await run(reg, [
    toolCall('todo_write', { items: [{ text: 'x', status: 'nope' }] }),
    endTurn('ok')
  ])
  check('A3 rejected', tool?.outcome === 'rejected', tool?.outcome)
  check('A3 message', /bad status "nope"/.test(tool?.result ?? ''), tool?.result)
  check('A3 state untouched', reg.todo_write.state.todos.length === 0, String(reg.todo_write.state.todos.length))
}

// --- A4. loadHooks shape ----------------------------------------------------------
{
  setHooks({ before_tool: [{ tools: ['write_file'], command: refuseCmd }] })
  const h = loadHooks([ROOT])
  check('A4 config loaded', !!h && h.before_tool.length === 1 && h.cwd === ROOT, JSON.stringify({ file: h?.file, cwd: h?.cwd }))
  check('A4 file path', h?.file === path.join(HOOKS_DIR, 'hooks.json'), h?.file)
}

// --- A5. before_tool blocks -------------------------------------------------------
{
  setHooks({ before_tool: [{ tools: ['write_file'], command: refuseCmd }] })
  const reg = makeRegistry({ roots: [ROOT] })
  let approveAsked = false
  const { res, tool } = await run(
    reg,
    [toolCall('write_file', { path: 'x.txt', content: 'nope' }), endTurn('understood')],
    {
      approve: async () => {
        approveAsked = true
        return true
      },
      hooks: loadHooks([ROOT])
    }
  )
  check('A5 blocked outcome', tool?.outcome === 'blocked', tool?.outcome)
  check('A5 stderr fed to model', /BLOCKED by hook/.test(tool?.result ?? '') && /b9 hook refused the action/.test(tool?.result ?? ''), tool?.result?.slice(0, 120))
  check('A5 approval never asked', approveAsked === false)
  check('A5 file not written', !fs.existsSync(path.join(ROOT, 'x.txt')))
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''
  check('A5 hook stdin payload', log.includes('"tool":"write_file"') && log.includes('x.txt'), log.slice(0, 120))
  check('A5 loop continued after block', res.status === 'text' && res.text === 'understood', res.text)
}

// --- A6. tool filter: run_command-only hook ignores write_file ---------------------
{
  setHooks({ before_tool: [{ tools: ['run_command'], command: refuseCmd }] })
  const reg = makeRegistry({ roots: [ROOT] })
  let approveAsked = false
  const { tool } = await run(
    reg,
    [toolCall('write_file', { path: 'y.txt', content: 'yes' }), endTurn('done')],
    {
      approve: async () => {
        approveAsked = true
        return true
      },
      hooks: loadHooks([ROOT])
    }
  )
  check('A6 write proceeded', tool?.outcome === 'ok', tool?.outcome)
  check('A6 approval asked', approveAsked === true)
  check('A6 file written', fs.readFileSync(path.join(ROOT, 'y.txt'), 'utf8') === 'yes')
}

// --- A7. after_tool failure notes, action stands ----------------------------------
{
  setHooks({ after_tool: [{ tools: ['write_file'], command: refuseCmd }] })
  const reg = makeRegistry({ roots: [ROOT] })
  const { tool } = await run(
    reg,
    [toolCall('write_file', { path: 'z.txt', content: 'kept' }), endTurn('done')],
    { approve: async () => true, hooks: loadHooks([ROOT]) }
  )
  check('A7 outcome still ok', tool?.outcome === 'ok', tool?.outcome)
  check('A7 note appended', /\[hook\] .*b9 hook refused the action/s.test(tool?.result ?? ''), tool?.result?.slice(-120))
  check('A7 action executed', fs.readFileSync(path.join(ROOT, 'z.txt'), 'utf8') === 'kept')
}

// --- A8. passing hook with stdin capture -------------------------------------------
{
  setHooks({ before_tool: [{ tools: ['*'], command: passCmd }] })
  const reg = makeRegistry({ roots: [ROOT] })
  const { tool } = await run(reg, [toolCall('read_file', { path: 'file.txt' }), endTurn('read it')], {
    hooks: loadHooks([ROOT])
  })
  check('A8 pass hook lets tool run', tool?.outcome === 'ok', tool?.outcome)
  check('A8 hook saw {tool,args}', fs.readFileSync(LOG, 'utf8').includes('"tool":"read_file"'), fs.readFileSync(LOG, 'utf8').slice(0, 100))
  fs.rmSync(path.join(HOOKS_DIR, 'hooks.json'), { force: true }) // no hooks beyond this point
}

// --- live helpers -------------------------------------------------------------------
function runProc(args, { lines = [], gap = 400, total = 120000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: PROJ, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    const kill = setTimeout(() => {
      try {
        p.kill()
      } catch {}
    }, total)
    let t = 500
    for (const l of lines) {
      setTimeout(() => p.stdin.write(l + '\r'), t)
      t += gap
    }
    if (lines.length) setTimeout(() => p.stdin.end(), t + gap)
    p.on('close', (code) => {
      clearTimeout(kill)
      resolve({ out, code })
    })
  })
}

// --- B. live ⎿ line -----------------------------------------------------------------
{
  const b = await runProc(
    [path.join(PROJ, 'cli/index.mjs'), 'exec', 'First call the list_dir tool with path ".", then reply with the single word DONE.'],
    {}
  )
  check('B exit 0', b.code === 0, `code=${b.code}`)
  check('B ⎿ line for list dir', /⎿\s+list dir\s+\S/.test(b.out), JSON.stringify(b.out.slice(0, 400)))
  check('B reply DONE', b.out.includes('DONE'))
}

// --- C. REPL /todos + /help -----------------------------------------------------------
{
  const c = await runProc([path.join(PROJ, 'cli/codezy-v2.mjs')], { lines: ['/help', '/todos', '/exit'], gap: 350, total: 20000 })
  check('C exit 0', c.code === 0, `code=${c.code}`)
  check('C help lists /todos', c.out.includes("show the agent's current checklist"), c.out.slice(0, 300))
  check('C todos empty notice', c.out.includes('no todos yet'))
}

fs.rmSync(ROOT, { recursive: true, force: true })
console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

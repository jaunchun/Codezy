#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CODEZY v2 — terminal shell over the shared agent harness.
//
//   node cli/codezy-v2.mjs [--root <dir>] [--model <id>] [--url <ollama>]
//                          [--auto] [--ctx <n>]
//
// ONE core, two shells: every loop / tool / safety / approval-gate line lives
// in cli/lib/harness.mjs — the Electron app imports that exact file too. This
// shell only injects the terminal pieces:
//   - approve → an interactive y/N question on your TTY (never in pipes:
//               piped input without --auto DENIES everything, by design)
//   - onEvent → prints one activity line per tool step
//   - reply   → rendered as markdown
//
// v1 (cli/codezy.mjs) is untouched — v2 is new files only.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

import {
  runAgent,
  makeRegistry,
  loadHooks,
  ollamaCall,
  openaiCall,
  DEFAULT_NUM_CTX,
  DANGEROUS_TOOLS
} from './lib/harness.mjs'
import { renderMd } from './lib/md.mjs'
import { webSearch } from './lib/search.mjs'
import { parseArgs, readStdin } from './lib/cli.mjs'

// -- flags (shared parser — cli/lib/cli.mjs, same surface as `codezy --help`) --

const argv = process.argv.slice(2)
// `codezy exec|run "prompt"` — codex-exec / opencode-run style one-shot entry
const A = parseArgs(argv, ['root', 'dir', 'model', 'url', 'ctx', 'print', 'p', 'output-format'])
const SUB = A.positionals[0] === 'exec' || A.positionals[0] === 'run' ? A.positionals.shift() : null
const auto = A.present.has('auto')
const ROOT0 = path.resolve(A.values.root ?? A.values.dir ?? process.cwd())
const CTX = Math.max(4096, parseInt(A.values.ctx ?? '', 10) || DEFAULT_NUM_CTX)
// one-shot print mode: `exec "prompt"` · `-p "prompt"` · `--agent "prompt"`
const PRINT =
  SUB !== null ||
  A.positionals.length > 0 ||
  A.present.has('print') ||
  A.present.has('p')

// one-shot output shape: text (default) · json (one object) · stream-json (NDJSON)
const FMT = String(A.values['output-format'] ?? 'text')
if (!['text', 'json', 'stream-json'].includes(FMT)) {
  console.error('codezy: --output-format must be text, json or stream-json')
  process.exit(2)
}
const toolEvents = [] // json mode: collected for the final result object

// -- settings (same conventions as cli/codezy.mjs) ------------------------------

const HOME = path.join(os.homedir(), '.codezy')
function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return fallback
  }
}
let settings = readJson(path.join(HOME, 'settings.json'), {})
if (settings.dataDir && settings.dataDir !== HOME) {
  settings = { ...settings, ...readJson(path.join(settings.dataDir, 'settings.json'), {}) }
}
const MODEL = A.values.model || settings.activeModel || 'llama3.1:8b'
const URL = A.values.url || settings.ollamaUrl || 'http://127.0.0.1:11434'

// cloud provider from settings (desktop or /provider nebius <key> sets this
// up): an OpenAI-compatible endpoint — Nebius Token Factory & friends — is
// used unless an explicit --url override was given.
const PROVIDER =
  !A.values.url && settings.activeProvider && settings.activeProvider !== 'ollama'
    ? (settings.providers ?? []).find((p) => p.id === settings.activeProvider) ?? null
    : null
// `--url …/v1` (or any …/vN) speaks the OpenAI wire format too
const URL_OPENAI = /\/v\d+\/?$/.test(URL)

// -- styling (empty when piped → clean test output) -----------------------------

const TTY = !!process.stdout.isTTY
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const cyan = (s) => c(36, s)
const dim = (s) => c(2, s)
const bold = (s) => c(1, s)
const green = (s) => c(32, s)
const red = (s) => c(31, s)
const yellow = (s) => c(33, s)

// -- session state ---------------------------------------------------------------

let roots = [ROOT0]
let history = [] // assistant/tool chain from the previous turn (stateful!)
const SYSTEM = `You are CODEZY, a coding agent running in the user's terminal.
You have tools: list_dir, read_file, write_file, grep_search, run_command, web_search, todo_write.
Inspect the workspace with them before answering when that helps. web_search queries
the internet (DuckDuckGo) and returns titles, URLs and snippets — USE IT for anything
current or web-related (releases, prices, docs, news) and whenever you are unsure; you
DO have internet access through it, never claim you cannot search the web. Paths are
relative to the workspace root. For any task with more than two steps, first save your
plan with todo_write (pending / in_progress / done) and update it as you finish each
step. Be direct and practical; answer in plain markdown,
fenced code blocks with a language tag. write_file and run_command always ask the
user for approval first — say in one short sentence what you are about to do.`

// print mode over a pipe never opens a REPL on stdin (the prompt is read raw)
const rl =
  PRINT && !process.stdin.isTTY
    ? null
    : readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: cyan('you> ')
      })

function question(q) {
  return new Promise((resolve) => (rl ? rl.question(q, resolve) : resolve('')))
}

// -- approval gate (the injected TUI half) ----------------------------------------

let awaitingApproval = false // the y/N question owns the next line of input

async function approve(name, args) {
  if (auto) return true
  if (!process.stdin.isTTY) return false // pipes: deny unless --auto
  const what =
    name === 'write_file'
      ? `write ${args.path} (${String(args.content ?? '').split('\n').length} lines)`
      : name === 'run_command'
        ? String(args.command)
        : name
  awaitingApproval = true
  try {
    const answer = await question(`${yellow('⚠ approve')} ${name}: ${dim(what.slice(0, 120))} ? [y/N] `)
    return /^(y|yes)$/i.test(answer.trim())
  } finally {
    awaitingApproval = false
    if (rl) {
      rl.setPrompt(cyan('you> '))
      if (process.stdin.isTTY) rl.prompt()
    }
  }
}

// -- tool activity (the injected onEvent half) -------------------------------------

function onEvent(ev) {
  if (ev.type !== 'tool') return
  const argStr =
    ev.name === 'run_command'
      ? String(ev.args?.command ?? '')
      : ev.name === 'read_file' || ev.name === 'write_file' || ev.name === 'list_dir'
        ? String(ev.args?.path ?? '.')
        : ev.name === 'grep_search'
          ? `/${ev.args?.pattern}/`
          : String(ev.args?.query ?? '')
  // structured output in print mode: stdout stays machine-readable
  if (PRINT && FMT === 'json') {
    toolEvents.push({ name: ev.name, arg: argStr.slice(0, 120), ok: ev.outcome === 'ok' })
    return
  }
  if (PRINT && FMT === 'stream-json') {
    console.log(
      JSON.stringify({ type: 'tool', iteration: ev.iteration, name: ev.name, arg: argStr.slice(0, 120), ok: ev.outcome === 'ok' })
    )
    return
  }
  // activity is telemetry: stderr in print mode so stdout stays just the reply.
  // One quiet ⎿ line per step: verb, argument, short outcome summary.
  const write = PRINT ? console.error : console.log
  const verb = ev.name.replace(/_/g, ' ')
  const summary = ev.outcome === 'ok' ? stepSummary(ev.name, ev.result) : ev.outcome
  write(`  ${dim('⎿')} ${cyan(verb)} ${dim(argStr.slice(0, 60))}${summary ? ` ${dim('·')} ${dim(summary)}` : ''}`)
}

/** One short human phrase for the ⎿ line after a successful tool step. */
function stepSummary(name, res) {
  const t = String(res ?? '')
  if (!t) return ''
  const lines = t.split('\n').length
  if (name === 'read_file') return t.endsWith('…[truncated]') ? `${lines}+ lines` : `${lines} lines`
  if (name === 'write_file') return t // "wrote 123 bytes to x"
  if (name === 'list_dir') return t === '(empty folder)' ? 'empty' : `${lines} entries`
  if (name === 'grep_search') return t.startsWith('no matches') ? 'no matches' : `${lines} matches`
  if (name === 'todo_write') return t.split('\n')[0] // "saved 3 todos (1 done)"
  if (name === 'web_search') return `${t.split('\n\n').length} results`
  if (name === 'run_command') return (t.split('\n').find((l) => l.trim()) ?? '').slice(0, 60)
  return t.slice(0, 60)
}

// -- the model call, shared by REPL turns and one-shot print --------------------

function call({ messages: msgs, tools, signal }) {
  if (PROVIDER) {
    // cloud provider (settings.activeProvider) — OpenAI-compatible chat API
    return openaiCall({
      baseUrl: PROVIDER.baseUrl,
      apiKey: PROVIDER.apiKey,
      model: MODEL,
      messages: msgs,
      tools,
      signal,
      temperature: 0.6
    })
  }
  if (URL_OPENAI) {
    // --url …/v1 — the OpenAI wire format (Nebius, LM Studio, Ollama's /v1…)
    return openaiCall({ baseUrl: URL, model: MODEL, messages: msgs, tools, signal, temperature: 0.6 })
  }
  return ollamaCall({ baseUrl: URL, model: MODEL, messages: msgs, tools, signal, numCtx: CTX, temperature: 0.6 })
}

// -- one turn ------------------------------------------------------------------------

// Registry is cached per workspace: todo_write state (and any future per-run
// state) then survives across turns instead of resetting every prompt.
let regCache = null
function getRegistry() {
  const key = roots.join('\n')
  if (!regCache || regCache.key !== key) regCache = { key, registry: makeRegistry({ roots }) }
  return regCache.registry
}

async function turn(prompt) {
  let registry
  try {
    registry = getRegistry()
  } catch (e) {
    console.log(red(`error: ${e.message}`))
    return
  }

  const messages = [
    { role: 'system', content: SYSTEM },
    ...history,
    { role: 'user', content: prompt }
  ]

  try {
    const result = await runAgent({
      messages,
      registry,
      approve,
      onEvent,
      callModel: call,
      hooks: loadHooks(roots)
    })

    history = result.messages // keep the chain: stateful across turns

    if (result.status === 'limit') {
      console.log(red(`stopped after ${result.iterations} tool steps (iteration cap)`))
    }
    if (result.text) console.log(`\n${renderMd(result.text, process.stdout.columns || 80)}\n`)
    else if (result.status !== 'limit') console.log(dim('(no reply text)'))
  } catch (e) {
    console.log(red(`error: ${e?.message ?? e}`))
    if (String(e?.message ?? '').includes('ECONNREFUSED')) {
      console.log(dim(`is Ollama running? try: ollama serve  (${URL})`))
    }
  }
}

// -- one-shot print mode (claude -p / codex exec shape) -------------------------

async function oneShot(prompt) {
  let registry
  try {
    registry = makeRegistry({ roots })
  } catch (e) {
    console.error(`codezy: ${e.message}`)
    return 1
  }
  try {
    const result = await runAgent({
      messages: [{ role: 'system', content: SYSTEM }, ...history, { role: 'user', content: prompt }],
      registry,
      approve,
      onEvent,
      callModel: call,
      hooks: loadHooks(roots)
    })
    if (result.status === 'limit') console.error(`codezy: stopped after ${result.iterations} tool steps (iteration cap)`)
    if (!result.text) {
      console.error('codezy: empty reply from the model')
      return 1
    }
    if (PRINT && FMT === 'json') {
      console.log(
        JSON.stringify({
          status: result.status,
          iterations: result.iterations,
          tool_events: toolEvents,
          reply: result.text
        })
      )
      return 0
    }
    if (PRINT && FMT === 'stream-json') {
      console.log(
        JSON.stringify({ type: 'result', status: result.status, iterations: result.iterations, reply: result.text })
      )
      return 0
    }
    process.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`)
    return 0
  } catch (e) {
    console.error(`codezy: ${e?.message ?? e}`)
    if (String(e?.message ?? '').includes('ECONNREFUSED')) {
      console.error(`is Ollama running? try: ollama serve  (${URL})`)
    }
    return 1
  }
}

// -- commands + line loop ----------------------------------------------------------------

async function command(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/)
  const arg = rest.join(' ')
  switch (cmd) {
    case '/exit':
    case '/quit':
      finish()
      return true
    case '/clear':
      history = []
      console.log(dim('history cleared'))
      return true
    case '/root':
      if (arg) {
        const r = path.resolve(arg)
        if (fs.existsSync(r)) {
          roots = [r]
          console.log(dim(`workspace → ${r}`))
        } else console.log(red(`no such folder: ${r}`))
      } else console.log(dim(`workspace: ${roots.join(', ')}`))
      return true
    case '/search': {
      if (!arg) {
        console.log(dim('usage: /search <query>'))
        return true
      }
      try {
        const hits = await webSearch(arg)
        if (!hits.length) {
          console.log(dim(`no results for "${arg}"`))
        } else {
          console.log('')
          hits.forEach((h, i) => {
            console.log(`${i + 1}. ${bold(h.title)}\n   ${cyan(h.url)}${h.snippet ? `\n   ${dim(h.snippet)}` : ''}`)
          })
          console.log('')
        }
      } catch (e) {
        console.log(red(`search failed: ${e?.message ?? e}`))
      }
      return true
    }
    case '/todos': {
      const todos = getRegistry().todo_write?.state?.todos ?? []
      if (!todos.length) {
        console.log(dim('no todos yet — the agent keeps its checklist with todo_write'))
      } else {
        const done = todos.filter((t) => t.status === 'done').length
        console.log(dim(`todos · ${done}/${todos.length} done`))
        for (const t of todos) {
          const mark = t.status === 'done' ? green('✓') : t.status === 'in_progress' ? cyan('›') : dim('·')
          console.log(`  ${mark} ${t.text}`)
        }
      }
      return true
    }
    case '/help':
      console.log(
        [
          `${bold('CODEZY v2')} — agent mode over the shared harness`,
          `  /root [dir]  show or set the workspace root`,
          `  /todos       show the agent's current checklist`,
          `  /search <q>  web search (DuckDuckGo) — runs instantly, no model needed`,
          `  /clear       forget the conversation chain`,
          `  /exit        quit`,
          `  model        ${MODEL}  (${URL})`,
          `  workspace    ${roots.join(', ')}`,
          `  gated tools  ${[...DANGEROUS_TOOLS].join(', ')} ${auto ? dim('(auto-approved)') : ''}`
        ].join('\n')
      )
      return true
    default:
      return false
  }
}

let busy = false
let closed = false
const queue = []

function finish() {
  try {
    rl.close()
  } catch {
    /* already closed */
  }
  process.exit(0)
}

async function drain() {
  if (busy) return
  busy = true
  while (queue.length) {
    const line = queue.shift()
    if (!line.trim()) continue
    await turn(line)
    if (closed) break
  }
  busy = false
  if (closed) finish()
}

let cmdChain = Promise.resolve() // commands run serially even when async (/search)

// REPL wiring — print mode never attaches (its stdin carries the prompt)
const wire = !PRINT && rl ? rl : null

wire?.on('line', (line) => {
  if (awaitingApproval) return // the approval question consumed this line
  const t = line.trim()
  // commands run right away — even while the model is still writing a reply
  if (t.startsWith('/')) {
    cmdChain = cmdChain
      .then(async () => {
        if (await command(t)) {
          if (process.stdin.isTTY) rl.prompt()
          return
        }
        queue.push(line)
        void drain()
        if (process.stdin.isTTY) rl.prompt()
      })
      .catch((e) => console.log(red(`command failed: ${e?.message ?? e}`)))
    return
  }
  queue.push(line)
  void drain()
  if (process.stdin.isTTY) rl.prompt()
})

wire?.on('close', () => {
  closed = true
  // wait for a still-running command (e.g. /search) before exiting
  cmdChain.then(() => {
    if (!busy) finish()
  })
})

// -- one-shot print entry (claude -p / codex exec shape) -------------------------

if (PRINT) {
  let prompt = String(A.values.print ?? A.values.p ?? A.positionals.join(' ')).trim()
  if (!prompt && !process.stdin.isTTY) prompt = (await readStdin()).trim()
  if (!prompt) {
    console.error('usage: codezy exec "prompt"   (or: codezy --agent -p "prompt")\nrun: codezy --help')
    process.exit(2)
  }
  const code = await oneShot(prompt)
  if (rl) {
    try {
      rl.close()
    } catch {
      /* already closed */
    }
  }
  process.exit(code)
}

// -- banner ------------------------------------------------------------------------------

if (TTY) {
  console.log(
    `${bold('CODEZY v2')} ${dim('— agent mode · tools + per-action approval')}\n` +
      `${dim(
        `model ${MODEL}${PROVIDER ? ` via ${PROVIDER.name || PROVIDER.id}` : ''} · ctx ${CTX} · workspace ${roots.join(', ')}`
      )}\n` +
      (auto ? `${yellow('--auto: every gated action is approved automatically')}\n` : '') +
      (MODEL.startsWith('qwen2.5-coder')
        ? `${yellow('note: qwen2.5-coder has no native function calling — llama3.1:8b works for tools')}\n`
        : '') +
      `${dim('type /help · /root · /search · /exit\n')}`
  )
}
if (rl) rl.prompt()

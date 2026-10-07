// ---------------------------------------------------------------------------
// harness.mjs — CODEZY v2 agent orchestration core.
//
// The stateful tool-calling loop, shared by BOTH shells (terminal v2 and the
// Electron app). UI-agnostic by contract:
//   - zero dependencies, no terminal/stdin access, side-effect-free import
//   - the model call is injected (`callModel`) — default hits Ollama
//   - approval is injected (`approve`) — TUI prompts, app shows a dialog,
//     tests resolve instantly; when a gated tool has NO gate wired, it is
//     DENIED (safe by default)
//   - progress is reported through `onEvent`, never printed
//
// Loop (per spec):
//   append prompt → send history + JSON tools schema to Ollama → response
//     ├─ tool_calls → extract name/args → validate safety → [approval gate]
//     │               → execute → append assistant msg with the EXACT
//     │                 tool_calls payload → append role:"tool" msg mapped
//     │                 by function name → loop (hard cap 5–10)
//     └─ plain text → append it, return, terminate
//
// Model payload ALWAYS overrides options.num_ctx (default 65536) — local
// models fall back to 4k, and truncation silently breaks tool calling.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exec, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { webSearch } from './search.mjs'

const execP = promisify(exec)

export const DEFAULT_NUM_CTX = 65536
export const DEFAULT_TEMPERATURE = 0.6
/** Spec: hard iteration cap per chain, 5–10. */
export const DEFAULT_MAX_ITER = 8
/** Tools that pause the loop for human approval before executing. */
export const DANGEROUS_TOOLS = new Set(['write_file', 'run_command'])

// -- tools: strict JSON schema array ----------------------------------------
// `name` must match a key returned by makeRegistry() exactly.

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the files and folders inside a directory of the linked workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder to list, relative to the workspace root. Defaults to the root.' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the linked workspace and return its content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to read, relative to the workspace root.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a text file in the linked workspace. Requires explicit user approval. Use this whenever the user asks to save, create, or write a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to write, relative to the workspace root.' },
          content: { type: 'string', description: 'The complete new content of the file.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search files in the workspace with a regular expression. Returns file:line: matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for.' },
          path: { type: 'string', description: 'Folder to search, relative to the workspace root. Defaults to the root.' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace and return its output. Requires explicit user approval. Destructive commands are rejected.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute.' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web (DuckDuckGo) and return titles, URLs and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        'Save the current checklist for this task — the complete list, replacing the previous one. Call it when you make a plan and update it as each item finishes; the user watches the list, and it keeps long runs coherent.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Every step, in order.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'One concrete step.' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'done'],
                  description: 'State of this step.'
                }
              },
              required: ['text', 'status']
            }
          }
        },
        required: ['items']
      }
    }
  }
]

// -- default model call: Ollama native /api/chat ----------------------------

/**
 * Non-streaming chat call with the tools schema attached.
 * Returns { content, tool_calls, stats } — tool_calls straight from Ollama
 * (arguments may arrive as an object OR a JSON string; runAgent normalizes).
 */
export async function ollamaCall({
  baseUrl = 'http://127.0.0.1:11434',
  model,
  messages,
  tools,
  signal,
  numCtx = DEFAULT_NUM_CTX,
  temperature = DEFAULT_TEMPERATURE,
  fetchImpl = globalThis.fetch
}) {
  const base = String(baseUrl).replace(/\/$/, '')
  const body = {
    model,
    messages,
    stream: false,
    // ⚠ the override that makes local tool calling work at all
    options: { num_ctx: numCtx, temperature }
  }
  if (tools?.length) body.tools = tools

  const res = await fetchImpl(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text().catch(() => '')}`)

  const data = await res.json()
  if (data.error) throw new Error(String(data.error))
  const msg = data.message ?? {}
  return {
    content: msg.content ?? '',
    tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    stats: { promptTokens: data.prompt_eval_count, completionTokens: data.eval_count }
  }
}

// -- OpenAI-compatible model call (Nebius, OpenRouter, LM Studio, …) ----------

/**
 * Base URL → chat-completions endpoint. Origin-only URLs get "/v1" appended
 * ("https://api.tokenfactory.nebius.com" → ".../v1/chat/completions"); URLs
 * that already carry a path (…/v1, …/api/v1, …/custom) are used as given.
 */
export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '')
  return `${/^https?:\/\/[^/]+$/.test(base) ? `${base}/v1` : base}/chat/completions`
}

/**
 * Chat messages → the OpenAI wire shape: drops Ollama-only fields
 * (tool_name), guarantees string arguments + pairing ids on tool_calls, and
 * turns an orphan role:"tool" result (no tool_call_id — e.g. from a text-form
 * tool call) into a user note the API still accepts.
 */
function toOpenAIMessages(messages) {
  const out = []
  for (const m of messages) {
    if (m.role === 'tool') {
      if (m.tool_call_id) out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content ?? '') })
      else out.push({ role: 'user', content: `[${m.tool_name ?? 'tool'} result]\n${String(m.content ?? '')}` })
      continue
    }
    if (m.role === 'assistant') {
      const a = { role: 'assistant', content: m.content ?? '' }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        a.tool_calls = m.tool_calls.map((t, i) => ({
          id: t.id ?? `call_${i}`,
          type: 'function',
          function: {
            name: t.function?.name ?? t.name,
            arguments:
              typeof t.function?.arguments === 'string'
                ? t.function.arguments
                : JSON.stringify(t.function?.arguments ?? t.arguments ?? {})
          }
        }))
      }
      out.push(a)
      continue
    }
    out.push({ role: m.role, content: m.content ?? '' })
  }
  return out
}

/**
 * Non-streaming chat call against any OpenAI-compatible /chat/completions
 * endpoint (Nebius Token Factory, OpenRouter, Ollama's own /v1, …) with the
 * tools schema attached. Same return shape as ollamaCall — runAgent treats
 * both identically: { content, tool_calls, stats }.
 */
export async function openaiCall({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  signal,
  temperature = DEFAULT_TEMPERATURE,
  fetchImpl = globalThis.fetch
}) {
  const res = await fetchImpl(chatCompletionsUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(messages),
      stream: false,
      ...(tools?.length ? { tools } : {}),
      temperature
    }),
    signal
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text().catch(() => '')}`)

  const data = await res.json()
  if (data.error) {
    const e = data.error
    throw new Error(typeof e === 'string' ? e : e.message ?? JSON.stringify(e))
  }
  const msg = data.choices?.[0]?.message ?? {}
  return {
    content: msg.content ?? '',
    tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    stats: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens }
  }
}

// -- safety ------------------------------------------------------------------

function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  // '' means root === target — the root itself is inside its own tree
  return (rel === '' || !rel.startsWith('..')) && !path.isAbsolute(rel)
}

/** Resolves a model-provided path against the allowed roots, or throws. */
export function resolveInRoots(roots, raw) {
  const p = String(raw ?? '').trim()
  if (!p) throw new Error('empty path')
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')) {
    const abs = path.normalize(p)
    if (roots.some((r) => inside(r, abs))) return abs
    throw new Error(`path outside the linked folders: ${raw}`)
  }
  for (const root of roots) {
    const candidate = path.resolve(root, p)
    if (inside(root, candidate)) return candidate
  }
  throw new Error(`path outside the linked folders: ${raw}`)
}

const DENY_PATTERNS = [
  /\bmkfs\b/i,
  /\brm\s+-rf\b/i,
  /\brm\s+-fr\b/i,
  /\bdel\b\s+\/[fsq]/i,
  /\bformat\s+[a-zA-Z]:/i,
  /\bshutdown\b/i,
  /\bdiskpart\b/i,
  /\breg\s+delete\b/i,
  /curl[^\n|]*\|\s*(ba)?sh/i,
  /powershell[^\n]*\s-enc/i,
  /Remove-Item\b[^\n]*-Recurse[^\n]*-Force/i,
  />\s*\/dev\/sd/i
]

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'venv', '.venv', '__pycache__', '.cache'])

// -- execution registry ------------------------------------------------------
// name → { check?, run }. `check` runs BEFORE the approval gate (validate →
// gate → execute), `run` only after both passed. Every entry returns strings.

/**
 * @param {object} opts
 * @param {string[]} opts.roots allowed folders (the chat's linked folders)
 * @param {string}  [opts.cwd]  default working directory for run_command
 * @param {number}  [opts.execTimeoutMs]
 */
export function makeRegistry({ roots = [], cwd, execTimeoutMs = 15000 } = {}) {
  if (!roots.length) throw new Error('makeRegistry: at least one root folder required')
  const workCwd = cwd ?? roots[0]

  const list_dir = {
    check: (a) => {
      try { resolveInRoots(roots, a.path ?? '.'); return null } catch (e) { return e.message }
    },
    run: async (a) => {
      const dir = resolveInRoots(roots, a.path ?? '.')
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      if (!entries.length) return '(empty folder)'
      return entries
        .slice(0, 300)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n')
    }
  }

  const read_file = {
    check: (a) => {
      if (!a.path) return 'path is required'
      try { resolveInRoots(roots, a.path); return null } catch (e) { return e.message }
    },
    run: async (a) => {
      const file = resolveInRoots(roots, a.path)
      const text = fs.readFileSync(file, 'utf8')
      return text.length > 30000 ? text.slice(0, 30000) + '\n…[truncated]' : text
    }
  }

  const write_file = {
    check: (a) => {
      if (!a.path) return 'path is required'
      if (typeof a.content !== 'string') return 'content must be a string'
      try { resolveInRoots(roots, a.path); return null } catch (e) { return e.message }
    },
    run: async (a) => {
      const file = resolveInRoots(roots, a.path)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, a.content, 'utf8')
      return `wrote ${Buffer.byteLength(a.content, 'utf8')} bytes to ${path.basename(file)}`
    }
  }

  const grep_search = {
    check: (a) => {
      if (!a.pattern) return 'pattern is required'
      try { new RegExp(a.pattern); } catch (e) { return `invalid regex: ${e.message}` }
      try { resolveInRoots(roots, a.path ?? '.'); return null } catch (e) { return e.message }
    },
    run: async (a) => {
      const start = resolveInRoots(roots, a.path ?? '.')
      const re = new RegExp(a.pattern)
      const hits = []
      let files = 0
      const walk = (dir) => {
        if (hits.length >= 100 || files >= 500) return
        let entries
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          if (hits.length >= 100 || files >= 500) return
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name))
          } else {
            files++
            try {
              const stat = fs.statSync(path.join(dir, e.name))
              if (stat.size > 1_000_000) continue
              const lines = fs.readFileSync(path.join(dir, e.name), 'utf8').split('\n')
              lines.forEach((line, i) => {
                if (hits.length < 100 && re.test(line)) {
                  hits.push(`${path.relative(start, path.join(dir, e.name))}:${i + 1}: ${line.trim().slice(0, 200)}`)
                }
              })
            } catch { /* binary / locked */ }
          }
        }
      }
      walk(start)
      return hits.length ? hits.join('\n') : `no matches for /${a.pattern}/`
    }
  }

  const run_command = {
    check: (a) => {
      if (!a.command) return 'command is required'
      if (a.command.length > 500) return 'command too long'
      for (const re of DENY_PATTERNS) {
        if (re.test(a.command)) return `destructive command rejected: matches ${re}`
      }
      return null
    },
    run: async (a) => {
      try {
        const { stdout, stderr } = await execP(a.command, {
          cwd: workCwd,
          timeout: execTimeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true
        })
        const out = [stdout, stderr].filter(Boolean).join('\n').trim()
        return (out || '(no output)').slice(0, 8000)
      } catch (e) {
        const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim()
        return `ERROR (exit ${e.code ?? '?'}): ${(out || e.message).slice(0, 4000)}`
      }
    }
  }

  const web_search = {
    check: (a) => (a.query && String(a.query).trim() ? null : 'query is required'),
    run: async (a) => {
      const results = await webSearch(String(a.query))
      if (!results?.length) return 'no results'
      return results
        .slice(0, 6)
        .map((r) => `${r.title}\n${r.url}${r.snippet ? `\n${r.snippet}` : ''}`)
        .join('\n\n')
    }
  }

  // Task list: lives with the registry, so it survives every iteration — and,
  // when the shell caches the registry, every turn of the conversation.
  // Read it as `registry.todo_write.state.todos`.
  const state = { todos: [] }

  const todo_write = {
    check: (a) => {
      if (!Array.isArray(a.items)) return 'items must be an array of {text, status}'
      if (!a.items.length) return 'items must not be empty'
      for (const it of a.items) {
        if (!it || typeof it.text !== 'string' || !it.text.trim()) return 'every item needs text'
        if (!['pending', 'in_progress', 'done'].includes(it.status))
          return `bad status "${it.status}" — use pending, in_progress or done`
      }
      return null
    },
    run: async (a) => {
      state.todos.length = 0 // replace in place — keeps .state.todos references live
      for (const it of a.items) state.todos.push({ text: String(it.text).slice(0, 300), status: it.status })
      const done = state.todos.filter((i) => i.status === 'done').length
      return (
        `saved ${state.todos.length} todos (${done} done):\n` +
        state.todos
          .map((it, i) => `${i + 1}. [${it.status === 'done' ? 'x' : it.status === 'in_progress' ? '>' : ' '}] ${it.text}`)
          .join('\n')
      )
    },
    state
  }

  return { list_dir, read_file, write_file, grep_search, run_command, web_search, todo_write }
}

// -- hooks ---------------------------------------------------------------------
// Lifecycle hooks let the workspace veto or audit tool actions, the way mature
// agent CLIs do: a hook is a shell command that receives {tool, args} as JSON
// on stdin, and its exit code decides what happens — 0 lets the action through,
// nonzero (2 in Claude Code) BLOCKS it and stderr becomes the tool result the
// model sees. Config: `.codezy/hooks.json` in the workspace, else the home dir.

/**
 * Loads the hook config for a run (workspace first, then the user's home dir).
 * Shape: `{ before_tool: [{tools?, command, timeout_ms?}], after_tool: [...] }`
 * `tools` defaults to all tools; omit it or use `"*"`.
 * @param {string[]} roots workspace roots
 * @returns {null | {file:string, cwd:string, before_tool:Array, after_tool:Array}}
 */
export function loadHooks(roots = []) {
  const candidates = []
  for (const r of roots) candidates.push(path.join(r, '.codezy', 'hooks.json'))
  candidates.push(path.join(os.homedir(), '.codezy', 'hooks.json'))
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (j && (Array.isArray(j.before_tool) || Array.isArray(j.after_tool))) {
        return { file: f, cwd: roots[0] ?? process.cwd(), before_tool: j.before_tool ?? [], after_tool: j.after_tool ?? [] }
      }
    } catch {
      // no file or invalid json — keep looking
    }
  }
  return null
}

/**
 * Runs every matching hook of one phase, in order.
 * @returns {string|null} null = all passed · string = first failure message
 */
function runHooks(hooks, phase, name, args) {
  const list = hooks?.[phase]
  if (!hooks || !Array.isArray(list) || !list.length) return null
  for (const h of list) {
    const tools = Array.isArray(h?.tools) ? h.tools : ['*']
    if (!tools.includes('*') && !tools.includes(name)) continue
    const cmd = String(h?.command ?? '').trim()
    if (!cmd) continue
    let r
    try {
      r = spawnSync(cmd, {
        shell: true,
        cwd: hooks.cwd || process.cwd(),
        encoding: 'utf8',
        timeout: Number(h.timeout_ms) || 10000,
        windowsHide: true,
        input: JSON.stringify({ tool: name, args })
      })
    } catch (e) {
      return `hook "${cmd}" failed to run: ${e?.message ?? e}`
    }
    if (r.status === null || r.status === undefined) return `hook "${cmd}" timed out or did not start`
    if (r.status !== 0) {
      return String(r.stderr ?? '').trim().slice(0, 400) || `hook "${cmd}" exited with code ${r.status}`
    }
  }
  return null
}

// -- the loop ----------------------------------------------------------------

function normalizeArgs(raw) {
  if (raw == null) return {}
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return { _raw: raw } }
  }
  return typeof raw === 'object' ? raw : { value: raw }
}

// -- text-form tool-call fallback --------------------------------------------
// Models without native function calling (qwen2.5-coder) — and even capable
// ones, occasionally — write the tool call as a JSON object INSIDE the reply
// text instead of the API `tool_calls` field. Without this fallback that reply
// becomes the final answer and the tool silently never runs (the "model says
// it has no web_search" bug).

/** All balanced top-level {...} objects inside `s` (string/escape aware). */
function scanJsonObjects(s) {
  const out = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' && depth > 0) {
      depth--
      if (depth === 0 && start !== -1) {
        out.push(s.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

/**
 * Finds a tool call written as TEXT and normalizes it to the API shape
 * `[{ function: { name, arguments } }]`. Accepts the shapes models actually
 * write: `{name, arguments|parameters|args}` or `{function: {name, ...}}`,
 * fenced (```json) or bare. `known` limits matches to real tool names, so a
 * JSON blob like a package.json (`{"name": "codezy"}`) is never executed.
 * @param {string} content assistant reply text
 * @param {Set<string>} [known] registry tool names
 * @returns {Array} normalized calls — empty array when there is none
 */
export function parseTextToolCall(content, known) {
  if (typeof content !== 'string' || !content.includes('"name"')) return []
  const fences = [...content.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)].map((m) => m[1])
  for (const blob of [...fences, content]) {
    for (const raw of scanJsonObjects(blob)) {
      let obj
      try {
        obj = JSON.parse(raw)
      } catch {
        continue
      }
      if (!obj || typeof obj !== 'object') continue
      const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj
      const name = typeof fn.name === 'string' ? fn.name : null
      if (!name) continue
      if (known && !known.has(name)) continue
      return [{ function: { name, arguments: fn.arguments ?? fn.parameters ?? fn.args ?? {} } }]
    }
  }
  return []
}

const cap = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '\n…[truncated]' : String(s))

/**
 * Runs one agent chain to termination.
 *
 * @param {object}   opts
 * @param {Array}    opts.messages   ordered history [{role, content, ...}] —
 *                                   NOT mutated; the extended copy is returned
 * @param {Array}    [opts.tools]    strict JSON schema array
 * @param {object}   opts.registry   name → { check?, run }
 * @param {Function} opts.callModel  async ({messages, tools, signal}) => {content, tool_calls}
 * @param {Function} [opts.approve]  async (name, args) => boolean — MISSING = deny
 * @param {Function} [opts.needsApproval] default: DANGEROUS_TOOLS.has(name)
 * @param {number}   [opts.maxIter]  hard cap, clamped to 5–10
 * @param {Function} [opts.onEvent]  ({type, ...}) — 'tool' | 'end' events
 * @param {object}   [opts.hooks]    loadHooks(roots) — before_tool failures
 *                                   BLOCK the action, after_tool failures are
 *                                   appended to the tool result
 * @returns {{status:'text'|'limit', text:string, messages:Array, iterations:number}}
 */
export async function runAgent({
  messages,
  tools = TOOLS,
  registry,
  callModel,
  approve,
  needsApproval = (name) => DANGEROUS_TOOLS.has(name),
  maxIter = DEFAULT_MAX_ITER,
  toolResultCap = 16000,
  onEvent = () => {},
  hooks = null,
  signal
}) {
  if (typeof callModel !== 'function') throw new Error('runAgent: callModel is required')
  if (!registry || typeof registry !== 'object') throw new Error('runAgent: registry is required')
  const toolNames = new Set(Object.keys(registry))
  const capIter = Math.min(10, Math.max(5, Math.floor(maxIter) || DEFAULT_MAX_ITER))
  const msgs = messages.map((m) => ({ ...m }))

  let iter = 0
  for (;;) {
    if (iter >= capIter) {
      onEvent({ type: 'end', status: 'limit', iterations: iter })
      return { status: 'limit', text: '', messages: msgs, iterations: iter }
    }
    iter++

    const res = await callModel({ messages: msgs, tools, signal })
    const content = res.content ?? ''
    // API tool_calls first; otherwise a text-form call written into the reply
    const calls = Array.isArray(res.tool_calls) && res.tool_calls.length
      ? res.tool_calls
      : parseTextToolCall(content, toolNames)

    if (!calls.length) {
      // plain text → terminate (the reply joins the history, done)
      msgs.push({ role: 'assistant', content })
      onEvent({ type: 'end', status: 'text', iterations: iter, text: content })
      return { status: 'text', text: content, messages: msgs, iterations: iter }
    }

    // (1) the assistant message carrying the EXACT tool_calls payload
    const assistantMsg = { role: 'assistant', content }
    if (res.message?.tool_calls) assistantMsg.tool_calls = res.message.tool_calls
    else assistantMsg.tool_calls = calls
    msgs.push(assistantMsg)

    // (2) one role:"tool" message per call, mapped by function name
    for (const call of calls) {
      const name = call?.function?.name ?? call?.name ?? '(unnamed)'
      const args = normalizeArgs(call?.function?.arguments ?? call?.arguments)
      let outcome = 'ok'
      let result

      const entry = registry[name]
      if (!entry) {
        outcome = 'unknown'
        result = `ERROR: unknown tool "${name}"`
      } else {
        const problem = entry.check ? await entry.check(args) : null
        if (problem) {
          outcome = 'rejected'
          result = `ERROR: ${problem}`
        } else {
          const blocked = runHooks(hooks, 'before_tool', name, args)
          if (blocked !== null) {
            // contract: nonzero hook exit blocks the action BEFORE approval
            // and the hook's stderr is what the model gets back
            outcome = 'blocked'
            result = `BLOCKED by hook: ${blocked}`
          } else if (needsApproval(name, args)) {
            const allowed = approve ? await approve(name, args) : false
            if (!allowed) {
              outcome = 'denied'
              result = `BLOCKED: the user denied approval for ${name}. Nothing was executed.`
            }
          }
        }
        if (outcome === 'ok') {
          try {
            const out = await entry.run(args)
            result = cap(out ?? '', toolResultCap)
          } catch (e) {
            outcome = 'error'
            result = `ERROR: ${e?.message ?? e}`
          }
          // after_tool hooks cannot un-run the action — a failure is reported
          // to the model so it can react (linters, formatters, checkers…)
          const afterFailure = runHooks(hooks, 'after_tool', name, args)
          if (afterFailure !== null) result += `\n[hook] ${afterFailure}`
        }
      }

      msgs.push({
        role: 'tool',
        tool_name: name, // Ollama native pairing key
        ...(call?.id ? { tool_call_id: call.id } : {}), // OpenAI-compatible pairing key
        content: result
      })
      onEvent({ type: 'tool', iteration: iter, name, args, outcome, result })
    }
  }
}

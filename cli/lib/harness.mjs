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
import { exec, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { webSearch } from './search.mjs'

const execP = promisify(exec)

export const DEFAULT_NUM_CTX = 65536
export const DEFAULT_TEMPERATURE = 0.6
/** Spec: hard iteration cap per chain, 5–10. */
export const DEFAULT_MAX_ITER = 8
/** Tools that pause the loop for human approval before executing. */
export const DANGEROUS_TOOLS = new Set(['write_file', 'edit_file', 'run_command'])

/** Tools that change the disk or run code — plan mode refuses all of them. */
export const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'run_command'])

/** Read-only tools — a batch of these at the FRONT of one turn runs concurrently
 *  (models love batching reads; N serial round-trips through the FS is pure
 *  latency). Anything else — gated, mutating, stateful, MCP-unknown — starts a
 *  strictly sequential tail so any ordering the model implied is preserved. */
export const PARALLEL_SAFE = new Set(['list_dir', 'read_file', 'grep_search', 'glob', 'web_search', 'web_fetch'])

/** v3 sub-agent tool schema — merged into the loop by runAgent itself. */
export const DELEGATE_TOOL = {
  type: 'function',
  function: {
    name: 'delegate',
    description:
      'Hand a self-contained sub-task to a SUB-AGENT with its own fresh context: research something broad, summarize a folder, or implement a piece that would need many steps and would clutter this conversation. Returns the sub-agent’s final answer. Its edits and commands still require user approval. Use sparingly — one focused brief per call.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'A complete brief: what to do, which folders/files matter, and what to return.'
        }
      },
      required: ['task']
    }
  }
}

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
      description:
        'Read a text file from the linked workspace and return its content. Large files come back as head+tail — pass offset/limit (1-based lines) to page through the rest.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to read, relative to the workspace root.' },
          offset: { type: 'number', description: 'First line to read (1-based). Optional.' },
          limit: { type: 'number', description: 'How many lines to return from offset. Optional, default 400.' }
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
          command: { type: 'string', description: 'The shell command to execute.' },
          background: {
            type: 'boolean',
            description:
              'Start the command and return immediately with a task id — for servers, builds and watchers. Poll task_status for output. Default false.'
          }
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
      name: 'web_fetch',
      description:
        'Fetch a URL and return its text — HTML is stripped to readable prose. Use it after web_search to open the promising links (docs, releases, issues). Read-only, http(s) only.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The http(s) URL to fetch.' },
          maxChars: { type: 'number', description: 'Cap on returned characters. Optional, default 20000.' }
        },
        required: ['url']
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
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace text inside a file: pass the exact `old` text and the exact `new` text. The old text must appear exactly once unless replace_all is true. Requires explicit user approval. Prefer this over write_file when changing an existing file — it is cheaper and cannot lose content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to edit, relative to the workspace root.' },
          old: { type: 'string', description: 'The exact text to find — copy it verbatim, indentation included.' },
          new: { type: 'string', description: 'The replacement text. Use an empty string to delete the old text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one. Default false.' }
        },
        required: ['path', 'old', 'new']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files by name pattern and return their paths, sorted. ** crosses folders, * stays inside one segment: "**/*.ts", "src/**", "*.md". Skips node_modules, .git and other build folders.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The glob pattern to match file paths against.' },
          path: { type: 'string', description: 'Folder to search in, relative to the workspace root. Defaults to the root.' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'task_status',
      description:
        'Check on background tasks started with run_command {"background": true}. Pass an id for one task (add "kill": true to stop it), or omit the id to list every task.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Task id. Optional — omit to list all tasks.' },
          kill: { type: 'boolean', description: 'Stop the task if it is still running. Default false.' }
        },
        required: []
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

/**
 * Minimal glob → RegExp. `**` crosses folders and swallows the following
 * slash, so a `**`-prefixed pattern also matches a top-level file;
 * `*` stays inside one segment, `?` matches one non-slash char,
 * `{a,b}` alternates.
 */
export function globToRegExp(pattern) {
  let out = ''
  const src = String(pattern)
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '*') {
      if (src[i + 1] === '*') {
        out += '.*'
        i++
        if (src[i + 1] === '/') i++ // "**/" matches zero folders too
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '{') out += '(?:'
    else if (c === '}') out += ')'
    else if (c === ',') out += '|'
    else if ('\\^$.|+()[]{}'.includes(c)) out += '\\' + c
    else out += c
  }
  return new RegExp(`^${out}$`)
}

// -- execution registry ------------------------------------------------------
// name → { check?, run }. `check` runs BEFORE the approval gate (validate →
// gate → execute), `run` only after both passed. Every entry returns strings.

/**
 * @param {object} opts
 * @param {string[]} opts.roots allowed folders (the chat's linked folders)
 * @param {string}  [opts.cwd]  default working directory for run_command
 * @param {number}  [opts.execTimeoutMs]
 */
export function makeRegistry({ roots = [], cwd, execTimeoutMs = 15000, allowMutations = true } = {}) {
  if (!roots.length) throw new Error('makeRegistry: at least one root folder required')
  const workCwd = cwd ?? roots[0]
  /** Plan mode: the mutating tools refuse BEFORE the approval gate — the
   *  agent may read, search and plan all it wants, but cannot touch the
   *  disk or run anything until the user switches to build/auto. */
  const refuse = (name) =>
    allowMutations
      ? null
      : `plan mode: ${name} is disabled — present the plan first; the user switches to build/auto when they want changes`
  // Lives with the registry: todo_write state AND background tasks survive
  // every iteration — and, when the shell caches the registry, every turn.
  const state = { todos: [], tasks: new Map(), nextTaskId: 1 }

  const list_dir = {
    check: (a) => {
      try { resolveInRoots(roots, a.path ?? '.'); return null } catch (e) { return e.message }
    },
    run: async (a) => {
      const dir = resolveInRoots(roots, a.path ?? '.')
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      if (!entries.length) return '(empty folder)'
      // folders first, then natural order — deterministic across OSes
      entries.sort((x, y) =>
        x.isDirectory() === y.isDirectory()
          ? x.name.localeCompare(y.name, 'en', { numeric: true })
          : x.isDirectory()
            ? -1
            : 1
      )
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
      const lines = text.split('\n')
      const total = lines.length
      // explicit paging — the model walks a big file instead of guessing
      if (a.offset != null || a.limit != null) {
        const offset = Math.max(1, Math.floor(Number(a.offset) || 1))
        const limit = Math.max(1, Math.min(2000, Math.floor(Number(a.limit) || 400)))
        if (offset > total) return `(file has only ${total} lines)`
        let chunk = lines.slice(offset - 1, offset - 1 + limit).join('\n')
        if (chunk.length > 40000) chunk = chunk.slice(0, 40000) + '\n…[slice too large — narrow offset/limit]'
        const last = Math.min(total, offset + limit - 1)
        const more = last < total
        if (offset === 1 && !more) return chunk
        return `lines ${offset}–${last} of ${total}${more ? ` (more after — next offset=${last + 1})` : ''}\n\n${chunk}`
      }
      if (text.length <= 30000) return text
      // too big for one shot: head + tail (the END of a file often matters)
      // plus a pointer — the final `…[truncated]` line is what the TUI's
      // "N+ lines" display keys on, so it stays last.
      const head = lines.slice(0, 900).join('\n').slice(0, 24000)
      const tail = lines.slice(-250).join('\n').slice(-6000)
      return (
        `${head}\n…[file has ${total} lines / ${text.length} chars — showing head+tail, re-read with offset/limit to page]…\n` +
        `${tail}\n…[truncated]`
      )
    }
  }

  const write_file = {
    check: (a) => {
      if (!a.path) return 'path is required'
      if (typeof a.content !== 'string') return 'content must be a string'
      const gated = refuse('write_file')
      if (gated) return gated
      try { resolveInRoots(roots, a.path); return null } catch (e) { return e.message }
    },
    run: async (a) => {
      const file = resolveInRoots(roots, a.path)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, a.content, 'utf8')
      return `wrote ${Buffer.byteLength(a.content, 'utf8')} bytes to ${path.basename(file)}`
    }
  }

  const edit_file = {
    check: (a) => {
      if (!a.path) return 'path is required'
      if (typeof a.old !== 'string' || !a.old.length) return 'old text is required — the exact text to replace'
      if (typeof a.new !== 'string') return 'new must be a string (use "" to delete the old text)'
      if (a.old === a.new) return 'old and new are identical — nothing to do'
      const gated = refuse('edit_file')
      if (gated) return gated
      try { resolveInRoots(roots, a.path); return null } catch (e) { return e.message }
    },
    run: async (a) => {
      const file = resolveInRoots(roots, a.path)
      if (!fs.existsSync(file)) return `ERROR: ${a.path} does not exist — use write_file to create it`
      const before = fs.readFileSync(file, 'utf8')
      if (Buffer.byteLength(before, 'utf8') > 2_000_000) return 'ERROR: file too large to edit safely — use write_file if you really must'
      const count = before.split(a.old).length - 1
      if (count === 0) {
        return `ERROR: the old text was not found in ${path.basename(file)} — copy it verbatim (indentation included) or read the file again first`
      }
      if (count > 1 && !a.replace_all) {
        return `ERROR: the old text appears ${count} times — add more surrounding lines to make it unique, or pass replace_all`
      }
      const after = a.replace_all ? before.split(a.old).join(a.new) : before.replace(a.old, a.new)
      fs.writeFileSync(file, after, 'utf8')
      const n = a.replace_all ? count : 1
      return (
        `edited ${path.basename(file)}: ${n} replacement${n === 1 ? '' : 's'} ` +
        `(${Buffer.byteLength(before, 'utf8')} → ${Buffer.byteLength(after, 'utf8')} bytes)`
      )
    }
  }

  const glob = {
    check: (a) => {
      if (!a.pattern) return 'pattern is required'
      try { resolveInRoots(roots, a.path ?? '.'); return null } catch (e) { return e.message }
    },
    run: async (a) => {
      const start = resolveInRoots(roots, a.path ?? '.')
      const re = globToRegExp(a.pattern)
      const hits = []
      let visited = 0
      const walk = (dir) => {
        if (hits.length >= 200 || visited >= 20000) return
        let entries
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          if (hits.length >= 200 || visited >= 20000) return
          const abs = path.join(dir, e.name)
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(abs)
          } else {
            visited++
            const rel = path.relative(start, abs).split(path.sep).join('/')
            if (re.test(rel)) hits.push(rel)
          }
        }
      }
      walk(start)
      hits.sort()
      if (!hits.length) return `no files match ${a.pattern}`
      return hits.join('\n') + (hits.length >= 200 ? '\n…[capped at 200 — narrow the pattern]' : '')
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

  // Background tasks: `run_command {"background":true}` spawns without
  // waiting and hands back an id; `task_status` reads output / kills. The
  // task map lives in the registry state, so it survives across iterations
  // AND — when the shell caches the registry — across turns of the chat.
  const killTask = (t) => {
    if (!t.running || !t.proc?.pid) return
    try {
      if (process.platform === 'win32') {
        // killing the shell alone leaves grandchildren alive AND their
        // inherited pipes open — taskkill takes down the whole tree, which
        // is what actually fires the 'close' event
        spawnSync('taskkill', ['/pid', String(t.proc.pid), '/T', '/F'], { windowsHide: true })
      } else t.proc.kill('SIGTERM')
    } catch { /* already gone */ }
    try { t.proc.kill() } catch { /* already gone */ }
  }

  const startTask = (command) => {
    // hard cap of 20 records — finished ones go first, then the oldest
    // (killed if it is somehow still running), so the map can never grow
    while (state.tasks.size >= 20) {
      const victim = [...state.tasks.values()].find((t) => !t.running) ?? [...state.tasks.values()][0]
      killTask(victim)
      state.tasks.delete(victim.id)
    }
    const id = state.nextTaskId++
    const task = { id, command, running: true, code: null, out: '', started: Date.now(), proc: null }
    let child
    try {
      child = spawn(command, { shell: true, cwd: workCwd, windowsHide: true })
    } catch (e) {
      return `ERROR: could not start task: ${e?.message ?? e}`
    }
    task.proc = child
    const keep = (chunk) => {
      task.out += String(chunk)
      if (task.out.length > 200_000) task.out = task.out.slice(-200_000) // ring buffer
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('close', (code) => {
      task.running = false
      task.code = code
    })
    child.on('error', (e) => {
      task.running = false
      task.code = 'error'
      keep(`\n${e?.message ?? e}`)
    })
    state.tasks.set(id, task)
    return `started background task #${id}: ${command.slice(0, 120)} — ask task_status {"id": ${id}} for progress`
  }

  const run_command = {
    check: (a) => {
      if (!a.command) return 'command is required'
      if (a.command.length > 500) return 'command too long'
      for (const re of DENY_PATTERNS) {
        if (re.test(a.command)) return `destructive command rejected: matches ${re}`
      }
      const gated = refuse('run_command')
      if (gated) return gated
      return null
    },
    run: async (a) => {
      if (a.background) return startTask(String(a.command))
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

  const task_status = {
    state,
    check: (a) => (a && typeof a === 'object' ? null : 'arguments must be an object — {} lists every task'),
    run: async (a) => {
      if (a.id == null) {
        const all = [...state.tasks.values()]
        if (!all.length) return 'no background tasks'
        return all
          .map((t) => `#${t.id} ${t.running ? 'running' : `exit ${t.code}`}: ${t.command.slice(0, 100)}`)
          .join('\n')
      }
      const t = state.tasks.get(Number(a.id))
      if (!t) return `no task #${a.id} — known tasks: ${[...state.tasks.keys()].join(', ') || '(none)'}`
      if (a.kill && t.running) killTask(t)
      const tail = t.out.length > 4000 ? `…${t.out.slice(-4000)}` : t.out
      return (
        `task #${t.id} ${t.running ? 'running' : `exited with code ${t.code}`}` +
        `${a.kill && t.running ? ' (kill requested)' : ''}\n${tail || '(no output yet)'}`
      )
    }
  }

  // HTML → readable prose: drop scripts/styles/noise, keep block breaks.
  // (module-scope helper would also do; keeping it beside its only caller)
  function stripHtml(html) {
    return String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre|table|ul|ol|figcaption)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t ]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
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

  // Open a link the search just surfaced. Read-only, http(s) only, 15s cap —
  // the whole point is answering "current" questions without a headless browser.
  const web_fetch = {
    check: (a) => {
      if (!a || !a.url) return 'url is required'
      if (!/^https?:\/\//i.test(String(a.url))) return 'only http(s) urls are allowed'
      return null
    },
    run: async (a) => {
      const res = await fetch(String(a.url), {
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
        headers: { 'user-agent': 'CODEZY agent (web_fetch)' }
      })
      if (!res.ok) return `fetch failed: HTTP ${res.status} ${res.statusText}`
      const type = (res.headers.get('content-type') ?? '').toLowerCase()
      const text = await res.text()
      const cap = Math.min(Math.max(Number(a.maxChars) || 20000, 1000), 100000)
      const out = type.includes('html') || type.includes('xml') ? stripHtml(text) : text.trim()
      if (!out) return '(the page had no readable text)'
      return out.length > cap ? `${out.slice(0, cap)}\n…[truncated]` : out
    }
  }

  // Task list: read it as `registry.todo_write.state.todos`.
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

  return {
    list_dir,
    read_file,
    write_file,
    edit_file,
    glob,
    grep_search,
    run_command,
    task_status,
    web_search,
    web_fetch,
    todo_write
  }
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

// -- transient model-call retry ------------------------------------------------

/**
 * Only genuine transport hiccups retry: HTTP 408/429/5xx and refused / reset /
 * timed-out sockets. "model not found" and friends fail fast — retrying them
 * only delays the honest error. An abort never retries.
 */
export function isTransient(e) {
  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') return false
  const m = String(e?.message ?? e ?? '')
  if (/(ECONNREFUSED|ETIMEDOUT|ECONNRESET|EPIPE|EAI_AGAIN|fetch failed|socket hang up)/i.test(m)) return true
  const http = m.match(/(?:Ollama|API) error (\d{3})/)
  if (http) {
    const s = Number(http[1])
    return s === 408 || s === 429 || s >= 500
  }
  return /timed? out/i.test(m)
}

const abortError = () => {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

/** callModel with short backoff on transient failures (2 retries by default).
 *  Nothing is appended to the chain before the call succeeds, so a retry
 *  re-sends the exact same messages — history can never double-append. */
async function callWithRetry({ callModel, params, retries, retryDelayMs, onEvent }) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (params.signal?.aborted) throw abortError()
    try {
      return await callModel(params)
    } catch (e) {
      lastErr = e
      if (e?.name === 'AbortError' || params.signal?.aborted) throw e
      if (attempt >= retries || !isTransient(e)) throw e
      const wait = retryDelayMs * 3 ** attempt
      onEvent({ type: 'retry', attempt: attempt + 1, max: retries, wait, error: String(e?.message ?? e) })
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw lastErr
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
  // a reply cut off mid-object still gets emitted — repairJson closes it
  if (depth > 0 && start !== -1) out.push(s.slice(start))
  return out
}

/**
 * Best-effort repair for the "almost JSON" local models write: curly quotes
 * used as delimiters, single-quoted strings, line and block comments, trailing
 * commas, or an object cut off mid-reply. Runs ONLY after strict JSON.parse
 * already failed, so valid JSON is never rewritten.
 */
export function repairJson(raw) {
  let s = String(raw)
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
  // string-aware pass: strip comments outside strings, single → double quotes
  let out = ''
  let mode = null
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (mode) {
      if (c === '\\') { out += c + (s[i + 1] ?? ''); i += 2; continue }
      if (c === mode) { out += mode === "'" ? '"' : c; mode = null; i++; continue }
      if (mode === "'" && c === '"') { out += '\\"'; i++; continue }
      out += c; i++; continue
    }
    if (c === '"' || c === "'") { mode = c; out += c === "'" ? '"' : c; i++; continue }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '/' && s[i + 1] === '*') {
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c; i++
  }
  if (mode) out += mode === "'" ? '"' : mode // unterminated string
  out = out.replace(/,\s*([}\]])/g, '$1') // trailing commas
  // close structures the reply was cut off inside (deepest first)
  const stack = []
  let inStr = false
  let esc = false
  for (const ch of out) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  if (inStr) out += '"'
  while (stack.length) out += stack.pop() === '{' ? '}' : ']'
  return out
}

/**
 * Finds tool calls written as TEXT and normalizes them to the API shape
 * `[{ function: { name, arguments } }]`. Accepts the shapes models actually
 * write: `{name, arguments|parameters|args}` or `{function: {name, ...}}`,
 * fenced (```json) or bare — and MORE THAN ONE call per reply. Strict parse
 * first; only a failed parse goes through repairJson (trailing commas,
 * smart/single quotes, comments, truncated tail). `known` limits matches to
 * real tool names, so a JSON blob like a package.json (`{"name":"codezy"}`)
 * is never executed; identical objects (fence + prose echo) are deduped.
 * @param {string} content assistant reply text
 * @param {Set<string>} [known] registry tool names
 * @returns {Array} normalized calls — empty array when there is none
 */
export function parseTextToolCall(content, known) {
  if (typeof content !== 'string' || !/["'\u201C\u2018]name["'\u201D\u2019]\s*:/.test(content)) return []
  const fences = [...content.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)].map((m) => m[1])
  const out = []
  const seen = new Set()
  for (const blob of [...fences, content]) {
    for (const raw of scanJsonObjects(blob)) {
      if (seen.has(raw)) continue // the fence and the same object in prose
      seen.add(raw)
      let obj = null
      try {
        obj = JSON.parse(raw)
      } catch {
        try { obj = JSON.parse(repairJson(raw)) } catch { /* not JSON at all */ }
      }
      if (!obj || typeof obj !== 'object') continue
      const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj
      const name = typeof fn.name === 'string' ? fn.name : null
      if (!name) continue
      if (known && !known.has(name)) continue
      out.push({ function: { name, arguments: fn.arguments ?? fn.parameters ?? fn.args ?? {} } })
      if (out.length >= 7) return out
    }
  }
  return out
}

const cap = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '\n…[truncated]' : String(s))

// -- context budget ----------------------------------------------------------
// Tool results pile up fast (read_file up to 30k chars × 8 rounds) and Ollama
// silently drops the OLDEST messages when a prompt overflows num_ctx — losing
// the system prompt and un-pairing tool messages. fitContext SHRINKS instead
// of dropping: the most recent tool rounds stay whole, older tool results
// collapse to a head+tail window, and if the total still overshoots the
// budget the oldest shrinkable messages halve. Structure (roles, ids,
// tool_calls) is never removed, so pairing survives regardless.
export function fitContext(msgs, { recentTools = 2, oldCap = 4000, budget = 210000 } = {}) {
  const shrink = (m, capTo) => {
    if (typeof m.content !== 'string' || m.content.length <= capTo) return false
    const marker = `\n…[${m.content.length} chars trimmed to fit the context window]…\n`
    const room = Math.max(200, capTo - marker.length)
    const head = Math.floor(room * 0.7)
    const tail = room - head
    m.content = m.content.slice(0, head) + marker + (tail > 0 ? m.content.slice(-tail) : '')
    return true
  }
  const toolIdx = []
  for (let i = 0; i < msgs.length; i++) if (msgs[i].role === 'tool') toolIdx.push(i)
  const keep = new Set(toolIdx.slice(-recentTools))
  for (const i of toolIdx) if (!keep.has(i)) shrink(msgs[i], oldCap)

  let total = 0
  for (const m of msgs) total += typeof m.content === 'string' ? m.content.length : 0
  for (let i = 0; i < msgs.length && total > budget; i++) {
    const m = msgs[i]
    if (m.role === 'system' || keep.has(i)) continue
    if (typeof m.content === 'string' && m.content.length > 2000) {
      const before = m.content.length
      shrink(m, Math.max(1000, Math.floor(before / 2)))
      total -= before - m.content.length
    }
  }
  return msgs
}

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
  retries = 2,
  retryDelayMs = 400,
  onEvent = () => {},
  hooks = null,
  signal,
  allowDelegate = true,
  delegateDepth = 0,
  maxDelegateDepth = 2,
  delegateIter = 4
}) {
  if (typeof callModel !== 'function') throw new Error('runAgent: callModel is required')
  if (!registry || typeof registry !== 'object') throw new Error('runAgent: registry is required')

  // v3 sub-agents: `delegate` hands a self-contained brief to a NESTED
  // chain with a fresh context — same registry (same folders, same approval
  // gate, same hooks), own small iteration budget, and depth-limited so a
  // sub-agent may delegate once more but never deeper. Merged HERE rather
  // than in makeRegistry because the child chain needs THIS run's callModel.
  let effRegistry = registry
  let effTools = tools
  if (allowDelegate && delegateDepth < maxDelegateDepth && !('delegate' in registry)) {
    effRegistry = {
      ...registry,
      delegate: {
        check: (a) => {
          if (!a || typeof a.task !== 'string' || !a.task.trim())
            return 'task is required — a focused brief for the sub-agent'
          if (a.task.length > 4000) return 'task too long — keep the brief under 4000 characters'
          return null
        },
        run: async (a) => {
          const sub = await runAgent({
            messages: [{ role: 'user', content: String(a.task) }],
            registry,
            callModel,
            approve,
            needsApproval,
            hooks,
            signal,
            maxIter: delegateIter,
            toolResultCap,
            allowDelegate,
            delegateDepth: delegateDepth + 1,
            maxDelegateDepth,
            delegateIter,
            onEvent: (ev) => onEvent({ ...ev, sub: true, depth: delegateDepth + 1 })
          })
          const text = sub.text || (sub.status === 'limit' ? '(the sub-agent hit its step cap)' : '(no final text)')
          return `sub-agent finished (${sub.status}, ${sub.iterations} steps):\n${cap(text, 8000)}`
        }
      }
    }
    effTools = effTools.some((t) => t?.function?.name === 'delegate') ? effTools : [...effTools, DELEGATE_TOOL]
  }
  const toolNames = new Set(Object.keys(effRegistry))
  const capIter = Math.min(40, Math.max(5, Math.floor(maxIter) || DEFAULT_MAX_ITER))
  const msgs = messages.map((m) => ({ ...m }))
  // token totals across every model call of this chain (returned to the shell
  // so /usage-style readouts don't need a second accounting path)
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0 }

  let iter = 0
  for (;;) {
    if (iter >= capIter) {
      onEvent({ type: 'end', status: 'limit', iterations: iter })
      return { status: 'limit', text: '', messages: msgs, iterations: iter, usage }
    }
    iter++

    // keep the chain inside the model window (see fitContext) — shrink here,
    // before the call, rather than letting Ollama front-truncate silently
    fitContext(msgs)

    let res
    try {
      res = await callWithRetry({ callModel, params: { messages: msgs, tools: effTools, signal }, retries, retryDelayMs, onEvent })
    } catch (e) {
      // user interrupt (or a dead signal) → stop CLEANLY with the chain as it
      // stands: every completed tool result stays, nothing is half-appended
      if (e?.name === 'AbortError' || signal?.aborted) {
        onEvent({ type: 'end', status: 'stopped', iterations: iter })
        return { status: 'stopped', text: '', messages: msgs, iterations: iter, usage }
      }
      throw e
    }
    usage.calls++
    if (res.stats) {
      usage.promptTokens += Number(res.stats.promptTokens) || 0
      usage.completionTokens += Number(res.stats.completionTokens) || 0
    }
    const content = res.content ?? ''
    // API tool_calls first; otherwise a text-form call written into the reply
    const calls = Array.isArray(res.tool_calls) && res.tool_calls.length
      ? res.tool_calls
      : parseTextToolCall(content, toolNames)

    if (!calls.length) {
      // plain text → terminate (the reply joins the history, done)
      msgs.push({ role: 'assistant', content })
      onEvent({ type: 'end', status: 'text', iterations: iter, text: content })
      return { status: 'text', text: content, messages: msgs, iterations: iter, usage }
    }

    // (1) the assistant message carrying the tool_calls payload — every call
    //     gets an id HERE so OpenAI-style pairing always resolves: native API
    //     calls keep their id, text-form fallback calls have none, and an
    //     unanswered id is a 400 on the next round against cloud providers.
    const wireCalls = calls.map((c, i) => {
      const fn = c && typeof c === 'object' && c.function ? c.function : c
      return {
        ...(c && typeof c === 'object' ? c : {}),
        id: c?.id ?? `call_${iter}_${i}`,
        function: {
          name: fn?.name ?? c?.name,
          arguments: fn?.arguments ?? c?.arguments ?? fn?.parameters ?? c?.args ?? {}
        }
      }
    })
    const assistantMsg = { role: 'assistant', content, tool_calls: wireCalls }
    msgs.push(assistantMsg)

    // (2) one role:"tool" message per call, mapped by function name.
    //     A prefix of READ-ONLY calls runs concurrently (Promise.all) — models
    //     batch reads constantly and N serial FS/network round-trips are pure
    //     latency. From the first mutating/gated/unknown call onward the tail
    //     runs strictly sequentially, preserving any ordering the model implied.
    //     Tool messages are pushed in wireCalls order NO MATTER which call
    //     finishes first — pairing and history shape never depend on
    //     completion order. Gated reads demote themselves to the tail:
    //     approvals are a one-question-at-a-time human UI.
    const run1 = async (call) => {
      const name = call.function.name ?? '(unnamed)'
      const args = normalizeArgs(call.function.arguments)
      let outcome = 'ok'
      let result
      const t0 = Date.now() // v3.1: wall time of the whole step (check → hooks → approval → run)

      const entry = effRegistry[name]
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

      onEvent({ type: 'tool', iteration: iter, name, args, outcome, result, ms: Date.now() - t0 })
      return {
        role: 'tool',
        tool_name: name, // Ollama native pairing key
        tool_call_id: call.id, // OpenAI-compatible pairing key (always set now)
        content: result
      }
    }

    // scan the read-only prefix: first unsafe call (or gated read) splits the batch
    let split = wireCalls.length
    for (let i = 0; i < wireCalls.length; i++) {
      const n = wireCalls[i].function.name
      if (!PARALLEL_SAFE.has(n)) {
        split = i
        break
      }
      if (await needsApproval(n, normalizeArgs(wireCalls[i].function.arguments))) {
        split = i
        break
      }
    }
    if (split > 0) {
      const head = await Promise.all(wireCalls.slice(0, split).map((c) => run1(c)))
      for (const m of head) msgs.push(m)
    }
    for (let i = split; i < wireCalls.length; i++) msgs.push(await run1(wireCalls[i]))
  }
}

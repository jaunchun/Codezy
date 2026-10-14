// ---------------------------------------------------------------------------
// mcp.mjs — Model Context Protocol client for the TUI shells (v3.1).
//
// A faithful JS port of src/main/mcp.ts (the desktop client): stdio transport,
// NDJSON JSON-RPC 2.0 — spawn → initialize → notifications/initialized →
// tools/list, then tools/call per invocation. Sessions are cached per server
// so a chat never pays the spawn+handshake twice; a crashed or reconfigured
// server reconnects on the next use.
//
//   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{…}}
//   ← {"jsonrpc":"2.0","id":1,"result":{…}}
//   → {"jsonrpc":"2.0","method":"notifications/initialized"}
//   → {"jsonrpc":"2.0","id":2,"method":"tools/list"}
//   → {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{name,arguments}}
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import readline from 'node:readline'

/** Handshake + tools/list budget. */
export const MCP_TIMEOUT_MS = 15_000
/** A tool call may legitimately run for a minute (searches, builds). */
export const MCP_CALL_TIMEOUT_MS = 60_000
/** Hard cap so a big server cannot blow the model's context. */
export const MCP_MAX_TOOLS = 40
export const MCP_RESULT_CAP = 16_000

/** Server name + tool name → the flat, namespaced tool the model sees. */
export function mcpToolName(server, tool) {
  const clean = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'x'
  return `mcp__${clean(server)}__${clean(tool)}`
}

/**
 * A tools/call result is a content list: text parts are joined, anything
 * else (images, resource links) is counted so the model knows it exists.
 * An `isError` result still carries its text — flagged, never swallowed.
 */
export function flattenMcpResult(result) {
  const r = result
  const parts = Array.isArray(r?.content) ? r.content : []
  const text = parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
  const other = parts.filter((p) => p?.type !== 'text').length
  const lines = []
  if (r?.isError) lines.push('[the tool reported an error]')
  lines.push(text || '(no text content)')
  if (other) lines.push(`…[${other} non-text part(s) omitted]`)
  const out = lines.join('\n')
  return out.length > MCP_RESULT_CAP ? out.slice(0, MCP_RESULT_CAP) + '\n…[truncated]' : out
}

/** One stdio connection to one MCP server process. */
export class McpConnection {
  constructor(name, cfg) {
    this.name = name
    this.cfg = cfg
    this.tools = []
    this.closed = false
    this.lastError = null
    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.stderrTail = ''
  }

  /** Spawn → initialize → tools/list. Rejects (with stderr context) on any
   *  step; the process is torn down so nothing lingers. */
  start(clientVersion = '3.1') {
    return new Promise((resolve, reject) => {
      let proc
      try {
        proc = spawn(this.cfg.command, this.cfg.args ?? [], {
          env: { ...process.env, ...(this.cfg.env ?? {}) },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (e) {
        reject(new Error(`could not spawn ${this.cfg.command}: ${e?.message ?? e}`))
        return
      }
      this.proc = proc
      const fail = (msg) => {
        this.lastError = msg
        this.close()
        reject(new Error(`${this.name}: ${msg}${this.stderrTail ? ` — stderr: ${this.stderrTail.slice(-300)}` : ''}`))
      }
      // a spawn error (ENOENT etc.) arrives asynchronously
      proc.once('error', (e) => fail(`spawn failed: ${e.message}`))
      proc.stderr?.on('data', (d) => {
        this.stderrTail = (this.stderrTail + String(d)).slice(-2000)
      })
      proc.on('close', (code) => {
        this.closed = true
        this.lastError = this.lastError ?? `server exited (code ${code})`
        // every in-flight request dies with the process
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error(`${this.name}: server exited (code ${code})`))
        }
        this.pending.clear()
      })

      const rl = readline.createInterface({ input: proc.stdout })
      rl.on('line', (line) => this.onLine(line))

      void (async () => {
        try {
          const init = await this.request(
            'initialize',
            {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'CODEZY', version: clientVersion }
            },
            MCP_TIMEOUT_MS
          )
          if (this.closed) throw new Error('server closed during initialize')
          this.notify('notifications/initialized', {})
          const listed = await this.request('tools/list', {}, MCP_TIMEOUT_MS)
          this.tools = (Array.isArray(listed?.tools) ? listed.tools : []).filter(
            (t) => typeof t?.name === 'string' && t.name
          )
          resolve(this.tools)
        } catch (e) {
          fail(`handshake failed: ${e?.message ?? e}`)
        }
      })()
    })
  }

  onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return // chatter on stdout that isn't JSON-RPC — ignore
    }
    if (typeof msg.id !== 'number') return // a server notification — nothing waiting
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(`${this.name}: ${msg.error.message ?? `JSON-RPC error ${msg.error.code}`}`))
    else p.resolve(msg.result)
  }

  /** JSON-RPC request with a hard timeout — a hung server never hangs a chat. */
  request(method, params, timeoutMs) {
    if (this.closed || !this.proc?.stdin) return Promise.reject(new Error(`${this.name}: not connected`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.name}: ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`${this.name}: write failed — ${e?.message ?? e}`))
      }
    })
  }

  notify(method, params) {
    try {
      this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    } catch {
      /* best effort */
    }
  }

  close() {
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`${this.name}: connection closed`))
    }
    this.pending.clear()
    try {
      this.proc?.stdin?.end()
    } catch {
      /* already gone */
    }
    try {
      this.proc?.kill()
    } catch {
      /* already gone */
    }
    this.proc = null
  }
}

// -- session cache -------------------------------------------------------------

const sessions = new Map()
const cfgKey = (cfg) => JSON.stringify([cfg.command, cfg.args ?? [], cfg.env ?? {}])

/** Reuse the live connection for this server, or (re)connect. A crashed or
 *  reconfigured server gets a fresh process. */
export async function mcpGetSession(name, cfg, clientVersion) {
  const key = `${name}\u0000${cfgKey(cfg)}`
  const hit = sessions.get(key)
  if (hit && !hit.conn.closed) return hit.conn
  hit?.conn.close()
  sessions.delete(key)
  const conn = new McpConnection(name, cfg)
  await conn.start(clientVersion)
  sessions.set(key, { cfgKey: cfgKey(cfg), conn })
  return conn
}

/** Drop one server's session. */
export function mcpDropSession(name) {
  for (const [k, s] of sessions) {
    if (s.conn.name === name) {
      s.conn.close()
      sessions.delete(k)
    }
  }
}

/** Tear every connection down (TUI exit) — children must never linger. */
export function mcpDisconnectAll() {
  for (const s of sessions.values()) s.conn.close()
  sessions.clear()
}

/** Live tool count per enabled server — used by `/mcp`. */
export function mcpConnectedServers() {
  return [...sessions.values()].map((s) => ({ name: s.conn.name, tools: s.conn.tools.length, closed: s.conn.closed }))
}

// -- registry bundle ------------------------------------------------------------

/**
 * Connect every enabled server and turn their tools into harness registry
 * entries + JSON tool schemas, namespaced as mcp__<server>__<tool>. One bad
 * server becomes a `failures` row — it never takes the whole bundle down.
 */
export async function mcpRegistryTools(servers, clientVersion) {
  const entries = {}
  const schemas = []
  const failures = []
  let total = 0
  for (const s of servers) {
    if (!s?.name || !s.command || s.enabled === false) continue
    if (total >= MCP_MAX_TOOLS) break
    try {
      const conn = await mcpGetSession(s.name, s, clientVersion)
      for (const t of conn.tools) {
        if (total >= MCP_MAX_TOOLS) break
        const full = mcpToolName(s.name, t.name)
        if (entries[full]) continue
        entries[full] = {
          check: (a) => (a && typeof a === 'object' ? null : 'arguments must be an object'),
          run: async (a) => {
            try {
              const res = await conn.request('tools/call', { name: t.name, arguments: a ?? {} }, MCP_CALL_TIMEOUT_MS)
              return flattenMcpResult(res)
            } catch (e) {
              return `ERROR: MCP tool ${full} failed: ${e?.message ?? e}`
            }
          }
        }
        schemas.push({
          type: 'function',
          function: {
            name: full,
            description: t.description?.trim() || `MCP tool "${t.name}" from server "${s.name}"`,
            parameters:
              t.inputSchema && typeof t.inputSchema === 'object'
                ? t.inputSchema
                : { type: 'object', properties: {} }
          }
        })
        total++
      }
    } catch (e) {
      failures.push({ server: s.name, error: e?.message ?? String(e) })
    }
  }
  return { entries, schemas, failures, total }
}

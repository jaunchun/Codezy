// ---------------------------------------------------------------------------
// mcp.ts — Model Context Protocol client (stdio transport, NDJSON JSON-RPC).
//
// An MCP server is an external process the user configured in Settings; it
// announces tools (name + JSON schema) and accepts tool calls over stdin/
// stdout as newline-delimited JSON-RPC 2.0 messages:
//   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{…}}
//   ← {"jsonrpc":"2.0","id":1,"result":{…}}
//   → {"jsonrpc":"2.0","method":"notifications/initialized"}
//   → {"jsonrpc":"2.0","id":2,"method":"tools/list"}
//   → {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{name,arguments}}
//
// Sessions are cached per server (keyed by command/args/env) so a chat never
// pays the spawn+handshake twice; a crashed or reconfigured server reconnects
// on the next use. Everything is confined to the main process — the renderer
// only ever sees tool NAMES and results through the agent loop.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import type { McpServerConfig } from '../shared/types'

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface McpRegistryEntry {
  check?: (args: Record<string, unknown>) => string | null
  run: (args: Record<string, unknown>) => Promise<string>
}

export interface McpRegistryBundle {
  entries: Record<string, McpRegistryEntry>
  schemas: McpSchema[]
  failures: { server: string; error: string }[]
  total: number
}

/** Handshake + tools/list budget. */
export const MCP_TIMEOUT_MS = 15_000
/** A tool call may legitimately run for a minute (searches, builds). */
export const MCP_CALL_TIMEOUT_MS = 60_000
/** Hard cap so a big server cannot blow the model's context. */
export const MCP_MAX_TOOLS = 40
export const MCP_RESULT_CAP = 16_000

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** Server name + tool name → the flat, namespaced tool the model sees. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'x'
  return `mcp__${clean(server)}__${clean(tool)}`
}

/**
 * A tools/call result is a content list: text parts are joined, anything
 * else (images, resource links) is counted so the model knows it exists.
 * An `isError` result still carries its text — flagged, never swallowed.
 */
export function flattenMcpResult(result: unknown): string {
  const r = result as { content?: { type?: string; text?: string }[]; isError?: boolean } | null
  const parts = Array.isArray(r?.content) ? r.content : []
  const text = parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
  const other = parts.filter((p) => p?.type !== 'text').length
  const lines: string[] = []
  if (r?.isError) lines.push('[the tool reported an error]')
  lines.push(text || '(no text content)')
  if (other) lines.push(`…[${other} non-text part(s) omitted]`)
  const out = lines.join('\n')
  return out.length > MCP_RESULT_CAP ? out.slice(0, MCP_RESULT_CAP) + '\n…[truncated]' : out
}

/** One stdio connection to one MCP server process. */
export class McpConnection {
  readonly name: string
  readonly cfg: McpServerConfig
  tools: McpToolInfo[] = []
  closed = false
  lastError: string | null = null
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private stderrTail = ''

  constructor(name: string, cfg: McpServerConfig) {
    this.name = name
    this.cfg = cfg
  }

  /** Spawn → initialize → tools/list. Rejects (with stderr context) on any
   *  step; the process is torn down so nothing lingers. */
  start(clientVersion = '3.0'): Promise<McpToolInfo[]> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams
      try {
        proc = spawn(this.cfg.command, this.cfg.args ?? [], {
          env: { ...process.env, ...(this.cfg.env ?? {}) },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (e) {
        reject(new Error(`could not spawn ${this.cfg.command}: ${(e as Error)?.message ?? e}`))
        return
      }
      this.proc = proc
      const fail = (msg: string): void => {
        this.lastError = msg
        this.close()
        reject(new Error(`${this.name}: ${msg}${this.stderrTail ? ` — stderr: ${this.stderrTail.slice(-300)}` : ''}`))
      }
      // a spawn error (ENOENT etc.) arrives asynchronously
      proc.once('error', (e) => fail(`spawn failed: ${e.message}`))
      proc.stderr?.on('data', (d: Buffer) => {
        this.stderrTail = (this.stderrTail + String(d)).slice(-2000)
      })
      proc.on('close', (code) => {
        this.closed = this.closed || true
        this.lastError = this.lastError ?? `server exited (code ${code})`
        // every in-flight request dies with the process
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error(`${this.name}: server exited (code ${code})`))
        }
        this.pending.clear()
      })

      const rl = readline.createInterface({ input: proc.stdout! })
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
          const listed = (await this.request('tools/list', {}, MCP_TIMEOUT_MS)) as { tools?: McpToolInfo[] }
          this.tools = (Array.isArray(listed?.tools) ? listed.tools : []).filter(
            (t) => typeof t?.name === 'string' && t.name
          )
          resolve(this.tools)
        } catch (e) {
          fail(`handshake failed: ${(e as Error)?.message ?? e}`)
        }
      })()
    })
  }

  private onLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string; code?: number } }
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
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed || !this.proc?.stdin) return Promise.reject(new Error(`${this.name}: not connected`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.name}: ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.proc!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`${this.name}: write failed — ${(e as Error)?.message ?? e}`))
      }
    })
  }

  private notify(method: string, params: unknown): void {
    try {
      this.proc?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    } catch { /* best effort */ }
  }

  close(): void {
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`${this.name}: connection closed`))
    }
    this.pending.clear()
    try {
      this.proc?.stdin?.end()
    } catch { /* already gone */ }
    try {
      this.proc?.kill()
    } catch { /* already gone */ }
    this.proc = null
  }
}

// -- session cache -------------------------------------------------------------

const sessions = new Map<string, { cfgKey: string; conn: McpConnection }>()
const cfgKey = (cfg: McpServerConfig): string => JSON.stringify([cfg.command, cfg.args ?? [], cfg.env ?? {}])

/** Reuse the live connection for this server, or (re)connect. A crashed or
 *  reconfigured server gets a fresh process. */
export async function mcpGetSession(name: string, cfg: McpServerConfig, clientVersion?: string): Promise<McpConnection> {
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

/** Drop one server's session (called when its config is saved or removed). */
export function mcpDropSession(name: string): void {
  for (const [k, s] of sessions) {
    if (s.conn.name === name) {
      s.conn.close()
      sessions.delete(k)
    }
  }
}

/** Tear every connection down (app quit). */
export function mcpDisconnectAll(): void {
  for (const s of sessions.values()) s.conn.close()
  sessions.clear()
}

/** Live tool count per enabled server — used by the settings status line. */
export function mcpConnectedServers(): { name: string; tools: number; closed: boolean }[] {
  return [...sessions.values()].map((s) => ({ name: s.conn.name, tools: s.conn.tools.length, closed: s.conn.closed }))
}

// -- registry bundle ------------------------------------------------------------

/**
 * Connect every enabled server and turn their tools into harness registry
 * entries + JSON tool schemas, namespaced as mcp__<server>__<tool>. One bad
 * server becomes a `failures` row — it never takes the whole bundle down.
 */
export async function mcpRegistryTools(
  servers: McpServerConfig[],
  clientVersion?: string
): Promise<McpRegistryBundle> {
  const entries: Record<string, McpRegistryEntry> = {}
  const schemas: McpSchema[] = []
  const failures: { server: string; error: string }[] = []
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
              return `ERROR: MCP tool ${full} failed: ${(e as Error)?.message ?? e}`
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
                ? (t.inputSchema as Record<string, unknown>)
                : { type: 'object', properties: {} }
          }
        })
        total++
      }
    } catch (e) {
      failures.push({ server: s.name, error: (e as Error)?.message ?? String(e) })
    }
  }
  return { entries, schemas, failures, total }
}

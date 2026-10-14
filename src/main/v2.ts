// ---------------------------------------------------------------------------
// v2.ts — the Electron shell around the shared agent harness.
//
// ONE core, two shells: every line of loop / tools / safety / approval-gate
// logic lives in cli/lib/harness.mjs (shared with `node cli/codezy-v2.mjs`).
// This file only injects the desktop-specific pieces:
//   - emit  → chat:event streams (v2tool activity lines, done/aborted/error)
//   - ask   → the renderer's confirm dialog (approve returns a promise the
//             main process resolves when the user clicks Approve/Deny)
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'
import type { ChatMessage, Session, Settings } from '../shared/types'
import type { TaskInfo } from '../shared/api'
import { runAgent, makeRegistry, loadHooks, ollamaCall, openaiCall, TOOLS, MUTATING_TOOLS } from '../../cli/lib/harness.mjs'
import type { V2Message } from '../../cli/lib/harness.mjs'
import { mcpRegistryTools, type McpSchema } from './mcp'

/** Effort presets, same temperatures the v1 engine uses. */
const TEMPERATURES: Record<string, number> = { light: 0.9, medium: 0.6, deep: 0.2 }

/** One cached workspace: its registry (todos + background tasks) and its LRU
 *  stamp. `roots` is kept raw — it namespaces task ids (every registry counts
 *  from #1) and labels rows in the tasks panel. */
interface RegEntry {
  key: string
  roots: string[]
  registry: ReturnType<typeof makeRegistry>
  used: number
}

/** Registry cache per workspace — keeps todo_write state AND live background
 *  tasks between runs. An LRU of REG_CACHE_MAX workspaces instead of one
 *  entry: chats in different folders each keep their task list, and evicting
 *  the least-recently-used workspace kills its leftover processes first, so
 *  no child is ever orphaned. */
const REG_CACHE_MAX = 4
let regCache: RegEntry[] = []
let regClock = 0

/** Tree-kill for a background child — mirrors the harness's own killTask:
 *  on Windows taskkill /T /F takes the whole process group down, which is
 *  what actually fires the child's 'close' event. */
function killProc(t: {
  running: boolean
  proc?: { pid?: number; kill: (signal?: unknown) => unknown } | null
}): void {
  if (!t.running || !t.proc?.pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(t.proc.pid), '/T', '/F'], { windowsHide: true })
    } else t.proc.kill('SIGTERM')
  } catch { /* already gone */ }
  try { t.proc.kill() } catch { /* already gone */ }
}

/** Find-or-create the cached registry for a workspace key (LRU bump on hit).
 *  Evicted workspaces get their running tasks killed before the entry drops. */
function cachedRegistry(
  key: string,
  roots: string[],
  make: () => ReturnType<typeof makeRegistry>
): ReturnType<typeof makeRegistry> {
  const hit = regCache.find((e) => e.key === key)
  if (hit) {
    hit.used = ++regClock
    return hit.registry
  }
  const entry: RegEntry = { key, roots, registry: make(), used: ++regClock }
  regCache.push(entry)
  while (regCache.length > REG_CACHE_MAX) {
    let evictAt = 0
    for (let i = 1; i < regCache.length; i++) if (regCache[i].used < regCache[evictAt].used) evictAt = i
    const victim = regCache.splice(evictAt, 1)[0]
    const tasks = victim.registry.task_status?.state?.tasks
    if (tasks) for (const t of tasks.values()) killProc(t)
  }
  return entry.registry
}

/** Output tail cap for the panel — the full capture stays in the registry. */
const TASK_OUT_TAIL = 6000

/** Every background task across the cached workspaces — the tasks panel's
 *  list. `uid` namespaces the per-registry ids by workspace root. */
export function listV2Tasks(): TaskInfo[] {
  const rows: TaskInfo[] = []
  for (const entry of regCache) {
    const tasks = entry.registry.task_status?.state?.tasks
    if (!tasks) continue
    const workspace = entry.roots[0] ?? ''
    for (const t of tasks.values()) {
      rows.push({
        uid: `${workspace}:${t.id}`,
        id: t.id,
        command: t.command,
        running: t.running,
        code: t.code,
        out: t.out.length > TASK_OUT_TAIL ? t.out.slice(-TASK_OUT_TAIL) : t.out,
        outTotal: t.out.length,
        started: t.started ?? 0,
        workspace
      })
    }
  }
  // running first, then newest — the kill button always finds its target
  return rows.sort((a, b) => Number(b.running) - Number(a.running) || b.id - a.id)
}

/** Kills ONE background task by uid across every cached workspace. */
export function stopV2Task(uid: string): boolean {
  for (const entry of regCache) {
    const tasks = entry.registry.task_status?.state?.tasks
    if (!tasks) continue
    const workspace = entry.roots[0] ?? ''
    for (const t of tasks.values()) {
      if (`${workspace}:${t.id}` === uid) {
        killProc(t)
        return true
      }
    }
  }
  return false
}

export interface V2RunResult {
  reply: string
  iterations: number
  stats: { promptTokens?: number; completionTokens?: number }
}

/** Agent mode only means something over a linked folder — that's the code-mode
 *  workspace. With none linked the chat simply runs on the normal engine. */
export function v2Active(session: Session, settings: Settings): boolean {
  return !!settings.v2 && (session.linkedFolders?.length ?? 0) > 0
}

export async function runV2(opts: {
  session: Session
  settings: Settings
  /** Prebuilt by buildMessages: system prompt, goal/btw notes, history, attachments. */
  messages: ChatMessage[]
  signal: AbortSignal
  /** Streams a ChatEvent-shaped payload to the renderer. */
  emit: (event: Record<string, unknown>) => void
  /** Opens the renderer's confirm dialog; resolves true only on Approve. */
  ask: (name: string, args: Record<string, unknown>) => Promise<boolean>
}): Promise<V2RunResult> {
  const { session, settings, messages, signal, emit, ask } = opts

  const roots = session.linkedFolders ?? []
  if (!roots.length) {
    throw new Error('Agent mode (v2) needs a linked folder — use the folder button in the composer first.')
  }

  // Registry cached per workspace — todo_write state and background tasks
  // survive across runs (LRU — flipping plan↔build or editing MCP config
  // builds a second registry without killing the first one's tasks).
  const allowMutations = (settings.mode ?? 'build') !== 'plan'
  const mcpKey = JSON.stringify(settings.mcpServers ?? [])
  const key = `${roots.join('\n')}|${allowMutations ? 'rw' : 'ro'}|${mcpKey}`
  const registry = cachedRegistry(key, roots, () => makeRegistry({ roots, allowMutations }))

  // v3 MCP: connect the configured servers and graft their tools onto the
  // registry as mcp__<server>__<tool>. NEVER in plan mode (servers can change
  // the world), and a broken server degrades to a chat event — it must not
  // take the whole run down.
  let mcpSchemas: McpSchema[] = []
  if (allowMutations && settings.mcpServers?.some((s) => s && s.command && s.enabled !== false)) {
    try {
      const bundle = await mcpRegistryTools(settings.mcpServers)
      if (bundle.total) {
        Object.assign(registry, bundle.entries)
        mcpSchemas = bundle.schemas
      }
      for (const f of bundle.failures) {
        emit({ type: 'v2tool', iteration: 0, name: `mcp:${f.server}`, args: {}, outcome: 'error', result: f.error })
      }
    } catch { /* MCP is optional — never block a chat on it */ }
  }

  const effort = session.effort ?? settings.effort
  const temperature = TEMPERATURES[effort] ?? 0.6
  // v3: longer chains for deeper thinking — the cap is a real budget now
  // (5–40), and plan mode needs fewer steps because nothing gets executed.
  const maxIter = allowMutations ? ({ light: 8, medium: 15, deep: 30 }[effort] ?? 15) : 8
  let prompt = 0
  let completion = 0

  // model target: a cloud provider (Nebius Token Factory & friends) when one
  // is active, otherwise local Ollama — same rule v1 chat uses (targetFor).
  const model = session.model ?? settings.activeModel
  const providerId = session.provider ?? settings.activeProvider
  const provider = providerId !== 'ollama' ? settings.providers.find((p) => p.id === providerId) : null
  if (providerId !== 'ollama' && !provider) throw new Error(`Provider "${providerId}" is not configured`)

  const result = await runAgent({
    // ChatMessage carries extra fields (id, ts, files) — fine for the wire;
    // the cast only bridges TypeScript's interface/index-signature quirk
    messages: messages as unknown as V2Message[],
    registry,
    signal,
    // v3 plan mode is enforced twice: the registry refuses mutating tools
    // AND the schema hides them — a model that cannot see write_file /
    // edit_file / run_command never even tries. MCP tools join the schema
    // only when they were merged above (never in plan mode).
    tools: allowMutations
      ? (mcpSchemas.length ? [...TOOLS, ...mcpSchemas] : undefined)
      : TOOLS.filter((t: { function?: { name?: string } }) => !MUTATING_TOOLS.has(t.function?.name ?? '')),
    maxIter,
    callModel: async ({ messages: msgs, tools, signal: sig }) => {
      const res = provider
        ? await openaiCall({
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model,
            messages: msgs,
            tools,
            signal: sig,
            temperature
          })
        : await ollamaCall({
            baseUrl: settings.ollamaUrl,
            model,
            messages: msgs,
            tools,
            signal: sig,
            // the override that makes local tool calling work at all
            numCtx: 65536,
            temperature
          })
      prompt += res.stats.promptTokens ?? 0
      completion += res.stats.completionTokens ?? 0
      return res
    },
    approve: async (name, args) => {
      if (signal.aborted) return false
      return ask(name, args)
    },
    onEvent: (ev) => {
      if (ev.type === 'tool') {
        emit({
          type: 'v2tool',
          iteration: ev.iteration ?? 0,
          name: ev.name ?? '?',
          args: ev.args ?? {},
          outcome: ev.outcome ?? 'ok',
          // v3.1 visibility: how long the step took + how big the result was
          ...(typeof ev.ms === 'number' ? { ms: ev.ms } : {}),
          ...(typeof ev.result === 'string' && ev.result ? { size: ev.result.length } : {})
        })
      }
    },
    hooks: loadHooks(roots)
  })

  const reply =
    result.text ||
    (result.status === 'limit'
      ? `*(agent mode stopped after ${result.iterations} tool steps — the hard iteration cap.)*`
      : '')

  return {
    reply,
    iterations: result.iterations,
    stats: { promptTokens: prompt, completionTokens: completion }
  }
}

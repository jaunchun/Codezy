// ---------------------------------------------------------------------------
// harness.d.mts — TypeScript declarations for cli/lib/harness.mjs.
// The Electron main process imports the SAME core file the terminal shell
// uses (one core, two shells) — this file is what lets `tsc` see its API.
// ---------------------------------------------------------------------------

export type V2Outcome = 'ok' | 'denied' | 'rejected' | 'unknown' | 'error' | 'blocked'

export interface V2ToolCall {
  id?: string
  name?: string
  arguments?: unknown
  function?: { name?: string; arguments?: unknown }
}

export interface V2Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: V2ToolCall[]
  tool_name?: string
  tool_call_id?: string
  [key: string]: unknown
}

export interface V2Event {
  type: 'tool' | 'end'
  iteration?: number
  name?: string
  args?: Record<string, unknown>
  outcome?: V2Outcome
  result?: string
  status?: 'text' | 'limit'
  text?: string
  iterations?: number
}

export interface V2Todo {
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

export interface V2RegistryEntry {
  check?: (args: Record<string, unknown>) => string | null
  run: (args: Record<string, unknown>) => Promise<string>
  /** todo_write only — the live checklist for the current registry. */
  state?: { todos: V2Todo[] }
}

export type V2Registry = Record<string, V2RegistryEntry>

export const DEFAULT_NUM_CTX: number
export const DEFAULT_TEMPERATURE: number
export const DEFAULT_MAX_ITER: number
export const DANGEROUS_TOOLS: ReadonlySet<string>
export const TOOLS: unknown[]

export interface OllamaCallOptions {
  baseUrl?: string
  model: string
  messages: V2Message[]
  tools?: unknown[]
  signal?: AbortSignal
  numCtx?: number
  temperature?: number
  fetchImpl?: typeof fetch
}

export interface OllamaCallResult {
  content: string
  tool_calls: V2ToolCall[]
  stats: { promptTokens?: number; completionTokens?: number }
}

export function ollamaCall(o: OllamaCallOptions): Promise<OllamaCallResult>

// -- OpenAI-compatible endpoints (Nebius Token Factory, OpenRouter, …) --------

/** Base URL → chat-completions endpoint (origin-only URLs gain "/v1"). */
export function chatCompletionsUrl(baseUrl: string): string

export interface OpenAICallOptions {
  baseUrl: string
  apiKey?: string
  model: string
  messages: V2Message[]
  tools?: unknown[]
  signal?: AbortSignal
  temperature?: number
  fetchImpl?: typeof fetch
}

/** Same result shape as ollamaCall — runAgent accepts either call. */
export function openaiCall(o: OpenAICallOptions): Promise<OllamaCallResult>

/** Resolves a model-provided path against the allowed roots, or throws. */
export function resolveInRoots(roots: string[], raw: unknown): string

export function makeRegistry(opts: { roots: string[]; cwd?: string; execTimeoutMs?: number }): V2Registry

/** One hook entry: shell command, optional tool filter (default: every tool). */
export interface V2Hook {
  tools?: string[]
  command: string
  timeout_ms?: number
}

/** Loaded hook config — `.codezy/hooks.json`, workspace first, else home. */
export interface V2Hooks {
  file: string
  cwd: string
  before_tool: V2Hook[]
  after_tool: V2Hook[]
}

/** Reads the hook config for a run; null when there is none. */
export function loadHooks(roots: string[]): V2Hooks | null

export interface RunAgentOptions {
  messages: V2Message[]
  tools?: unknown[]
  registry: V2Registry
  callModel: (o: {
    messages: V2Message[]
    tools?: unknown[]
    signal?: AbortSignal
  }) => Promise<{ content?: string; tool_calls?: V2ToolCall[]; message?: { tool_calls?: V2ToolCall[] } }>
  approve?: (name: string, args: Record<string, unknown>) => Promise<boolean> | boolean
  needsApproval?: (name: string, args: Record<string, unknown>) => boolean
  maxIter?: number
  toolResultCap?: number
  onEvent?: (e: V2Event) => void
  /** before_tool failures BLOCK the action; after_tool failures are appended to the tool result. */
  hooks?: V2Hooks | null
  signal?: AbortSignal
}

export interface RunAgentResult {
  status: 'text' | 'limit'
  text: string
  messages: V2Message[]
  iterations: number
}

export function runAgent(o: RunAgentOptions): Promise<RunAgentResult>

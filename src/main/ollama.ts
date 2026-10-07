// ---------------------------------------------------------------------------
// ollama.ts — the model engine layer.
// CODEZY's renderer NEVER talks to a model directly. Everything goes through
// this file in the main process: it pings Ollama, lists models, and streams
// chat tokens from either Ollama or any OpenAI-compatible API.
// ---------------------------------------------------------------------------

import type { ChatMessage, ProviderConfig } from '../shared/types'

export interface ModelEntry {
  id: string
  provider: string // 'ollama' or a provider id from settings
  providerName: string
}

export interface ChatTarget {
  kind: 'ollama' | 'openai'
  baseUrl: string
  apiKey?: string
  model: string
  effort: 'light' | 'medium' | 'deep'
}

/**
 * Local models run at the FULL window — CODEZY imposes no token limit on a
 * local Ollama run (the v2 agent loop already uses this same size). Effort
 * only controls sampling temperature + reply length.
 */
export const LOCAL_NUM_CTX = 65536

/** Sampling presets — this is the "effort" control from the sketch. */
const EFFORT = {
  light: { temperature: 0.9, num_ctx: LOCAL_NUM_CTX, num_predict: 1024 },
  medium: { temperature: 0.6, num_ctx: LOCAL_NUM_CTX, num_predict: 2048 },
  deep: { temperature: 0.2, num_ctx: LOCAL_NUM_CTX, num_predict: 4096 }
} as const

// -- health + model listing --------------------------------------------------

/** Returns {ok:false} when Ollama isn't running — UI shows a red status dot. */
export async function pingOllama(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(2500)
    })
    return res.ok
  } catch {
    return false
  }
}

export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  return (await listOllamaModelDetails(baseUrl)).map((m) => m.id)
}

/** Rich version for the model picker: size, quantization, family, params. */
export async function listOllamaModelDetails(
  baseUrl: string
): Promise<{ id: string; size?: number; quant?: string; family?: string; parameter?: string }[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`)
    if (!res.ok) return []
    const data = (await res.json()) as {
      models?: {
        name: string
        size?: number
        details?: { quantization_level?: string; family?: string; parameter_size?: string }
      }[]
    }
    return (data.models ?? []).map((m) => ({
      id: m.name,
      size: m.size,
      quant: m.details?.quantization_level,
      family: m.details?.family,
      parameter: m.details?.parameter_size
    }))
  } catch {
    return []
  }
}

/** Best-effort model list for the OpenAI-style picker: the saved provider
 *  config plus a GET /models when the endpoint supports it. */
export async function listOpenAIModels(provider: ProviderConfig): Promise<string[]> {
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
      signal: AbortSignal.timeout(4000)
    })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: { id: string }[] }
    return (data.data ?? []).map((m) => m.id)
  } catch {
    return []
  }
}

// -- streaming chat ----------------------------------------------------------

export interface StreamOptions {
  signal: AbortSignal
  onDelta: (text: string) => void
}

/** Real token counts, when the engine reports them (Ollama always does). */
export interface StreamStats {
  promptTokens?: number
  completionTokens?: number
}

/** The (uncapped) context window every effort runs at — kept as a function so
 *  callers stay effort-agnostic if presets ever diverge again. */
export function contextSizeFor(_effort: 'light' | 'medium' | 'deep'): number {
  return LOCAL_NUM_CTX
}

/**
 * Streams a chat completion from either engine.
 * `messages` must already be fully built by prompt.ts (system prompt,
 * memory, project context, skill, goal, history) — this file only ships it.
 */
export async function streamChat(target: ChatTarget, messages: ChatMessage[], opts: StreamOptions): Promise<StreamStats> {
  const base = target.baseUrl.replace(/\/$/, '')
  return target.kind === 'ollama'
    ? streamOllama(base, target, messages, opts)
    : streamOpenAI(base, target, messages, opts)
}

async function streamOllama(base: string, target: ChatTarget, messages: ChatMessage[], opts: StreamOptions): Promise<StreamStats> {
  const preset = EFFORT[target.effort]
  const stats: StreamStats = {}
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: target.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      options: {
        temperature: preset.temperature,
        num_ctx: preset.num_ctx,
        num_predict: preset.num_predict
      }
    })
  })
  if (!res.ok || !res.body) throw new Error(`Ollama error ${res.status}: ${await res.text().catch(() => '')}`)

  // Ollama streams newline-delimited JSON: {"message":{"content":"…"},"done":false}
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // keep the possibly-incomplete last line
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const json = JSON.parse(line)
        if (json.message?.content) opts.onDelta(json.message.content)
        if (json.done) {
          stats.promptTokens = json.prompt_eval_count
          stats.completionTokens = json.eval_count
        }
        if (json.error) throw new Error(json.error)
      } catch (e) {
        if (e instanceof SyntaxError) continue // partial line, wait for more
        throw e
      }
    }
  }
  return stats
}

async function streamOpenAI(base: string, target: ChatTarget, messages: ChatMessage[], opts: StreamOptions): Promise<StreamStats> {
  const preset = EFFORT[target.effort]
  const stats: StreamStats = {}
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: target.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      temperature: preset.temperature
    })
  })
  if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text().catch(() => '')}`)

  // SSE format: lines like `data: {...}` terminated by `data: [DONE]`
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return stats
      try {
        const json = JSON.parse(payload)
        const delta: string | undefined = json.choices?.[0]?.delta?.content
        if (delta) opts.onDelta(delta)
        if (json.usage) {
          stats.promptTokens = json.usage.prompt_tokens
          stats.completionTokens = json.usage.completion_tokens
        }
      } catch {
        /* partial JSON across chunks — wait for more data */
      }
    }
  }
  return stats
}

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
/**
 * Ollama wire shape — `images` carries RAW base64 (Ollama infers the format
 * from the bytes), so the data-URL prefix from expandMessage is stripped.
 */
export function ollamaWireMessages(messages: ChatMessage[]): { role: string; content: string; images?: string[] }[] {
  return messages.map((m) => {
    const images = m.images?.length ? m.images.map((u) => u.replace(/^data:[^;,]+;base64,/, '')) : undefined
    return { role: m.role, content: m.content, ...(images?.length ? { images } : {}) }
  })
}

/**
 * OpenAI wire shape — images become content parts: the text stays first and
 * each image is a `image_url` part with the full data URL. Plain messages
 * keep the simple string form (some endpoints reject parts without images).
 */
export function openaiWireMessages(messages: ChatMessage[]): { role: string; content: unknown }[] {
  return messages.map((m) => {
    if (!m.images?.length) return { role: m.role, content: m.content }
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.content },
        ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))
      ]
    }
  })
}

export async function streamChat(target: ChatTarget, messages: ChatMessage[], opts: StreamOptions): Promise<StreamStats> {
  const base = target.baseUrl.replace(/\/$/, '')
  return target.kind === 'ollama'
    ? streamOllama(base, target, messages, opts)
    : streamOpenAI(base, target, messages, opts)
}

async function streamOllama(base: string, target: ChatTarget, messages: ChatMessage[], opts: StreamOptions): Promise<StreamStats> {
  const preset = EFFORT[target.effort]
  let deltas = 0
  const counted: StreamOptions = {
    signal: opts.signal,
    onDelta: (t) => {
      deltas++
      opts.onDelta(t)
    }
  }

  const once = async (): Promise<StreamStats> => {
    const stats: StreamStats = {}
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      signal: opts.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: target.model,
        messages: ollamaWireMessages(messages),
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
    const processLine = (line: string): void => {
      if (!line.trim()) return
      try {
        const json = JSON.parse(line)
        if (json.message?.content) counted.onDelta(json.message.content)
        if (json.done) {
          stats.promptTokens = json.prompt_eval_count
          stats.completionTokens = json.eval_count
        }
        if (json.error) throw new Error(json.error)
      } catch (e) {
        if (e instanceof SyntaxError) return // partial line, wait for more
        throw e
      }
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // keep the possibly-incomplete last line
      for (const line of lines) processLine(line)
    }
    // flush: a server that closes without a trailing newline would otherwise
    // lose its final line — often {"done":true,…} carrying the token counts
    buffer += decoder.decode()
    if (buffer.trim()) processLine(buffer)
    return stats
  }

  try {
    return await once()
  } catch (e) {
    // Ollama often resets the connection while the model is still loading —
    // one quiet retry, but ONLY when nothing has streamed yet (never duplicate
    // visible text) and the failure wasn't an HTTP error or an abort.
    const httpErr = e instanceof Error && /^Ollama error \d/.test(e.message)
    const aborted = opts.signal.aborted || (e instanceof Error && e.name === 'AbortError')
    if (deltas > 0 || httpErr || aborted) throw e
    await new Promise((r) => setTimeout(r, 700))
    return once()
  }
}

async function streamOpenAI(base: string, target: ChatTarget, messages: ChatMessage[], opts: StreamOptions): Promise<StreamStats> {
  const preset = EFFORT[target.effort]
  let deltas = 0
  const counted: StreamOptions = {
    signal: opts.signal,
    onDelta: (t) => {
      deltas++
      opts.onDelta(t)
    }
  }

  const once = async (): Promise<StreamStats> => {
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
        messages: openaiWireMessages(messages),
        stream: true,
        temperature: preset.temperature
      })
    })
    if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text().catch(() => '')}`)

    // SSE format: lines like `data: {...}` terminated by `data: [DONE]`
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finished = false
    const processLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') {
        finished = true
        return
      }
      try {
        const json = JSON.parse(payload)
        const delta: string | undefined = json.choices?.[0]?.delta?.content
        if (delta) counted.onDelta(delta)
        if (json.usage) {
          stats.promptTokens = json.usage.prompt_tokens
          stats.completionTokens = json.usage.completion_tokens
        }
      } catch {
        /* partial JSON across chunks — wait for more data */
      }
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        processLine(line)
        if (finished) return stats
      }
    }
    // flush: a final unterminated `data:` line (usage stats) is not lost
    buffer += decoder.decode()
    if (buffer.trim()) processLine(buffer)
    return stats
  }

  try {
    return await once()
  } catch (e) {
    // transient connect/reset before any visible output → one quiet retry
    const httpErr = e instanceof Error && /^API error \d/.test(e.message)
    const aborted = opts.signal.aborted || (e instanceof Error && e.name === 'AbortError')
    if (deltas > 0 || httpErr || aborted) throw e
    await new Promise((r) => setTimeout(r, 700))
    return once()
  }
}

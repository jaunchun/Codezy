// ---------------------------------------------------------------------------
// engine.mjs — model engine layer for the terminal (port of src/main/ollama.ts).
// Ollama or any OpenAI-compatible endpoint, effort presets (sampling + context
// size), model listing, and one streaming function both engines share.
// Plain Node, no dependencies.
// ---------------------------------------------------------------------------

/** Sampling presets — the app's "effort" control.
 *  Local models run at the FULL window (no artificial token limit);
 *  effort only changes temperature + reply length. */
export const EFFORTS = {
  light: { temperature: 0.9, num_ctx: 65536, num_predict: 1024 },
  medium: { temperature: 0.6, num_ctx: 65536, num_predict: 2048 },
  deep: { temperature: 0.2, num_ctx: 65536, num_predict: 4096 }
}

export const isEffort = (v) => Object.hasOwn(EFFORTS, v)

/** Context window — uncapped local default; used by trimming and the ctx indicator. */
export const contextSizeFor = (effort) => (EFFORTS[effort] ?? EFFORTS.medium).num_ctx

export async function pingOllama(baseUrl) {
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(2500)
    })
    return res.ok
  } catch {
    return false
  }
}

/** Ollama model list with size/quant details for the model picker. */
export async function listOllamaModels(baseUrl) {
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(4000)
    })
    if (!res.ok) return []
    const data = await res.json()
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

/** Best-effort model list for an OpenAI-compatible provider. */
export async function listOpenAIModels(provider) {
  try {
    const res = await fetch(`${String(provider.baseUrl).replace(/\/$/, '')}/models`, {
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
      signal: AbortSignal.timeout(4000)
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.data ?? []).map((m) => m.id)
  } catch {
    return []
  }
}

// -- streaming ---------------------------------------------------------------

/**
 * Streams a chat completion from either engine.
 * @param target {{kind:'ollama'|'openai', baseUrl:string, apiKey?:string, model:string, effort:string}}
 * @param messages {{role:string, content:string}[]}
 * @param opts {{signal?:AbortSignal, onDelta:(t:string)=>void}}
 * @returns {Promise<{promptTokens?:number, completionTokens?:number}>}
 */
export async function streamChat(target, messages, opts) {
  const base = String(target.baseUrl).replace(/\/$/, '')
  return target.kind === 'ollama'
    ? streamOllama(base, target, messages, opts)
    : streamOpenAI(base, target, messages, opts)
}

async function streamOllama(base, target, messages, opts) {
  const preset = EFFORTS[target.effort] ?? EFFORTS.medium
  const stats = {}
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: target.model,
      messages,
      stream: true,
      options: {
        temperature: preset.temperature,
        num_ctx: preset.num_ctx,
        num_predict: preset.num_predict
      }
    })
  })
  if (!res.ok || !res.body) throw new Error(`Ollama error ${res.status}: ${await res.text().catch(() => '')}`)

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
      if (!line.trim()) continue
      try {
        const json = JSON.parse(line)
        if (json.error) throw new Error(json.error)
        if (json.message?.content) opts.onDelta(json.message.content)
        if (json.done) {
          stats.promptTokens = json.prompt_eval_count
          stats.completionTokens = json.eval_count
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue // partial line
        throw e
      }
    }
  }
  return stats
}

/** Ollama-style `images: [b64]` on a message → OpenAI content parts.
 *  Mime sniffed from magic bytes (buildMessages only has base64 here). */
function sniffMime(b64) {
  try {
    const h = Buffer.from(String(b64).slice(0, 16), 'base64')
    if (h[0] === 0x89 && h[1] === 0x50) return 'image/png'
    if (h[0] === 0xff && h[1] === 0xd8) return 'image/jpeg'
    if (h[0] === 0x47 && h[1] === 0x49) return 'image/gif'
    if (h[0] === 0x42 && h[1] === 0x4d) return 'image/bmp'
    if (h.toString('latin1', 0, 4) === 'RIFF') return 'image/webp'
  } catch {
    // sniff is best effort
  }
  return 'image/png'
}

function openaiMessage(m) {
  if (!m.images?.length) return m
  const parts = [{ type: 'text', text: String(m.content ?? '') }]
  for (const b64 of m.images) {
    parts.push({ type: 'image_url', image_url: { url: `data:${sniffMime(b64)};base64,${b64}` } })
  }
  return { role: m.role, content: parts }
}

async function streamOpenAI(base, target, messages, opts) {
  const preset = EFFORTS[target.effort] ?? EFFORTS.medium
  const stats = {}
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: target.model,
      messages: messages.map(openaiMessage),
      stream: true,
      temperature: preset.temperature
    })
  })
  if (!res.ok || !res.body) throw new Error(`API error ${res.status}: ${await res.text().catch(() => '')}`)

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
        const delta = json.choices?.[0]?.delta?.content
        if (delta) opts.onDelta(delta)
        if (json.usage) {
          stats.promptTokens = json.usage.prompt_tokens
          stats.completionTokens = json.usage.completion_tokens
        }
      } catch {
        /* partial JSON across chunks — wait */
      }
    }
  }
  return stats
}

/** Human-readable model size: 4.7 GB, 380 MB … */
export function fmtSize(bytes) {
  if (!bytes) return ''
  const gb = bytes / 1e9
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}

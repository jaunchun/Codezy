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

import type { ChatMessage, Session, Settings } from '../shared/types'
import { runAgent, makeRegistry, loadHooks, ollamaCall, openaiCall } from '../../cli/lib/harness.mjs'
import type { V2Message } from '../../cli/lib/harness.mjs'

/** Effort presets, same temperatures the v1 engine uses. */
const TEMPERATURES: Record<string, number> = { light: 0.9, medium: 0.6, deep: 0.2 }

/** Registry cache per workspace — keeps todo_write state between runs. */
let regCache: { key: string; registry: ReturnType<typeof makeRegistry> } | null = null

export interface V2RunResult {
  reply: string
  iterations: number
  stats: { promptTokens?: number; completionTokens?: number }
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

  // Registry cached per workspace — todo_write state survives across runs
  const key = roots.join('\n')
  if (!regCache || regCache.key !== key) regCache = { key, registry: makeRegistry({ roots }) }
  const registry = regCache.registry
  const temperature = TEMPERATURES[session.effort ?? settings.effort] ?? 0.6
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
          outcome: ev.outcome ?? 'ok'
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

// ---------------------------------------------------------------------------
// providers.ts — one-click presets for connecting a cloud model provider.
// A preset only fills the form (name + baseUrl + a good starting model); the
// API key always stays in the user's own settings file, entered by them.
//
// Every preset is a plain OpenAI-compatible endpoint — the same wire format
// the v1 chat engine, the v2 agent harness (openaiCall) and the CLI all speak.
// ---------------------------------------------------------------------------

import type { ProviderConfig } from './types'

export interface ProviderPreset {
  id: string
  name: string
  /** OpenAI-compatible base URL — always ends in /v1 (or gains it). */
  baseUrl: string
  /** Model the provider should start on, when the preset has a known-good one. */
  defaultModel?: string
  hint: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'nebius',
    name: 'Nebius Token Factory',
    baseUrl: 'https://api.tokenfactory.nebius.com/v1',
    defaultModel: 'nvidia/Nemotron-3_5-Lightning',
    hint: 'formerly AI Studio · NVIDIA Nemotron, DeepSeek, Qwen, Llama… — tokenfactory.nebius.com'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    hint: 'one key, hundreds of models — openrouter.ai'
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    hint: 'very fast inference — console.groq.com'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    hint: 'DeepSeek V3/R1 — platform.deepseek.com'
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    hint: 'open-weight models, pay per token — together.ai'
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'codestral-latest',
    hint: 'Mistral + Codestral — console.mistral.ai'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    hint: 'GPT-4o / o-series — platform.openai.com'
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    hint: 'local server, no API key — lmstudio.ai'
  }
]

/**
 * Settings patch that connects (or re-keys) a preset provider and activates
 * it — the same upsert the TUI's `/provider nebius <key>` command performs:
 * every other provider stays intact, and presets without a known-good model
 * keep the current one. Used by the first-run setup screen.
 */
export function connectPatch(
  providers: ProviderConfig[],
  preset: ProviderPreset,
  apiKey: string,
  currentModel: string
): { providers: ProviderConfig[]; activeProvider: string; activeModel: string } {
  const entry: ProviderConfig = { id: preset.id, name: preset.name, baseUrl: preset.baseUrl, apiKey }
  return {
    providers: [...providers.filter((p) => p.id !== preset.id), entry],
    activeProvider: preset.id,
    activeModel: preset.defaultModel ?? currentModel
  }
}

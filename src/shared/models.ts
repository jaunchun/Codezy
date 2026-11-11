// ---------------------------------------------------------------------------
// models.ts — the models CODEZY recommends, and what each one can actually do.
//
// Agent mode (read_file / write_file / web_search / run_command) requires a
// model that supports TOOL CALLING. Plenty of popular local models do not —
// codellama and llama2-uncensored answer a tools schema with HTTP 400
// ("does not support tools"). The app probes Ollama directly for installed
// models; this list is the curated starting point shown in Settings and the
// docs site. Keep it honest: only list tools:true where tool calling works.
// ---------------------------------------------------------------------------

export interface ModelGuideEntry {
  /** Ollama model id (the `ollama pull` argument). */
  id: string
  label: string
  /** Can it call tools (agent mode)? */
  tools: boolean
  /** Rough unified RAM / VRAM the model needs at Q4. */
  ram: string
  /** Where it shines. */
  use: string
  note: string
}

export const MODEL_GUIDE: ModelGuideEntry[] = [
  {
    id: 'qwen2.5-coder:7b',
    label: 'Qwen2.5 Coder 7B',
    tools: true,
    ram: '~8 GB',
    use: 'agent mode · default',
    note: 'Best all-round local coding model. Tool calling verified — start here.'
  },
  {
    id: 'qwen2.5-coder:14b',
    label: 'Qwen2.5 Coder 14B',
    tools: true,
    ram: '~12 GB',
    use: 'agent mode · better code',
    note: 'Sharper edits and fewer retries; slower on an 8 GB machine.'
  },
  {
    id: 'qwen2.5-coder:32b',
    label: 'Qwen2.5 Coder 32B',
    tools: true,
    ram: '~24 GB',
    use: 'agent mode · best local',
    note: 'Closest to cloud quality. Needs a big GPU or lots of RAM.'
  },
  {
    id: 'qwen3:8b',
    label: 'Qwen3 8B',
    tools: true,
    ram: '~8 GB',
    use: 'reasoning · chat · tools',
    note: 'Strong reasoning and tool calling; thinking mode can be slower.'
  },
  {
    id: 'llama3.1:8b',
    label: 'Llama 3.1 8B',
    tools: true,
    ram: '~8 GB',
    use: 'general chat · tools',
    note: 'Reliable general-purpose model with tool calling.'
  },
  {
    id: 'codellama:13b',
    label: 'Code Llama 13B',
    tools: false,
    ram: '~10 GB',
    use: 'completion only',
    note: 'No tool calling. Agent mode falls back to edit blocks with your files.'
  },
  {
    id: 'llama2-uncensored:7b',
    label: 'Llama 2 Uncensored 7B',
    tools: false,
    ram: '~6 GB',
    use: 'chat only',
    note: 'No tool calling; changes go through the classic ===FILE blocks.'
  }
]

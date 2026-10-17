// Batch 11 — Nebius provider + OpenAI-compatible agent mode:
//  1. shared/providers (esbuild): Nebius preset — /v1 base URL + NVIDIA default
//     model; SettingsModal maps the presets.
//  2. commands (esbuild): /provider documents the nebius connect form.
//  3. harness unit (mock fetch): chatCompletionsUrl URL building, openaiCall —
//     Bearer header, wire-shape sanitizing (tool_name out, tool_call_id kept,
//     object args → string, orphan tool → user note), stats mapping, error
//     paths ("API error <code>" / data.error message).
//  4. runAgent + openaiCall scripted loop: pairing ids survive into request
//     #2, the tool really runs, final text returned.
//  5. desktop v2.ts (esbuild bundle): provider target really calls openaiCall
//     (tokenfactory URL + Bearer + model), ollama path unchanged (num_ctx),
//     unconfigured provider throws.
//  6. store /provider (esbuild bundle, mocked bridge): bare listing, connect
//     without key → error, connect with key → provider saved + active +
//     nvidia model, switching, unknown → error.
//  7. TUI /provider (USERPROFILE-isolated settings): /help row, card, connect
//     nebius <key> → settings.json written in the temp home only.
//  8. CLI v2 routing: --url …/v1 live through Ollama's OpenAI endpoint
//     (exit 0); settings provider branch proven by "API error" vs "Ollama
//     error" — the real ~/.codezy/settings.json is never touched.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const require = createRequire(path.join(PROJ, 'package.json'))
const { build } = require('esbuild')

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

const OUT = path.join(os.tmpdir(), `codezy-batch11-${Date.now()}`)
fs.mkdirSync(OUT, { recursive: true })
const ISO_ROOTS = []
process.on('exit', () => {
  for (const d of ISO_ROOTS) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {}
  }
  try {
    fs.rmSync(OUT, { recursive: true, force: true })
  } catch {}
})

// --- 1. shared/providers ------------------------------------------------------
await build({
  entryPoints: [path.join(PROJ, 'src/shared/providers.ts')],
  outfile: path.join(OUT, 'providers.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { PROVIDER_PRESETS } = await import(pathToFileURL(path.join(OUT, 'providers.mjs')).href)
const nebius = PROVIDER_PRESETS.find((p) => p.id === 'nebius')
check('presets: Nebius present', !!nebius, JSON.stringify(PROVIDER_PRESETS.map((p) => p.id)))
check('presets: Nebius base URL /v1', nebius?.baseUrl === 'https://api.tokenfactory.nebius.com/v1', nebius?.baseUrl)
check('presets: NVIDIA default model', nebius?.defaultModel?.startsWith('nvidia/') === true, nebius?.defaultModel)
check(
  'presets: OpenRouter + LM Studio rows',
  ['openrouter', 'lm-studio'].every((id) => PROVIDER_PRESETS.some((p) => p.id === id))
)
const smSrc = fs.readFileSync(path.join(PROJ, 'src/renderer/src/components/SettingsModal.tsx'), 'utf8')
check('SettingsModal imports presets', smSrc.includes("from '../../../shared/providers'"))
check('SettingsModal maps preset chips', smSrc.includes('PROVIDER_PRESETS.map('))

// --- 2. commands: /provider documents the connect form ------------------------
await build({
  entryPoints: [path.join(PROJ, 'src/shared/commands.ts')],
  outfile: path.join(OUT, 'commands.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { COMMANDS, helpText, parseInput } = await import(pathToFileURL(path.join(OUT, 'commands.mjs')).href)
const prov = COMMANDS.find((c) => c.name === '/provider')
check('commands: /provider args', prov?.args === '[id|nebius key]', prov?.args)
check('commands: /provider mentions Nebius', /Nebius/.test(prov?.description ?? ''), prov?.description)
check('commands: help mentions Nebius', helpText().includes('Nebius'))
check(
  'commands: parseInput /provider nebius nk',
  JSON.stringify(parseInput('/provider nebius nk-b11')) ===
    JSON.stringify({ kind: 'command', name: '/provider', args: 'nebius nk-b11' }),
  JSON.stringify(parseInput('/provider nebius nk-b11'))
)

// --- 3. harness: chatCompletionsUrl + openaiCall ------------------------------
const harness = await import(pathToFileURL(path.join(PROJ, 'cli/lib/harness.mjs')).href)
const { chatCompletionsUrl, openaiCall, runAgent, makeRegistry, TOOLS } = harness

check(
  'url: origin-only gains /v1',
  chatCompletionsUrl('https://api.tokenfactory.nebius.com') ===
    'https://api.tokenfactory.nebius.com/v1/chat/completions',
  chatCompletionsUrl('https://api.tokenfactory.nebius.com')
)
check(
  'url: …/v1 kept',
  chatCompletionsUrl('https://api.tokenfactory.nebius.com/v1/') ===
    'https://api.tokenfactory.nebius.com/v1/chat/completions'
)
check(
  'url: /api/v1 path kept',
  chatCompletionsUrl('https://openrouter.ai/api/v1') === 'https://openrouter.ai/api/v1/chat/completions'
)
check(
  'url: plain origin gains /v1',
  chatCompletionsUrl('http://127.0.0.1:11434') === 'http://127.0.0.1:11434/v1/chat/completions'
)

{
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init })
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'hi',
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }]
            }
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      })
    }
  }
  const res = await openaiCall({
    baseUrl: 'https://api.tokenfactory.nebius.com',
    apiKey: 'nk-test',
    model: 'nvidia/Nemotron-3_5-Lightning',
    temperature: 0.6,
    tools: TOOLS,
    messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u' },
      // Ollama-ish assistant tool call: no id/type, object arguments
      { role: 'assistant', content: 'thinking', tool_calls: [{ function: { name: 'list_dir', arguments: { path: '.' } } }] },
      { role: 'tool', tool_name: 'list_dir', tool_call_id: 'call_x', content: 'r1' },
      // orphan tool result (text-form call): no tool_call_id
      { role: 'tool', tool_name: 'web_search', content: 'r2' }
    ],
    fetchImpl
  })
  check('call: hits …/v1/chat/completions', seen[0].url === 'https://api.tokenfactory.nebius.com/v1/chat/completions', seen[0].url)
  check('call: Bearer header', seen[0].init.headers.Authorization === 'Bearer nk-test', JSON.stringify(seen[0].init.headers))
  const body = JSON.parse(seen[0].init.body)
  check('call: model + stream:false + temperature', body.model === 'nvidia/Nemotron-3_5-Lightning' && body.stream === false && body.temperature === 0.6)
  check('call: tools passed through', Array.isArray(body.tools) && body.tools[0]?.type === 'function')
  const a = body.messages[2]
  check(
    'call: assistant tool_calls sanitized (id + type + string args)',
    a.tool_calls?.[0]?.id === 'call_0' && a.tool_calls?.[0]?.type === 'function' &&
      a.tool_calls?.[0]?.function?.arguments === '{"path":"."}',
    JSON.stringify(a.tool_calls)
  )
  const t1 = body.messages[3]
  check('call: tool msg keeps tool_call_id, drops tool_name', t1.role === 'tool' && t1.tool_call_id === 'call_x' && !('tool_name' in t1) && t1.content === 'r1', JSON.stringify(t1))
  const t2 = body.messages[4]
  check('call: orphan tool → user note', t2.role === 'user' && String(t2.content).includes('[web_search result]') && String(t2.content).includes('r2'), JSON.stringify(t2))
  check('call: content mapped', res.content === 'hi')
  check('call: tool_calls mapped', res.tool_calls.length === 1 && res.tool_calls[0].id === 'call_1')
  check('call: usage → stats', res.stats.promptTokens === 10 && res.stats.completionTokens === 5, JSON.stringify(res.stats))

  // no apiKey → no Authorization header
  await openaiCall({ baseUrl: 'http://localhost:1234/v1', model: 'm', messages: [{ role: 'user', content: 'x' }], fetchImpl })
  check('call: no key → no Authorization', !('Authorization' in seen[1].init.headers), JSON.stringify(seen[1].init.headers))

  // HTTP error → "API error <code>"
  let err = null
  try {
    await openaiCall({
      baseUrl: 'https://api.tokenfactory.nebius.com/v1',
      model: 'm',
      messages: [],
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":"bad key"}' })
    })
  } catch (e) {
    err = e
  }
  check('call: !ok → "API error 401"', /API error 401/.test(err?.message ?? ''), err?.message)

  // body-level error object → its message
  err = null
  try {
    await openaiCall({
      baseUrl: 'https://api.tokenfactory.nebius.com/v1',
      model: 'm',
      messages: [],
      fetchImpl: async () => ({ ok: true, json: async () => ({ error: { message: 'rate limited' } }) })
    })
  } catch (e) {
    err = e
  }
  check('call: data.error → message', err?.message === 'rate limited', err?.message)
}

// --- 4. runAgent loop over openaiCall -----------------------------------------
{
  const requests = []
  let n = 0
  const fetchImpl = async (url, init) => {
    requests.push(JSON.parse(init.body))
    n++
    if (n === 1) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [{ id: 'call_7', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }]
              }
            }
          ]
        })
      }
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'done' } }] }) }
  }
  const tmpRoot = path.join(OUT, 'root1')
  fs.mkdirSync(tmpRoot, { recursive: true })
  const result = await runAgent({
    messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'look' }
    ],
    registry: makeRegistry({ roots: [tmpRoot] }),
    callModel: ({ messages, tools, signal }) =>
      openaiCall({
        baseUrl: 'https://api.tokenfactory.nebius.com/v1',
        apiKey: 'k',
        model: 'nvidia/Nemotron-3_5-Lightning',
        messages,
        tools,
        signal,
        fetchImpl
      })
  })
  check('loop: final text + 2 iterations', result.status === 'text' && result.text === 'done' && result.iterations === 2, `${result.status}/${result.iterations}`)
  const second = requests[1]
  const asst = second.messages[2]
  const tool = second.messages[3]
  check('loop: assistant tool_calls echo id', asst?.role === 'assistant' && asst?.tool_calls?.[0]?.id === 'call_7', JSON.stringify(asst))
  check('loop: tool result carries tool_call_id', tool?.role === 'tool' && tool?.tool_call_id === 'call_7' && String(tool?.content).length > 0, JSON.stringify(tool))
}

// --- 5. desktop v2.ts — provider target ---------------------------------------
await build({
  entryPoints: [path.join(PROJ, 'src/main/v2.ts')],
  outfile: path.join(OUT, 'v2.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { runV2 } = await import(pathToFileURL(path.join(OUT, 'v2.mjs')).href)

const tmpRoot = path.join(OUT, 'root2')
fs.mkdirSync(tmpRoot, { recursive: true })
const calls = []
let nTok = 0
let nOll = 0
globalThis.fetch = async (url, init) => {
  const u = String(url)
  calls.push({ url: u, init })
  if (u.includes('tokenfactory')) {
    nTok++
    if (nTok === 1) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [{ id: 'call_b11', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }]
              }
            }
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3 }
        })
      }
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'nebius ok' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) }
  }
  nOll++
  if (nOll === 1) {
    // Ollama wire: object arguments, no ids
    return {
      ok: true,
      json: async () => ({
        message: { content: '', tool_calls: [{ function: { name: 'list_dir', arguments: { path: '.' } } }] },
        prompt_eval_count: 4,
        eval_count: 2
      })
    }
  }
  return { ok: true, json: async () => ({ message: { content: 'ollama ok' }, prompt_eval_count: 3, eval_count: 2 }) }
}

const baseSettings = {
  ollamaUrl: 'http://127.0.0.1:11434',
  activeProvider: 'ollama',
  activeModel: 'qwen2.5-coder:7b',
  providers: [],
  effort: 'medium'
}
const mkMsgs = () => [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' }
]

{
  const emitted = []
  const res = await runV2({
    session: { linkedFolders: [tmpRoot], model: 'nvidia/Nemotron-3_5-Lightning', provider: 'nebius', effort: 'medium' },
    settings: {
      ...baseSettings,
      activeProvider: 'nebius',
      activeModel: 'nvidia/Nemotron-3_5-Lightning',
      providers: [{ id: 'nebius', name: 'Nebius Token Factory', baseUrl: 'https://api.tokenfactory.nebius.com/v1', apiKey: 'nk-b11' }]
    },
    messages: mkMsgs(),
    signal: new AbortController().signal,
    emit: (ev) => emitted.push(ev),
    ask: async () => true
  })
  check('v2 provider: reply + iterations', res.reply === 'nebius ok' && res.iterations === 2, `${res.reply}/${res.iterations}`)
  check('v2 provider: tokenfactory URL', calls[0]?.url === 'https://api.tokenfactory.nebius.com/v1/chat/completions', calls[0]?.url)
  check('v2 provider: Bearer', calls[0]?.init?.headers?.Authorization === 'Bearer nk-b11', JSON.stringify(calls[0]?.init?.headers))
  const b1 = JSON.parse(calls[0].init.body)
  check('v2 provider: model', b1.model === 'nvidia/Nemotron-3_5-Lightning', b1.model)
  const b2 = JSON.parse(calls[1].init.body)
  check('v2 provider: pairing in request 2', b2.messages[2]?.tool_calls?.[0]?.id === 'call_b11' && b2.messages[3]?.tool_call_id === 'call_b11', JSON.stringify(b2.messages.slice(2)))
  check('v2 provider: tool event emitted', emitted.some((e) => e.type === 'v2tool' && e.name === 'list_dir'), JSON.stringify(emitted.map((e) => e.type)))
  check('v2 provider: stats accumulated', res.stats.promptTokens === 12 && res.stats.completionTokens === 5, JSON.stringify(res.stats))
}

{
  const res = await runV2({
    session: { linkedFolders: [tmpRoot], effort: 'medium' },
    settings: { ...baseSettings },
    messages: mkMsgs(),
    signal: new AbortController().signal,
    emit: () => {},
    ask: async () => true
  })
  const last = calls[calls.length - 1]
  check('v2 ollama: /api/chat URL', last.url === 'http://127.0.0.1:11434/api/chat', last.url)
  const b = JSON.parse(last.init.body)
  check('v2 ollama: num_ctx 65536 kept', b.options?.num_ctx === 65536 && b.model === 'qwen2.5-coder:7b', JSON.stringify(b.options))
  check('v2 ollama: reply', res.reply === 'ollama ok', res.reply)
}

{
  let err = null
  try {
    await runV2({
      session: { linkedFolders: [tmpRoot], effort: 'medium' },
      settings: { ...baseSettings, activeProvider: 'ghost' },
      messages: mkMsgs(),
      signal: new AbortController().signal,
      emit: () => {},
      ask: async () => true
    })
  } catch (e) {
    err = e
  }
  check('v2: unconfigured provider throws', /Provider "ghost" is not configured/.test(err?.message ?? ''), err?.message)
}

// --- 6. store /provider (real dispatch, mocked bridge) ------------------------
{
  const mock = {
    settings: {
      // main merges the patch over what's on disk (patchSettings)
      set: async (patch) => ({ ...useApp.getState().settings, ...patch })
    },
    health: { ollama: async () => 'online', drive: async () => ({ folder: null }) },
    memory: { read: async () => '', write: async () => true },
    skills: { list: async () => [] },
    sessions: { save: async (s) => s },
    models: { list: async () => [] }
  }
  globalThis.window = { codezy: mock }

  await build({
    entryPoints: [path.join(PROJ, 'src/renderer/src/store/app.ts')],
    outfile: path.join(OUT, 'app.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent'
  })
  const { useApp } = await import(pathToFileURL(path.join(OUT, 'app.mjs')).href)

  const now = Date.now()
  const session = {
    id: 's1',
    projectId: null,
    title: 'batch11',
    createdAt: now,
    updatedAt: now,
    messages: [],
    linkedFolders: []
  }
  useApp.setState({
    settings: {
      theme: 'dark',
      accent: '#3d9bff',
      dataDir: 'C:/tmp/batch11',
      driveFolder: null,
      ollamaUrl: 'http://127.0.0.1:11434',
      providers: [],
      activeProvider: 'ollama',
      activeModel: 'qwen2.5-coder:7b',
      effort: 'medium',
      userName: 'dev',
      learn: true,
      fontSize: 14,
      mode: 'build'
    },
    sessions: [session],
    activeId: 's1',
    notices: [],
    ready: true
  })

  const st = () => useApp.getState()
  const last = () => st().notices[st().notices.length - 1]
  const send = async (t) => st().send(t, [], false)

  await send('/provider')
  check('store: bare lists ollama', (last()?.text ?? '').startsWith('Active: ollama') && (last()?.text ?? '').includes('• ollama'), (last()?.text ?? '').slice(0, 60))

  await send('/provider nebius')
  check('store: connect w/o key errors', last()?.kind === 'error' && /Connect first: \/provider nebius <api key>/.test(last()?.text ?? ''), `${last()?.kind}: ${last()?.text}`)

  await send('/provider nebius nk-b11')
  const s = st().settings
  check('store: provider saved', s.providers.length === 1 && s.providers[0].id === 'nebius' && s.providers[0].apiKey === 'nk-b11' && s.providers[0].baseUrl.endsWith('/v1'), JSON.stringify(s.providers))
  check('store: active + NVIDIA model', s.activeProvider === 'nebius' && s.activeModel === 'nvidia/Nemotron-3_5-Lightning', `${s.activeProvider} / ${s.activeModel}`)
  check('store: connect notice', /Connected Nebius Token Factory · model → nvidia\/Nemotron-3_5-Lightning/.test(last()?.text ?? ''), (last()?.text ?? '').split('\n')[0])

  await send('/provider ollama')
  check('store: switch back to ollama', st().settings.activeProvider === 'ollama', st().settings.activeProvider)

  await send('/provider nebius')
  check('store: connected nebius switches without key', st().settings.activeProvider === 'nebius' && last()?.text === 'Provider set to nebius', last()?.text)

  await send('/provider ghost')
  check('store: unknown errors', last()?.kind === 'error' && /Unknown provider "ghost"/.test(last()?.text ?? ''), last()?.text)
}

// --- 7. TUI /provider (isolated USERPROFILE) ----------------------------------
const ISO = path.join(os.tmpdir(), `codezy-b11-home-${Date.now()}`)
ISO_ROOTS.push(ISO)
fs.mkdirSync(path.join(ISO, '.codezy'), { recursive: true })
fs.writeFileSync(
  path.join(ISO, '.codezy', 'settings.json'),
  JSON.stringify(
    {
      ollamaUrl: 'http://127.0.0.1:11434',
      activeProvider: 'ollama',
      activeModel: 'qwen2.5-coder:7b',
      effort: 'medium',
      providers: [],
      dataDir: '',
      theme: 'light'
    },
    null,
    2
  )
)

const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '\n')

const TUI_OUT = await new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(PROJ, 'cli/codezy.mjs')], {
    cwd: ISO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, USERPROFILE: ISO }
  })
  let out = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (out += d))
  const kill = setTimeout(() => {
    try {
      p.kill()
    } catch {}
  }, 60000)
  const keys = [
    [900, '/help\r'],
    [1800, '/provider\r'],
    [2700, '/provider nebius b11-fake-key\r'],
    [3600, '/provider\r'],
    [4500, '/quit\r']
  ]
  for (const [ms, buf] of keys) setTimeout(() => p.stdin.write(buf), ms)
  setTimeout(() => p.stdin.end(), 5600)
  p.on('close', (code) => {
    clearTimeout(kill)
    resolve({ out, code })
  })
})
{
  const s = strip(TUI_OUT.out)
  check('tui: exit 0', TUI_OUT.code === 0, `code=${TUI_OUT.code}`)
  check('tui: /help row', /\/provider\s+\[id\|nebius <key>\]/.test(s), (s.match(/\/provider[^\n]*/) ?? [''])[0])
  check('tui: bare card connect line', s.includes('connect: /provider nebius <api key>'))
  check(
    'tui: connect notice',
    s.includes('connected Nebius Token Factory · model → nvidia/Nemotron-3_5-Lightning'),
    (s.match(/connected[^\n]*/) ?? [''])[0]
  )
  check('tui: second card lists provider', s.includes('nebius   Nebius Token Factory'), (s.match(/nebius {1,4}Nebius[^\n]*/) ?? [''])[0])

  const isoSettings = JSON.parse(fs.readFileSync(path.join(ISO, '.codezy', 'settings.json'), 'utf8'))
  check(
    'tui: settings.json in temp home',
    isoSettings.activeProvider === 'nebius' &&
      isoSettings.activeModel === 'nvidia/Nemotron-3_5-Lightning' &&
      isoSettings.providers?.[0]?.id === 'nebius' &&
      isoSettings.providers?.[0]?.apiKey === 'b11-fake-key' &&
      isoSettings.providers?.[0]?.baseUrl === 'https://api.tokenfactory.nebius.com/v1',
    JSON.stringify({ p: isoSettings.activeProvider, m: isoSettings.activeModel, n: isoSettings.providers?.length })
  )
}

// --- 8. CLI v2 routing --------------------------------------------------------
// 8a. --url …/v1 → OpenAI wire, live through Ollama's OpenAI endpoint.
{
  const r = spawnSync(
    process.execPath,
    [path.join(PROJ, 'cli/index.mjs'), 'exec', '--url', 'http://127.0.0.1:11434/v1', 'Reply with only the word OK'],
    { cwd: ISO, encoding: 'utf8', timeout: 180000, env: process.env }
  )
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  check('cli: --url …/v1 live exit 0', r.status === 0, `status=${r.status} out=${out.slice(0, 200)}`)
  check('cli: --url …/v1 replied OK', /OK/.test(out), out.slice(0, 120))
}

// 8b. settings provider branch: provider active + live Ollama /v1 endpoint but
// a nonexistent model → the OpenAI path must answer ("API error"), the Ollama
// path would say "Ollama error". Settings live in an isolated temp home.
{
  const ISO2 = path.join(os.tmpdir(), `codezy-b11-home2-${Date.now()}`)
  ISO_ROOTS.push(ISO2)
  fs.mkdirSync(path.join(ISO2, '.codezy'), { recursive: true })
  fs.writeFileSync(
    path.join(ISO2, '.codezy', 'settings.json'),
    JSON.stringify(
      {
        ollamaUrl: 'http://127.0.0.1:11434',
        activeProvider: 'nebius',
        activeModel: 'codezy-nonexistent-b11',
        providers: [{ id: 'nebius', name: 'Nebius Token Factory', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'nk' }],
        dataDir: ''
      },
      null,
      2
    )
  )
  const r = spawnSync(process.execPath, [path.join(PROJ, 'cli/index.mjs'), 'exec', 'hi'], {
    cwd: ISO2,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, USERPROFILE: ISO2 }
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  check('cli: provider branch exit 1', r.status === 1, `status=${r.status}`)
  check(
    'cli: provider branch = OpenAI path',
    (/API error \d|not found/.test(out) && !/Ollama error/.test(out)),
    out.slice(0, 240)
  )
}

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

// Batch 24 — v3 connections:
//  A. MCP naming + result flattening (pure helpers).
//  B. McpConnection against a REAL fake MCP server (spawned child speaking
//     NDJSON JSON-RPC): handshake validation, tools/list, tool calls, isError
//     results, RPC errors, hung-call timeout, crashing server, ENOENT spawn.
//  C. mcpRegistryTools: namespaced entries/schemas, one bad server isolated
//     in failures, disabled servers skipped, session cache + reconnect after
//     a crash, drop/disconnect lifecycle.
//  D. vision: expandMessage turns image attachments into data-URL vision
//     input; text files stay inline; unreadable images degrade to a warning.
//  E. wire helpers: Ollama raw base64 `images` / OpenAI image_url parts.
//  F. provider presets — the five new ones (groq/deepseek/together/mistral/
//     openai) + connectPatch still wires them.
//  G. settings round-trip: mcpServers defaults to [] and survives save/load.
//  H. Settings → MCP section (jsdom): status rows, test probe, remove,
//     disable, add — through the mocked mcp bridge.
//  I. wiring/static: IPC handlers, preload, api type, v2 plan-mode gating,
//     CSS block 28, vision call sites.
// Deterministic: fake server on stdin/stdout, scripted bridge, no network.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const require = createRequire(path.join(PROJ, 'package.json'))
const { build } = require('esbuild')

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

// OUT must live INSIDE the project so esbuild resolves node_modules.
const OUT = path.join(PROJ, 'tests', '.tmp', `b24-${Date.now() % 100000}`)
fs.mkdirSync(OUT, { recursive: true })

const rd = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8')

// --- fake MCP server (NDJSON JSON-RPC over stdio) ------------------------------
// Validates the handshake (protocolVersion + clientInfo), lists 3 tools, and
// for calls: echo (text + a non-text part), boom (isError result), slow
// (3 s — for timeout tests), crash (exit 3), unknown tool → RPC error.
const FAKE = path.join(OUT, 'fake-server.mjs')
fs.writeFileSync(
  FAKE,
  [
    "import readline from 'node:readline'",
    'const rl = readline.createInterface({ input: process.stdin })',
    'const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n")',
    "rl.on('line', (line) => {",
    '  let msg',
    '  try { msg = JSON.parse(line) } catch { return }',
    '  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result })',
    '  const replyErr = (code, message) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } })',
    '  switch (msg.method) {',
    '    case "initialize": {',
    '      const p = msg.params || {}',
    "      if (p.protocolVersion !== '2024-11-05') return replyErr(-32602, 'bad protocolVersion: ' + p.protocolVersion)",
    "      if (!p.clientInfo || p.clientInfo.name !== 'CODEZY') return replyErr(-32602, 'bad clientInfo')",
    '      reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0.0.1" } })',
    '      break',
    '    }',
    '    case "notifications/initialized":',
    '      break',
    '    case "tools/list":',
    '      reply({ tools: [',
    '        { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },',
    '        { name: "boom", description: "Always reports an error" },',
    '        { name: "slow", description: "Answers after 3 seconds" }',
    '      ] })',
    '      break',
    '    case "tools/call": {',
    '      const name = msg.params && msg.params.name',
    '      const args = (msg.params && msg.params.arguments) || {}',
    '      if (name === "echo") reply({ content: [{ type: "text", text: "echo:" + args.message }, { type: "image", data: "xxx" }] })',
    '      else if (name === "boom") reply({ content: [{ type: "text", text: "kaboom" }], isError: true })',
    '      else if (name === "slow") setTimeout(() => reply({ content: [{ type: "text", text: "late" }] }), 3000)',
    '      else if (name === "crash") process.exit(3)',
    '      else replyErr(-32602, "Unknown tool: " + name)',
    '      break',
    '    }',
    '    default:',
    '      if (msg.id !== undefined) replyErr(-32601, "Method not found: " + msg.method)',
    '  }',
    '})'
  ].join('\n')
)

// electron stub for bundles that pull main/store.ts (batch12 pattern)
fs.writeFileSync(
  path.join(OUT, 'electron-stub.mjs'),
  'export const app = { getPath: () => "" }\nexport default { app }\n'
)
const ELECTRON_ALIAS = { electron: path.join(OUT, 'electron-stub.mjs') }

// --- bundles --------------------------------------------------------------------
const bundle = async (relEntry, outName, opts = {}) => {
  const out = path.join(OUT, outName)
  await build({
    entryPoints: [path.join(PROJ, relEntry)],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    ...opts
  })
  return import(pathToFileURL(out).href)
}

const M = await bundle('src/main/mcp.ts', 'mcp.mjs')
const O = await bundle('src/main/ollama.ts', 'ollama.mjs')
const P = await bundle('src/main/prompt.ts', 'prompt.mjs', { alias: ELECTRON_ALIAS })
const store = await bundle('src/main/store.ts', 'store.mjs', { alias: ELECTRON_ALIAS })
const PV = await bundle('src/shared/providers.ts', 'providers.mjs')

// --- A. naming + flattening -------------------------------------------------------
{
  check('A namespaced tool name', M.mcpToolName('my server', 'get file') === 'mcp__my_server__get_file')
  check(
    'A odd characters never break the name',
    /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(M.mcpToolName('日本語!', 'a/b c')),
    M.mcpToolName('日本語!', 'a/b c')
  )
  check(
    'A long names are truncated',
    M.mcpToolName('x'.repeat(80), 't') === `mcp__${'x'.repeat(40)}__t`
  )
  check('A flatten joins text parts', M.flattenMcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) === 'a\nb')
  check(
    'A non-text parts counted',
    M.flattenMcpResult({ content: [{ type: 'text', text: 'x' }, { type: 'image', data: 'y' }] }).includes('1 non-text part(s) omitted')
  )
  check(
    'A isError flagged but kept',
    M.flattenMcpResult({ content: [{ type: 'text', text: 'kaboom' }], isError: true }) === '[the tool reported an error]\nkaboom'
  )
  check('A empty content says so', M.flattenMcpResult({ content: [] }) === '(no text content)')
  check('A junk input does not throw', M.flattenMcpResult(null) === '(no text content)' && M.flattenMcpResult(undefined) === '(no text content)')
  const huge = M.flattenMcpResult({ content: [{ type: 'text', text: 'z'.repeat(50000) }] })
  check('A huge results truncated at the cap', huge.length <= 16100 && huge.endsWith('…[truncated]'), String(huge.length))
}

// --- B. a real connection against the fake server -----------------------------------
const CFG = { name: 'fake', command: process.execPath, args: [FAKE] }
{
  // the fake REJECTS the handshake unless protocolVersion/clientInfo are right,
  // so a resolved start() is the handshake assertion
  const conn = new M.McpConnection('fake', CFG)
  const tools = await conn.start('test')
  check('B handshake + tools/list succeeds', tools.length === 3 && tools.map((t) => t.name).join(',') === 'echo,boom,slow', tools.map((t) => t.name).join(','))
  check('B input schemas survive the wire', JSON.stringify(tools[0].inputSchema).includes('"message"'))

  const echo = await conn.request('tools/call', { name: 'echo', arguments: { message: 'hi' } }, 5000)
  check('B tool call flattens to text + omission note', M.flattenMcpResult(echo) === 'echo:hi\n…[1 non-text part(s) omitted]', JSON.stringify(M.flattenMcpResult(echo)))

  const boom = await conn.request('tools/call', { name: 'boom', arguments: {} }, 5000)
  const flatBoom = M.flattenMcpResult(boom)
  check('B isError result keeps its text', flatBoom.includes('[the tool reported an error]') && flatBoom.includes('kaboom'))

  let rpcErr = null
  try { await conn.request('nope/method', {}, 3000) } catch (e) { rpcErr = e.message }
  check('B unknown method → JSON-RPC error', !!rpcErr && rpcErr.includes('Method not found'), String(rpcErr))

  let toolErr = null
  try { await conn.request('tools/call', { name: 'nope', arguments: {} }, 3000) } catch (e) { toolErr = e.message }
  check('B unknown tool → JSON-RPC error', !!toolErr && toolErr.includes('Unknown tool'), String(toolErr))

  let toErr = null
  try { await conn.request('tools/call', { name: 'slow', arguments: {} }, 300) } catch (e) { toErr = e.message }
  check('B hung call hits the timeout', !!toErr && toErr.includes('timed out after 300ms'), String(toErr))

  let crashErr = null
  try { await conn.request('tools/call', { name: 'crash', arguments: {} }, 5000) } catch (e) { crashErr = e.message }
  check('B crashing server fails the pending call', !!crashErr && crashErr.includes('server exited (code 3)'), String(crashErr))
  let dead = null
  try { await conn.request('tools/list', {}, 1000) } catch (e) { dead = e.message }
  check('B dead connection refuses new work', !!dead && dead.includes('not connected'), String(dead))
  conn.close()

  let spawnErr = null
  try { await new M.McpConnection('bad', { name: 'bad', command: 'definitely-not-a-real-binary-xyz' }).start('test') } catch (e) { spawnErr = e.message }
  check('B missing binary fails fast with context', !!spawnErr && /spawn failed|ENOENT/.test(spawnErr), String(spawnErr))
}

// --- C. registry bundle -------------------------------------------------------------
{
  const servers = [
    { name: 'fake', command: process.execPath, args: [FAKE] },
    { name: 'off', command: process.execPath, args: [FAKE], enabled: false },
    { name: 'badsrv', command: 'definitely-not-a-real-binary-xyz' }
  ]
  const b = await M.mcpRegistryTools(servers, 'test')
  check('C every tool becomes a namespaced entry', b.total === 3 && !!b.entries['mcp__fake__echo'] && !!b.entries['mcp__fake__slow'], String(b.total))
  check(
    'C schemas carry name + description + parameters',
    b.schemas.length === 3 && b.schemas[0].type === 'function' && b.schemas[0].function.description.includes('Echo') && JSON.stringify(b.schemas[0].function.parameters).includes('message')
  )
  check('C one bad server lands in failures, not a throw', b.failures.length === 1 && b.failures[0].server === 'badsrv' && /spawn|ENOENT/.test(b.failures[0].error), JSON.stringify(b.failures))
  check('C disabled servers never connect', !('mcp__off__echo' in b.entries))

  const echoOut = await b.entries['mcp__fake__echo'].run({ message: 'yo' })
  check('C registry run returns flattened text', echoOut === 'echo:yo\n…[1 non-text part(s) omitted]', JSON.stringify(echoOut))
  check('C check() guards non-objects', typeof b.entries['mcp__fake__echo'].check('nope') === 'string' && b.entries['mcp__fake__echo'].check({}) === null)
  check('C tool cap constant', M.MCP_MAX_TOOLS === 40, String(M.MCP_MAX_TOOLS))

  // crash the cached session, then prove the next call reconnects it
  const sess = await M.mcpGetSession('fake', { name: 'fake', command: process.execPath, args: [FAKE] }, 'test')
  check('C getSession reuses the live connection', sess === await M.mcpGetSession('fake', { name: 'fake', command: process.execPath, args: [FAKE] }, 'test'))
  let cerr = null
  try { await sess.request('tools/call', { name: 'crash', arguments: {} }, 5000) } catch (e) { cerr = e.message }
  check('C crash closes the cached session', !!cerr && sess.closed, String(cerr))

  const b2 = await M.mcpRegistryTools(servers, 'test')
  check('C dead session reconnects on next use', b2.total === 3 && b2.failures.length === 1, String(b2.total))
  const echo2 = await b2.entries['mcp__fake__echo'].run({ message: 'again' })
  check('C reconnected server works', echo2.startsWith('echo:again'), echo2.slice(0, 20))
  check('C connected servers visible for the status line', M.mcpConnectedServers().some((x) => x.name === 'fake' && x.tools === 3), JSON.stringify(M.mcpConnectedServers()))

  M.mcpDropSession('fake')
  check('C drop removes one session', !M.mcpConnectedServers().some((x) => x.name === 'fake'))
  M.mcpDisconnectAll()
  check('C disconnect clears everything', M.mcpConnectedServers().length === 0)
}

// --- D. vision: expandMessage --------------------------------------------------------
{
  const png = path.join(OUT, 'pic.png')
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const png2 = path.join(OUT, 'pic2.png')
  fs.writeFileSync(png2, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const note = path.join(OUT, 'note.txt')
  fs.writeFileSync(note, 'hello text file')
  const msg = (files, content = 'hi') => ({ id: 'm1', role: 'user', content, ts: 1, files })

  const img = P.expandMessage(msg([{ path: png, content: '' }]))
  check('D image file → vision data URL', img.images?.length === 1 && img.images[0] === 'data:image/png;base64,iVBORw0KGgo=', img.images?.[0]?.slice(0, 30))
  check('D image NOT inlined as base64 text', !img.content.includes('base64,iVBOR') && img.content.includes('Attached image:') && img.content.includes('vision input'))
  check('D original text kept up front', img.content.startsWith('hi'))

  const passthrough = P.expandMessage(msg([{ path: 'C:/somewhere/s.png', content: 'data:image/png;base64,QUJD' }]))
  check('D existing data URL passes through', passthrough.images?.[0] === 'data:image/png;base64,QUJD', passthrough.images?.[0])

  const txt = P.expandMessage(msg([{ path: note, content: 'hello text file' }]))
  check('D text files stay inline-only', txt.images === undefined && txt.content.includes('Attached file:') && txt.content.includes('hello text file'))

  const missing = P.expandMessage(msg([{ path: path.join(OUT, 'nope.jpg'), content: '' }]))
  check('D unreadable image degrades to a warning', missing.images === undefined && missing.content.includes('could not be embedded'))

  const none = { id: 'm2', role: 'user', content: 'plain', ts: 2 }
  check('D messages without files pass through untouched', P.expandMessage(none) === none)

  const multi = P.expandMessage(msg([{ path: png, content: '' }, { path: png2, content: '' }, { path: note, content: 'x' }]))
  check('D multiple images collected, order kept', multi.images?.length === 2 && multi.images[1].startsWith('data:image/png'), String(multi.images?.length))
  check('D text block still added for the non-image', multi.content.includes('Attached file:'))
}

// --- E. wire helpers -------------------------------------------------------------------
{
  const base = [
    { id: '1', role: 'user', content: 'look', ts: 1, images: ['data:image/png;base64,QUJD'] },
    { id: '2', role: 'assistant', content: 'ok', ts: 2 }
  ]
  const ow = O.ollamaWireMessages(base)
  check('E ollama strips the data-URL prefix', ow[0].images?.[0] === 'QUJD' && ow[0].content === 'look', ow[0].images?.[0])
  check('E ollama omits the images key for plain messages', !('images' in ow[1]))
  const oa = O.openaiWireMessages(base)
  check(
    'E openai uses image_url parts when images exist',
    Array.isArray(oa[0].content) && oa[0].content[0].type === 'text' && oa[0].content[1].image_url.url === 'data:image/png;base64,QUJD',
    JSON.stringify(oa[0].content).slice(0, 80)
  )
  check('E openai keeps plain string content otherwise', oa[1].content === 'ok')
}

// --- F. provider presets ------------------------------------------------------------------
{
  const ids = PV.PROVIDER_PRESETS.map((p) => p.id)
  const expected = ['nebius', 'openrouter', 'groq', 'deepseek', 'together', 'mistral', 'openai', 'lm-studio']
  check('F preset set expanded to 8', expected.every((i) => ids.includes(i)) && ids.length === expected.length, ids.join(','))
  check('F ids unique', new Set(ids).size === ids.length)
  check('F every preset has baseUrl + hint', PV.PROVIDER_PRESETS.every((p) => p.baseUrl && p.hint))
  const patch = PV.connectPatch([], PV.PROVIDER_PRESETS.find((p) => p.id === 'groq'), 'g-secret', 'keep-me')
  check(
    'F connectPatch wires the new preset',
    patch.activeProvider === 'groq' && patch.providers?.some((p) => p.id === 'groq' && p.apiKey === 'g-secret') && patch.activeModel === 'llama-3.3-70b-versatile',
    JSON.stringify(patch).slice(0, 120)
  )
}

// --- G. settings round-trip -----------------------------------------------------------------
{
  const TDIR = path.join(OUT, 'data')
  store.initStore(TDIR)
  const s0 = store.getSettings()
  check('G mcpServers defaults to []', Array.isArray(s0.mcpServers) && s0.mcpServers.length === 0, JSON.stringify(s0.mcpServers))
  const cfg = { name: 'srv', command: 'npx', args: ['-y', 'pkg'], env: { K: 'V' } }
  store.saveSettings({ ...s0, dataDir: TDIR, mcpServers: [cfg] })
  const s1 = store.getSettings()
  check(
    'G mcpServers round-trips through disk',
    s1.mcpServers?.length === 1 && s1.mcpServers[0].command === 'npx' && s1.mcpServers[0].args[1] === 'pkg' && s1.mcpServers[0].env.K === 'V',
    JSON.stringify(s1.mcpServers)
  )
}

// --- H. Settings → MCP section (jsdom) ----------------------------------------------------
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
})
const defineGlobal = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
defineGlobal('window', dom.window)
defineGlobal('document', dom.window.document)
defineGlobal('navigator', dom.window.navigator)
defineGlobal('HTMLElement', dom.window.HTMLElement)
defineGlobal('HTMLInputElement', dom.window.HTMLInputElement)
defineGlobal('Event', dom.window.Event)
defineGlobal('MouseEvent', dom.window.MouseEvent)
defineGlobal('KeyboardEvent', dom.window.KeyboardEvent)
defineGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
defineGlobal('localStorage', dom.window.localStorage)
defineGlobal(
  'requestAnimationFrame',
  typeof dom.window.requestAnimationFrame === 'function'
    ? dom.window.requestAnimationFrame.bind(dom.window)
    : (cb) => setTimeout(cb, 0)
)
dom.window.matchMedia =
  dom.window.matchMedia ||
  (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// scripted MCP bridge
let mcpListImpl = async () => []
let mcpListCalls = 0
const mcpSaveCalls = []
const mcpProbeCalls = []
const SETTINGS = {
  theme: 'dark',
  accent: '#3d9bff',
  dataDir: path.join(OUT, 'data'),
  driveFolder: null,
  ollamaUrl: 'http://127.0.0.1:11434',
  providers: [],
  activeProvider: 'ollama',
  activeModel: 'm',
  effort: 'medium',
  userName: 'dev',
  learn: true,
  fontSize: 14,
  mode: 'build',
  v2: false,
  setupDone: true,
  reduceMotion: false,
  density: 'cozy',
  autoUpdate: true,
  notifyDone: false,
  enterSends: true,
  mcpServers: []
}
const mock = {
  settings: { get: async () => SETTINGS, set: async (patch) => ({ ...SETTINGS, ...patch }) },
  models: { list: async () => [] },
  memory: { read: async () => '' },
  mcp: {
    list: async () => {
      mcpListCalls++
      return mcpListImpl()
    },
    probe: async (cfg) => {
      mcpProbeCalls.push(cfg)
      return { ok: true, tools: ['alpha', 'beta'] }
    },
    save: async (servers) => {
      mcpSaveCalls.push(servers)
    }
  }
}
dom.window.codezy = mock
defineGlobal('codezy', mock)

const R_OUT = path.join(OUT, 'entry24.tsx')
fs.writeFileSync(
  R_OUT,
  [
    `export { default as SettingsModal } from '${PROJ}/src/renderer/src/components/SettingsModal'`,
    `export { useApp } from '${PROJ}/src/renderer/src/store/app'`,
    `export { createRoot } from 'react-dom/client'`,
    `export { act } from 'react'`,
    `export { createElement } from 'react'`
  ].join('\n')
)
await build({
  entryPoints: [R_OUT],
  outfile: path.join(OUT, 'renderer.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  define: { __APP_VERSION__: JSON.stringify('0.0.0-test') },
  logLevel: 'silent'
})
const ui = await import(pathToFileURL(path.join(OUT, 'renderer.mjs')).href)
const { createElement: h } = ui

const flush = async (n = 6) => {
  await ui.act(async () => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
  })
}
const root = ui.createRoot(document.getElementById('root'))
// one act window per interaction: the click/type AND the promise-driven
// setStates it triggers (mcp.save → reload → setMcp) land together, so no
// "not wrapped in act(...)" warning can slip through the boundary.
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
const render = async (el) => {
  await ui.act(async () => {
    root.render(el)
    await settle()
  })
}
const click = async (el) => {
  await ui.act(async () => {
    el.click()
    await settle()
  })
}
const type = async (el, v) => {
  await ui.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await settle()
  })
}
const rowButtons = (row) => [...row.querySelectorAll('button')].find((b) => b.textContent.trim())

{
  mcpListImpl = async () => [
    { name: 'fs', command: 'npx', args: ['-y', 'srv-fs', '/tmp'], status: 'ok', tools: ['read', 'write'] },
    { name: 'broken', command: 'uvx', args: [], status: 'error', tools: [], error: 'spawn failed' },
    { name: 'off', command: 'node', args: ['x.js'], status: 'disabled', tools: [], enabled: false }
  ]
  ui.useApp.setState({ settings: SETTINGS, settingsOpen: true })
  await render(h(ui.SettingsModal))

  const headers = [...document.querySelectorAll('.settings-section')].map((el) => el.textContent)
  check('H MCP section rendered', headers.includes('MCP servers'), headers.join('|'))
  const rows = [...document.querySelectorAll('.mcp-row')]
  check('H one row per server', rows.length === 3, String(rows.length))
  check('H status dots per status', !!document.querySelector('.mcp-dot.ok') && !!document.querySelector('.mcp-dot.error') && rows[2].classList.contains('off'))
  check('H tool counts shown', rows[0].textContent.includes('2 tools') && rows[1].textContent.includes('error'), rows[1].textContent.slice(0, 60))
  check('H command shown', rows[0].querySelector('.mcp-cmd')?.textContent.includes('npx -y srv-fs'))

  // test → probe reports the tools
  await click(rowButtons(rows[0]))
  check('H test button probes the server', mcpProbeCalls.length === 1 && mcpProbeCalls[0].name === 'fs', JSON.stringify(mcpProbeCalls[0] ?? null))
  check('H probe result rendered', document.querySelector('.mcp-probe')?.textContent.includes('2 tools: alpha, beta'), document.querySelector('.mcp-probe')?.textContent)

  // remove → saves the remaining list
  const removeBroken = [...document.querySelectorAll('.mcp-row')][1]
  await click([...removeBroken.querySelectorAll('button')].find((b) => b.textContent.trim() === 'remove'))
  check('H remove saves without the row', mcpSaveCalls.length === 1 && mcpSaveCalls[0].length === 2 && !mcpSaveCalls[0].some((s) => s.name === 'broken'), JSON.stringify(mcpSaveCalls[0]?.map((s) => s.name)))

  // disable → enabled:false in the payload
  const firstRow = document.querySelectorAll('.mcp-row')[0]
  await click([...firstRow.querySelectorAll('button')].find((b) => b.textContent.trim() === 'disable'))
  check('H disable persists enabled:false', mcpSaveCalls[1]?.[0]?.name === 'fs' && mcpSaveCalls[1][0].enabled === false, JSON.stringify(mcpSaveCalls[1]))

  // add → appends the new entry (button starts disabled with empty inputs).
  // Scoped to the MCP field: the providers section has its own "add" button.
  const mcpField = document.querySelector('.mcp-row')?.closest('.field') ?? document
  const addBtn = [...mcpField.querySelectorAll('button')].find((b) => b.textContent.trim() === 'add')
  check('H add disabled until the form is filled', addBtn?.disabled === true, String(addBtn?.disabled))
  await type(mcpField.querySelector('input[placeholder="name"]'), 'new-srv')
  await type(mcpField.querySelector('input[placeholder="command (npx, uvx, an absolute path…)"]'), 'npx')
  await type(mcpField.querySelector('input[placeholder="args (space separated)"]'), '-y pkg')
  const addBtn2 = [...mcpField.querySelectorAll('button')].find((b) => b.textContent.trim() === 'add')
  check('H add enabled once filled', addBtn2?.disabled === false)
  await click(addBtn2)
  check(
    'H add persists the new server',
    mcpSaveCalls[2]?.length === 4 && mcpSaveCalls[2][3].name === 'new-srv' && mcpSaveCalls[2][3].args.join(' ') === '-y pkg',
    JSON.stringify(mcpSaveCalls[2]?.map((s) => s.name))
  )
  check('H list refreshed after each save', mcpListCalls === 4, String(mcpListCalls))

  // closing: setState must go through act — the modal is mounted and
  // subscribes to the store (a bare setState re-renders it outside act)
  await ui.act(async () => {
    ui.useApp.setState({ settingsOpen: false })
  })
  await render(h(ui.SettingsModal))
  check('H closing unmounts the dialog', !document.querySelector('.modal'))
}

// --- I. wiring / static -------------------------------------------------------------------------
{
  const idx = rd('src/main/index.ts')
  check("I index registers the mcp IPC", ["'mcp:list'", "'mcp:probe'", "'mcp:save'"].every((s) => idx.includes(s)))
  check('I connections die with the app', idx.includes("app.on('before-quit'") && idx.includes('mcpDisconnectAll()'))
  const pre = rd('src/preload/index.ts')
  check('I preload exposes the mcp bridge', pre.includes('mcp: {') && pre.includes("invoke('mcp:list')"))
  const apiT = rd('src/shared/api.ts')
  check('I api type has mcp + status entry', apiT.includes('mcp: {') && apiT.includes('McpStatusEntry'))
  const v2 = rd('src/main/v2.ts')
  check('I v2 merges mcp only with mutations allowed', v2.includes('allowMutations && settings.mcpServers') && v2.includes('mcpSchemas'))
  check('I v2 ships mcp schemas with the tool list', v2.includes('[...TOOLS, ...mcpSchemas]'))
  check('I mcp failures surface as chat events', v2.includes("emit({ type: 'v2tool'"))
  const sm = rd('src/renderer/src/components/SettingsModal.tsx')
  check('I settings has the MCP section', sm.includes('>MCP servers</div>') && sm.includes('window.codezy.mcp.list()'))
  const css = rd('src/renderer/src/styles/global.css')
  check('I css block 28 appended after 27', css.includes('28 — v3 connections') && css.indexOf('28 — v3') > css.indexOf('27 — v3'))
  check('I mcp row styles present', css.includes('.mcp-dot') && css.includes('.mcp-row') && css.includes('.mcp-probe'))
  const types = rd('src/shared/types.ts')
  check('I ChatMessage carries images', types.includes('images?: string[]'))
  check('I McpServerConfig in shared types', types.includes('export interface McpServerConfig'))
  const ol = rd('src/main/ollama.ts')
  check('I both wire helpers used at the call sites', ol.includes('messages: ollamaWireMessages(messages)') && ol.includes('messages: openaiWireMessages(messages)'))
  const mcpIface = rd('src/main/mcp.ts')
  check('I mcp client caps documented', mcpIface.includes('MCP_MAX_TOOLS = 40') && mcpIface.includes('windowsHide: true'))
}

// --- cleanup + summary -------------------------------------------------------------------------------
try {
  M.mcpDisconnectAll()
} catch { /* best effort */ }
try {
  fs.rmSync(OUT, { recursive: true, force: true })
} catch { /* best effort */ }

console.log('')
console.log(fails.length ? `${fails.length} FAIL:\n  ${fails.join('\n  ')}` : 'ALL PASS')
// jsdom + any lingering child pipes keep handles open — exit explicitly
process.exit(fails.length ? 1 : 0)

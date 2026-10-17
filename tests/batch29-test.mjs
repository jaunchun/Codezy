// Batch 29 — v3.1 MCP visibility:
//  A. harness timing: runAgent's tool event carries wall-clock ms (dynamic
//     against the real harness with a scripted model), d.mts declares it.
//  B. desktop pipeline: v2.ts forwards ms + derives size, the trace type
//     widened, the store pushes both into pendingTrace.
//  C. TraceLine (jsdom): the three chips — MCP server, duration, result
//     size — plus the failed-row state and the live activity label.
//  D. palette → Settings ▸ MCP servers: the jump scrolls the section into
//     view, flashes it, consumes itself; closing Settings first drops it.
//  E. TUI codezy-v2: /mcp command, MCP graft (registry + schemas) on every
//     turn/one-shot, clean disconnect on exit, activity line shows ms.
//  F. cli/lib/mcp.mjs against a REAL fake MCP server (spawned child speaking
//     NDJSON JSON-RPC): namespacing, registry entries, flatten, failures,
//     session reuse, disconnect-all.
//  G. wiring/static: CSS block 33.
// Deterministic: fake server on stdin/stdout, scripted model, no network.
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
const OUT = path.join(PROJ, 'tests', '.tmp', `b29-${Date.now() % 100000}`)
fs.mkdirSync(OUT, { recursive: true })
const rd = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8')

// electron stub for bundles that pull main/store.ts (batch12 pattern)
fs.writeFileSync(
  path.join(OUT, 'electron-stub.mjs'),
  'export const app = { getPath: () => "" }\nexport default { app }\n'
)
const ELECTRON_ALIAS = { electron: path.join(OUT, 'electron-stub.mjs') }

const bundle = async (entryContent, outName, opts = {}) => {
  const entry = path.join(OUT, `${outName}.entry.mjs`)
  fs.writeFileSync(entry, entryContent)
  const out = path.join(OUT, outName)
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    ...opts
  })
  return import(pathToFileURL(out).href)
}

// --- A. the shared harness measures every tool step ---------------------------------
{
  const H = await import(pathToFileURL(path.join(PROJ, 'cli', 'lib', 'harness.mjs')).href)
  const events = []
  let calls = 0
  const callModel = async () => {
    calls++
    if (calls === 1) {
      return { content: '', tool_calls: [{ id: 'c1', function: { name: 'ping_step', arguments: '{}' } }] }
    }
    return { content: 'done' }
  }
  const registry = {
    ping_step: {
      run: async () => {
        await new Promise((r) => setTimeout(r, 6))
        return 'pong'
      }
    }
  }
  const res = await H.runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry,
    callModel,
    onEvent: (ev) => events.push(ev),
    allowDelegate: false
  })
  const tool = events.find((e) => e.type === 'tool' && e.name === 'ping_step')
  check(
    'A the tool event carries its wall time',
    !!tool && typeof tool.ms === 'number' && tool.ms >= 5,
    tool ? `ms=${tool.ms}` : JSON.stringify(events.map((e) => `${e.type}:${e.name ?? ''}`))
  )
  check('A the timing covers the tool run itself', tool?.result === 'pong', String(tool?.result))
  check('A the run still ends in text', res.status === 'text' && res.text === 'done', `${res.status}/${res.text}`)
  check('A every tool event of the run is timed', events.filter((e) => e.type === 'tool').every((e) => typeof e.ms === 'number'))
  const dts = rd('cli/lib/harness.d.mts')
  check('A the event type declares ms', /\/\*\* v3\.1[^*]*\*\/\s*\n\s*ms\?: number/.test(dts))
}

// --- B. the desktop pipeline carries ms + size into the trace -------------------------
{
  const v2 = rd('src/main/v2.ts')
  check('B v2 forwards the harness timing', v2.includes("typeof ev.ms === 'number'") && v2.includes('{ ms: ev.ms }'))
  check('B v2 derives the result size', v2.includes('size: ev.result.length'))
  const types = rd('src/shared/types.ts')
  check('B the trace type widened', types.includes('ms?: number; size?: number'))
  const app = rd('src/renderer/src/store/app.ts')
  check('B the store pushes ms + size', app.includes("typeof payload.ms === 'number'") && app.includes("typeof payload.size === 'number'"))
  check('B pendingTrace annotation widened', /ms\?: number; size\?: number \}\[\]/.test(app))
  const cv = rd('src/renderer/src/components/ChatView.tsx')
  check('B the live label names MCP servers', /calling \$\{server\}\/\$\{tool\}/.test(cv))
}

// --- jsdom + scripted bridge -----------------------------------------------------------
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
// jsdom has no scrollIntoView — the jump effect + ChatView call it
const scrollSpans = []
dom.window.HTMLElement.prototype.scrollIntoView = function (opts) {
  scrollSpans.push({ el: this, opts })
}
// ChatView reads CSS.highlights at import (find bar detection)
defineGlobal('CSS', {})
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// fake bridge (batch27 shape) — Settings probes memory/mcp and resyncs on open
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
  learn: false,
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
  mcp: { list: async () => [], probe: async () => ({ ok: false, tools: [] }), save: async () => {} },
  ide: { read: async () => null, write: async (_sid, p, content) => p && content },
  files: { open: async () => '' },
  notify: { send: async () => {} },
  sessions: { search: async () => [] },
  chat: { v2decision: async () => {} }
}
dom.window.codezy = mock
defineGlobal('codezy', mock)

const ui = await bundle(
  [
    `export { default as ChatView } from '${PROJ}/src/renderer/src/components/ChatView'`,
    `export { default as Palette } from '${PROJ}/src/renderer/src/components/Palette'`,
    `export { default as SettingsModal } from '${PROJ}/src/renderer/src/components/SettingsModal'`,
    `export { useApp } from '${PROJ}/src/renderer/src/store/app'`,
    `export { createRoot } from 'react-dom/client'`,
    `export { act } from 'react'`,
    `export { createElement } from 'react'`
  ].join('\n'),
  'renderer.mjs',
  { platform: 'browser', jsx: 'automatic', define: { __APP_VERSION__: JSON.stringify('0.0.0-test') } }
)
const { createElement: h } = ui
const st = () => ui.useApp.getState()

const wait = async (ms) => {
  await ui.act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
const root = ui.createRoot(document.getElementById('root'))
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

// --- C. TraceLine: the visibility chips ------------------------------------------------
{
  const session = {
    id: 's-trace',
    projectId: null,
    title: 'Trace chat',
    createdAt: 1,
    updatedAt: 1,
    linkedFolders: [],
    messages: [
      { id: 't1', role: 'user', content: 'search the issues', ts: 1 },
      {
        id: 't2',
        role: 'assistant',
        content: 'Found 3.',
        ts: 2,
        trace: [
          { name: 'read_file', ok: true, ms: 142, size: 612 },
          { name: 'mcp__github__search_issues', ok: true, ms: 1400 },
          { name: 'run_command', ok: false, ms: 9000, size: 40000 }
        ]
      }
    ]
  }
  await ui.act(async () => {
    ui.useApp.setState({ sessions: [session], activeId: 's-trace', streaming: false, streamText: '', v2Activity: null })
  })
  await render(h(ui.ChatView))

  const head = document.querySelector('.trace-head')
  check('C the collapsed line still counts + flags failures', head?.textContent.includes('3 tool steps · 1 failed'), head?.textContent)
  check('C chips are hidden while collapsed', document.querySelector('.trace-list') == null)
  await click(head)
  const rows = [...document.querySelectorAll('.trace-list li')]
  check('C one row per step', rows.length === 3, String(rows.length))
  check('C duration chip', rows[0]?.textContent.includes('142ms'), rows[0]?.textContent)
  check('C result-size chip', rows[0]?.textContent.includes('612 B'), rows[0]?.textContent)
  const mcpChip = rows[1]?.querySelector('.trace-chip.mcp')
  check('C the MCP server gets its own chip', mcpChip?.textContent === 'github', mcpChip?.textContent)
  check('C long durations read as seconds', rows[1]?.textContent.includes('1.4s') && rows[2]?.textContent.includes('9.0s'), rows[1]?.textContent)
  check('C a big result shows as KB', rows[2]?.textContent.includes('39.1 KB'), rows[2]?.textContent)
  check('C the failed step keeps its bad state', rows[2]?.classList.contains('bad'), rows[2]?.className)
  await click(document.querySelector('.trace-head'))
  check('C clicking again collapses it', document.querySelector('.trace-list') == null)
}

// --- D. the palette jumps to Settings ▸ MCP servers ------------------------------------
{
  await ui.act(async () => {
    ui.useApp.setState({ paletteOpen: true })
  })
  await render(h(ui.Palette))
  const item = [...document.querySelectorAll('.pal-item')].find((b) => /MCP servers — status, tools & failures/.test(b.textContent))
  check('D the palette has the MCP jump', !!item, item?.textContent?.slice(0, 60))
  await click(item)
  check('D it opens Settings on the MCP section', st().settingsOpen === true && st().settingsSection === 'MCP servers', JSON.stringify({ open: st().settingsOpen, sec: st().settingsSection }))

  scrollSpans.length = 0
  await ui.act(async () => {
    ui.useApp.setState({ settings: SETTINGS, paletteOpen: false })
    await settle()
  })
  await render(h(ui.SettingsModal))
  const jumped = scrollSpans.find((s) => s.el.textContent === 'MCP servers')
  check('D the MCP section scrolls into view', !!jumped && jumped.opts?.block === 'start', JSON.stringify(scrollSpans.map((s) => s.el.className)))
  check('D the section flashes while on screen', [...document.querySelectorAll('.settings-section')].find((n) => n.textContent === 'MCP servers')?.classList.contains('flash'))
  await wait(1800)
  check('D the request consumes itself', st().settingsSection === null, String(st().settingsSection))
  check('D the flash is removed', ![...document.querySelectorAll('.settings-section')].some((n) => n.textContent === 'MCP servers' && n.classList.contains('flash')))

  // closing Settings before the timeout must NOT reopen it later
  await ui.act(async () => {
    ui.useApp.setState({ settingsSection: 'MCP servers' })
    await settle()
  })
  await render(h(ui.SettingsModal))
  await ui.act(async () => {
    ui.useApp.setState({ settingsOpen: false })
    await settle()
  })
  await render(h(ui.SettingsModal))
  check('D closing drops the pending jump', st().settingsSection === null, String(st().settingsSection))
  await wait(1900)
  check('D nothing reopens Settings afterwards', st().settingsOpen === false && st().settingsSection === null, JSON.stringify({ open: st().settingsOpen, sec: st().settingsSection }))
}

// --- E. the TUI shell: /mcp + the graft + clean exit ------------------------------------
{
  const tui = rd('cli/codezy-v2.mjs')
  check('E the shell has the /mcp command', tui.includes("case '/mcp'"))
  check('E /mcp appears in the banner + help', /type \/help · \/mcp/.test(tui) && tui.includes('MCP servers: status + the tools they offer'))
  check('E enabled servers are connected through the shared bundle', tui.includes('await mcpRegistryTools(servers)'))
  check('E server tools join the schema on every turn + one-shot', tui.split('tools: mcp?.schemas?.length ? [...TOOLS, ...mcp.schemas] : undefined').length === 3)
  check('E the registry gets the entries too', tui.includes('Object.assign(registry, mcp.entries)'))
  check('E the activity line shows the step time', tui.includes('ev.ms < 1000'))
  const disconnects = (tui.match(/mcpDisconnectAll\(\)/g) ?? []).length
  check('E children are torn down on exit + print', disconnects >= 2, String(disconnects))
  check('E the cache survives across turns', tui.includes('let mcpCache = null'))
}

// --- F. cli/lib/mcp.mjs against a REAL fake MCP server ------------------------------------
// The fake validates the handshake, lists 3 tools, and for calls: echo (text +
// an image part), boom (isError), slow (3 s), unknown tool → RPC error.
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
{
  const M = await import(pathToFileURL(path.join(PROJ, 'cli', 'lib', 'mcp.mjs')).href)

  check('F namespaced tool names', M.mcpToolName('my server', 'get file') === 'mcp__my_server__get_file')
  check('F odd characters never break the name', /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(M.mcpToolName('日本語!', 'a/b c')))

  const b = await M.mcpRegistryTools([{ name: 'fake', command: process.execPath, args: [FAKE] }], 'test')
  check('F handshake + tools/list over stdio', b.total === 3 && b.failures.length === 0, `total=${b.total} fail=${b.failures.length}`)
  check('F every tool becomes a namespaced entry', !!b.entries['mcp__fake__echo'] && !!b.entries['mcp__fake__slow'])
  check('F schemas carry the flat names + parameters', b.schemas.every((s) => s.type === 'function' && /^mcp__fake__/.test(s.function.name)) && !!b.schemas[0].function.parameters)
  const echoOut = await b.entries['mcp__fake__echo'].run({ message: 'yo' })
  check('F a call round-trips', echoOut.includes('echo:yo') && echoOut.includes('non-text part(s) omitted'), echoOut)
  const boomOut = await b.entries['mcp__fake__boom'].run({})
  check('F isError results are flagged, not swallowed', boomOut === '[the tool reported an error]\nkaboom', boomOut)
  check('F check() guards non-objects', typeof b.entries['mcp__fake__echo'].check('nope') === 'string' && b.entries['mcp__fake__echo'].check({}) === null)

  const b2 = await M.mcpRegistryTools(
    [
      { name: 'fake', command: process.execPath, args: [FAKE] },
      { name: 'badsrv', command: 'definitely-not-a-real-binary-xyz', args: [] }
    ],
    'test'
  )
  check('F one bad server lands in failures, not a throw', b2.total === 3 && b2.failures.length === 1 && b2.failures[0].server === 'badsrv', JSON.stringify(b2.failures))

  const s1 = await M.mcpGetSession('fake', { name: 'fake', command: process.execPath, args: [FAKE] }, 'test')
  const s2 = await M.mcpGetSession('fake', { name: 'fake', command: process.execPath, args: [FAKE] }, 'test')
  check('F sessions are reused', s1 === s2 && s1.tools.length === 3)
  check('F connected servers are visible', M.mcpConnectedServers().some((x) => x.name === 'fake' && x.tools === 3 && !x.closed), JSON.stringify(M.mcpConnectedServers()))

  check('F empty content says so', M.flattenMcpResult({ content: [] }) === '(no text content)')
  const huge = M.flattenMcpResult({ content: [{ type: 'text', text: 'z'.repeat(50000) }] })
  check('F huge results truncate at the cap', huge.length <= 16100 && huge.endsWith('…[truncated]'), String(huge.length))

  M.mcpDisconnectAll()
  check('F disconnect-all leaves nothing behind', M.mcpConnectedServers().length === 0, JSON.stringify(M.mcpConnectedServers()))
}

// --- G. wiring / static: CSS block 33 ----------------------------------------------------
{
  const css = rd('src/renderer/src/styles/global.css')
  check('G block 33 marker', css.includes('block 33 — v3.1 batch29'))
  check('G trace chips styled', /\.trace-chip \{/.test(css) && css.includes('.trace-chip.mcp'))
  check('G the jump flashes its section', css.includes('@keyframes sectionFlash'))
  check('G motion-off keeps a static ring', css.includes("html[data-motion='off'] .settings-section.flash"))
  const pal = rd('src/renderer/src/components/Palette.tsx')
  check('G palette action wired to the section', pal.includes("openSettings('MCP servers')"))
  const sm = rd('src/renderer/src/components/SettingsModal.tsx')
  check('G the modal consumes the jump request', sm.includes('settingsSection') && sm.includes("classList.add('flash')"))
}

if (!fails.length) {
  try {
    fs.rmSync(OUT, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}
console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

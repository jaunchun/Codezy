#!/usr/bin/env node
// ---------------------------------------------------------------------------
// doctor.mjs — `codezy doctor`: a headless health check for the whole CLI.
//
// Checks the things that actually break an agent CLI, in the order they break:
//   node · the package itself · settings.json · data dir · endpoint · model ·
//   hooks · MCP servers · git
//
// Exit codes follow the CLI convention: 0 = nothing broken (warnings allowed,
// an Ollama that simply isn't running is a warning, not an error), 1 = a real
// problem (node too old, settings file unreadable), 2 = usage.
// Plain Node, no dependencies.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { getVersion } from './lib/cli.mjs'
import { pingOllama, listOllamaModels, listOpenAIModels } from './lib/engine.mjs'
import { loadHooks } from './lib/harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// -- styling (plain when piped → clean capture in tests / CI) ------------------

const TTY = !!process.stdout.isTTY
const paint = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const dim = (s) => paint(2, s)
const bold = (s) => paint(1, s)
const green = (s) => paint(32, s)
const red = (s) => paint(31, s)
const yellow = (s) => paint(33, s)
const cyan = (s) => paint(36, s)

// -- settings (same conventions as the TUI shells) -----------------------------

const HOME = path.join(os.homedir(), '.codezy')
function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return fallback
  }
}
const settingsFile = path.join(HOME, 'settings.json')
let settingsRaw = null
try {
  settingsRaw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
} catch {
  settingsRaw = null
}
let settings = settingsRaw ?? {}
const dataDir = settings.dataDir && settings.dataDir !== HOME ? settings.dataDir : HOME
if (dataDir !== HOME) settings = { ...settings, ...readJson(path.join(dataDir, 'settings.json'), {}) }

const PROVIDER =
  settings.activeProvider && settings.activeProvider !== 'ollama'
    ? (settings.providers ?? []).find((p) => p.id === settings.activeProvider) ?? null
    : null
// NB: named ENDPOINT, not URL — that would shadow the global URL constructor.
const ENDPOINT = PROVIDER ? PROVIDER.baseUrl : settings.ollamaUrl || 'http://127.0.0.1:11434'
const MODEL = settings.activeModel || 'llama3.1:8b'

// -- the rows -------------------------------------------------------------------

const rows = []
let errors = 0
let warnings = 0
/** status: 'ok' | 'warn' | 'fail' */
function row(status, label, detail) {
  if (status === 'fail') errors++
  else if (status === 'warn') warnings++
  rows.push({ status, label, detail })
}

// 1 — node itself (an agent CLI needs modern fetch/AbortSignal/ESM)
{
  const [maj] = process.versions.node.split('.').map(Number)
  row(
    maj >= 18 ? 'ok' : 'fail',
    'node',
    `${process.version}${maj >= 18 ? '' : ' — needs >= 18 (fetch / AbortSignal / ESM)'}`
  )
}

// 2 — the package: version + bin entry point
{
  const v = getVersion()
  const hasEntry = fs.existsSync(path.join(HERE, 'index.mjs'))
  row(v !== '0.0.0' && hasEntry ? 'ok' : 'fail', 'package', `codezy ${v} · bin ${cyan('codezy')} → index.mjs`)
}

// 3 — settings.json: present is optional, INVALID is not
{
  if (settingsRaw === null) {
    row(fs.existsSync(settingsFile) ? 'fail' : 'ok', 'settings', fs.existsSync(settingsFile)
      ? `${settingsFile} — unreadable / invalid JSON`
      : `${dim('none — using built-in defaults')}`)
  } else {
    row('ok', 'settings', settingsFile)
  }
}

// 4 — data dir writable (the app stores sessions/updates there)
{
  const probe = path.join(dataDir, '.doctor-write-probe')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    row('ok', 'data dir', `${dataDir} — writable`)
  } catch (e) {
    row('fail', 'data dir', `${dataDir} — not writable (${e.message})`)
  }
}

// 5 — endpoint: is anything listening? (warn only — `ollama serve` is a choice)
let endpointUp = false
{
  endpointUp = PROVIDER ? (await listOpenAIModels(PROVIDER)).length > 0 : await pingOllama(ENDPOINT)
  row(
    endpointUp ? 'ok' : 'warn',
    'endpoint',
    endpointUp
      ? `${ENDPOINT} ${PROVIDER ? `(${PROVIDER.name || PROVIDER.id})` : '(ollama)'} — reachable`
      : `${ENDPOINT} — unreachable · try: ${cyan('ollama serve')}`
  )
}

// 6 — model: verified against the live list when the endpoint answered
{
  if (!endpointUp) {
    row('warn', 'model', `${MODEL} — not verified (endpoint down)`)
  } else {
    const list = PROVIDER ? await listOpenAIModels(PROVIDER) : (await listOllamaModels(ENDPOINT)).map((m) => m.id)
    const hit = list.some((m) => m === MODEL || String(m).startsWith(`${MODEL}:`))
    row(hit ? 'ok' : 'warn', 'model', hit ? `${MODEL} — available` : `${MODEL} — not in ${list.length} on the endpoint`)
  }
}

// 7 — hooks (workspace lifecycle hooks)
{
  const hooks = loadHooks([process.cwd()])
  const n = hooks ? hooks.before_tool.length + hooks.after_tool.length : 0
  row('ok', 'hooks', hooks ? `${n} hook(s) — ${hooks.file}` : 'none configured')
}

// 8 — MCP servers
{
  const servers = (settings.mcpServers ?? []).filter((s) => s && s.name && s.command)
  const on = servers.filter((s) => s.enabled !== false).length
  row(servers.length && !on ? 'warn' : 'ok', 'mcp', servers.length ? `${on}/${servers.length} enabled` : 'none configured')
}

// 9 — git (the agent reasons about diffs; not fatal on its own)
{
  const r = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 })
  const ok = r.status === 0
  row(ok ? 'ok' : 'warn', 'git', ok ? String(r.stdout ?? '').trim().replace(/^git version /, '') : 'not on PATH')
}

// -- report ---------------------------------------------------------------------

const mark = { ok: green('✓'), warn: yellow('!'), fail: red('✗') }
const w = Math.max(...rows.map((r) => r.label.length))
console.log(`${bold('codezy doctor')} ${dim(`v${getVersion()}`)}\n`)
for (const r of rows) console.log(`  ${mark[r.status]} ${bold(r.label.padEnd(w))}  ${r.detail}`)
console.log(
  `\n${errors ? red(`${errors} error(s)`) : green('no errors')}${
    warnings ? dim(` · ${yellow(`${warnings} warning(s)`)}`) : dim(' · no warnings')
  }`
)
if (errors) console.log(dim('fix the ✗ rows above, then re-run: codezy doctor'))
process.exit(errors ? 1 : 0)

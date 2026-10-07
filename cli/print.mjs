#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CODEZY one-shot chat — the `claude -p` / `codex exec` shape over the v1
// engine: one prompt in, the reply streamed to stdout, exit. Activity and
// errors go to stderr so `codezy -p "…" | something` stays clean.
// Invoked by cli/index.mjs; also runnable directly.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { streamChat, isEffort } from './lib/engine.mjs'
import { fileTree } from './lib/edits.mjs'
import { parseArgs, readStdin } from './lib/cli.mjs'

const A = parseArgs(process.argv.slice(2), ['model', 'dir', 'root', 'url', 'p', 'print', 'output-format'])

// --output-format: text (default, streams) · json (one object) · stream-json (NDJSON)
const FMT = String(A.values['output-format'] ?? 'text')
if (!['text', 'json', 'stream-json'].includes(FMT)) {
  process.stderr.write('codezy: --output-format must be text, json or stream-json\n')
  process.exit(2)
}

// -- settings (same conventions as codezy.mjs) --------------------------------

const HOME = path.join(os.homedir(), '.codezy')
function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return fallback
  }
}
let settings = readJson(path.join(HOME, 'settings.json'), {
  ollamaUrl: 'http://127.0.0.1:11434',
  activeProvider: 'ollama',
  activeModel: 'qwen2.5-coder:7b',
  effort: 'medium',
  providers: [],
  dataDir: ''
})
if (settings.dataDir && settings.dataDir !== HOME) {
  settings = { ...settings, ...readJson(path.join(settings.dataDir, 'settings.json'), {}) }
}

function targetFor() {
  const effort = isEffort(settings.effort) ? settings.effort : 'medium'
  const model = A.values.model || settings.activeModel || 'qwen2.5-coder:7b'
  if (settings.activeProvider && settings.activeProvider !== 'ollama') {
    const p = (settings.providers ?? []).find((x) => x.id === settings.activeProvider)
    if (p?.baseUrl) return { kind: 'openai', baseUrl: p.baseUrl, apiKey: p.apiKey, model, effort }
  }
  return {
    kind: 'ollama',
    baseUrl: A.values.url || settings.ollamaUrl || 'http://127.0.0.1:11434',
    model,
    effort
  }
}

// -- prompt: -p value, else positionals, else stdin ---------------------------

let prompt = String(A.values.print ?? A.values.p ?? A.positionals.join(' ')).trim()
if (!prompt && !process.stdin.isTTY) prompt = (await readStdin()).trim()
if (!prompt) {
  process.stderr.write('usage: codezy -p "prompt"\nrun: codezy --help\n')
  process.exit(2)
}

const SYSTEM_BASE =
  'You are CODEZY, running a one-shot command in the user’s terminal.\n' +
  'Answer directly in plain markdown with fenced code blocks. No preamble, no file-edit blocks.'

// optional workspace context: `codezy -p --dir ./repo "…"` gets the file tree
const dirArg = A.values.dir ?? A.values.root ?? ''
const absDir = dirArg ? path.resolve(dirArg) : ''
const SYSTEM =
  absDir && fs.existsSync(absDir)
    ? `${SYSTEM_BASE}\n\nThe user's folder (${absDir}):\n${fileTree(absDir) || '(empty folder)'}`
    : SYSTEM_BASE

// -- stream the one reply ------------------------------------------------------

let out = ''
let stats = null
const t0 = Date.now()
const target = targetFor()
try {
  stats = await streamChat(target, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: prompt }
  ], {
    onDelta: (t) => {
      out += t
      if (FMT === 'text') process.stdout.write(t)
      else if (FMT === 'stream-json') process.stdout.write(`${JSON.stringify({ type: 'text', text: t })}\n`)
    }
  })
} catch (e) {
  process.stderr.write(`\ncodezy: ${e?.message ?? e}\n`)
  if (String(e?.message ?? '').includes('ECONNREFUSED')) {
    process.stderr.write('is Ollama running? try: ollama serve\n')
  }
  process.exit(1)
}

if (!out.trim()) {
  process.stderr.write('codezy: empty reply from the model\n')
  process.exit(1)
}
if (FMT === 'json' || FMT === 'stream-json') {
  const result = {
    model: target.model,
    effort: target.effort,
    reply: out,
    duration_ms: Date.now() - t0,
    tokens: stats ? { prompt: stats.promptTokens ?? null, completion: stats.completionTokens ?? null } : null
  }
  process.stdout.write(`${JSON.stringify(FMT === 'json' ? result : { type: 'result', ...result })}\n`)
} else if (!out.endsWith('\n')) process.stdout.write('\n')
process.exit(0)

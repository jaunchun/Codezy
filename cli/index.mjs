#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CODEZY CLI — one entry point, following the conventions of the mature agent
// CLIs (Claude Code, Codex, Antigravity, opencode): interactive by default,
// -p/--print for one-shot runs, `exec`/`run` for scripted agent runs, one
// --help/--version surface, honest exit codes (0 ok · 1 error · 2 usage).
//
// Routing (the engines stay self-contained; this file only dispatches):
//   codezy                → cli/codezy.mjs    chat TUI        (v1)
//   codezy "prompt"       → cli/print.mjs     one-shot chat   (v1 engine)
//   codezy -p "prompt"    → cli/print.mjs
//   codezy exec|run "…"   → cli/codezy-v2.mjs one-shot agent  (harness)
//   codezy --agent […]    → cli/codezy-v2.mjs agent REPL / print
// ---------------------------------------------------------------------------

import { parseArgs, helpText, getVersion } from './lib/cli.mjs'

const argv = process.argv.slice(2)

const COMMON = ['h', 'help', 'V', 'version']
const V1 = new Set([...COMMON, 'model', 'dir'])
const PRINT = new Set([...V1, 'p', 'print', 'url', 'output-format'])
const V2 = new Set([...COMMON, 'a', 'agent', 'p', 'print', 'model', 'dir', 'root', 'ctx', 'url', 'auto', 'output-format'])

const A = parseArgs(argv, ['model', 'dir', 'root', 'ctx', 'url', 'print', 'p', 'output-format'])

// -- help / version first, regardless of engine -------------------------------
if (A.present.has('h') || A.present.has('help')) {
  process.stdout.write(`${helpText()}\n`)
  process.exit(0)
}
if (A.present.has('V') || A.present.has('version')) {
  process.stdout.write(`codezy ${getVersion()}\n`)
  process.exit(0)
}

// -- pick the engine ----------------------------------------------------------
const sub = A.positionals[0]
const agent = A.present.has('agent') || A.present.has('a') || sub === 'exec' || sub === 'run'
const oneShot =
  A.present.has('p') || A.present.has('print') || A.positionals.length > 0

const target = agent ? './codezy-v2.mjs' : oneShot ? './print.mjs' : './codezy.mjs'
const known = agent ? V2 : oneShot ? PRINT : V1

for (const flag of A.present) {
  if (!known.has(flag)) {
    const dash = flag.length === 1 ? '-' : '--'
    process.stderr.write(`codezy: unknown option ${dash}${flag}\nrun: codezy --help\n`)
    process.exit(2)
  }
}

await import(target)

// ---------------------------------------------------------------------------
// cli.mjs — shared command-line plumbing for every CODEZY CLI entry point.
//
// One parser, one help text, one exit-code convention — the CLI must behave
// like the mature agent CLIs (Claude Code, Codex, Antigravity, opencode)
// instead of each script inventing its own flags:
//   - flags are `--name value`, `--name=value` or boolean; `-x` shorts work
//   - positionals are the free words (a prompt, or an `exec`/`run` subcommand)
//   - exit codes: 0 ok · 1 runtime error · 2 usage error
// Plain Node, no dependencies.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.join(HERE, '..', '..', 'package.json')

/** Version from package.json — the single source of truth. */
export function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(PKG, 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Parses argv into flags + positionals.
 * @param {string[]} argv
 * @param {string[]} valueFlags names that take a value (stored in `values`)
 * @returns {{ values: Record<string,string>, present: Set<string>, positionals: string[] }}
 */
export function parseArgs(argv, valueFlags = []) {
  const values = Object.create(null)
  const present = new Set()
  const positionals = []
  const takesValue = new Set(valueFlags)

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (a.length > 1 && a.startsWith('-')) {
      let name = a.replace(/^--?/, '')
      let inline = null
      const eq = name.indexOf('=')
      if (eq !== -1) {
        inline = name.slice(eq + 1)
        name = name.slice(0, eq)
      }
      present.add(name)
      if (takesValue.has(name)) {
        if (inline !== null) {
          values[name] = inline
        } else if (argv[i + 1] !== undefined && (name === 'p' || name === 'print' || !argv[i + 1].startsWith('-'))) {
          values[name] = argv[++i]
        } else {
          values[name] = '' // flag present without a value → read stdin
        }
      }
      continue
    }
    positionals.push(a)
  }
  return { values, present, positionals }
}

/** Reads all of stdin (for `-p` with no inline prompt). */
export async function readStdin() {
  let buf = ''
  for await (const chunk of process.stdin) buf += chunk
  return buf
}

/** The one unified `--help` screen, codex/claude-code style. */
export function helpText() {
  return `CODEZY — local coding agent for the terminal  (v${getVersion()})

USAGE
  codezy                       interactive chat (TUI)
  codezy "prompt"              one-shot: print the answer, then exit
  codezy -p "prompt"           one-shot with an explicit flag (stdin works too)
  codezy exec|run "prompt"     one-shot AGENT run: tools + approvals, then exit
  codezy --agent               agent chat REPL (tools + per-action approval)

OPTIONS
  -p, --print <prompt>         one-shot mode; omit the value to read stdin
  -a, --agent                  use the tool-calling agent (tools + approvals)
      --model <id>             override the model from settings
      --dir <path>             workspace root / linked folder (alias: --root)
      --url <url>              Ollama or OpenAI-compatible endpoint
      --ctx <n>                context window (agent mode, default 65536)
      --auto                   agent mode: approve gated tools automatically
      --output-format <fmt>    one-shot output: text (default) · json · stream-json
  -h, --help                   show this help
  -V, --version                show the version

EXAMPLES
  codezy                                     open the chat
  codezy -p "explain this stack trace"
  cat error.log | codezy -p "why is this failing?"
  codezy -p "summarize this diff" --output-format json
  codezy exec "fix the failing tests" --auto
  codezy --agent --dir ../my-repo            agent REPL over a folder

EXIT CODES
  0  ok    1  runtime error    2  usage error

Inside a REPL: /help lists the commands. The agent REPL adds /root, /todos
and /search <query> (instant web search, no model involved).`
}

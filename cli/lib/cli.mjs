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
// cli/package.json FIRST: the CLI ships as its own npm package, so a global
// install has no repo root next to it. The Electron app's package.json stays
// the fallback for older checkouts.
const PKGS = [path.join(HERE, '..', 'package.json'), path.join(HERE, '..', '..', 'package.json')]

/** Version from the CLI package.json — the single source of truth. */
export function getVersion() {
  for (const f of PKGS) {
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8')).version
      if (v) return v
    } catch {
      /* try the next candidate */
    }
  }
  return '0.0.0'
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
        } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
          values[name] = argv[++i]
        } else if (name === 'p' || name === 'print') {
          // `-p` immediately followed by another flag: leave the value UNSET
          // so the engine falls through to positionals (or stdin) instead of
          // eating `--dir` as the prompt. `present` still records `-p`, so
          // one-shot routing is unaffected. (Value after the flag works:
          // `-p "text"` — only a flag-looking token is refused.)
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

// -- one help screen, styled when it lands on a TTY, plain when piped --------
const TTY = !!process.stdout.isTTY
const paint = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const dim = (s) => paint(2, s)
const cyan = (s) => paint(36, s)
const bold = (s) => paint(1, s)

/** The one unified `--help` screen, codex/claude-code style. */
export function helpText() {
  const head = (t) => bold(t)
  return `${bold('CODEZY')} ${dim('— local coding agent for the terminal')}  ${dim(`(v${getVersion()})`)}

${head('USAGE')}
  codezy                       ${dim('interactive chat (TUI)')}
  codezy "prompt"              ${dim('one-shot: print the answer, then exit')}
  codezy -p "prompt"           ${dim('one-shot with an explicit flag (stdin works too)')}
  codezy exec|run "prompt"     ${dim('one-shot AGENT run: tools + approvals, then exit')}
  codezy --agent               ${dim('agent chat REPL (tools + per-action approval)')}
  codezy doctor                ${dim('check install, settings and endpoint')}

${head('OPTIONS')}
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

${head('AGENT COMMANDS')} ${dim('(codezy --agent — type them in the REPL, TAB completes)')}
  /root [dir]  /todos  /mcp  /search <q>  /model <id>  /tools  /auto  /export  /clear

${head('EXAMPLES')}
  codezy                                     ${dim('open the chat')}
  codezy -p "explain this stack trace"
  cat error.log | codezy -p "why is this failing?"
  codezy -p "summarize this diff" --output-format json
  codezy exec "fix the failing tests" --auto
  codezy --agent --dir ../my-repo            ${dim('agent REPL over a folder')}
  codezy doctor                              ${dim('is everything wired up?')}

${head('EXIT CODES')}
  0  ok    1  runtime error    2  usage error

${dim('Install: npm install -g ./cli   (then `codezy` is on your PATH)')}
${dim("Inside a REPL: /help lists the commands. The agent REPL adds /root, /todos")}
${dim("and /search <query> (instant web search, no model involved).")}`
}

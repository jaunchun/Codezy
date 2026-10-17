# codezy

**CODEZY terminal companion** — a chat TUI and an agent CLI (tools + approvals)
for **Ollama** and any OpenAI-compatible endpoint. One local mind for your
codebase: the same agent conventions as Claude Code / Codex / opencode, zero
dependencies (Node builtins only).

```bash
npm install -g codezy
```

Works on **Windows, macOS and Linux** (Node.js 18+).

## Quick start

```bash
codezy                       # interactive chat (TUI)
codezy "explain this file"   # one-shot: print the answer, exit
codezy exec "fix the tests"  # agent run: tools + approvals, then exit
codezy doctor                # check install, settings and endpoint
```

## Requirements

A model, either way:

- **Local** — [Ollama](https://ollama.com) running with a model pulled
  (`ollama serve`, then `ollama pull qwen2.5-coder:7b`), or
- **Remote** — any OpenAI-compatible endpoint via `--url` (plus `--model`).

Settings live in `~/.codezy/settings.json` — shared with the CODEZY desktop
app, so the terminal and the app see the same memory, sessions and skills.

## Modes

| Command | What it does |
| --- | --- |
| `codezy` | interactive chat (TUI) |
| `codezy "prompt"` / `codezy -p` | one-shot chat, prints and exits (stdin works) |
| `codezy exec\|run "prompt"` | one-shot **agent** run — tools, approvals, exit codes |
| `codezy --agent` | agent REPL with per-action approval (`/auto` toggles) |
| `codezy doctor` | health check: node · package · settings · endpoint · hooks · mcp |

Flags: `--model <id>` · `--dir <path>` (workspace root, alias `--root`) ·
`--url <url>` · `--ctx <n>` · `--auto` · `--output-format text|json|stream-json`.
`codezy --help` prints the full screen.

## REPL commands

`/help` lists all 33 commands — `/resume` / `/open` (terminal saves + app
chats), `/save`, `/link <dir>`, `/apply`, `/diff`, `/theme`, `/usage`,
`/doctor`, `/quit` and more. The agent REPL adds `/root`, `/todos`, `/mcp`,
`/search <q>` (instant web search, no model), `/model <id>`, `/tools`,
`/auto [on|off]` and `/export [f]`. Type `/` and the command palette opens
itself.

## Exit codes

`0` ok · `1` runtime error · `2` usage error

## License

MIT · <https://github.com/jaunchun/Codezy>

# CODEZY

> **Claude Code–style chat for your models — local first, cloud ready.**
> An Electron desktop client that talks to **Ollama** running on your machine (or any
> OpenAI-compatible API), with a coding agent that can read and edit files, run commands,
> search the web and keep todos — plus a matching terminal agent.

![version](https://img.shields.io/badge/version-3.2.0-6FA8FF) ![license](https://img.shields.io/badge/license-MIT-green) ![tests](https://img.shields.io/badge/tests-2366%20checks%20%C2%B7%2052%20batches-brightgreen) ![electron](https://img.shields.io/badge/Electron-44-9fe8ff)

> **Field manual:** open [`docs/index.html`](docs/index.html) — models, agent mode, the CLI, and 37
> known errors with a fix for each. Self-contained; works offline.

---

## Contents

- [Features](#features)
- [Installation](#installation)
  - [1. Prerequisites — Node.js](#1-prerequisites--nodejs)
  - [2. Prerequisites — Ollama](#2-prerequisites--ollama)
  - [3. Pull a model](#3-pull-a-model)
  - [4. Install and build CODEZY](#4-install-and-build-codezy)
- [First run — welcome & autosetup](#first-run--welcome--autosetup)
- [Using CODEZY](#using-codezy)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings](#settings)
- [Terminal companion (CLI)](#terminal-companion-cli)
- [Where your data lives](#where-your-data-lives)
- [Development & testing](#development--testing)
- [Troubleshooting](#troubleshooting)
- [What's new in 3.2.0](#whats-new-in-320)
- [What's new in 3.1.7](#whats-new-in-317)
- [What's new in 3.1.6](#whats-new-in-316)
- [What's new in 3.1.5](#whats-new-in-315)
- [What's new in 3.1.3](#whats-new-in-313)
- [What's new in 3.1.2](#whats-new-in-312)
- [What's new in 3.1.1](#whats-new-in-311)
- [What's new in 3.1.0](#whats-new-in-310)
- [What's new in 3.0.0](#whats-new-in-300)
- [What's new in 2.6.1](#whats-new-in-261)
- [What's new in 2.6.0](#whats-new-in-260)
- [What's new in 2.5.0](#whats-new-in-250)
- [What's new in 2.4.0](#whats-new-in-240)
- [What's new in 2.3.0](#whats-new-in-230)
- [License](#license)

---

## Features

| Area | What you get |
| --- | --- |
| **Local engine** | Talks to Ollama at `http://127.0.0.1:11434`. Launch only checks whether it's running — the first chat **starts Ollama for you** if the engine is down, and the sidebar keeps watching until it answers. |
| **Cloud too** | Built-in presets for **Nebius Token Factory**, **OpenRouter**, **Groq**, **DeepSeek**, **Together AI**, **Mistral**, **OpenAI** and **LM Studio**, plus any other OpenAI-compatible endpoint (base URL + key). |
| **Coding agent** | `list_dir · read_file · write_file · edit_file · grep_search · glob · run_command (background too) · web_search · todo_write · task_status · delegate` — with live "thinking / writing…" activity, per-step traces and approval prompts; background runs surface in a **Background tasks panel** (live status, output tail, stop button). |
| **Cowork pane** | Press **Ctrl+E**: browse the chat's linked folder, open files side-by-side with the conversation, and watch the AI cursor move as the agent writes. |
| **Modes** | **plan** (advice only) · **build** (you accept every edit) · **auto** (edits apply immediately, always backed up). Effort: **light / medium / deep**. |
| **Safe edits** | Every apply is previewed as a real diff and backed up first — review it **hunk by hunk** and keep exactly the changes you want; one `/undo` reverts the batch. |
| **MCP** | Add any stdio **Model Context Protocol** server in Settings → Tools → MCP servers; its tools join the agent as `mcp__server__tool` in build mode — one broken server never blocks a run. |
| **Images** | Attach screenshots to a chat — capable models (local Ollama vision models, OpenAI-compatible endpoints) actually **see** them. |
| **Edit history** | `/history` lists every safety copy taken before an edit; restore any point in time (confinement and a binary guard included). |
| **Updates** | Checks **GitHub** for a newer CODEZY and installs it **in place** — a small pill in the top bar, a percentage while it downloads, and no second app. |
| **First run** | A three-step welcome (01 welcome → 02 connect → 03 ready) with a **live engine status** and a one-click **“Start with local Ollama”** path. |
| **Boot animation** | The CODEZY logo pops in on startup and flies onto its perch in the title bar. |
| **Sessions** | Chat sidebar with per-chat linked folders, resume, export to Markdown, `/rewind` step-back, clipboard copy. |
| **Memory & skills** | `# fact` or `/remember` pins facts to `memory.md`; `/skill` activates prompt playbooks from the skills folder. |
| **Command palette** | **Ctrl+K** for the simple action and command list; **Ctrl+U** opens the usage dashboard when Advanced features is on. |
| **Themes** | **Graphite** (the default), **Paper**, **Contrast** and **Singularity**; cobalt signal accent plus lime / amber / magenta, font size, reduced motion. |
| **Terminal TUI** | The same brain in your terminal: `codezy` — 33 slash commands, resume saves, image attach, vim mode. |

---

## Installation

CODEZY runs from source. You need **Node.js** and **Ollama** — everything else is installed
by npm. (Primary target is **Windows**; the app is plain Electron, so macOS and Linux work
from source as well.)

### 1. Prerequisites — Node.js

Download the **LTS** installer from **<https://nodejs.org>** and run it (defaults are fine).

Check it worked:

```powershell
node -v     # e.g. v20.x / v22.x
npm -v
```

### 2. Prerequisites — Ollama

Ollama is the local engine that runs the models. **Download it from <https://ollama.com/download>**:

| OS | How |
| --- | --- |
| **Windows** | Get the installer from <https://ollama.com/download/windows>, **or** in a terminal: `winget install Ollama.Ollama` |
| **macOS** | Download the `.dmg` from <https://ollama.com/download/mac>, **or**: `brew install --cask ollama` |
| **Linux** | `curl -fsSL https://ollama.com/install.sh \| sh` |

Verify:

```powershell
ollama -v
```

> You don't have to start it yourself — **CODEZY launches `ollama serve` for you the first
> time you actually chat** if the engine is down. Opening the app itself never boots it.

### 3. Pull a model

CODEZY's default model is **`qwen2.5-coder:7b`** (~4.7 GB download; 8 GB RAM minimum,
16 GB comfortable):

```powershell
ollama pull qwen2.5-coder:7b
```

Any other Ollama model works too - pick it later in **Settings → Models** or with `/model`.
Want a cloud model instead? Skip this step and connect a provider during setup.

### 4. Install and build CODEZY

Open a terminal in the `codezy` project folder:

```powershell
cd path\to\codezy

npm install        # installs dependencies + Electron (one-time, a few minutes)
npm run build      # production build → out/
npm run preview    # launch the built app
```

For day-to-day development:

```powershell
npm run dev        # dev server with hot reload
```

Prefer the terminal companion? It ships as its own package (`codezy-cli`):

```powershell
npm i codezy-cli          # add -g to put codezy on your PATH
```

The [CLI home page](https://github.com/jaunchun/codezy-cli#readme) covers setup,
commands and flags.

---

## First run — welcome & autosetup

1. **The logo appears** in the middle of the window and flies into the title bar.
2. **01 · welcome** — a live status pill reads your engine as CODEZY boots it:
   - **“Ollama ready — local engine detected”** → click **Start with local Ollama** and you're in.
   - Still starting? It flips green by itself; or click **Continue** to
     **02 · connect** a cloud provider (Nebius key, OpenRouter, LM Studio keyless, or a
     custom OpenAI-compatible URL).
3. **03 · ready** — **Open CODEZY**. That's it; everything is changeable later in
   **Settings (Ctrl+,)**, and **Run setup** brings the wizard back.

---

## Using CODEZY

- **Chats** — `Ctrl+N` starts a new one; the sidebar keeps them all. Each chat can link a
  folder (`/add-dir <folder>`).
- **Cowork pane (Ctrl+E)** — the workspace next to the chat: file tree, editor, and the AI
  write cursor. The file you're looking at rides along as an accent chip on the composer,
  so the next message always knows what you're on.
- **Sending** — Enter sends (configurable), Shift+Enter makes a new line. Attach images by
  pasting them. Typing while a reply streams **interjects**: the partial answer is kept as
  “*(cut off by your next message)*” and yours goes next. **Stop** always works — switch
  chats mid-reply and each conversation keeps its own stream.
- **Edits** — in build/auto mode the agent proposes file edits: open the preview to read
  the diff, then **Accept**, **Always** or **Decline** (`Ctrl+Enter` accepts while the
  preview is open). Everything is backed up first, `/undo` reverts the last batch.
- **Commands** — type `/` in the composer for suggestions. The simple surface is 12 core commands; `/help all` (or Settings → Advanced features) reveals the rest. Highlights:

  | Command | Does |
  | --- | --- |
  | `/help` · `/new` · `/clear` | basics |
  | `/model` · `/provider` · `/effort` · `/mode` | engine & behavior |
  | `/theme` · `/fast` · `/goal` · `/btw` | look & focus |
  | `/diff` · `/undo` · `/review` · `/init` | file work |
  | `/remember <fact>` · `/memory` · `/skill` | memory & playbooks |
  | `/search <query>` · `/doctor` · `/usage` · `/cost` | utilities |
  | `/export` · `/copy` · `/rewind` · `/compact` | transcript care |

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+N` | New chat |
| `Ctrl+K` | Command palette |
| `Ctrl+E` | Show / hide the cowork pane (Advanced features) |
| `Ctrl+B` | Show / hide the sidebar (focus mode) |
| `Ctrl+,` | Settings |
| `Ctrl+U` | Usage dashboard (Advanced features) |
| `Ctrl+F` | Find in chat |
| `Ctrl+Enter` | Accept edits (when the preview is open) |
| `Ctrl+/` | Shortcut cheat sheet |
| `Enter` / `Shift+Enter` | Send / new line (flips with the *Enter sends* setting) |

While a reply streams, the composer's send button turns into **Stop** (also available as
“Stop generating” in the Ctrl+K palette). `Esc` closes whatever popover or bar is open.

---

## Settings

**Ctrl+,** opens four categories in the simple UI. Advanced features adds **Tools** and **Data**:

- **General** — profile name, the simple/advanced switch, theme (graphite / paper / contrast / singularity), accent color, font size,
  reduce motion, window and tray behavior, notifications, Enter-to-send, logs folder.
- **Models** — Ollama URL, active provider and model, provider keys for Nebius Token
  Factory, OpenRouter, LM Studio or any OpenAI-compatible endpoint, plus the
  supported-model guide.
- **Agent** — reply mode (plan / build / auto), effort default, auto-continue,
  and project instructions.
- **Tools** *(advanced)* — MCP servers: add a stdio server, see its status, tools and failures.
- **Data** *(advanced)* — data folder, learning and `memory.md`, backup / export / import.
- **About** — version and update checks.

Every control from the old single page is still present; the palette’s Settings jumps
open the right category before scrolling.

---

## Terminal companion (CLI)

The same agent, in your terminal — its own package
([`codezy-cli`](https://github.com/jaunchun/codezy-cli)) and its own repo, so it
needs no Electron build. One install puts `codezy` on your PATH —
**Windows, macOS and Linux**. `codezy` opens one unified REPL with four modes;
its only runtime dependency is
[`nanospinner`](https://www.npmjs.com/package/nanospinner) for the live phase
line. The desktop app's **Open terminal interface** launches this same REPL,
bundled with the installer.

```bash
npm i codezy-cli               # add -g to put codezy on your PATH

codezy --help                  # one screen: usage, options, agent commands, exit codes
codezy doctor                  # node · package · settings · endpoint · model · hooks · mcp · git
codezy doctor --json           # the same report as one machine-readable line (CI/scripts)
```

Full command, option and REPL reference:
[the CLI home page](https://github.com/jaunchun/codezy-cli#readme).

- Shares settings, memory and sessions with the desktop app.
- `/help` lists every command: `/resume` / `/open` (terminal saves + app chats),
  `/save`, `/link <dir>`, `/apply`, `/diff`, `/theme`, `/mode`, `/model`,
  `/root`, `/todos`, `/mcp`, `/tools`, `/export`, `/doctor`, `/exit` and more.
  TAB completes every command.
- `/mode` switches between **chat**, **agent**, **plan** and **auto** in place;
  `--chat`, `--plan` and `--auto` start there directly.
- A `nanospinner` braille phase line (`⠋ › run command npm test…`) holds the
  bottom while the model works — the live phase, elapsed seconds after two, and
  frames dropped while you type or answer an approval. There are no step
  counters; the activity ledger is the order.
- The agent can **`web_fetch`** a URL a search surfaced — HTML is stripped to prose,
  `maxChars` caps it, http(s) only.
- Drop an image path into a message and it attaches (`📷 1 image attached`).
- Edit proposals answer to keys: `y` apply · `a` always · `s` skip · `d` diff.
- Keys: `↑`/`↓` history, type `/` and the command palette opens itself (filters as you
  type; Enter runs a typed command, or accepts the highlighted row), `esc esc` rewind
  picker, `ctrl+p` palette, `ctrl+c` exit.

---

## Where your data lives

| Location | Contents |
| --- | --- |
| `~/.codezy/` | `settings.json` (shared with the CLI), `memory.md`, saves, backups, skills |
| Linked folder | `CODEZY.md` — generated project context (`/init`) |
| Google Drive (optional) | `/drive <folder>` mirrors sessions into a Drive folder |

Nothing leaves your machine unless you point CODEZY at a cloud provider — prompts, files
and memory stay local.

---

## Development & testing

```powershell
npm run typecheck   # tsc --noEmit
npm run dev         # electron-vite dev
npm run build       # electron-vite build → out/
```

**Regression suite** — 21 headless batches, **948 checks**, no model or GUI needed for
most of them. From the project root:

```powershell
$t = (Resolve-Path tests\.tmp).Path   # keep every temp file inside the project
$env:TEMP = $t; $env:TMP = $t
$env:USERPROFILE = "$t\regress-home"; $env:HOME = "$t\regress-home"

foreach ($n in 1..21) {
  $out = & node "tests\batch$n-test.mjs" 2>&1 | Out-String
  "batch$n  PASS=$(([regex]::Matches($out, '(?m)^PASS')).Count)  FAIL=$(([regex]::Matches($out, '(?m)^FAIL')).Count)"
}
```

> Run batches one at a time (`node tests\batch5-test.mjs`) when debugging; batch5 talks to
> a live model and the clipboard, so it needs a working Ollama and Windows PowerShell.
> batch11 starts a throwaway HTTP server — if its `--url` check fails once, rerun it.
> Use **absolute** paths for the temp redirection above — relative ones break subprocess
> working directories.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Sidebar says **Ollama offline** | The dot refreshes every few seconds, and the next message starts the engine itself. Or start it manually with `ollama serve`, or check the URL in **Settings** (default `http://127.0.0.1:11434`). |
| **Model not found** | `ollama pull qwen2.5-coder:7b` (or switch model with `/model`). |
| Port already in use | Something else owns `11434` — either use it (set the same URL in Settings) or stop it and let Ollama take the port. |
| Reply stops mid-code | Auto-continue finishes truncated replies (Settings → Agent); or just say "continue". |
| Cloud provider won't connect | Re-enter the key in Settings (`/provider nebius <key>` in the CLI), and confirm your account has credit. |
| Editor feels busy | Settings → General → **reduce motion**. |
| Need a health check | Run `/doctor` — endpoint, model, folder, memory at a glance. |

---

## What's new in 3.2.0

- **A quieter desktop, restyled end to end.** "Graphite Signal" replaces the
  old glass-and-glow surfaces: layered graphite, warm off-white type, hairline
  rules, one cobalt signal colour and no bloom. Layout, navigation, shortcuts
  and behaviour are unchanged — this is a visual pass.

- **Four themes, one picker.** **Graphite** is the new default, **Paper** is the
  warm light surface, **Contrast** is for bright rooms, and **Singularity**
  stays selectable with its black-hole backdrop and obsidian tokens. Cobalt is
  the default accent; lime, amber and magenta remain.

- **One CLI REPL.** `codezy` now opens the same agent REPL as `--agent`: one
  prompt, four modes (`/mode` → chat, agent, plan, auto), the same flags and
  file formats. The banner, help screen, activity ledger and stat line were
  rebuilt for 3.2.0.

- **`/settings` is a live screen, not a poster.** Every row that can change is
  numbered; type the number, pick from the choices, and the change lands
  immediately — theme, accent, thinking, model, fast model, mode, approvals and
  the workspace root. It runs the very same slash commands the panel
  advertises, so the screen and the commands can never disagree. In a pipe it
  stays the read-only map, because a script's next line is data, not an answer.

- **The home screen names the project.** The banner shows the workspace folder
  (`codezy-cli`) instead of the whole path — a home screen should say where you
  are, not print your directory tree. `/root` still shows the full path.

- **The spinner is nanospinner, visibly.** A cobalt braille phase line
  (`⠋ › thinking`, `⠋ › run command npm test`) replaces the step labels; the
  elapsed time appears after two seconds and frames drop while you type. There
  is no "step 3" anywhere — the activity ledger is the order.

- **The desktop button runs it.** **Open terminal interface** now launches the
  bundled `index.mjs` REPL instead of the legacy TUI; `codezy.mjs` remains as a
  fallback. The installer carries the CLI, its `src/` tree and nanospinner, so
  it works without a global npm install.

- **Nothing lost.** Every CLI flag, slash command, output format and settings
  file still works; piped output stays ANSI-free unless colour is forced.

The 3.1.7 notes below stay untouched as history.

---

## What's new in 3.1.7

- **The updater finds the release again.** A release whose installer is named
  `CODEZY-Setup.exe` now takes its version from a semver tag (`3.1.7`) instead
  of being skipped, so the GitHub release and the app agree. This is the
  mismatch that made 3.1.5 report itself as the latest version while 3.1.6 was
  already published.

- **One toast, not a wall.** Repeated "check now" or `/update` runs no longer
  stack identical notices — the message already on screen is the only copy.

- **Simple by default.** The app now opens with the 12 commands most people
  actually use: `/help`, `/clear`, `/new`, `/model`, `/provider`, `/mode`,
  `/copy`, `/compact`, `/undo`, `/export`, `/add-dir`, `/update`. The palette,
  Settings, composer, sidebar and title bar keep only the essentials; token
  meters, thinking/web controls, Projects, Drive, cowork/preview, the terminal
  entry, the MCP/storage/memory panes and 24 extra commands are hidden.

- **Nothing was removed.** One switch brings it all back: Settings → General →
  **Advanced features**. In a chat, `/help all` lists every command. Hidden
  advanced commands still parse and run exactly as before.

- **Live edits — watch the agent code.** A new panel streams the agent's file
  edits the moment it starts writing them, diff by diff, before you accept
  anything; a blinking caret marks the exact line being written. It opens by
  itself on the first edit (close it and it stays closed until you reopen it),
  shares its slot with the cowork/preview panes, and is always reachable from
  the title bar or the palette ("Live edits") — it's a core feature, so it
  stays visible in simple mode.

The updater changes are independent of the UI simplification and the live
edits panel; the agent, models and CLI behaviour are unchanged. The 3.1.6 notes
below stay untouched as history.

---

## What's new in 3.1.6

- **The CLI has a home page now.** [`cli/README.md`](cli/README.md) was rebuilt
  as a package page rather than an appendix: badges, a three-command quickstart,
  a terminal still, an honest chat-vs-agent table, the spinner explained, every
  command and flag, approvals, REPL reference, CI contract, doctor table and
  privacy notes. The npm page is the first thing a new user sees; it now says
  what CODEZY is in one screen.

- **The spinner gets top billing.** The agent REPL's
  [`nanospinner`](https://www.npmjs.com/package/nanospinner) line is documented
  as part of the interface, not apologised for: it names the live phase
  (`thinking`, `read file …`, `run command …`), adds elapsed seconds after two,
  drops frames while you are typing or answering an approval, writes to stderr
  and stays off in pipes. It drives the loop itself instead of `start()`, so
  Ctrl+C still interrupts a turn. The chat TUI keeps its own zero-dependency
  spinner.

- **The terminal banner names the build.** The agent REPL header now reads
  `CODEZY v2 · 3.1.6`, and `codezy --agent --preview` includes a sample phase
  line — the design sheet shows the spinner, not just the boxes around it.

- **Package identity and manual are 3.1.6.** Root and CLI manifests, both
  lockfiles, the installer filename and the field manual all report 3.1.6. The
  manual's Terminal section now explains the spinner. 3.1.4 stays skipped and
  the 3.1.5 notes below remain untouched as history.

Nothing in the harness moved: prompts, tools, approvals and model routing are
unchanged. This release is about making the terminal surface as considered as
the app around it.

---

## What's new in 3.1.5

- **Thinking mode: a button for hard problems.** The composer now has a
  **Thinking** toggle (the CLI equivalent is `/thinking on|off`). On top of
  whatever effort chip is selected it shifts sampling to the careful end,
  adds a reason-first contract to the prompt (restate → plan → consider the
  alternative → verify before answering), and in agent mode doubles the tool
  step budget. It persists in settings, so the mode survives restarts —
  flip it when a task deserves care instead of speed.

- **The agent can ask you questions.** A new `ask_user` tool lets the model
  pause mid-task and ask ONE focused clarifying question when requirements
  are genuinely ambiguous — the chain literally parks until you type your
  answer (options included), and Ctrl+C skips the question with "you
  decide". One-shot/print runs get an instant "no user here" stub, so
  headless automation never hangs, and thinking mode tells the model to ask
  instead of guessing.

- **You can always see what it's doing.** The terminal spinner now names
  the live phase — `step 3: thinking`, `step 3: run_command npm test…` —
  and a dim stat line closes every run (`✓ 5 step(s) · 12041 tokens · 43s`).
  The app's agent mode streams the same live activity ("thinking…" /
  "running grep…") as it happens, not just when a step finishes.

- **A visual round, in the singularity's own language.** The app's live
  agent rail now shows the step number and pulses with the phase — slow
  while the model thinks, quick while a tool runs — with a slow pass of
  light along it, like the accretion disk in miniature. The Thinking chip
  breathes when it is lit, a fresh chat opens on a thin arc of light
  orbiting the mark, code blocks carry a hairline of light along their top
  edge, and the sidebar's section labels read as ruler marks while the
  active row wears a rail of white. Modals, popovers and toasts become
  obsidian panels with a line of light along their top edge, the scrim
  behind them deepens, and GFM tables, task lists, quotes and rules in a
  reply finally look like they belong to the app instead of the browser.
  In the singularity theme the title bar gets a horizon and the wordmark a
  faint bloom — all monochrome, all transform-only, and every motion stands
  still when reduced motion is on.

- **A real reading experience.** Replies now have a proper type scale —
  headings that step down cleanly, a calmer reading rhythm, quieter list
  markers, and links that look like links. A fresh chat opens on a
  composed welcome: the mark under a ring of light, the wordmark set wide
  and light, a one-line tagline, four starter cards that lift and light
  their top edge, and a row of keyboard hints. Messages arrive with a
  whisper of motion instead of blinking in, and a breath of light sits
  behind the conversation column.

- **The terminal got the same treatment as the app.** The agent REPL now
  opens with a bordered header card — model, endpoint, context, tools,
  fast model, thinking mode, workspace — instead of a flat line, a run
  reads as a ledger (`1 ⎿ read file   src/main/index.ts · 143 lines ·
  118ms`), a question the model asks you arrives in its own framed card,
  `/help` is laid out in aligned sections, and the prompt itself shows
  the mode (`you> `, or `you* ` while thinking). `codezy v2 --preview`
  prints the whole terminal chrome with no model and no session, so the
  look can be reviewed on its own.

- **The look, in every theme.** The horizon under the title bar, the seam
  of light above the composer, the lit active row in the sidebar, the
  breath of light behind the conversation column, the glowing send button
  and the Thinking chip all follow each theme's **own** accent now — so
  the acrylic, dark and light surfaces get the same craft as the black
  hole, instead of looking like the app didn't change. (And the
  singularity theme is where the whole thing is designed to live: the
  ray-traced black hole, obsidian panels, the mark under its ring of
  light.)

- **The web actually works now.** DuckDuckGo was answering the agent with
  an anti-bot page that parsed as "no results" — that is why searching
  came up empty. It now speaks to the engine like a browser, falls back to
  key-free sources when it is rate-limited, digs the line that holds the
  answer out of the pages, and **labels** it, so a 7B model quotes the
  live value instead of the release it remembers. The normal chat (which
  has no tools) searches for the model and says so in the chat; the
  composer's **web** chip switches between auto, always and off.

- **A live preview of the site you're building.** The chat's folder is
  served over its own scheme, so the preview is the real site — relative
  CSS, JS and images resolve — and it reloads the moment the agent writes
  a file. It also takes a dev-server URL, and it frames the page at
  desktop, tablet or phone width.

- **"Open terminal interface" works in the installed app.** The chat TUI
  now ships with CODEZY (outside the asar, node builtins only), so the
  button opens the real terminal agent in your project folder — no npm
  install, no asar path errors. The agent REPL is still its own package.

- **The agent harness got faster, tougher, and remembers more.** Read-only
  tools (dir listings, file reads, greps, globs, web lookups) now run
  concurrently instead of one-by-one, transient network errors retry with
  backoff instead of failing the turn, and every run reports its token
  usage. The v2 REPL gained an elapsed-time spinner, `a=always` approval
  previews, session saves under `~/.codezy/agent/` with `/resume` and
  `-c/--continue`, automatic `/compact` past 60% of context, `/usage`, and
  Ctrl+C that interrupts cleanly without losing the chain.

- **Two models, one session — built for long coding sessions.** A "fast"
  model role (`/model fast <id>`, or `fastModel` in settings) takes the
  cheap work — conversation summaries during `/compact` and every scout run
  — so the main model keeps its context for real coding. `/scout
  <question>` is a read-only research run in fresh context: it can list,
  read, grep and search but never writes, and files its digest back into
  the conversation. A stall watchdog now streams from Ollama and retries a
  wedged generation after 90 seconds of silence instead of hanging
  forever, cloud calls get a 10-minute ceiling, and the agent can't
  declare "done" while a checklist item is still in progress — it gets
  pushed back into the loop (twice max, never a nag-loop).

- **The composer stays live while the model talks** (terminal chat). Type
  during a reply: slash commands stop the reply and run, plain lines queue
  and auto-send after (`· 1 queued` shows in the progress row), Esc still
  stops the stream, Shift+Enter breaks a line — and keys are never eaten
  between turns anymore. Fast typing over a pipe no longer swallows the
  first keystrokes.

- **Windows, macOS, Linux.** The app now builds for all three (dmg/zip and
  AppImage/deb targets alongside the Windows installer), "Open terminal
  interface" follows a real per-OS plan (Windows Terminal → cmd, Terminal.app
  on macOS, x-terminal-emulator → gnome-terminal → konsole → xfce4-terminal →
  xterm on Linux) with a visible "tried these" error instead of a silent
  no-op, `launch.sh` starters ship for both roots, and the updater picks the
  asset for YOUR platform — off Windows it opens the release page rather
  than trying to run an .exe.

- **The window remembers itself.** Position, size and maximized state are
  restored on every launch, sanitized against the monitors that exist now —
  an unplugged display can never strand the window off-screen, and the title
  strip always keeps a grabbable edge.

- **A tray icon, and it stays running.** Settings → General → Appearance & window makes ✕ hide CODEZY
  into a tray icon (first time, a balloon tells you where it went;
  left-click toggles the window, right-click quits). Startup launches CODEZY
  at login, optionally straight into the tray with no window flash.

- **Zoom that sticks, and a window that stays put.** Ctrl/Cmd +/−/0 scales
  the whole interface live and the level survives restarts; Settings →
  General → Always on top keeps the chat above your editor.

- **One click starts the engine.** The sidebar's offline dot is now a
  button — click it to boot `ollama serve` from inside the app, with a
  status notice when it answers, instead of hunting for a terminal.

- **Finished replies are one click away.** With notifications on, clicking
  the OS notification focuses CODEZY immediately.

- **Crashes leave a paper trail.** The main log (`~/.codezy/logs/main.log`)
  records launches, hangs and renderer crashes with 512 KiB rotation; a
  crashed renderer reloads itself (capped) instead of leaving a dead
  window; Settings → General → Diagnostics opens the logs folder.

- **`codezy://` deep links.** The app registers its own protocol — opening
  a `codezy://` URL focuses the window and logs the request (session
  targeting lands later).

- **`codezy doctor --json`.** The health check can print one
  machine-readable line — version, endpoint, model, and every check with
  its status — for CI and scripts; the human report is unchanged, and
  `--help` documents the flag.

- **Agent mode is on by default — and only when it can work.** Existing
  settings migrate once (`agentModeMigrated`). A folder-linked chat asks
  Ollama `/api/show` what the selected model can do before any tools
  schema is attached. A completion-only model such as `codellama:13b`
  now falls back to classic edit blocks with the real folder contents and
  a plain notice, instead of `Ollama error 400: … does not support tools`.
  The composer badges models **tools** or **chat only**, and Settings
  gains a supported-model guide with RAM guidance and pull commands.

- **The prompt states the setup twice.** A setup card in the system
  prompt and a synthetic turn immediately before your question repeat the
  linked folder, edit mode, web mode and model limits — small models
  weight the newest turn most heavily. Classic chat now receives the real
  text-file contents, not just a tree, while secrets, binaries and
  `node_modules` are skipped.

- **Errors read like instructions.** Every error toast is reduced to
  **what happened** and **what to do**; the raw engine text lives under
  **Technical details**, with an explicit close button and no truncated
  useful part. “That path is outside the folders linked to this chat” now
  names the boundary instead of dumping a JSON payload.

- **No more repeated-tool spirals.** The shared harness skips a third
  consecutive identical read-only call and gives the model one tool-free
  turn to answer from the evidence it already has. Live `qwen2.5-coder:7b`
  now reports the current Ollama release and URL in six steps instead of
  fetching the same page until the iteration cap.

- **Settings is a map now, not a long scroll.** Six categories — General,
  Models, Agent, Tools, Data and About — hold every control from the old
  page. Notifications and input sit in General, the supported-model guide in
  Models, MCP under Tools; the original section labels remain, and every
  deep link or Ctrl+K jump opens its category before scrolling.

- **The terminal explains itself.** `codezy --help`, `codezy exec --help`
  and `codezy doctor --help` print command-specific pages with aligned
  options, a short “what it does”, and exit codes. The REPL banner reports
  the selected model’s capability from Ollama `/api/show`; `/model`
  re-probes after a switch.

- **A field manual you can navigate.** [`docs/index.html`](docs/index.html)
  now opens as three columns — the eight categories, the guide, and “On
  this page” — with one search field over section titles, subheadings and
  all 37 errors. The catalogue is still collapsed by default, each entry
  still has a cause and a fix, and the page is still dark-only,
  dependency-free and `file://` safe.

---

## What's new in 3.1.3

- **New surface theme: Singularity — a live black hole.** A strictly monochrome
  deep-space scene you can actually watch, built to match real black-hole
  renders: a pitch-black event horizon hangs dead-centre of the window, edged
  by a thin, blazing photon ring with a second, tighter image stacked just
  outside it, while a tilted accretion disk sweeps past almost edge-on — its
  near side crossing in front of the shadow, its far side lensed up and over
  the top as a broad crown of light, with a mirror sliver tucked underneath.
  The disk gas is real turbulence — seamless noise filaments sheared into
  spirals by Keplerian differential rotation (inner gas laps the outer), each
  strand drawn as a sharp thread with dark gaps between — and relativistic
  beaming blows the approaching side to white while the receding side stays a
  dull grey. Highlights roll off filmically like a real exposure, a tilted
  bloom rides the disk plane and an anamorphic streak lances through the hole;
  infalling sparks flare as they cross the horizon, and down the left a
  cascade of white light pours. Sidebar, chat and cards sit on top as obsidian
  silhouettes with a hairline of light; the composer throws a blinding white
  glow; and it all settles to one quiet frame when motion is reduced. No
  colour anywhere — black, white, grey.

---

## What's new in 3.1.2

- **The installer got a full redesign.** The grey 90s dialog is gone: the
  installing window is now a compact dark Chrome-setup-style panel — dark
  title bar, the CODEZY mark top-center, a quiet "Installing …" line, a thin
  Google-blue progress hairline and a plain-text *Cancel* wired to the stock
  abort flow. Purely cosmetic: silent installs (`/S`), the uninstall registry
  key and in-app updates are byte-identical to before, and the uninstaller
  builds none of it.

- **Chats no longer need a linked folder to use v2.** Linking a folder was
  only ever required for code mode, but a chat without one silently fell back
  to plain chat even when v2 was on. The check is now "is this code mode?",
  not "is a folder linked?" — plain v2 chats just work, and code mode still
  tells you to link a folder when you ask it for files.

- **The acrylic theme no longer breaks the delete confirmation.** Deleting a
  chat in the acrylic (Windows blur) theme opened its confirm menu over an
  unblurred hole. The blur is now re-applied the moment the menu opens, so
  the confirm reads cleanly in every theme.

- **The effort/mode popovers fan outward — the hop to mode is gone.** The
  two badges sit side by side and each popover is wider than the gap between
  them, so anchored inward they sat right on top of their sibling badge: the
  trip to an effort option lit the mode popover up under the cursor and the
  pick "hopped to mode". The left badge's popover now opens left, the right
  badge's opens right — proven in a headless browser with real mouse journeys:
  the effort trip never wakes mode, both popovers can be open at once without
  intersecting, and both stay inside the composer rail.

- **Deleting a chat asks first.** The trash on a chat row used to hard-delete
  on a single click. It now opens a small confirm menu ("Delete this chat?" —
  *Delete chat* / *Cancel*); Cancel, Escape or clicking anywhere else backs
  out, clicking the trash again toggles the menu, and only the confirm
  actually deletes. The right-click menu's own two-step "Really delete?"
  stays as it was.

---

## What's new in 3.1.1

- **The invisible corridor, done properly** — the effort/mode popovers now
  hold open over a static *quad corridor* between the badge's edge and the
  popover's edge (the same geometry every good menu system uses), plus a
  260 ms grace when the pointer slips out — so diagonal, curved or sideways
  sweeps between the two boxes all just work, in either direction. Real
  mouse journeys are replayed in a headless browser to prove it: 16 checks
  covering hover, click-pin, travel, hit-testing, picking, closing and the
  grace window.

- **The installer updates in place** — NSIS one-click: double-clicking any
  `CODEZY-Setup-*.exe` now always replaces the existing install at the
  standard location (no directory page to mis-click into a second copy),
  never touches your data in `%APPDATA%\CODEZY`, and is exactly what the
  in-app updater runs. If you currently have two CODEZY entries, uninstall
  the extras once in Settings → Apps; from then on it's one app forever.

---

## What's new in 3.1.0

A hardening pass over 3.0 — it fixes the two interactions people actually
touch first, and puts running background work where you can see it.

- **Effort & Mode popovers finally work** — the little `E` / `M` circles by
  the composer got a proper interaction model: **hover previews, click pins
  the menu open** (click again, click outside, or Esc to let go), and an
  invisible triangle between badge and popover keeps it open while the cursor
  travels across the gap — so a pick can no longer close the menu mid-flight.
  Three real bugs died here: the hover-intent class was silently dropped
  during an earlier refactor (hover travel never worked), fast flicks left
  the menu stuck open (the exit anchor pointed at the destination, not the
  exit), and a picked option kept focus, trapping the menu open via
  `:focus-within`. All of it is now pinned by a real-browser test that
  replays the actual click journey with a real mouse.

- **Background task panel** — every `run_command` that keeps running shows a
  live chip next to the composer with the running count; click it for the
  panel: one row per task with elapsed time and an output tail, a **stop**
  button per task, and per-workspace numbering (`app #1`, `server #2` — the
  same task names the agent sees). The list polls itself while open, and the
  count updates instantly after any command starts or stops, in any chat.

- **Cowork cursor that follows the agent** — the AI cursor in the editor
  now auto-scrolls to follow the agent while it works (streaming-aware, with
  a grace period after the last change), tracks the caret horizontally, and
  its lifetime is tied to the run — it no longer vanishes the moment the
  measurement hides it.

- **Ollama starts when you chat, not when you launch** — the app no longer
  pokes the local server at boot; it comes up on the first chat that needs
  it, so startup is faster and nothing sits in VRAM until asked.

- Plus the small stuff: approval diffs announce themselves to screen
  readers, the settings screen handles a missing drive folder gracefully,
  and the `/diff` approval dialog never shows an empty state.

---

## What's new in 3.0.0

The big one — CODEZY 3.0 turns the assistant into a proper coding agent,
makes every edit reviewable, connects to the outside world, and gets a full
visual makeover.

- **Agent superpowers** — the agent gained `edit_file` (targeted edits instead
  of full-file rewrites), `glob`, `task_status`, **background commands**
  (`run_command` can keep running while the agent works — check or stop it
  anytime), and **sub-agents**: `delegate` spins up a depth-limited helper
  that shares the same tool registry, approval gate and hooks. Iteration caps
  (light / medium / deep → 8 / 15 / 30 steps) keep runs bounded.

- **Review-first editing** — proposed edits are now reviewed **hunk by
  hunk**: a real diff view where you tick exactly the changes you want and
  skip the rest; what gets written is composed from *your* selection. The
  approval dialog shows real diffs too, with the raw arguments tucked into a
  collapsible footer.

- **Works with everything** — **MCP**: add stdio servers in Settings → MCP
  servers and their tools join the agent as `mcp__server__tool` (build mode
  only — plan mode never sees them; a dead server degrades to a chat notice,
  never a blocked run). Five new provider presets: **Groq, DeepSeek, Together
  AI, Mistral, OpenAI**. Image attachments are now real **vision input** for
  capable models — local Ollama vision models and OpenAI-compatible endpoints
  alike.

- **Full makeover** — a typography rhythm across the whole app (balanced
  headings, pretty-wrapped replies, tabular chips), a richer **layered theme
  picker** with accent glow and keyboard focus rings, unified button/field
  focus states, dialogs that ease in, accent-tinted text selection and a
  touch of depth on chat bubbles — every bit of it obeys the reduce-motion
  switch.

---

## What's new in 2.6.1

- **The first update delivered in-app** — no feature changes; this release
  exists to close the loop on the updater. Install 2.6.0, launch it, and the
  pill appears with *v2.6.1* a few seconds later → download with a live
  percentage → **restart to update** → the silent NSIS installer replaces the
  app in place and brings the new version back. The check looks at **every**
  published release (drafts and prereleases ignored) and always offers the
  newest installer it finds, whatever the release is tagged.

---

## What's new in 2.6.0

- **It updates itself** — CODEZY checks **GitHub** (`jaunchun/Codezy`) once at
  launch and when you ask (`/update` or Settings → about → *check now*). When
  a newer release exists, a **small pill appears in the top bar**: *v2.6.0 →
  Download update*. It streams the setup in the background with a real
  percentage, then restarts and **installs in place** — the NSIS installer
  reads where CODEZY already lives and replaces it silently. No separate
  updater app, no second install, no window stealing focus, and the pill can
  be waved away per version (a newer one comes back). Settings → about can
  turn the launch check off entirely.
- **The cowork tree never loses folders again** — a file cap used to break out
  of the walk and silently drop everything behind it. Folders are now always
  walked; only file rows are capped, and every cut is explained by a marker
  row (`… 12 more files (tree cap reached)`, `… N more files in this folder`,
  `… deeper folders are hidden`). The **ignored** chip now shows `dist`,
  `venv`, `.vscode` and friends while still hiding `.git` and `node_modules`.
- **Git at a glance** — every file in the tree carries its letter
  (**M / A / D / ?**) from one `git status` per linked root (2.5 s timeout,
  never a frozen window); a **git** chip switches the badges off.
- **Edit history** — `/history` (or the palette's *Edit history* entry) lists
  every backup taken before an edit, newest first, with time and file names.
  Restoring one writes a snapshot of the current files **first**, so pressing
  twice is always safe, refuses anything outside the linked folders and never
  touches a binary. *Undo newest* sits at the top.
- **Quick follow-ups** — four one-click chips under the last reply:
  *Continue · Explain · Review it · Add tests*. They never appear while a
  reply is still streaming.
- **Settings you can carry** — **export settings (.json)** and **import
  settings…** (folders deliberately left out — they never move between
  machines), a **send a test** notification, and your **custom instructions**
  now get their own `## Instructions from you` section that sits *above*
  everything CODEZY learned about you and the project context.
- **21-batch regression suite — 948 checks green.**

---

## What's new in 2.5.0

- **A model picker that actually fits** — the dropdown measures the space
  around its chip, flips above the composer when there is no room below,
  clamps itself inside the window, caps its height to what is free, and
  animates both open and closed (no more "stretches then never retracts").
  Inside: **★ favorites** and a **Recent** group (both remembered between
  launches), one filter chip per connected provider, and Home/End/PageUp/
  PageDown on top of the usual ↑↓ / Enter.
- **Chat control** — every message has **delete from here** (two clicks, so a
  stray hover can never truncate a chat), composer **drafts survive a
  restart**, a live **token counter** runs while the reply streams, and
  `/transcript` copies the whole conversation. `/pin` and `/archive` work from
  the keyboard too.
- **A sidebar you can search** — a search box over titles *and* message text
  (it reaches archived chats), **archive/unarchive** with a *Show archived*
  row, a pulsing dot on chats **generating in the background**, a recent/A→Z
  sort toggle, and one click to **export every chat** as a single Markdown
  file.
- **Settings that show their work** — a **font-size slider** (12–20 px,
  applied live), **density** (cozy/compact) that tightens every row in the
  app, **hover-to-preview themes** (leave the swatch to cancel, click to
  keep), and a keyboard-shortcut sheet button.
- **Cowork pane** — filter the tree, expand/collapse everything, **rename and
  delete files** (both confined to the linked folders; a directory can never
  be deleted), **find in file** (Ctrl+F, ↑/↓, it selects the match) and a
  **line-number gutter** that scrolls with the buffer.
- **Partial edits** — the preview ticks every file, so one file of a five-file
  proposal can be written now and the rest later. What already landed is
  remembered and never offered twice, and the accept bar only disappears once
  every block is in.
- **Palette** — eight new actions: cowork toggle, find in chat, copy the
  conversation, export all, archive, bigger/smaller text and density.

---

## What's new in 2.4.0

- **Smarter local models** — the harness repairs the "almost JSON" tool calls
  models actually write (curly/single quotes, comments, trailing commas, a
  reply cut off mid-object), takes **several tool calls per answer** (deduped,
  capped), pages big files with `read_file` `offset`/`limit` (or head+tail),
  and **shrinks old context instead of ever dropping messages** — tool pairing
  survives every round. Prompt rules: lead with the answer, real code fences,
  never invent file contents.
- **Hardened edits** — the safety copy is written **before** the first file
  write (a failed backup means nothing is applied), non-UTF-8/binary files are
  refused instead of corrupted, CRLF files keep their endings, and a partial
  `/undo` stays retryable (keeps the entries that failed, restores the true
  original even when a region was edited twice).
- **Streaming that can't wedge** — Ollama/OpenAI streams flush the last partial
  chunk and retry once when a stream dies before any token; a turn whose IPC
  never started rolls back (no more stuck "thinking…"), a failed save hands
  your draft back, and `/init` flags, tool traces and steering no longer bleed
  between chats.
- **Cowork pane** — Cancel in the file picker no longer wipes staged
  attachments, buffers don't leak across chats, and files past the editor's
  read cap open **read-only with a save guard** instead of silently truncating.
- **TUI polish** — multi-line input redraw keeps its place (vim `k`/`j`),
  proposal answers typed at the right moment aren't dropped, `--dir`/`--root`
  validate (`--root` is accepted again), `-p --dir … "prompt"` parses,
  `snake_case` and hex colors survive markdown highlighting, auto mode marks
  proposals resolved so `/review` doesn't re-offer them, token usage shows on
  every OpenAI-compatible endpoint.
- **18-batch regression suite — 518 checks green.**

---

## What's new in 2.3.0

- **Ollama auto-start** — the desktop boots the engine on launch and polls until it's up.
- **Startup logo animation** — center-screen entrance that flies onto the title bar.
- **Welcome & autosetup** — live engine status pill and one-click local start.
- **Per-session streaming** — switching chats mid-reply no longer loses replies or fakes a
  “thinking” composer; Stop targets the chat that's actually generating and a dead stream
  can never wedge the UI.
- **Cowork file chip** — the picked file rides along with the next message.
- **Effort/mode pills** float as popovers (no more row jitter in the narrow code rail).
- **Settings face-lift** + new: reduce motion, auto-continue, notify-when-done.
- **TUI**: unquoted image paths containing spaces now attach; apply notices print friendly
  short paths.
- **17-batch regression suite — 462 checks green.**

---

## License

[MIT](LICENSE) — © kajtg

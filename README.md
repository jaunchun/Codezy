# CODEZY

> **Claude Code–style chat for your models — local first, cloud ready.**
> An Electron desktop client that talks to **Ollama** running on your machine (or any
> OpenAI-compatible API), with a coding agent that can read and edit files, run commands,
> search the web and keep todos — plus a matching terminal TUI.

![version](https://img.shields.io/badge/version-3.0.0-3d9bff) ![license](https://img.shields.io/badge/license-MIT-green) ![tests](https://img.shields.io/badge/tests-1184%20checks%20%C2%B7%2025%20batches-brightgreen) ![electron](https://img.shields.io/badge/Electron-44-9fe8ff)

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
| **MCP** | Add any stdio **Model Context Protocol** server in Settings → MCP servers; its tools join the agent as `mcp__server__tool` in build mode — one broken server never blocks a run. |
| **Images** | Attach screenshots to a chat — capable models (local Ollama vision models, OpenAI-compatible endpoints) actually **see** them. |
| **Edit history** | `/history` lists every safety copy taken before an edit; restore any point in time (confinement and a binary guard included). |
| **Updates** | Checks **GitHub** for a newer CODEZY and installs it **in place** — a small pill in the top bar, a percentage while it downloads, and no second app. |
| **First run** | A three-step welcome (01 welcome → 02 connect → 03 ready) with a **live engine status** and a one-click **“Start with local Ollama”** path. |
| **Boot animation** | The CODEZY logo pops in on startup and flies onto its perch in the title bar. |
| **Sessions** | Chat sidebar with per-chat linked folders, resume, export to Markdown, `/rewind` step-back, clipboard copy. |
| **Memory & skills** | `# fact` or `/remember` pins facts to `memory.md`; `/skill` activates prompt playbooks from the skills folder. |
| **Command palette** | **Ctrl+K** for commands and actions, **Ctrl+U** for the usage dashboard (context, tokens, 12-week heatmap). |
| **Themes** | Dark · Light · **Acrylic** (Windows blur) plus midnight / ember / mint / slate palettes; accent color, font size, reduced motion. |
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

Any other Ollama model works too — pick it later in **Settings → model** or with `/model`.
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

Prefer the terminal companion? No build needed:

```powershell
node cli\index.mjs        # Windows
node cli/index.mjs        # macOS / Linux
# or make it global once:  npm link   →   codezy
```

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
- **Commands** — type `/` in the composer for suggestions. Highlights:

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
| `Ctrl+E` | Show / hide the cowork pane |
| `Ctrl+B` | Show / hide the sidebar (focus mode) |
| `Ctrl+,` | Settings |
| `Ctrl+U` | Usage dashboard |
| `Ctrl+F` | Find in chat |
| `Ctrl+Enter` | Accept edits (when the preview is open) |
| `Ctrl+/` | Shortcut cheat sheet |
| `Enter` / `Shift+Enter` | Send / new line (flips with the *Enter sends* setting) |

While a reply streams, the composer's send button turns into **Stop** (also available as
“Stop generating” in the Ctrl+K palette). `Esc` closes whatever popover or bar is open.

---

## Settings

**Ctrl+,** — highlights:

- **Appearance** — theme (dark / light / acrylic), accent color, font size, reduce motion.
- **Engine** — Ollama URL, active provider, active model, effort default, mode
  (plan / build / auto).
- **Providers** — connect Nebius Token Factory, OpenRouter, LM Studio, or any custom
  OpenAI-compatible endpoint (base URL + API key).
- **Behavior** — Enter sends, notify when a reply finishes, auto-continue truncated code.
- **Learning & memory** — toggle learning and edit `memory.md` directly.
- **Data folder** — where sessions, memory and skills live; **Run setup** re-opens the
  welcome wizard.

---

## Terminal companion (CLI)

The same agent, in your terminal — no build required:

```powershell
node cli\index.mjs
```

The CLI is also its **own npm package** (`cli/package.json`, zero dependencies — Node
builtins only), so one install puts `codezy` on your PATH:

```powershell
npm install -g .\cli      # from the repo — or: npm install -g ./cli
codezy --help             # one screen: usage, options, agent commands, exit codes
codezy doctor             # node · package · settings · endpoint · model · hooks · mcp · git
```

- Shares settings, memory and sessions with the desktop app.
- `/help` lists all **33 commands**: `/resume` / `/open` (terminal saves + app chats),
  `/save`, `/link <dir>`, `/apply`, `/diff`, `/vim`, `/theme`, `/btw`, `/compact`,
  `/usage`, `/doctor`, `/quit` and more. The v2 agent REPL (`codezy --agent`, or
  `node cli/codezy-v2.mjs`) adds `/root`, `/todos`, `/mcp`, `/search <q>` (instant web
  search, no model), `/model <id>` (switch mid-session), `/tools` (everything the agent
  can call), `/auto [on|off]` (toggle auto-approval) and `/export [f]` (save the
  conversation to markdown). TAB completes every command, and a spinner holds the line
  while the model thinks.
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
| Reply stops mid-code | Auto-continue finishes truncated replies (Settings → behavior); or just say “continue”. |
| Cloud provider won't connect | Re-enter the key in Settings (`/provider nebius <key>` in the CLI), and confirm your account has credit. |
| Editor feels busy | Settings → appearance → **reduce motion**. |
| Need a health check | Run `/doctor` — endpoint, model, folder, memory at a glance. |

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

# CODEZY

> **Claude Code–style chat for your models — local first, cloud ready.**
> An Electron desktop client that talks to **Ollama** running on your machine (or any
> OpenAI-compatible API), with a coding agent that can read and edit files, run commands,
> search the web and keep todos — plus a matching terminal TUI.

![version](https://img.shields.io/badge/version-2.3.0-3d9bff) ![license](https://img.shields.io/badge/license-MIT-green) ![tests](https://img.shields.io/badge/tests-462%20checks%20%C2%B7%2017%20batches-brightgreen) ![electron](https://img.shields.io/badge/Electron-44-9fe8ff)

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
- [What's new in 2.3.0](#whats-new-in-230)
- [License](#license)

---

## Features

| Area | What you get |
| --- | --- |
| **Local engine** | Talks to Ollama at `http://127.0.0.1:11434`. CODEZY **starts Ollama for you on launch** if it isn't running, and keeps watching until it answers. |
| **Cloud too** | Built-in presets for **Nebius Token Factory**, **OpenRouter** and **LM Studio**, plus any other OpenAI-compatible endpoint (base URL + key). |
| **Coding agent** | `list_dir · read_file · write_file · grep_search · run_command · web_search · todo_write` — with live "thinking / writing…" activity, per-step traces and approval prompts. |
| **Cowork pane** | Press **Ctrl+E**: browse the chat's linked folder, open files side-by-side with the conversation, and watch the AI cursor move as the agent writes. |
| **Modes** | **plan** (advice only) · **build** (you accept every edit) · **auto** (edits apply immediately, always backed up). Effort: **light / medium / deep**. |
| **Safe edits** | Every apply is previewed as a diff and backed up first — one `/undo` reverts the batch. |
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
| **macOS(not supported yet)** | Download the `.dmg` from <https://ollama.com/download/mac>, **or**: `brew install --cask ollama` |
| **Linux(not supported yet)** | `curl -fsSL https://ollama.com/install.sh \| sh` |

Verify:

```powershell
ollama -v
```

> You don't have to start it yourself — **CODEZY launches `ollama serve` automatically on
> startup** if the engine is down (v2.3.0). Opening the app is enough.

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

- Shares settings, memory and sessions with the desktop app.
- `/help` lists all **33 commands**: `/resume` / `/open` (terminal saves + app chats),
  `/save`, `/link <dir>`, `/apply`, `/diff`, `/vim`, `/theme`, `/btw`, `/compact`,
  `/usage`, `/doctor`, `/quit` and more. The v2 agent REPL (`node cli/codezy-v2.mjs`)
  adds its own `/root` and `/todos`.
- Drop an image path into a message and it attaches (`📷 1 image attached`).
- Edit proposals answer to keys: `y` apply · `a` always · `s` skip · `d` diff.
- Keys: `↑`/`↓` history, `esc esc` rewind picker, `ctrl+p` palette, `ctrl+c` exit.

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

**Regression suite** — 17 headless batches, **462 checks**, no model or GUI needed for
most of them. From the project root:

```powershell
$t = (Resolve-Path tests\.tmp).Path   # keep every temp file inside the project
$env:TEMP = $t; $env:TMP = $t
$env:USERPROFILE = "$t\regress-home"; $env:HOME = "$t\regress-home"

foreach ($n in 1..17) {
  $out = & node "tests\batch$n-test.mjs" 2>&1 | Out-String
  "batch$n  PASS=$(([regex]::Matches($out, '(?m)^PASS')).Count)  FAIL=$(([regex]::Matches($out, '(?m)^FAIL')).Count)"
}
```

> Run batches one at a time (`node tests\batch5-test.mjs`) when debugging; batch5 talks to
> a live model and the clipboard, so it needs a working Ollama and Windows PowerShell.
> Use **absolute** paths for the temp redirection above — relative ones break subprocess
> working directories.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Sidebar says **Ollama offline** | The app retries every few seconds and starts the engine itself. Start it manually with `ollama serve`, or check the URL in **Settings** (default `http://127.0.0.1:11434`). |
| **Model not found** | `ollama pull qwen2.5-coder:7b` (or switch model with `/model`). |
| Port already in use | Something else owns `11434` — either use it (set the same URL in Settings) or stop it and let Ollama take the port. |
| Reply stops mid-code | Auto-continue finishes truncated replies (Settings → behavior); or just say “continue”. |
| Cloud provider won't connect | Re-enter the key in Settings (`/provider nebius <key>` in the CLI), and confirm your account has credit. |
| Editor feels busy | Settings → appearance → **reduce motion**. |
| Need a health check | Run `/doctor` — endpoint, model, folder, memory at a glance. |

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

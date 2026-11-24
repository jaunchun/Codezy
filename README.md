# CODEZY

> **Claude Code–style chat for your models — local first, cloud ready.**
> An Electron desktop client for **Ollama** and OpenAI-compatible APIs, featuring an autonomous coding agent that reads/edits files, runs background commands, searches the web, and tracks todos—paired with a matching terminal REPL.

![version](https://shields.io)
![license](https://shields.io)
![tests](https://shields.io)
![electron](https://shields.io)

<!-- TODO: Replace with a screenshot or GIF of the Graphite or Singularity theme in action -->
<!-- ![CODEZY Desktop Preview](docs/preview.png) -->

> **Offline Field Manual:** Open [`docs/index.html`](docs/index.html) in any browser for full documentation on models, agent modes, CLI flags, and 37 searchable error fixes.

---

## Contents

- [Highlights](#highlights)
- [Quick Start](#quick-start)
- [Core Workflows](#core-workflows)
- [Terminal Companion (CLI)](#terminal-companion-cli)
- [Keyboard Shortcuts & Commands](#keyboard-shortcuts--commands)
- [Data & Privacy](#data--privacy)
- [Troubleshooting](#troubleshooting)
- [Development & Testing](#development--testing)
- [Release Notes](#release-notes)
- [License](#license)

---

## Highlights

| Area | Capabilities |
| --- | --- |
| **Local & Cloud Engines** | Connects to local **Ollama** (`127.0.0.1:11434`) and starts `ollama serve` automatically on your first message. Built-in presets for **Nebius Token Factory, OpenRouter, Groq, DeepSeek, Together AI, Mistral, OpenAI, LM Studio**, and any custom OpenAI-compatible endpoint. |
| **Coding Agent** | Full tool suite (`list_dir`, `read_file`, `write_file`, `edit_file`, `grep_search`, `glob`, `run_command`, `web_search`, `todo_write`, `task_status`, `delegate`) with live phase traces, background task management, and sub-agent delegation. |
| **Safe, Reviewable Edits** | Choose between **Plan** (read-only advice), **Build** (approve diffs hunk-by-hunk), and **Auto** (applies immediately with automatic snapshots). Revert batches anytime with `/undo` or `/history`. |
| **Cowork Pane (`Ctrl+E`)** | Side-by-side workspace with a git-aware file tree, live editor, and an AI cursor that follows the agent as it writes. |
| **MCP & Vision** | Connect stdio **Model Context Protocol** servers in Settings (`mcp__server__tool`). Paste or attach screenshots for local or cloud vision models. |
| **In-App Updates & Themes** | One-click in-place GitHub updates. Four built-in themes (**Graphite**, **Paper**, **Contrast**, **Singularity**) with customizable accents and reduced-motion support. |

---

## Quick Start

CODEZY runs from source on **Windows** (primary), **macOS**, and **Linux**.

### 1. Install Prerequisites
* **Node.js (LTS):** Download from [nodejs.org](https://nodejs.org) and verify with `node -v`.
* **Ollama (for local models):** Download from [://ollama.com](https://://ollama.com) or install via CLI:
  * **Windows:** `winget install Ollama.Ollama`
  * **macOS:** `brew install --cask ollama`
  * **Linux:** `curl -fsSL https://ollama.com | sh`

*(Skip Ollama if you plan to use cloud APIs exclusively.)*

### 2. Pull a Default Model
CODEZY defaults to `qwen2.5-coder:7b` (~4.7 GB download; 8 GB RAM minimum, 16 GB recommended):

```bash
ollama pull qwen2.5-coder:7b
```

### 3. Build & Launch CODEZY

```bash
git clone https://github.com
cd Codezy

npm install        # Installs dependencies and Electron
npm run build      # Builds production bundle to out/
npm run preview    # Launches the desktop app
```

*(For active development with hot reload, run `npm run dev`.)*

### 4. First-Run Setup
On launch, the 3-step welcome wizard checks your local Ollama status:
1. Click **Start with local Ollama** if detected, or click **Continue** to configure a cloud provider.
2. Re-run the wizard anytime via **Settings (`Ctrl+,`) → Run setup**.

---

## Core Workflows

* **Link a Workspace:** Run `/add-dir <folder>` inside any chat to give the agent file access. Press `Ctrl+E` to open the **Cowork pane**—whichever file you view is automatically attached as context to your next prompt.
* **Interject Mid-Stream:** Typing while the model streams cleanly cuts off the partial response and sends your follow-up next. Switching chats keeps background streams running independently.
* **Simple vs. Advanced UI:** CODEZY opens with 12 essential slash commands and 4 core settings tabs (**General, Models, Agent, About**). Toggle **Settings → General → Advanced features** (or type `/help all`) to unlock MCP servers, usage dashboards (`Ctrl+U`), memory management, and all 36 commands.
* **Persistent Memory & Skills:** Pin project facts to `memory.md` using `# <fact>` or `/remember <fact>`, and load reusable prompt playbooks with `/skill`.

---

## Terminal Companion (CLI)

[`codezy-cli`](https://github.com) brings the exact same agent, settings, and session history to your terminal with zero Electron overhead (or launch it directly from the desktop app via **Open terminal interface**).

```bash
npm i -g codezy-cli

codezy             # Launch interactive unified REPL (chat / agent / plan / auto)
codezy doctor      # Run diagnostics on Node, settings, endpoints, models, MCP & git
codezy --help      # View all flags and exit codes
```

* **Interactive Controls:** Type `/` to filter commands with `Tab` completion; press `Esc Esc` to rewind turns; attach images by dropping a file path into your message; approve diffs with `y` (apply), `a` (always), `s` (skip), or `d` (diff).

---

## Keyboard Shortcuts & Commands

### Essential Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` / `Ctrl+B` | New chat / Toggle sidebar |
| `Ctrl+K` | Open command palette |
| `Ctrl+E` | Toggle Cowork file pane *(Advanced)* |
| `Ctrl+Enter` | Accept proposed edits (when diff preview is open) |
| `Ctrl+,` / `Ctrl+/` | Open Settings / View full shortcut sheet |
| `Ctrl+F` / `Ctrl+U` | Find in chat / Usage dashboard *(Advanced)* |
| `Esc` | Close active popover or modal |

### Common Slash Commands

| Category | Commands |
| --- | --- |
| **Session** | `/new`, `/clear`, `/rewind`, `/compact`, `/export`, `/copy` |
| **Model & Mode** | `/model`, `/provider`, `/mode` (`plan`/`build`/`auto`), `/effort`, `/fast` |
| **Workspace** | `/add-dir`, `/init` (generates `CODEZY.md`), `/diff`, `/undo`, `/history`, `/review` |
| **Context & Tools** | `/remember`, `/memory`, `/skill`, `/search`, `/doctor`, `/help all` |

---

## Data & Privacy

All prompts, chat histories, and backups stay on your machine unless you explicitly configure a cloud API provider.

| Path | Contents |
| --- | --- |
| `~/.codezy/` | `settings.json` (shared with CLI), `memory.md`, session saves, edit backups, and skills |
| `<linked-folder>/CODEZY.md` | Project-specific context generated via `/init` |
| Google Drive *(optional)* | `/drive <folder>` mirrors sessions to a local Drive sync directory |

---

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| **Sidebar shows "Ollama offline"** | Send a message to auto-start Ollama, click the offline indicator, or run `ollama serve` manually. Verify the endpoint URL in **Settings → Models** (`http://127.0.0.1:11434`). |
| **Model not found** | Run `ollama pull qwen2.5-coder:7b` or switch models via `/model`. |
| **Port `11434` already in use** | Another instance or proxy is bound to `11434`. Point CODEZY to that URL in Settings or stop the conflicting process. |
| **Replies cut off mid-code** | Enable **Auto-continue** in **Settings → Agent**, or reply `continue`. |
| **Health check** | Run `/doctor` in chat or `codezy doctor` in your terminal to inspect endpoints, models, and permissions. |

---

## Development & Testing

```bash
npm run typecheck   # Run TypeScript checks (tsc --noEmit)
npm run dev         # Start electron-vite dev server
npm run build       # Build production bundle
```

### Headless Regression Suite
Run the full suite (2,366 checks across 52 batches) from the project root using isolated temp directories:

```powershell
$t = (Resolve-Path tests\.tmp).Path
$env:TEMP = $t; $env:TMP = $t
$env:USERPROFILE = "$t\regress-home"; $env:HOME = "$t\regress-home"

foreach ($n in 1..52) {
  $out = & node "tests\batch$n-test.mjs" 2>&1 | Out-String
  "batch$n  PASS=$(([regex]::Matches($out, '(?m)^PASS')).Count)  FAIL=$(([regex]::Matches($out, '(?m)^FAIL')).Count)"
}
```

> **Notes:** Always use absolute paths for `$t` so subprocess working directories resolve properly. `batch5` requires a live Ollama instance and Windows PowerShell; `batch11` spins up a local HTTP server (rerun once if port binding races).

---

## Release Notes

### What's New in 3.2.0
* **"Graphite Signal" UI Overhaul:** Replaced glass-and-glow surfaces with layered graphite, hairline borders, warm off-white typography, and a cobalt signal accent. Added four themes (**Graphite**, **Paper**, **Contrast**, **Singularity**) and four accent colors.
* **Unified CLI REPL:** `codezy` now launches directly into the interactive agent REPL with four switchable modes (`chat`, `agent`, `plan`, `auto`), a project-focused home banner, and a `nanospinner` live phase indicator.
* **Interactive CLI `/settings`:** Numbered rows let you toggle themes, models, modes, and approvals directly in the terminal while staying read-only when piped.
* **Bundled Desktop Terminal:** Clicking **Open terminal interface** now launches the bundled `index.mjs` REPL out of the box without requiring a global `npm` install.
* i just wanted to make a commit from my other account ;) 

<details>
<summary><strong>View Previous Releases (3.1.7 – 2.3.0)</strong></summary>


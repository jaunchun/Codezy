# CODEZY v2 — Agent Orchestration Harness (handoff brief)

> **STATUS (v2.3.0 shipped): local-first UX round — Ollama auto-start, boot splash, autosetup, streaming isolation — suites batch1–17 all green (462 checks).**
> - **batch13 first-run setup + window hardening** — shared `connectPatch` upserts
>   the setup screen's provider (activate + default model, re-keys without
>   duplicating, presets keep their known-good model); main store: fresh install
>   or a TUI-written settings file → `setupDone false`, the patch flips it;
>   renderer sends `{setupDone}` as a partial patch. Runs on a faked USERPROFILE
>   with dataDir-pinned fixtures so the live settings file can never be
>   clobbered. suite: 27 checks.
> - **batch14 settings expansion + face-lift** — reduceMotion defaults off;
>   custom accent applies inline (`--accent`/`--accent-2`) while palette themes
>   WIN over it; motion flips `html[data-motion]`; every change is a patch
>   payload; Settings dialog: 7 sections, 8 accent swatches (click → applies +
>   persists), mode + effort rows, motion switch, build-time version chip.
>   suite: 16 checks.
> - **batch15 auto-continue + model cursor** — autoContinue defaults on: a reply
>   stopping inside an unclosed ``` fence gets a hidden "Continue exactly…"
>   nudge (capped at 3 per human turn, resets on every real message, the
>   setting kills it); v2tool `write_file` + applied chat edits publish `aiWrite`
>   → cowork editor live reload + blinking overlay cursor + tree dot + chip,
>   a dirty buffer is never clobbered by the reload; Settings row flips the
>   persisted flag. suite: 25 checks.
> - **batch16 effort bar + picked file chip** — code mode's 420px chat rail: the
>   tools row wraps and never flex-shrinks its pills while `.grow` stays
>   `flex: 1`; IdePane mirrors the open file (path + live content, unsaved
>   edits included) into `store.ideFile` and an image clears it; the composer
>   shows the chip and submit() attaches it (`message.files` → `expandMessage`);
>   closing the pane stops it. suite: 15 checks.
> - **batch17 streaming isolation + boot splash + autosetup** — per-session
>   streaming: a background reply lands in ITS own session, deltas never leak
>   into the visible chat, switching swaps thinking/stop state; stop() aborts
>   the session that's actually generating and force-clears a dead stream;
>   error events refresh the health dot; BootSplash logo renders during init
>   and flies to the measured title-bar rect; setup welcome: live engine pill +
>   one-click "Start with local Ollama"; static: seg-fab popover (no row
>   expansion), boot CSS, main spawns `ollama serve` windowless. suite: 29 checks.
> - **release wiring** — main `ensureOllama()` pings then spawns `ollama serve`
>   (detached, windowsHide) on whenReady; renderer `armOllamaWatch()` polls
>   every 3.5s while offline; TUI `imagePathsIn` re-joins unquoted paths split
>   at spaces (a folder like `Projekt domyślny` used to eat the attach),
>   apply notices print link-folder-relative paths instead of 100-char
>   absolutes; README + LICENSE added. Full sweep batch1–17 green.
>   typecheck 0, build 0 → **version 2.3.0**.
>
> **STATUS (v2.2.1 shipped): "models don't show up" root-cause fixes — suites batch1–12 all green.**
> - **batch12 settings coherence** — both holders used to write the settings
>   file as a WHOLE object from their in-memory copy, so whoever saved last
>   wiped what the other had just written (a Nebius provider connected in the
>   TUI could vanish after a desktop settings change, and vice versa) — and
>   neither side ever re-read the other's changes, so the app you looked in
>   showed no provider models at all. Fixes: main `patchSettings` (settings:set
>   now merges a PARTIAL patch over the file on disk; renderer sends only the
>   changed keys); TUI `saveSettings` writes only its dirty keys (baseline
>   diff) and `syncSettings()` re-reads disk before every input line (external
>   change → `refreshCtx`); renderer `resync()` pulls settings + models when
>   the picker opens or the Settings dialog shows (also fixes updateSettings
>   ordering — model refresh no longer sits behind `health.drive()` in one
>   try/catch); picker renders an explicit `(no models loaded — check the API
>   key)` note for a connected provider whose GET /models failed instead of a
>   silent gap (row building extracted to `pickerRows.ts`). suite: 17 checks
>   (disk-merge units, mocked-bridge patch payload + refresh order + resync,
>   picker rows, TUI clobber survival + external visibility on isolated
>   USERPROFILE). typecheck 0, build 0 → **version 2.2.1**.
>
> **STATUS (v2.2 shipped): Nebius provider + OpenAI-compatible agent mode — suites batch1–11 all green.**
> - **batch11 Nebius** — harness gained `openaiCall` + `chatCompletionsUrl`:
>   the OpenAI wire format (Bearer auth; messages sanitized — `tool_name` out,
>   `tool_call_id` in, object arguments → strings, orphan role:"tool" results
>   → user notes; `API error <code>` on !ok), same return shape as ollamaCall,
>   so runAgent speaks Ollama /api/chat AND any /chat/completions endpoint.
>   v2 agent mode resolves its target from `session.provider ??
>   settings.activeProvider` (desktop v2.ts + CLI codezy-v2; the CLI also
>   treats `--url …/vN` as OpenAI). Connection UX: shared `PROVIDER_PRESETS`
>   (Nebius Token Factory → `nvidia/Nemotron-3_5-Lightning`, OpenRouter, LM
>   Studio) fills Settings-dialog quick-add chips; `/provider nebius <key>`
>   connects in both shells (upsert + activate + NVIDIA default model),
>   bare `/provider` shows a card. batch11 suite: 59 checks (wire-shape units,
>   runAgent pairing loop, bundled v2.ts against a mocked fetch, real store
>   dispatch, TUI on an isolated USERPROFILE, live `--url …/v1` through
>   Ollama's OpenAI endpoint). typecheck 0, build 0 → **version 2.2.0**.
>
> **STATUS (v2.1 shipped): 4-batch feature round — suites batch1–10 all green.**
> - **batch7 TUI input & quick actions** — piped: /help rows, `!shell` prefix
>   (card + context push), `#fact` + /remember (memory.md append + card),
>   /fast toggle, /vim persist, /rewind card + numbered picker + empty notice.
>   TTY: cursor editing (arrow + mid-insert), vim modes — usable from the
>   splash, Esc → normal, i/a/o → insert, normal-mode keys dispatch
>   char-by-char so fast chunks like `dd` land, mode tag in the status line,
>   Esc-Esc → rewind picker (vim off). 37 checks.
> - **batch8 TUI meta + JSON output** — /export [path] (default
>   codezy-export-<stamp>.md in linkFolder/cwd, `# CODEZY session` + ## You +
>   transcript), /cost (transcript bytes/tokens, last stats, provider cost
>   line), /doctor (node, settings, data dir, endpoint, model, git, folder,
>   memory, skills, terminal + "first ✗ above is the thing to fix"); CLI
>   `--output-format text|json|stream-json` on -p and exec (json carries
>   tool_events, stream-json emits {type:'tool'} NDJSON, bogus → exit 2),
>   documented in --help.
> - **batch9 harness** — `todo_write` tool (pending/in_progress/done, validated
>   in `check`, state on the registry as `.state.todos`; registry cached per
>   workspace so lists survive turns; /todos in the v2 REPL; system prompts
>   name it). Lifecycle hooks: `loadHooks(roots)` reads .codezy/hooks.json
>   (workspace else home) — before_tool nonzero exit BLOCKS before the
>   approval gate and the hook's stderr becomes the model's tool result;
>   after_tool failures append `[hook] …` to the result; `{tool, args}` JSON
>   on stdin, per-hook `tools` filter, 10s default timeout. Tool lines
>   restyled to `⎿ verb arg · summary` (stepSummary). Suites: 31 checks incl.
>   a live `⎿ list dir . · 12 entries` line.
> - **batch10 desktop mirror** — /rewind [n] (numbered listing, drop, guarded
>   while streaming), /fast (light ↔ medium), /doctor (✓/✗ rows + fix hint),
>   /cost (turns/transcript/estimate), /add-dir (dedupe), `#fact` →
>   /remember via a new parseInput 'remember' kind; parseInput now accepts
>   hyphen commands (/add-dir) while `/usr/local…` stays chat. Friendly trace
>   names (`read file`) + `updating todos…` activity; design-layer section 4:
>   command toasts in the mono stack (aligned rows hold) with a 200ms strong
>   ease-out enter. batch10 suite: 47 checks (real store dispatch through
>   send() against a mocked bridge). typecheck 0, build 0 →
>   **version 2.1.0**. Headless tests only; no windows spawned.
>
> **STATUS (v2.0 shipped): 7-batch design overhaul — all green.**
> - **b1 design** — 6-row block wordmark, splash bands, status bar below input,
>   two-sided statusLine, left-truncated footer cwd.
> - **b2 navigation** — one COMMANDS table feeds /help + ctrl+p, /clear alias of
>   /new, overlay engine (cmds/hist/files) with the shared input line as filter,
>   @file autocomplete, drawBox = cursor-on-input-row invariant.
> - **b3 pickers & config** — THEMES (midnight/ember/mint/slate) + applyTheme(),
>   shared settings.json (read+write), pickItem/valuePrompt primitives, no-args
>   /model /effort /mode /theme pickers in TTY (cards piped), /settings,
>   ctrl+c wipes input + closes palette (blocks autoOverlay reopen).
> - **b4 sessions & git** — gitBranch helper (5s TTL), statusLine branch
>   segment + splash meta row, /resume + /open TTY pickers, /diff vs HEAD
>   (stat + colored content, `-- <path>` narrowing, untracked / no-repo /
>   no-commits notes, g:2 in COMMANDS).
> - **b5 editing & sharing** — proposal keys y/n/a/d/s/r (d = unified diff via
>   `git diff --no-index`, a = auto mode + apply), /copy (clip.exe / pbcopy /
>   wl-copy), image attachments: real image paths detected per message,
>   stored as paths in history, read fresh at send — Ollama passthrough,
>   OpenAI content parts via sniffMime, 📷 marker in the bubble.
> - **b6 desktop mirror** — 7-name ThemeName union shared with the TUI
>   (themeBase/themePalette → data-theme + data-palette), desktop /copy +
>   /diff (main git.ts via `git:diff` IPC), EditCard "Always" (= a), and ONE
>   delimited DESIGN LAYER block at the end of global.css: palette accents
>   matching the terminal, composer accent edge, hairline accent scrollbars.
>   Typecheck 0, build 0 (index-CkzVqFFp.css / index-B2T_hhE9.js).
> - **b7 integration** — suites batch1–6 ALL PASS (regression), CLI conventions
>   verified (`--help` → 0 · unknown flag → 2 · `-p` one-shot → 0), bumped to
>   **version 2.0.0**. Headless tests only; no windows spawned.
>
> Previous phase — harness hardening (state of the branches below still holds):
> - **CLI (v1.5)** — one entry point `cli/index.mjs` (`bin: codezy`), conventions
>   borrowed from claude-code/codex/opencode: `--help`/`--version` (exit 0),
>   unknown flag → exit 2, `-p/--print` one-shot (activity → stderr, reply →
>   stdout), `exec`/`run "prompt"` one-shot agent, `--agent` REPL, shared parser
>   in `cli/lib/cli.mjs`. v1 TUI gained `--model`/`--dir`. `cli/print.mjs` is the
>   plain-chat one-shot (optional `--dir` adds the file tree to context).
> - **Text-form tool-call fallback** (`parseTextToolCall`) — models without
>   native function calling (qwen2.5-coder) and flaky ones (llama3.1:8b, ~50%)
>   write tool calls as JSON *inside the reply text*; the loop now parses those
>   (balanced-brace scan, fenced or bare, registry-names only — a package.json
>   `{"name":…}` never executes) and runs them. This was the real "model can't
>   search the net" bug: `web_search` was requested as text and dropped. Fixed
>   in the SHARED core → desktop benefits too (`parseTextToolCall` in out/main).
> - **`inside()` root bug** — `path.relative(root, root)` is `''`, so any path
>   resolving to the root itself (`list_dir .`) was rejected as "outside the
>   linked folders". Root now counts as inside; `..` escapes and other drives
>   still throw.
> - **Mid-stream input** — desktop: slash commands run while the model writes,
>   new messages interject (partial kept as *(cut off by your next message)*);
>   v2 REPL: commands execute immediately mid-turn (chained, EOF waits for
>   async `/search`), approval answers no longer double-consume input;
>   v1 TUI: a `/command` submitted during streaming stops the stream to run now.
> - **v2 tool awareness** — `prompt.ts` adds a Tools section when `settings.v2`,
>   v2 SYSTEM names `web_search` explicitly; verified live: `exec` →
>   `✓ web_search` → real result, exit 0. typecheck+build green.
>
> **STATUS (batch 5 done): both shells shipped.**
> - Terminal: `cli/codezy-v2.mjs` — readline REPL, interactive `y/N` gate on TTY,
>   piped input **denies** gated tools unless `--auto` (safe default). Verified
>   headless: commands-only pipe → exit 0; live llama3.1:8b run exercised the
>   full loop (write_file approved → executed → final text → exit 0) and the
>   deny path (run_command denied → loop continued → exit 0).
> - Desktop: `src/main/v2.ts` (`runV2`) imports `cli/lib/harness.mjs` directly
>   (types via `cli/lib/harness.d.mts`). Approval = promise resolved by the
>   renderer's `ApproveModal` via `chat:v2decision`; tool activity streams as
>   `v2tool` events into the chat's activity line; toggled by the new
>   **Agent mode (v2)** setting (`settings.v2`, default off). typecheck+build green.

**The harness ships in BOTH versions.** One UI-agnostic core, consumed by the
terminal v2 TUI *and* the Electron desktop app. It must not know anything about
its UI: model call, approval gate, and tool registry are all injected, so each
shell can wire its own (terminal `y/n` prompt vs the app's confirm dialog).

## What CODEZY is

A local-first coding assistant with two shells over the same brain:

- **Desktop app** (Electron, built): React sidebar + chat UI, Electron main is the
  only backend. Accent `#3d9bff`, no purple, dark/light/acrylic themes.
  Confirm-before-write edit flow with backups + undo ("confirm everything with me").
- **Terminal v1** (`cli/codezy.mjs`, DONE — leave intact): opencode-style TUI over
  `cli/lib/{engine,md,edits,search,usage}.mjs`. Chat + `===FILE/===SEARCH/===REPLACE/===END`
  edit blocks the user confirms. State in `~/.codezy` (settings.json, sessions/,
  terminal/, backups/, memory.md).

v1 can only *suggest* edits — the model writes edit blocks in prose and a JS
function applies them after confirmation. It never calls tools itself.

**v2 closes that gap: a real stateful tool-calling loop.**

## The loop

```
append prompt → send message history + JSON tools schema to Ollama → response
  ├─ response has tool_calls?
  │    → extract name/args
  │    → validate safety
  │    → [human-in-the-loop approval gate]
  │    → execute via registry
  │    → append assistant msg containing the EXACT tool_calls payload
  │    → append role:"tool" msg with output (matched by function name / call id)
  │    → loop (iteration counter++)
  └─ plain text? → return it, terminate
```

## Hard requirements

1. **Endpoint** — `POST http://127.0.0.1:11434` native chat API, or the
   OpenAI-compatible `/v1/chat/completions`. Use models with function calling
   (`qwen3-coder`, `llama3.1`). The payload **must override `"num_ctx": 65536`
   in `options`** — local models default to 4096 and context truncation
   silently breaks tool calling.
2. **Tools layer** — a strict JSON-schema array, each entry:
   - `name` — must match a key in the backend execution registry exactly
   - `description` — what/when to use it
   - `parameters` — JSON Schema: `type`, `properties`, `required`
   Registry maps name → async fn that validates args and returns a string
   result (candidates: read_file, list_dir, grep, write_file, run_command,
   web_search — reuse `cli/lib/search.mjs`).
3. **Stateful history** — ordered `system/user/assistant/tool` messages.
   When a tool fires, append TWO messages in order:
   1. the assistant message containing the exact `tool_calls` payload returned by Ollama
   2. a `role:"tool"` message with the runtime output, mapped back via matching
      function name / call ID
   Never drop, reorder, or rewrite them.
4. **Human-in-the-loop gate** — optional async middleware/hook that pauses the
   loop awaiting an approval event before executing `write_file` / `run_command`.
   Design as an injectable async fn (e.g. `approve(toolName, args) → boolean`)
   so the TUI can prompt `y/n` and tests can auto-approve.
5. **Termination** — hard iteration cap per chain, **5–10**. On cap: stop with a
   visible message. Prevents infinite / hallucinated tool loops.
6. **Safety validation before every execution** — paths confined to the linked
   folder, blocked commands. Same spirit as `applyEdits` in `cli/lib/edits.mjs`.
7. **v1 stays untouched** — v2 = NEW files only (`cli/codezy-v2.mjs` entry +
   `cli/lib/harness.mjs` loop/tools/registry/gate). Importing `cli/lib/*` is
   fine; never modify v1 files.

## Two consumers of the same core

The harness core (`cli/lib/harness.mjs`, plain ESM, zero deps) exposes the loop
as something like `runAgent({ history, tools, callModel, approve, maxIter, onEvent })`:

- **Terminal v2** (`cli/codezy-v2.mjs`) — feeds `callModel` from
  `lib/engine.mjs`-style streaming, `approve` blocks on a TUI `y/n` prompt,
  `onEvent` draws tool activity on the TUI screen.
- **Desktop app** (`src/main/…`) — Electron main imports the SAME core file;
  `approve` returns a promise resolved by the renderer's confirm dialog
  (existing confirm-before-write UX), `onEvent` streams tool events over IPC.

The core must therefore:
- run in plain Node AND in Electron main (no browser/Node-specific globals
  outside the injected parts — use `fetch`, injectable fs/shell access)
- be side-effect free on import (no terminal writes, no stdin handling)
- report progress via the `onEvent` callback instead of printing

If electron-vite can't import a `.mjs` from `cli/lib/` directly, resolve it
(adjust the main-process build config or add a thin re-export) — do NOT fork the
logic into a second copy.

## Reuse from v1 / app

- `cli/lib/engine.mjs` — SSE/stream parsing, headers, effort presets
  (light `{0.9, num_ctx 4096, predict 1024}` / medium `{0.6, 8192, 2048}` /
  deep `{0.2, 16384, 4096}`) — v2 likely wants a higher ctx floor.
- `cli/lib/edits.mjs` — path safety, backup/undo conventions.
- `cli/codezy.mjs` — settings/DIRS conventions (`~/.codezy`, dataDir re-root),
  renderer/input patterns if v2 gets a TUI.
- `src/main/ollama.ts` — reference for the native `num_ctx` override.
- `src/main/prompt.ts` — BASE_INSTRUCTIONS, fileTree, message trimming.

## Testing (headless ONLY — no windows, no focus stealing)

- `node --check` on every new file.
- DI harness: inject a fake model fn returning canned `tool_calls` responses;
  assert:
  - approval gate actually pauses the loop (pending promise → resolve → resumes)
  - iteration cap stops a always-returns-tool_calls model at N
  - assistant `tool_calls` + `role:"tool"` messages pair correctly by name/id
  - `options.num_ctx === 65536` present in every outgoing payload
  - plain-text response terminates with no tool execution
- piped regression: pipe commands in, expect exit 0.
- the shared core gets tested ONCE, shell-independently (fake `approve`,
  fake registry) — both consumers then only need a thin wiring check.
- app side: verify Electron main can import the core and that an approval
  promise resolves from the renderer dialog (still headless — no live UI).

## Environment gotchas

- PowerShell 5 shell: no `&&` (use `;` / `foreach`), backticks get mangled in
  `node -e` → write `.mjs` files instead of inline JS.
- Node v24.21.0, plain ESM, no build step, no dependencies in `cli/`.
- Ollama confirmed live at `http://127.0.0.1:11434` (current model
  `qwen2.5-coder:7b`, default `num_ctx` 4096).
- Ask the user before anything destructive — the standing rule is
  "confirm everything with me".

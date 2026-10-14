// ---------------------------------------------------------------------------
// api.ts — the contract between the React UI (renderer) and the backend
// (main process). The renderer may ONLY touch the app through this interface,
// which is exposed on window.codezy by the preload script. Nothing in the UI
// can reach Node, the file system, or Ollama directly — that's the security
// model mentioned in the design doc.
// ---------------------------------------------------------------------------

import type {
  ChatEvent,
  ConnectionStatus,
  McpServerConfig,
  Project,
  ProviderConfig,
  Settings,
  Session
} from './types'
import type { FileEdit } from './edits'
import type { UsageRange, UsageStats } from './usage'

/** What the backend reports after writing edits to disk. */
export interface ApplyOutcome {
  applied: { path: string; isNew: boolean }[]
  errors: string[]
  /** Backup file id (timestamp) — kept for /undo, null when nothing was written. */
  backupId: string | null
}

/** One safety copy in the /history timeline (files captured before a batch). */
export interface BackupInfo {
  id: string
  ts: number
  /** Relative-ish labels for the list — the file names touched. */
  files: string[]
}

/** One cross-chat search hit (v3.1): where the message lives + a single-line
 *  snippet with ~70 chars of context before the match. Named apart from the
 *  web-search SearchHit below. */
export interface ChatSearchHit {
  sessionId: string
  sessionTitle: string
  messageId: string
  ts: number
  role: string
  snippet: string
}

export interface ModelEntry {
  id: string
  provider: string // 'ollama' or provider id
  providerName: string
  /** Ollama metadata for the picker */
  size?: number // bytes on disk
  quant?: string // Q4_K_M, Q8_0, …
  family?: string // qwen2, llama, …
  parameter?: string // 7B, 8x7B, …
}

export interface CodezyApi {
  settings: {
    get(): Promise<Settings>
    /** Partial patch — main merges it over the settings on disk. */
    set(patch: Partial<Settings>): Promise<Settings>
  }
  projects: {
    list(): Promise<Project[]>
    save(projects: Project[]): Promise<void>
  }
  sessions: {
    list(): Promise<Session[]>
    get(id: string): Promise<Session | null>
    save(s: Session): Promise<Session>
    create(projectId: string | null, title?: string): Promise<Session>
    delete(id: string): Promise<void>
    /** Ctrl+Shift+F — case-insensitive message scan across every chat (v3.1). */
    search(q: string): Promise<ChatSearchHit[]>
  }
  models: {
    /** Everything selectable in the model/effort picker. */
    list(): Promise<ModelEntry[]>
  }
  health: {
    ollama(): Promise<ConnectionStatus>
    drive(): Promise<{ enabled: boolean; folder: string | null; healthy: boolean }>
  }
  chat: {
    /** Streams a reply for the session's newest user message. */
    send(sessionId: string): Promise<void>
    abort(sessionId: string): Promise<void>
    /** delta / done / error / aborted events for every generation. */
    onEvent(cb: (payload: { sessionId: string } & ChatEvent) => void): () => void
    /** Approve/Deny answer for a pending agent-mode (v2) tool request. */
    v2Decision(askId: number, allowed: boolean): Promise<void>
  }
  memory: {
    read(): Promise<string>
    write(content: string): Promise<void>
  }
  skills: {
    /** Playbook names (.md files) available for /skill. */
    list(): Promise<string[]>
  }
  edits: {
    /** Writes proposed edits into the session's linked folders (validated in main). */
    apply(sessionId: string, edits: FileEdit[]): Promise<ApplyOutcome>
    /** Restores the most recent backup for this session. */
    undo(sessionId: string): Promise<{ restored: number; message: string }>
    /** Every safety copy this chat has, newest first (the /history timeline). */
    list(sessionId: string): Promise<BackupInfo[]>
    /** Restores ONE backup. Writes a safety copy of the current state first,
     *  so /undo still steps back to what you had before restoring. */
    restore(sessionId: string, backupId: string): Promise<{ restored: number; message: string }>
  }
  usage: {
    /** Aggregated stats for the /usage dashboard. */
    stats(range: UsageRange): Promise<UsageStats>
  }
  search: {
    /** DuckDuckGo results (no API key) for /search. */
    query(q: string): Promise<SearchHit[]>
  }
  git: {
    /** /diff: git status + unified diff vs HEAD in the chat's linked folder. */
    diff(sessionId: string, pathspec?: string): Promise<GitDiff>
    /** Just `git status --porcelain=1` for a linked folder — tree badges. */
    status(sessionId: string, folder: string): Promise<GitStatus>
  }
  files: {
    /** @mention: files under the chat's linked folders matching a query. */
    list(sessionId: string, query: string): Promise<FileRef[]>
    /** Reads a linked-folder file for an @mention — null when outside the folders. */
    read(sessionId: string, path: string): Promise<string | null>
    /** Drag & drop: reads dropped files / classifies dropped folders, capped. */
    ingest(paths: string[]): Promise<DroppedImport>
    /** Save markdown file dumps from a reply into the linked folder — writes the paths. */
    saveDump(sessionId: string, files: { path: string; content: string }[]): Promise<string[]>
    /** Code-block "apply": overwrite/create a file in the linked folder —
     *  goes through the same backup machinery as agent edits (/undo reverts). */
    applyBlock(sessionId: string, path: string, content: string): Promise<{ saved: string; backupId: string | null }>
    /** Open a file with the OS default app — resolves an error string ('' = ok). */
    open(path: string): Promise<string>
    /** Reveal a file in the OS file manager. */
    show(path: string): Promise<void>
  }
  /** Cowork editor (v1.5): browse and edit the chat's linked folders. */
  ide: {
    tree(sessionId: string, showIgnored?: boolean): Promise<IdeNode[]>
    /** File content + truncation flag — null when outside the linked folders. */
    read(sessionId: string, path: string): Promise<{ content: string; truncated: boolean } | null>
    /** Save — throws when outside the linked folders. */
    write(sessionId: string, path: string, content: string): Promise<string>
    /** Create a file (or folder) inside the linked folders. */
    create(sessionId: string, path: string, dir: boolean): Promise<string>
    /** Rename a file — throws when outside the folders or the target exists. */
    rename(sessionId: string, from: string, to: string): Promise<string>
    /** Delete a file (never a directory) — throws when outside the folders. */
    delete(sessionId: string, path: string): Promise<boolean>
  }
  images: {
    /** Local image → data URL for inline viewing (10 MB cap, null if not an image). */
    dataUrl(path: string): Promise<string | null>
    /** Clipboard image → temp PNG path (null when the clipboard holds no image). */
    paste(): Promise<string | null>
  }
  /** Absolute filesystem path of a dropped File (Electron webUtils bridge). */
  filesPath(file: File): string
  init: {
    /** /init step 1: linked folder + shallow file tree (null when nothing is linked). */
    prepare(sessionId: string): Promise<{ folder: string; tree: string } | null>
    /** /init step 2: writes the generated CODEZY.md into the linked folder. */
    write(sessionId: string, content: string): Promise<string>
  }
  dialog: {
    pickFolder(title?: string): Promise<string | null>
    pickFiles(): Promise<{ path: string; content: string }[]>
    saveText(defaultName: string, content: string): Promise<string | null>
  }
  win: {
    minimize(): void
    maximize(): void
    close(): void
    isMaximized(): Promise<boolean>
  }
  app: {
    version(): Promise<string>
    openExternal(url: string): Promise<void>
    /** Opens the external terminal REPL. Resolves to an error message, or null on success. */
    openTerminal(): Promise<string | null>
  }
  /** Built-in GitHub updater (v2.6) — check, download, restart in place. */
  update: {
    /** Asks GitHub for a newer release. Never throws: `ok:false` = offline. */
    check(): Promise<UpdateCheck>
    /** Streams the setup EXE into the app's temp dir. */
    download(): Promise<{ path: string } | { error: string }>
    /** Starts the installer silently and quits the app (`--updated /S --force-run`). */
    apply(): Promise<{ ok: boolean; error?: string }>
    /** Download progress while `download()` runs. */
    onProgress(cb: (p: UpdateProgress) => void): () => void
    /** Open the release page in the browser (fallback / release notes). */
    openRelease(url: string): Promise<void>
  }
  /** MCP servers (v3) — stdio tool servers the agent calls as mcp__* tools. */
  mcp: {
    /** Configured servers + live status/tool count for the settings UI. */
    list(): Promise<McpStatusEntry[]>
    /** Connect a candidate config WITHOUT saving it. Never throws. */
    probe(cfg: McpServerConfig): Promise<{ ok: boolean; tools: string[]; error?: string }>
    /** Persist the whole server list; drops sessions that changed. */
    save(servers: McpServerConfig[]): Promise<void>
  }
  /** Background tasks (v3.1 batch30) — agent `run_command {"background":true}` children. */
  tasks: {
    /** Every task across the cached agent workspaces, running ones first. */
    list(): Promise<TaskInfo[]>
    /** Kills ONE task by uid (workspace-root namespaced id). */
    stop(uid: string): Promise<boolean>
  }
}

/** One background task from the agent harness, as the panel shows it. */
export interface TaskInfo {
  /** workspace-root namespaced id — registries each count from #1. */
  uid: string
  id: number
  command: string
  running: boolean
  /** exit code ('error' when the spawn itself failed); null while running. */
  code: number | string | null
  /** tail of the combined stdout+stderr capture (full length: outTotal). */
  out: string
  /** total captured chars — how much output exists beyond the tail. */
  outTotal: number
  started: number
  /** the chat's first linked folder — which workspace owns the task. */
  workspace: string
}

/** One MCP server as shown in Settings: config + connection outcome. */
export interface McpStatusEntry extends McpServerConfig {
  status: 'ok' | 'error' | 'disabled'
  tools: string[]
  error?: string
}

/** One web search result for /search. */
export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** Result of /diff — plain git output, the renderer colors and truncates it. */
export interface GitDiff {
  ok: boolean
  /** Why ok=false — not a repo, no folder linked, git missing. */
  error?: string
  folder: string
  branch: string
  /** `git status --porcelain=1` lines (includes untracked files). */
  files: string[]
  /** `git diff HEAD --stat` output. */
  stat: string
  /** `git diff HEAD` output (empty in a fresh repo with no commits). */
  body: string
}

/** One @mention candidate: absolute path for IO, relative name for display. */
export interface FileRef {
  path: string
  name: string
}

/** Result of dropping files onto the composer. */
export interface DroppedImport {
  files: { path: string; content: string }[]
  /** Dropped directories — the renderer links them to the chat. */
  dirs: string[]
  skipped: { path: string; reason: string }[]
}

/** One node of the IDE file tree. */
export interface IdeNode {
  name: string
  path: string
  dir?: boolean
  children?: IdeNode[]
  /** Marker row (not clickable): entries left out at this spot. */
  more?: number
}

/** One folder's `git status --porcelain=1` lines — cheap, no diff. */
export interface GitStatus {
  ok: boolean
  folder: string
  /** `XY path` lines; path is relative to `folder`. */
  files: string[]
}

/** The GitHub release that carries a newer setup than the running version. */
export interface UpdateRelease {
  /** Parsed from the asset name — the tag is prose ("Release"), never semver. */
  version: string
  /** Asset file name, e.g. `CODEZY-Setup-2.6.0.exe`. */
  name: string
  url: string
  size: number
  /** Release body (first chars) — shown as the pill's tooltip. */
  notes?: string
  /** Release page on GitHub. */
  page?: string
}

/** Result of an update check — always resolved, never thrown. */
export interface UpdateCheck {
  /** false = the check failed (offline, rate limit) — `error` says why. */
  ok: boolean
  current: string
  /** true only when GitHub has a strictly newer setup than `current`. */
  available: boolean
  /** null when nothing newer exists — the pill stays hidden. */
  release: UpdateRelease | null
  error?: string
}

/** Download progress for the title-bar pill. */
export interface UpdateProgress {
  received: number
  total: number
  /** 0–100, or -1 while the server sent no content-length. */
  percent: number
}

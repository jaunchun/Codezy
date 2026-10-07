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
    /** Open a file with the OS default app — resolves an error string ('' = ok). */
    open(path: string): Promise<string>
    /** Reveal a file in the OS file manager. */
    show(path: string): Promise<void>
  }
  /** Cowork editor (v1.5): browse and edit the chat's linked folders. */
  ide: {
    tree(sessionId: string): Promise<IdeNode[]>
    /** Full file content — null when outside the linked folders. */
    read(sessionId: string, path: string): Promise<string | null>
    /** Save — throws when outside the linked folders. */
    write(sessionId: string, path: string, content: string): Promise<string>
    /** Create a file (or folder) inside the linked folders. */
    create(sessionId: string, path: string, dir: boolean): Promise<string>
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
}

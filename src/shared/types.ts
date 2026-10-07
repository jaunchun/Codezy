// Shared type definitions — imported by BOTH the Electron main process and the
// React renderer. Keeping them in one file guarantees the two sides never
// disagree about the shape of a session, a message, or the settings.

export type Role = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  ts: number // timestamp in ms, shown next to bubbles
  model?: string // which model produced an assistant reply
  /** Attachments: chips in the UI, expanded into text only for the model. */
  files?: { path: string; content: string }[]
  /** Internal turns (e.g. the /review request) — sent to the model, never drawn as a bubble. */
  hidden?: boolean
  /** Agent tool steps that produced this reply — collapsible preview in the UI (v1.5). */
  trace?: { name: string; ok: boolean }[]
}

export interface Session {
  id: string
  projectId: string | null // null = session not attached to a project
  title: string // shown in the sidebar chat list
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  goal?: string // active /goal for this session
  /** Background notes added with /btw — injected into prompts, never a turn. */
  notes?: string[]
  /** Folders linked with the link-folder button — read into context. */
  linkedFolders?: string[]
  /** Token counts from the last generation (reported by /usage). */
  lastUsage?: { prompt: number; completion: number; ctx: number; ts: number }
  /** Active skill name (from the skills folder), if any. */
  skill?: string | null
  /** Message ids whose proposed edits were accepted or declined (hides the bar). */
  resolvedEdits?: string[]
  /** Per-chat generation overrides — absent = follow the global settings. */
  model?: string
  provider?: string
  effort?: EffortLevel
  /** Pinned to the top of the sidebar chat list. */
  pinned?: boolean
}

/** Project = a folder of work (and optionally a real directory on disk). */
export interface Project {
  id: string
  name: string
  /** Grouping folder inside the sidebar ("Work", "Uni", ...) */
  group?: string
  /** Real path on disk the agent may read/write, if linked */
  rootPath?: string | null
  /** Project context injected into every prompt (like CLAUDE.md) */
  context?: string
  color?: string
  createdAt: number
}

/** One OpenAI-compatible endpoint (OpenRouter, DeepSeek, LM Studio, ...). */
export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string // e.g. https://openrouter.ai/api/v1
  apiKey?: string
}

/**
 * Shared between app and terminal: dark/light/acrylic are app surfaces,
 * midnight/ember/mint/slate are accent palettes (the terminal /theme names).
 */
export type ThemeName = 'dark' | 'light' | 'acrylic' | 'midnight' | 'ember' | 'mint' | 'slate'
export type EffortLevel = 'light' | 'medium' | 'deep'

export interface Settings {
  theme: ThemeName
  accent: string
  /** Root folder for all CODEZY data (sessions, memory, skills, goals). */
  dataDir: string
  /** Optional Google Drive folder; sessions are mirrored there when set. */
  driveFolder: string | null
  /** http://127.0.0.1:11434 — CODEZY pings this on launch. */
  ollamaUrl: string
  providers: ProviderConfig[]
  activeProvider: 'ollama' | string // provider id
  activeModel: string
  effort: EffortLevel
  /** Display name used in your profile. */
  userName: string
  /** Whether CODEZY is allowed to update its memory file about you. */
  learn: boolean
  fontSize: number
  /**
   * How CODEZY handles proposed file edits:
   * plan  — the model only plans, never outputs edit blocks
   * build — the model proposes edits, you accept/decline them
   * auto  — edits are applied automatically (always backed up, /undo reverts)
   */
  mode: 'plan' | 'build' | 'auto'
  /** OS notification when a reply finishes while the window is unfocused. */
  notifyDone?: boolean
  /** true = Enter sends / Shift+Enter new line; false = Ctrl+Enter sends / Enter new line. */
  enterSends?: boolean
  /**
   * Agent mode (v2) — the model calls files/commands itself through the
   * shared harness (cli/lib/harness.mjs), with a per-action approval dialog.
   * Needs a linked folder. Off = the classic v1 edit-block flow.
   */
  v2?: boolean
  /** false/absent = show the first-run setup screen; true = finished
   *  (rerunnable any time from the Settings dialog). */
  setupDone?: boolean
  /** true = kill every transition/animation (accessibility preference). */
  reduceMotion?: boolean
  /** false = never auto-nudge the model when a reply stops mid-code. */
  autoContinue?: boolean
}

/** Outcome of one v2 tool execution (reported live to the chat). */
export type V2Outcome = 'ok' | 'denied' | 'rejected' | 'unknown' | 'error'

/** What /help prints: every slash command CODEZY handles itself. */
export interface CommandInfo {
  name: string
  args: string
  description: string
}

/** Events streamed from main -> renderer while a reply is generating. */
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; message: string }
  | { type: 'aborted' }
  | { type: 'v2tool'; iteration: number; name: string; args: Record<string, unknown>; outcome: V2Outcome }
  | { type: 'v2ask'; askId: number; name: string; args: Record<string, unknown> }

export type ConnectionStatus = 'checking' | 'online' | 'offline'

// ---------------------------------------------------------------------------
// store.ts — CODEZY's file system layer.
// Everything CODEZY remembers (settings, projects, sessions, memory, skills,
// goals) lives in ONE folder, by default ~/.codezy (C:\Users\you\.codezy).
// Because it's just one folder, "save to Google Drive" later = point this
// folder (or a mirror of it) at a Drive directory.
// ---------------------------------------------------------------------------

import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import type { Project, Session, Settings } from '../shared/types'
import type { ChatSearchHit } from '../shared/api'

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.codezy')

let dataDir = DEFAULT_DATA_DIR

// -- small JSON helpers -----------------------------------------------------

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) } as T
  } catch {
    // A corrupted file must never crash the app — fall back to defaults, but
    // move the unreadable file aside first: the next write would otherwise
    // silently replace the user's real config with defaults, losing it.
    try {
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.corrupt`)
    } catch {
      /* leave it in place — still better than crashing */
    }
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Unique temp per writer: the GUI and the TUI both write these files, and
  // a shared `<file>.tmp` lets one process rename the other's half-written
  // temp into place (torn JSON) or hit a locked handle on Windows.
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8') // write temp first …
    try {
      fs.renameSync(tmp, file) // … then atomically swap it in
    } catch {
      // Windows: the target can be held open briefly by the other writer
      fs.rmSync(file, { force: true })
      fs.renameSync(tmp, file)
    }
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw e
  }
}

// -- folder layout ----------------------------------------------------------

export const p = {
  settings: () => path.join(dataDir, 'settings.json'),
  projects: () => path.join(dataDir, 'projects.json'),
  sessions: () => path.join(dataDir, 'sessions'),
  session: (id: string) => path.join(dataDir, 'sessions', `${id}.json`),
  memory: () => path.join(dataDir, 'memory.md'), // what CODEZY learns about you
  projectContext: (id: string) => path.join(dataDir, 'projects', `${id}.md`),
  skills: () => path.join(dataDir, 'skills'),
  goals: () => path.join(dataDir, 'goals.json'),
  backups: (sessionId: string) => path.join(dataDir, 'backups', sessionId) // pre-edit file copies for /undo
}

export function getDataDir(): string {
  return dataDir
}

/** The custom data folder recorded in the DEFAULT settings file (boot pointer).
 *  The pointer itself must live in the default location — there is nowhere
 *  else to read before we know where the data folder is. */
function readDataDirPointer(): string | undefined {
  try {
    const file = path.join(DEFAULT_DATA_DIR, 'settings.json')
    if (!fs.existsSync(file)) return undefined
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { dataDir?: unknown }
    return typeof j.dataDir === 'string' && j.dataDir.trim() ? j.dataDir : undefined
  } catch {
    return undefined
  }
}

/** Creates the folder tree. Called once at startup (and after a data-dir change). */
export function initStore(dir?: string): void {
  // no explicit dir = boot: honour a persisted dataDir, or the next launch
  // would silently start over in ~/.codezy and strand the custom folder
  const target = dir && dir.trim() ? dir : readDataDirPointer()
  dataDir = target && target.trim() ? target : DEFAULT_DATA_DIR
  for (const dir of [dataDir, p.sessions(), path.dirname(p.projectContext('x')), p.skills()]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  seedSkills() // first run: give /skill a few starter playbooks
}

// -- skills (prompt playbooks for /skill) -----------------------------------

const SEED_SKILLS: Record<string, string> = {
  'code-reviewer': `You are a strict senior code reviewer. Go through the code or edits in
front of you and report, in this order:
1. Correctness - logic errors, off-by-one, wrong assumptions, unhandled null/empty cases.
2. Security - injection, path traversal, secrets in source, unsafe input handling.
3. Performance - needless loops, quadratic work on large data, repeated I/O.
4. Readability - naming, dead code, functions doing too many things.
Format: one bullet per finding with the file/line, why it matters, and the minimal fix.
End with a verdict line: APPROVE or FIX NEEDED. Be blunt; never pad with praise and
never restate the code back.`,

  explainer: `Explain code fast, assuming the reader already has it open in front of them:
1. One line on what this file or feature does overall.
2. Walk it top to bottom: each block or function in execution order, one sentence on
   what it does and WHY it exists.
3. Call out the non-obvious parts - state, async, side effects - with a tiny example
   of what happens at runtime.
4. Finish with gotchas: edge cases and things that break silently.
Never paste the whole code back; refer to parts by name. Keep it tight.`,

  'test-writer': `Write real, runnable tests:
1. Detect the framework from the project files (package.json, pyproject.toml,
   CMakeLists.txt) and match its conventions exactly.
2. Cover the happy path, boundary values, error paths and empty input.
3. One behavior per test, descriptive test names, no branching logic inside tests.
4. No placeholders - every assert must be real and the tests must run as-is.
Output test files as ===FILE edit blocks so they can be accepted into the linked folder.`
}

/** Names of the .md playbooks in the skills folder (without extension). */
export function listSkills(): string[] {
  try {
    return fs
      .readdirSync(p.skills())
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}

/** Writes the starter playbooks when the folder is empty (idempotent). */
function seedSkills(): void {
  try {
    if (listSkills().length > 0) return
    for (const [name, body] of Object.entries(SEED_SKILLS)) {
      fs.writeFileSync(path.join(p.skills(), `${name}.md`), `${body.trim()}\n`, 'utf8')
    }
  } catch {
    // never let seeding block startup
  }
}

// -- settings ---------------------------------------------------------------

export const DEFAULT_SETTINGS: Settings = {
  theme: 'graphite',
  accent: '#6FA8FF',
  dataDir: DEFAULT_DATA_DIR,
  driveFolder: null,
  ollamaUrl: 'http://127.0.0.1:11434',
  providers: [],
  activeProvider: 'ollama',
  activeModel: 'qwen2.5-coder:7b',
  /** CLI dual-model roles — cheap model for compaction + /scout (app ignores). */
  fastModel: '',
  /** Thinking mode (long mode) — the Thinking button's persisted state. */
  thinkingMode: false,
  /** Web mode for the normal chat: 'auto' | 'always' | 'off'. */
  webSearch: 'auto',
  effort: 'medium',
  userName: '',
  learn: true,
  fontSize: 14,
  mode: 'build',
  /** agent mode (v2 harness) — ON by default: a linked folder IS the agent's
   *  workspace. Off keeps the classic edit-block flow. */
  v2: true,
  /** 3.1.5 migration marker (see getSettings). */
  agentModeMigrated: true,
  /** OS notification when a reply finishes while the window is unfocused */
  notifyDone: false,
  /** Enter sends (true) vs Ctrl+Enter sends (false) */
  enterSends: true,
  /** first-run setup screen — false until the user finishes (or skips) it */
  setupDone: false,
  /** kill every transition/animation (accessibility) */
  reduceMotion: false,
  /** nudge the model when a reply stops inside an unclosed code fence */
  autoContinue: true,
  /** row/padding density of the interface */
  density: 'cozy',
  /** false = simple UI; true = every pane, command and developer control */
  showAdvanced: false,
  /** check GitHub for a newer CODEZY on launch (the quiet title-bar pill) */
  autoUpdate: true,
  /** keep the window above other windows (coding alongside a chat) */
  alwaysOnTop: false,
  /** with the tray on: launch CODEZY hidden at login (no window flash) */
  startHidden: false,
  /** MCP servers (v3) — none until the user adds one in Settings */
  mcpServers: []
}

export function getSettings(): Settings {
  // 3.1.5 migration: agent mode used to be a buried Settings opt-in, so a
  // folder-linked chat still ran the NO-TOOLS flow — the model got a file
  // tree but could not read a file, search the web or edit anything, and
  // answered with suggestions. Flip it on ONCE for existing settings (the
  // toggle still turns it off afterwards).
  let hadMarker = true
  try {
    const raw = JSON.parse(fs.readFileSync(p.settings(), 'utf8')) as { agentModeMigrated?: boolean }
    hadMarker = raw.agentModeMigrated === true
  } catch {
    /* no settings file yet — defaults already have agent mode on */
  }
  const s = readJson<Settings>(p.settings(), DEFAULT_SETTINGS)
  if (!hadMarker) {
    s.v2 = true
    s.agentModeMigrated = true
    try {
      writeJson(p.settings(), s)
    } catch {
      /* read-only settings dir — the in-memory flip still applies this run */
    }
  }
  return s
}

export function saveSettings(s: Settings): Settings {
  // If the data folder moved, re-root everything before saving.
  if (s.dataDir && s.dataDir !== dataDir) {
    // The boot pointer lives in the DEFAULT location's settings file (see
    // readDataDirPointer) — update it there too, or the next launch starts
    // from the old folder and the change never survives a restart. When we
    // ARE rooted at the default, the regular write below is that pointer.
    if (dataDir !== DEFAULT_DATA_DIR) {
      try {
        const pointerFile = path.join(DEFAULT_DATA_DIR, 'settings.json')
        writeJson(pointerFile, { ...readJson<Settings>(pointerFile, DEFAULT_SETTINGS), dataDir: s.dataDir })
      } catch {
        /* best effort — the save below still lands in the new folder */
      }
    }
    initStore(s.dataDir)
  }
  writeJson(p.settings(), s)
  return s
}

/**
 * Merge a partial patch over the settings ON DISK. The renderer and the TUI
 * both write this file, so a holder with a stale in-memory copy must never
 * rewrite keys it didn't touch — a provider another app just connected, e.g.
 */
export function patchSettings(patch: Partial<Settings>): { prev: Settings; saved: Settings } {
  const prev = getSettings()
  const saved = saveSettings({ ...prev, ...patch })
  return { prev, saved }
}

// -- projects ---------------------------------------------------------------

export function listProjects(): Project[] {
  try {
    const file = path.join(dataDir, 'projects.json')
    if (!fs.existsSync(file)) return []
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Project[]
  } catch {
    return []
  }
}

export function saveProjects(projects: Project[]): void {
  writeJson(path.join(dataDir, 'projects.json'), projects)
}

// -- sessions (one JSON file per chat) --------------------------------------

export function listSessions(): Session[] {
  try {
    return fs
      .readdirSync(p.sessions())
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(p.sessions(), f), 'utf8')) as Session
          // legacy files may predate timestamps — fall back to file mtime so the
          // sidebar never renders "Invalid Date" and the sort stays sane
          if (typeof s.updatedAt !== 'number' || typeof s.createdAt !== 'number') {
            let m = Date.now()
            try {
              m = fs.statSync(path.join(p.sessions(), f)).mtimeMs
            } catch {
              /* keep Date.now() */
            }
            if (typeof s.createdAt !== 'number') s.createdAt = m
            if (typeof s.updatedAt !== 'number') s.updatedAt = m
          }
          return s
        } catch {
          return null
        }
      })
      .filter((s): s is Session => s !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

/**
 * Cross-chat message search (v3.1): case-insensitive substring scan over the
 * most recent sessions (listSessions is newest-first, top 60), newest message
 * first inside each. Hidden/system notes are skipped; snippets are single-line
 * with ~70 chars of context before the match. Caps: `limit` hits (default 50).
 */
export function searchSessions(query: string, limit = 50): ChatSearchHit[] {
  const q = String(query ?? '').trim().toLowerCase()
  if (q.length < 2) return []
  const hits: ChatSearchHit[] = []
  for (const s of listSessions().slice(0, 60)) {
    if (hits.length >= limit) break
    const messages = [...(s.messages ?? [])].reverse()
    for (const m of messages) {
      if (hits.length >= limit) break
      if (m.hidden || typeof m.content !== 'string' || !m.content) continue
      const i = m.content.toLowerCase().indexOf(q)
      if (i < 0) continue
      const from = Math.max(0, i - 70)
      const to = Math.min(m.content.length, i + q.length + 110)
      const raw = m.content.slice(from, to).replace(/\s+/g, ' ')
      hits.push({
        sessionId: s.id,
        sessionTitle: s.title,
        messageId: m.id,
        ts: m.ts,
        role: m.role,
        snippet: `${from > 0 ? '…' : ''}${raw}${to < m.content.length ? '…' : ''}`
      })
    }
  }
  return hits
}

export function getSession(id: string): Session | null {
  return readJson<Session | null>(p.session(id), null)
}

export function saveSession(session: Session): Session {
  session.updatedAt = Date.now()
  writeJson(p.session(session.id), session)
  mirrorToDrive(session) // best-effort sync, no-op if no Drive folder set
  return session
}

export function createSession(projectId: string | null, title = 'New chat'): Session {
  const now = Date.now()
  const session: Session = {
    id: randomUUID(),
    projectId,
    title,
    createdAt: now,
    updatedAt: now,
    messages: []
  }
  return saveSession(session)
}

export function deleteSession(id: string): void {
  try {
    fs.rmSync(p.session(id))
  } catch {
    /* already gone */
  }
}

// -- Google Drive (phase 3, but wired in now) -------------------------------
// Simplest reliable design: CODEZY writes a copy of every session into a
// folder you choose (your real Google Drive folder or Drive File Stream).
// Google's own client does the uploading — no OAuth, no API keys.

function mirrorToDrive(session: Session): void {
  const { driveFolder } = getSettings()
  if (!driveFolder) return
  try {
    const target = path.join(driveFolder, 'CODEZY', 'sessions')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, `${session.id}.json`), JSON.stringify(session, null, 2), 'utf8')
  } catch {
    /* Drive not mounted / offline — local copy is the source of truth */
  }
}

export function driveStatus(): { enabled: boolean; folder: string | null; healthy: boolean } {
  const { driveFolder } = getSettings()
  const healthy = !!driveFolder && fs.existsSync(driveFolder)
  return { enabled: !!driveFolder, folder: driveFolder, healthy }
}

// -- memory file (learning about you) ---------------------------------------

export function readMemory(): string {
  try {
    return fs.readFileSync(p.memory(), 'utf8')
  } catch {
    return ''
  }
}

export function writeMemory(content: string): void {
  fs.writeFileSync(p.memory(), content, 'utf8')
}

// -- app storage (window bounds etc.) ---------------------------------------

export function appPath(name: string): string {
  return path.join(app.getPath('userData'), name)
}

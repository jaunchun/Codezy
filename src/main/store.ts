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

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.codezy')

let dataDir = DEFAULT_DATA_DIR

// -- small JSON helpers -----------------------------------------------------

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) } as T
  } catch {
    // A corrupted file must never crash the app — fall back to defaults.
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp' // write to a temp file first …
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file) // … then atomically swap it in
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

/** Creates the folder tree. Called once at startup (and after a data-dir change). */
export function initStore(dir?: string): void {
  dataDir = dir && dir.trim() ? dir : DEFAULT_DATA_DIR
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
  theme: 'acrylic',
  accent: '#3d9bff',
  dataDir: DEFAULT_DATA_DIR,
  driveFolder: null,
  ollamaUrl: 'http://127.0.0.1:11434',
  providers: [],
  activeProvider: 'ollama',
  activeModel: 'qwen2.5-coder:7b',
  effort: 'medium',
  userName: '',
  learn: true,
  fontSize: 14,
  mode: 'build',
  /** agent mode (v2 harness) — off keeps the classic edit-block flow */
  v2: false,
  /** OS notification when a reply finishes while the window is unfocused */
  notifyDone: false,
  /** Enter sends (true) vs Ctrl+Enter sends (false) */
  enterSends: true,
  /** first-run setup screen — false until the user finishes (or skips) it */
  setupDone: false,
  /** kill every transition/animation (accessibility) */
  reduceMotion: false,
  /** nudge the model when a reply stops inside an unclosed code fence */
  autoContinue: true
}

export function getSettings(): Settings {
  return readJson<Settings>(p.settings(), DEFAULT_SETTINGS)
}

export function saveSettings(s: Settings): Settings {
  // If the data folder moved, re-root everything before saving.
  if (s.dataDir && s.dataDir !== dataDir) initStore(s.dataDir)
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

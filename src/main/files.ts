// ---------------------------------------------------------------------------
// files.ts — @mention support for the composer: list and read files inside
// the chat's linked folders. Same confinement rule as the edit writer — a
// path outside the linked folders is invisible / unreadable here.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'venv',
  '.venv',
  '__pycache__',
  '.cache',
  '.next',
  '.idea',
  '.vscode'
])
const MAX_WALKED = 4000 // files inspected per query
const MAX_HITS = 40 // results returned
const MAX_READ = 60_000 // characters handed to an attachment chip

export interface FileRef {
  path: string // absolute — used for read + the attachment chip
  name: string // relative to its linked folder — what you see and type
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Files under `roots` matching `query` (case-insensitive; basename matches
 * rank above path matches, shallow files first on an empty query).
 */
export function listFiles(roots: string[], query: string): FileRef[] {
  const q = query.trim().toLowerCase()
  const hits: (FileRef & { score: number })[] = []
  let walked = 0

  for (const root of roots) {
    const walk = (dir: string): void => {
      if (walked > MAX_WALKED || hits.length > MAX_HITS * 4) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (walked > MAX_WALKED) return
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full)
          continue
        }
        if (!e.isFile()) continue
        walked++
        const rel = path.relative(root, full).split(path.sep).join('/')
        const base = e.name.toLowerCase()
        let score: number
        if (!q) score = rel.split('/').length
        else if (base.startsWith(q)) score = 0
        else if (base.includes(q)) score = 1
        else if (rel.toLowerCase().includes(q)) score = 2
        else continue
        hits.push({ path: full, name: rel, score })
      }
    }
    walk(path.resolve(root))
  }

  hits.sort((a, b) => a.score - b.score || a.name.length - b.name.length)
  return hits.slice(0, MAX_HITS).map(({ path: p, name }) => ({ path: p, name }))
}

/** Reads a linked-folder file for an @mention — null when outside the roots. */
export function readFileIn(roots: string[], target: string): string | null {
  if (!roots.some((r) => inside(r, target))) return null
  try {
    const text = fs.readFileSync(target, 'utf8')
    return text.length > MAX_READ ? text.slice(0, MAX_READ) + '\n…[truncated]' : text
  } catch {
    return null
  }
}

// -- IDE pane (v1.5): cowork the linked folders side by side with the agent --

export interface IdeNode {
  name: string
  path: string
  dir?: boolean
  children?: IdeNode[]
  /** Present on a marker row (never clickable): how many entries were left
   *  out right here because a cap was hit — 0 = the reason is in the name
   *  (deeper folders). Without this the truncation used to be silent, which
   *  read as "CODEZY lost my folders". */
  more?: number
}

export interface IdeTreeOptions {
  /** Include the ignored folders (dist/venv/.vscode/…). .git and node_modules
   *  stay out either way — either would bury the tree in tens of thousands of
   *  rows and neither is something you cowork on. */
  showIgnored?: boolean
  /** File rows for the whole tree (default MAX_TREE_FILES). */
  maxFiles?: number
  /** File rows per folder, so one monster folder can't starve the rest. */
  maxFilesPerDir?: number
}

const MAX_TREE_FILES = 12_000 // file rows for the whole tree
const MAX_FILES_PER_DIR = 3_000 // so one monster folder can't starve the rest
const MAX_TREE_DIRS = 30_000 // directory nodes (a pathologic tree still stops)
const MAX_TREE_DEPTH = 40 // deeper than this: the folder shows, its contents don't
const MAX_IDE_READ = 1_000_000 // characters the editor will open

/**
 * Structured tree of the linked folders.
 *
 * Rules that exist because they were once broken (v2.5.0: a user saw 2 of
 * their 10 folders): a full FILE budget may only ever cost you files, never
 * directories — every folder the user made is walked and shown, and whatever
 * is left out says so with a marker row. Directories are emitted before
 * files, so a truncation never reads as "this folder is empty".
 */
export function ideTree(roots: string[], opts?: IdeTreeOptions): IdeNode[] {
  const out: IdeNode[] = []
  const skip = opts?.showIgnored ? new Set(['.git', 'node_modules']) : SKIP_DIRS
  const fileCap = Math.max(0, opts?.maxFiles ?? MAX_TREE_FILES)
  const dirFileCap = Math.max(1, opts?.maxFilesPerDir ?? MAX_FILES_PER_DIR)
  let files = 0
  let dirs = 0

  const walk = (dir: string, depth: number): IdeNode[] => {
    const nodes: IdeNode[] = []
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return nodes // unreadable (permission, vanished) — siblings still show
    }
    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1
    )

    // 1. directories — ALWAYS, whatever the file counters say
    for (const e of entries) {
      if (!e.isDirectory() || skip.has(e.name) || dirs >= MAX_TREE_DIRS) continue
      const full = path.join(dir, e.name)
      dirs++
      const children =
        depth >= MAX_TREE_DEPTH
          ? [{ name: '… deeper folders are hidden', path: `${full}\u0000deep`, dir: false, more: 0 } as IdeNode]
          : walk(full, depth + 1)
      nodes.push({ name: e.name, path: full, dir: true, children })
    }

    // 2. files — capped, per directory and for the whole tree
    let leftOut = 0 // skipped for the whole-tree budget
    let leftOutDir = 0 // skipped for this folder's own budget
    let perDirCut = false // which cap caused leftOutDir (labels the marker)
    for (const e of entries) {
      if (!e.isFile()) continue
      if (files >= fileCap) {
        leftOut++
        continue
      }
      if (leftOutDir >= dirFileCap) {
        leftOutDir++
        perDirCut = true
        continue
      }
      files++
      leftOutDir++
      nodes.push({ name: e.name, path: path.join(dir, e.name), dir: false })
    }
    if (leftOutDir) {
      nodes.push({
        name: perDirCut
          ? `… ${leftOutDir} more file${leftOutDir === 1 ? '' : 's'} in this folder`
          : `… ${leftOutDir} more file${leftOutDir === 1 ? '' : 's'} (tree cap reached)`,
        path: `${dir}\u0000more`,
        dir: false,
        more: leftOutDir
      })
    }
    if (leftOut) {
      nodes.push({
        name: `… ${leftOut} more file${leftOut === 1 ? '' : 's'} (tree cap reached)`,
        path: `${dir}\u0000more-tree`,
        dir: false,
        more: leftOut
      })
    }
    return nodes
  }

  for (const r of roots) {
    const root = path.resolve(r)
    out.push({ name: path.basename(root) || root, path: root, dir: true, children: walk(root, 1) })
  }
  return out
}

export interface IdeReadResult {
  content: string
  /** The file is over MAX_IDE_READ and its tail was cut off — the buffer in
   *  the editor is NOT the whole file, so saving it back would destroy the
   *  rest. The editor opens such files read-only. */
  truncated: boolean
}

/** Full read for the editor — confined to the linked folders, big cap. */
export function ideRead(roots: string[], target: string): IdeReadResult | null {
  if (!roots.some((r) => inside(r, target))) return null
  try {
    const text = fs.readFileSync(target, 'utf8')
    if (text.length > MAX_IDE_READ) return { content: text.slice(0, MAX_IDE_READ), truncated: true }
    return { content: text, truncated: false }
  } catch {
    return null
  }
}

/**
 * True when writing `content` over `target` would destroy data: the file on
 * disk is bigger than the editor's read cap, so `content` can only be a
 * truncated buffer of it. (A full rewrite from scratch is always smaller than
 * the file it replaces — anything that fits the cap while the file doesn't is
 * by definition a truncated view.)
 */
export function ideSaveWouldTruncate(target: string, content: string): boolean {
  try {
    if (!fs.existsSync(target)) return false
    return fs.statSync(target).size > MAX_IDE_READ && content.length <= MAX_IDE_READ
  } catch {
    return false
  }
}

/** Save from the editor — confined; creates missing parent folders. */
export function ideWrite(roots: string[], target: string, content: string): string | null {
  if (!roots.some((r) => inside(r, target))) return null
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf8')
    return target
  } catch {
    return null
  }
}

/** New file (or folder) inside the linked folders. */
export function ideCreate(roots: string[], target: string, dir: boolean): string | null {
  if (!roots.some((r) => inside(r, target))) return null
  try {
    if (dir) {
      fs.mkdirSync(target, { recursive: true })
    } else if (!fs.existsSync(target)) {
      fs.writeFileSync(target, '', 'utf8')
    }
    return target
  } catch {
    return null
  }
}

/**
 * Rename/move a cowork file. Both ends must sit inside the linked folders,
 * the source must exist and the destination must not (a silent overwrite of
 * another file is exactly what a rename must never do).
 */
export function ideRename(roots: string[], from: string, to: string): string | null {
  if (!roots.some((r) => inside(r, from)) || !roots.some((r) => inside(r, to))) return null
  try {
    if (!fs.existsSync(from) || fs.existsSync(to)) return null
    fs.renameSync(from, to)
    return to
  } catch {
    return null
  }
}

/**
 * Delete a cowork file. Files only — removing a directory tree from a
 * one-click row is never what the user meant — and never a linked root.
 */
export function ideDelete(roots: string[], target: string): boolean {
  if (!roots.some((r) => inside(r, target))) return false
  if (roots.some((r) => path.resolve(r) === path.resolve(target))) return false
  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false
    fs.unlinkSync(target)
    return true
  } catch {
    return false
  }
}

/** Image formats the viewer can render inline. */
export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
}

export const isImagePath = (p: string): boolean => !!IMAGE_MIME[path.extname(p).toLowerCase()]

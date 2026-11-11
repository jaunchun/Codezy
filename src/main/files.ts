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

// -- find in files ----------------------------------------------------------

const MAX_SEARCH_FILES = 12_000 // files read per search
const MAX_SEARCH_HITS = 400 // matches returned
const MAX_SEARCH_PER_FILE = 25 // one minified file can't eat the whole list
const MAX_SEARCH_BYTES = 1_500_000 // bigger files are skipped (lockfiles, dumps)
const MAX_SEARCH_TOTAL_BYTES = 40_000_000 // whole search stops after this much text
const MAX_PREVIEW = 220 // characters of line context shown per hit

/** Binary and asset formats that are never worth scanning as text. */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.avif', '.tif', '.tiff',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv',
  '.zip', '.gz', '.7z', '.rar', '.tar', '.bz2', '.xz',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.class', '.o', '.a', '.lib',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.sqlite', '.db', '.mdb', '.pyc', '.pyo', '.node'
])

export interface FileSearchHit {
  /** Absolute path — what the cowork editor opens. */
  path: string
  /** Path relative to its linked folder — what the list shows. */
  name: string
  /** 1-based line number. */
  line: number
  /** 1-based column of the match in the real line — the editor selection. */
  column: number
  /** 1-based column of the match inside the trimmed `text` preview. */
  previewColumn: number
  /** Match length in characters (the editor selects exactly this much). */
  length: number
  /** Trimmed, capped line excerpt around the match. */
  text: string
}

export interface FileSearchResult {
  hits: FileSearchHit[]
  /** Files whose contents were read. */
  scanned: number
  /** A cap stopped the walk — the list is a prefix, not the whole project. */
  truncated: boolean
}

/** True when a buffer looks binary (NUL byte or a known asset extension). */
function looksBinary(file: string, buf: Buffer): boolean {
  if (BINARY_EXT.has(path.extname(file).toLowerCase())) return true
  const head = Math.min(buf.length, 8000)
  for (let i = 0; i < head; i++) if (buf[i] === 0) return true
  return false
}

/** One line excerpt, capped around the match, trimmed for display. */
function excerpt(line: string, at: number): { text: string; previewColumn: number } {
  let start = 0
  let end = line.length
  if (line.length > MAX_PREVIEW) {
    start = Math.max(0, at - Math.floor(MAX_PREVIEW / 2))
    end = Math.min(line.length, start + MAX_PREVIEW)
    if (end === line.length) start = Math.max(0, end - MAX_PREVIEW)
  }
  let text = line.slice(start, end)
  const lead = text.length - text.trimStart().length
  text = text.trim()
  return { text, previewColumn: Math.max(1, at - start - lead + 1) }
}

/**
 * Case-insensitive literal search across the linked folders (v3.1 Find in
 * files). One hit per line, shallow-first within each folder, with hard caps
 * on files read, hits returned and bytes per file so a node_modules-shaped
 * project can never hang the main process.
 */
export function searchFiles(roots: string[], query: string): FileSearchResult {
  const needle = query.trim().toLowerCase()
  if (needle.length < 2) return { hits: [], scanned: 0, truncated: false }

  const hits: FileSearchHit[] = []
  let scanned = 0
  let bytes = 0
  let truncated = false

  const walk = (root: string, dir: string, depth: number): void => {
    if (hits.length >= MAX_SEARCH_HITS) {
      truncated = true
      return
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))

    for (const e of entries) {
      if (hits.length >= MAX_SEARCH_HITS) {
        truncated = true
        return
      }
      if (scanned >= MAX_SEARCH_FILES) {
        truncated = true
        return
      }
      if (e.isDirectory()) {
        if (depth < 40 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(root, path.join(dir, e.name), depth + 1)
        continue
      }
      if (!e.isFile() || BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue

      const full = path.join(dir, e.name)
      let buf: Buffer
      try {
        const st = fs.statSync(full)
        if (st.size > MAX_SEARCH_BYTES) continue
        if (bytes + st.size > MAX_SEARCH_TOTAL_BYTES) {
          truncated = true
          return
        }
        buf = fs.readFileSync(full)
        bytes += st.size
      } catch {
        continue
      }
      scanned++
      if (looksBinary(full, buf)) continue

      const rel = path.relative(root, full).split(path.sep).join('/')
      const lines = buf.toString('utf8').split(/\r?\n/)
      let inFile = 0
      for (let i = 0; i < lines.length && inFile < MAX_SEARCH_PER_FILE; i++) {
        const at = lines[i].toLowerCase().indexOf(needle)
        if (at === -1) continue
        if (hits.length >= MAX_SEARCH_HITS) {
          truncated = true
          break
        }
        const view = excerpt(lines[i], at)
        hits.push({
          path: full,
          name: rel,
          line: i + 1,
          column: at + 1,
          previewColumn: view.previewColumn,
          length: needle.length,
          text: view.text
        })
        inFile++
      }
      if (hits.length >= MAX_SEARCH_HITS) truncated = true
    }
  }

  for (const r of roots) {
    const root = path.resolve(r)
    walk(root, root, 1)
    if (truncated || hits.length >= MAX_SEARCH_HITS) {
      truncated = true
      break
    }
  }

  hits.sort((a, b) => a.name.localeCompare(b.name) || a.line - b.line || a.column - b.column)
  return { hits, scanned, truncated }
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

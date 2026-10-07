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
}

const MAX_TREE_FILES = 4000
const MAX_IDE_READ = 1_000_000 // characters the editor will open

/** Structured tree of the linked folders (skips node_modules/.git/…). */
export function ideTree(roots: string[]): IdeNode[] {
  const out: IdeNode[] = []
  let count = 0
  const walk = (dir: string): IdeNode[] => {
    const nodes: IdeNode[] = []
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return nodes
    }
    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1
    )
    for (const e of entries) {
      if (count > MAX_TREE_FILES) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        nodes.push({ name: e.name, path: full, dir: true, children: walk(full) })
      } else if (e.isFile()) {
        count++
        nodes.push({ name: e.name, path: full, dir: false })
      }
    }
    return nodes
  }
  for (const r of roots) {
    const root = path.resolve(r)
    out.push({ name: path.basename(root) || root, path: root, dir: true, children: walk(root) })
  }
  return out
}

/** Full read for the editor — confined to the linked folders, big cap. */
export function ideRead(roots: string[], target: string): string | null {
  if (!roots.some((r) => inside(r, target))) return null
  try {
    const text = fs.readFileSync(target, 'utf8')
    return text.length > MAX_IDE_READ ? text.slice(0, MAX_IDE_READ) : text
  } catch {
    return null
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

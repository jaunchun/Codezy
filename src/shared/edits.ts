// ---------------------------------------------------------------------------
// edits.ts — the model's file-edit language: parse it, strip it, diff it.
//
// The model proposes changes in this exact format (see BASE_INSTRUCTIONS):
//
//   ===FILE: relative/path.ext
//   ===SEARCH
//   exact lines to find (verbatim)     — or the single word EMPTY for a new file
//   ===REPLACE
//   new lines
//   ===END
//
// This module is shared: the renderer parses it to draw the "New edit" bar and
// the preview popup, the main process parses it again before touching disk
// (never trust one side alone — main re-validates everything anyway).
// Models love wrapping the content in ```fences``` — stripFences handles that.
// ---------------------------------------------------------------------------

export interface FileEdit {
  path: string
  search: string // exact text to find; '' when isNew
  replace: string // the new content
  isNew: boolean // true when ===SEARCH said EMPTY
}

export interface ParsedEdit extends FileEdit {
  added: number // lines that will appear / change
  removed: number // lines that will disappear
}

/** One line of a unified-ish diff. */
export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
}

// Colon optional (===FILE path) — small models sometimes drop it; the path is
// still mandatory, so the line must separate it from FILE with ":" or blanks.
const FILE_HEAD = /(?:^|\n)===FILE(?::|[ \t]+)[ \t]*([^\n]+?)[ \t]*\r?\n/g

/** Models fence their code (```python … ```); the protocol text is raw. */
function stripFences(s: string): string {
  let t = s.replace(/^[ \t]*```[a-zA-Z0-9_+.#-]*[ \t]*\r?\n/, '')
  t = t.replace(/\r?\n[ \t]*```[ \t]*\s*$/, '')
  return t
}

/** Index just past the end of the line containing `idx`. */
function afterLine(text: string, idx: number): number {
  const nl = text.indexOf('\n', idx)
  return nl === -1 ? text.length : nl + 1
}

/**
 * Line-based LCS diff. Falls back to "delete all / add all" for giant files
 * where the O(n·m) table would be wasteful (cap: 4M cells ≈ 16 MB Int32).
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((t) => ({ type: 'del' as const, text: t })),
      ...b.map((t) => ({ type: 'add' as const, text: t }))
    ]
  }
  const n = a.length
  const m = b.length
  const width = m + 1
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i++
    } else {
      out.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}

// Parsing the same message text repeatedly (chat view + stream + preview) —
// cache the result so big replies aren't re-scanned on every token render.
const cache = new Map<string, ParsedEdit[]>()
const CACHE_MAX = 60

function countChanges(edit: FileEdit): { added: number; removed: number } {
  if (edit.isNew) {
    return { added: edit.replace ? edit.replace.split('\n').length : 0, removed: 0 }
  }
  const d = diffLines(edit.search, edit.replace)
  return {
    added: d.filter((l) => l.type === 'add').length,
    removed: d.filter((l) => l.type === 'del').length
  }
}

function parseUncached(text: string): ParsedEdit[] {
  const out: ParsedEdit[] = []
  FILE_HEAD.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FILE_HEAD.exec(text))) {
    const filePath = m[1].trim()
    if (!filePath) continue
    const bodyStart = m.index + m[0].length
    const endIdx = text.indexOf('===END', bodyStart)
    if (endIdx === -1) break // block still streaming (or cut off) → ignore
    const body = text.slice(bodyStart, endIdx)

    const sIdx = body.search(/===SEARCH\b/)
    const rIdx = body.search(/===REPLACE\b/)
    if (sIdx === -1 || rIdx === -1 || rIdx < sIdx) continue

    const searchRaw = body.slice(afterLine(body, sIdx), rIdx)
    const replaceRaw = body.slice(afterLine(body, rIdx))
    const trimmedSearch = searchRaw.trim()
    const isNew = trimmedSearch === 'EMPTY' || trimmedSearch === ''
    const edit: FileEdit = {
      path: filePath,
      isNew,
      search: isNew ? '' : stripFences(searchRaw),
      replace: stripFences(replaceRaw)
    }
    out.push({ ...edit, ...countChanges(edit) })
  }
  return out
}

/** Extracts every complete ===FILE block from a message. */
export function parseEdits(text: string): ParsedEdit[] {
  if (!text.includes('===FILE')) return []
  const hit = cache.get(text)
  if (hit) return hit
  const parsed = parseUncached(text)
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(text, parsed)
  return parsed
}

/**
 * Removes edit blocks from the message so the markdown renderer only shows
 * the prose — the blocks are presented by the styled "New edit" card instead
 * of as ugly raw ===FILE text. Also drops a trailing half-written block while
 * the model is still streaming.
 */
export function stripEditBlocks(text: string): string {
  if (!text.includes('===FILE')) return text
  let out = text.replace(/(?:^|\n)===FILE(?::|[ \t]+)[\s\S]*?===END/g, '\n')
  out = out.replace(/(?:^|\n)===FILE(?::|[ \t]+)[\s\S]*$/, '\n')
  return out.replace(/\n{3,}/g, '\n\n')
}

// -- hunks (v3 review-first editing) -------------------------------------------
// A diff the user can review PIECEWISE: changes are grouped into hunks
// (a run of +/− lines with up to `ctx` context lines around it; two change
// runs separated by only a little context merge into one hunk). Selecting a
// subset of hunks and composing the result is what "accept 2 of 3 hunks"
// means — the untouched hunks are simply written back as their old lines.

export interface DiffHunk {
  id: number
  /** Index range [start, end) this hunk covers in the diff it came from. */
  start: number
  end: number
  /** Context + change lines, in diff order (context makes it readable). */
  lines: DiffLine[]
  added: number
  removed: number
}

/** Groups a diff into reviewable hunks. Change runs within `ctx * 2`
 *  unchanged lines merge; each hunk keeps up to `ctx` context lines. */
export function toHunks(diff: DiffLine[], ctx = 3): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let id = 0
  let i = 0
  while (i < diff.length) {
    if (diff[i].type === 'ctx') {
      i++
      continue
    }
    // a change run starts here — pull back over up to ctx context lines
    let start = i
    while (start > 0 && i - start < ctx && diff[start - 1].type === 'ctx') start--
    let j = i
    let stoppedInCtx = false
    while (j < diff.length) {
      if (diff[j].type !== 'ctx') {
        j++
        continue
      }
      let k = j
      while (k < diff.length && diff[k].type === 'ctx') k++
      // merge when the next change is close enough to belong to this hunk
      if (k < diff.length && k - j <= ctx * 2) {
        j = k
        continue
      }
      stoppedInCtx = true
      break
    }
    // keep up to ctx trailing context lines when the run stopped in one
    const end = stoppedInCtx ? Math.min(j + ctx, diff.length) : j
    const lines = diff.slice(start, end)
    const added = lines.filter((l) => l.type === 'add').length
    const removed = lines.filter((l) => l.type === 'del').length
    if (added || removed) hunks.push({ id: id++, start, end, lines, added, removed })
    i = j > i ? j : i + 1
  }
  return hunks
}

/**
 * Rebuilds the file keeping only the SELECTED hunks: kept hunks contribute
 * their `+` lines, skipped ones fall back to their `−` (old) lines, and the
 * context between them passes through unchanged. Selection is by hunk id;
 * hunks must come from `toHunks()` on a diff with the SAME shape as the one
 * passed here (matching by line POSITION, not object identity).
 * Returns the full new text, ready to hand to the write engine.
 */
export function composeHunks(diff: DiffLine[], hunks: DiffHunk[], keep: number[] | Set<number>): string {
  const keepSet = keep instanceof Set ? keep : new Set(keep)
  // which hunk (if any) owns each diff line — -1 = untouched context
  const owner = new Int32Array(diff.length).fill(-1)
  for (const h of hunks) {
    if (keepSet.has(h.id)) {
      for (let i = h.start; i < h.end && i < diff.length; i++) owner[i] = h.id
    }
  }
  const out: string[] = []
  for (let i = 0; i < diff.length; i++) {
    const line = diff[i]
    if (owner[i] !== -1) {
      if (line.type !== 'del') out.push(line.text) // kept hunk: adds + context
    } else if (line.type === 'ctx') {
      out.push(line.text) // context between/around hunks
    } else {
      // a skipped hunk falls back to its OLD lines: dels stay, adds go
      const inSkipped = hunks.some((h) => i >= h.start && i < h.end)
      if (inSkipped && line.type === 'del') out.push(line.text)
    }
  }
  return out.join('\n')
}

/** added/removed counts for a proposed replacement (shared by UI + store). */
export function changeCounts(search: string, replace: string, isNew = false): { added: number; removed: number } {
  return countChanges({ path: '', search, replace, isNew })
}

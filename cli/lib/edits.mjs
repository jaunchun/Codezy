// ---------------------------------------------------------------------------
// edits.mjs — the model's file-edit language for the terminal.
// Parse ===FILE blocks (port of src/shared/edits.ts), apply them with the
// same safety rules as the app (port of src/main/edits.ts):
//   1. writes only inside the linked folder (traversal refused),
//   2. ===SEARCH must match EXACTLY one place (CRLF/LF neutral),
//   3. every original is backed up BEFORE the first write → /undo reverts.
// Also: the shallow file tree for prompts, and a line diff for review cards.
// Plain Node, no dependencies.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'

// -- file tree (port of prompt.ts) ------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  'coverage',
  '.idea',
  '.vscode'
])

/** Shallow file tree of a folder (depth 2, junk dirs skipped). */
export function fileTree(dir, maxEntries = 120) {
  const out = []
  const walk = (current, rel, depth) => {
    if (depth > 2 || out.length >= maxEntries) return
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxEntries) return
      const name = entry.name
      if (name.startsWith('.') && name !== '.env.example') continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        out.push(`${rel}${name}/`)
        walk(path.join(current, name), `${rel}${name}/`, depth + 1)
      } else {
        out.push(`${rel}${name}`)
      }
    }
  }
  walk(dir, '', 1)
  return out.join('\n')
}

// -- parsing (port of shared/edits.ts) --------------------------------------

const FILE_HEAD = /(?:^|\n)===FILE:[ \t]*([^\n]+)[ \t]*\r?\n/g

function stripFences(s) {
  let t = s.replace(/^[ \t]*```[a-zA-Z0-9_+.#-]*[ \t]*\r?\n/, '')
  t = t.replace(/\r?\n[ \t]*```[ \t]*\s*$/, '')
  return t
}

function afterLine(text, idx) {
  const nl = text.indexOf('\n', idx)
  return nl === -1 ? text.length : nl + 1
}

/** Line-based LCS diff (cap: 4M cells ≈ 16 MB Int32). */
export function diffLines(oldText, newText) {
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((t) => ({ type: 'del', text: t })),
      ...b.map((t) => ({ type: 'add', text: t }))
    ]
  }
  const n = a.length
  const m = b.length
  const width = m + 1
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const out = []
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

function countChanges(edit) {
  if (edit.isNew) {
    return { added: edit.replace ? edit.replace.split('\n').length : 0, removed: 0 }
  }
  const d = diffLines(edit.search, edit.replace)
  return {
    added: d.filter((l) => l.type === 'add').length,
    removed: d.filter((l) => l.type === 'del').length
  }
}

function parseUncached(text) {
  const out = []
  FILE_HEAD.lastIndex = 0
  let m
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
    const edit = {
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
export function parseEdits(text) {
  if (!text.includes('===FILE:')) return []
  return parseUncached(text)
}

/** Removes complete + trailing half-written edit blocks (prose only). */
export function stripEditBlocks(text) {
  if (!text.includes('===FILE:')) return text
  let out = text.replace(/(?:^|\n)===FILE:[\s\S]*?===END/g, '\n')
  out = out.replace(/(?:^|\n)===FILE:[\s\S]*$/, '\n')
  return out.replace(/\n{3,}/g, '\n\n')
}

// -- applying (port of main/edits.ts) ---------------------------------------

/** True when `target` lives strictly inside `folder`. */
function inside(folder, target) {
  const rel = path.relative(path.resolve(folder), path.resolve(target))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function resolveTarget(edit, folders) {
  const raw = edit.path.trim().replace(/\//g, '\\')
  const absolute = path.isAbsolute(raw) || /^[a-zA-Z]:\\/.test(raw) || raw.startsWith('\\\\')

  if (absolute) {
    const target = path.normalize(raw)
    if (!folders.some((f) => inside(f, target))) {
      return { error: `${edit.path}: outside the linked folder — refused.` }
    }
    return { target }
  }

  const candidates = folders.map((f) => path.join(f, raw)).filter((c) => folders.some((f) => inside(f, c)))
  if (!candidates.length) return { error: `${edit.path}: outside the linked folder — refused.` }
  const existing = candidates.find((c) => fs.existsSync(c))
  if (existing) return { target: existing }
  if (!edit.isNew) return { error: `${edit.path}: not found in the linked folder.` }
  return { target: candidates[0] }
}

/**
 * Applies edits inside `folders`. Partial success is allowed; a backup is
 * only created when something was actually written.
 * @param folders {string[]}
 * @param edits {{path:string, search:string, replace:string, isNew:boolean}[]}
 * @param backupDir {string} — e.g. ~/.codezy/backups/terminal
 */
export function applyEdits(folders, edits, backupDir) {
  const applied = []
  const errors = []

  if (!folders.length) return { applied, errors: ['Link a folder first (/link <dir>).'], backupId: null }
  if (!edits.length) return { applied, errors: ['Nothing to apply.'], backupId: null }

  const backups = []

  for (const edit of edits) {
    try {
      const { target, error } = resolveTarget(edit, folders)
      if (error || !target) {
        errors.push(error ?? `${edit.path}: could not be resolved.`)
        continue
      }

      let next
      let prev = null

      if (edit.isNew) {
        if (fs.existsSync(target)) {
          errors.push(`${edit.path}: already exists (model claimed EMPTY).`)
          continue
        }
        next = edit.replace
      } else {
        if (!fs.existsSync(target)) {
          errors.push(`${edit.path}: not found.`)
          continue
        }
        const current = fs.readFileSync(target, 'utf8')
        const hay = current.replace(/\r\n/g, '\n')
        const needle = edit.search.replace(/\r\n/g, '\n')
        const idx = hay.indexOf(needle)
        if (idx === -1) {
          errors.push(`${edit.path}: the code to replace no longer matches (file changed?).`)
          continue
        }
        if (hay.indexOf(needle, idx + needle.length) !== -1) {
          errors.push(`${edit.path}: the code to replace matches several places — be more specific.`)
          continue
        }
        prev = current
        next = hay.slice(0, idx) + edit.replace.replace(/\r\n/g, '\n') + hay.slice(idx + needle.length)
      }

      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, next, 'utf8')
      backups.push({ path: target, prev })
      applied.push({ path: target, isNew: edit.isNew })
    } catch (e) {
      errors.push(`${edit.path}: ${e.message}`)
    }
  }

  let backupId = null
  if (backups.length) {
    try {
      fs.mkdirSync(backupDir, { recursive: true })
      backupId = String(Date.now())
      fs.writeFileSync(
        path.join(backupDir, `${backupId}.json`),
        JSON.stringify({ ts: Date.now(), entries: backups }, null, 2),
        'utf8'
      )
    } catch {
      backupId = null // writes succeeded; only the safety copy failed
    }
  }

  return { applied, errors, backupId }
}

/** Restores the most recent backup. One step back in time. */
export function undoLast(backupDir) {
  let files
  try {
    files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json'))
  } catch {
    return { restored: 0, message: 'Nothing to undo — no edits were applied yet.' }
  }
  if (!files.length) return { restored: 0, message: 'Nothing to undo — no edits were applied yet.' }

  const latest = files.sort((a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0))[0]
  let entries
  try {
    entries = JSON.parse(fs.readFileSync(path.join(backupDir, latest), 'utf8')).entries
  } catch {
    return { restored: 0, message: 'Backup unreadable — nothing changed.' }
  }

  let restored = 0
  for (const e of entries) {
    try {
      if (e.prev === null) fs.rmSync(e.path, { force: true })
      else fs.writeFileSync(e.path, e.prev, 'utf8')
      restored++
    } catch {
      /* file vanished or locked — keep going */
    }
  }
  fs.rmSync(path.join(backupDir, latest), { force: true })
  return { restored, message: `Reverted ${restored} file${restored === 1 ? '' : 's'}.` }
}

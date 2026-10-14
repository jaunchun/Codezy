// ---------------------------------------------------------------------------
// edits.ts — applying the model's proposed edits to real files.
//
// Safety rules (the whole point of the accept/confirm flow):
// 1. A file may ONLY be written inside one of the chat's linked folders —
//    absolute paths outside them and ../traversals are rejected in main,
//    no matter what the renderer asked for.
// 2. The ===SEARCH text must match EXACTLY one place in the current file
//    (CRLF/LF neutral), otherwise nothing is written for that file — the
//    file may have changed since the model read it.
// 3. Every original is backed up to ~/.codezy/backups/<sessionId>/ BEFORE
//    the first write, so /undo can put everything back in one step.
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import type { Session } from '../shared/types'
import type { FileEdit } from '../shared/edits'
import type { ApplyOutcome, BackupInfo } from '../shared/api'
import { p } from './store'

interface BackupEntry {
  path: string
  prev: string | null // null = file didn't exist (new file → delete on undo)
}

/** Millisecond ids, never colliding within a process — /undo sorts via parseInt. */
let lastBackupTs = 0
function nextBackupId(): string {
  const now = Date.now()
  lastBackupTs = now > lastBackupTs ? now : lastBackupTs + 1
  return String(lastBackupTs)
}

/** True when `target` lives strictly inside `folder`. */
function inside(folder: string, target: string): boolean {
  const rel = path.relative(path.resolve(folder), path.resolve(target))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function resolveTarget(edit: FileEdit, folders: string[]): { target?: string; error?: string } {
  const raw = edit.path.trim().replace(/\//g, '\\')
  const absolute = path.isAbsolute(raw) || /^[a-zA-Z]:\\/.test(raw) || raw.startsWith('\\\\')

  if (absolute) {
    const target = path.normalize(raw)
    if (!folders.some((f) => inside(f, target))) {
      return { error: `${edit.path}: outside the linked folders — refused.` }
    }
    return { target }
  }

  const candidates = folders
    .map((f) => path.join(f, raw))
    .filter((c) => folders.some((f) => inside(f, c))) // kills ../ traversals
  if (!candidates.length) return { error: `${edit.path}: outside the linked folders — refused.` }
  const existing = candidates.find((c) => fs.existsSync(c))
  if (existing) return { target: existing }
  if (!edit.isNew) return { error: `${edit.path}: not found in the linked folders.` }
  return { target: candidates[0] }
}

/**
 * Applies edits to the session's linked folders. Two phases: everything is
 * resolved and computed first (no disk changes), then the safety copy is
 * written, and only then do the file writes happen — if the backup cannot be
 * written, NOTHING is applied, because an applied-but-unbacked-up edit is
 * unrecoverable. Non-UTF-8 files are refused outright: matching them through
 * a lossy decode would destroy every invalid byte in the file.
 */
export function applyEdits(session: Session, edits: FileEdit[]): ApplyOutcome {
  const applied: ApplyOutcome['applied'] = []
  const errors: string[] = []
  const folders = session.linkedFolders ?? []

  if (!folders.length) return { applied, errors: ['Link a folder to this chat first.'], backupId: null }
  if (!edits.length) return { applied, errors: ['Nothing to apply.'], backupId: null }

  // -- pass 1: resolve, validate, compute — nothing on disk yet -------------
  const plan: { target: string; next: string; prev: string | null; isNew: boolean; editPath: string }[] = []

  for (const edit of edits) {
    try {
      const { target, error } = resolveTarget(edit, folders)
      if (error || !target) {
        errors.push(error ?? `${edit.path}: could not be resolved.`)
        continue
      }

      let next: string
      let prev: string | null = null

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
        const rawBuf = fs.readFileSync(target)
        const current = rawBuf.toString('utf8')
        // a NUL or any byte that doesn't survive a UTF-8 round-trip means
        // binary or legacy-encoded content — refuse rather than corrupt it
        if (current.includes('\0') || !Buffer.from(current, 'utf8').equals(rawBuf)) {
          errors.push(`${edit.path}: not UTF-8 text (binary or legacy encoding) — refusing to edit to avoid corruption.`)
          continue
        }
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
        // matching runs on the LF-normalized copy — restore the file's
        // dominant ending so a one-line edit doesn't rewrite every line
        const crlf = (current.match(/\r\n/g) ?? []).length
        const lf = (current.match(/\n/g) ?? []).length - crlf
        if (crlf > lf) next = next.replace(/\n/g, '\r\n')
      }

      plan.push({ target, next, prev, isNew: edit.isNew, editPath: edit.path })
    } catch (e) {
      errors.push(`${edit.path}: ${(e as Error).message}`)
    }
  }

  if (!plan.length) return { applied, errors, backupId: null }

  // -- pass 2: the safety copy — BEFORE the first write ---------------------
  const entries: BackupEntry[] = plan.map((w) => ({ path: w.target, prev: w.prev }))
  let backupId: string | null = null
  try {
    const dir = p.backups(session.id)
    fs.mkdirSync(dir, { recursive: true })
    backupId = nextBackupId()
    fs.writeFileSync(path.join(dir, `${backupId}.json`), JSON.stringify({ ts: Date.now(), entries }, null, 2), 'utf8')
  } catch (e) {
    return {
      applied,
      errors: [...errors, `safety backup could not be written (${(e as Error).message}) — no files were changed.`],
      backupId: null
    }
  }

  // -- pass 3: the writes ---------------------------------------------------
  const written: BackupEntry[] = []
  for (const w of plan) {
    try {
      fs.mkdirSync(path.dirname(w.target), { recursive: true })
      fs.writeFileSync(w.target, w.next, 'utf8')
      applied.push({ path: w.target, isNew: w.isNew })
      written.push({ path: w.target, prev: w.prev })
    } catch (e) {
      errors.push(`${w.editPath}: ${(e as Error).message}`)
    }
  }

  // shrink the backup to what actually changed (a superset would also undo
  // fine — rewriting an untouched file with its original is a no-op — but
  // /undo should report the files that really were edited)
  if (backupId) {
    const backupFile = path.join(p.backups(session.id), `${backupId}.json`)
    if (!written.length) {
      try {
        fs.rmSync(backupFile, { force: true })
      } catch {
        /* ignore */
      }
      backupId = null
    } else if (written.length !== entries.length) {
      try {
        fs.writeFileSync(backupFile, JSON.stringify({ ts: Date.now(), entries: written }, null, 2), 'utf8')
      } catch {
        /* keep the pre-write superset — undo still restores everything */
      }
    }
  }

  return { applied, errors, backupId }
}

/**
 * Code-block "apply" (v3.1): overwrite (or create) ONE file with the exact
 * content of a rendered code block. The whole current file becomes the search
 * text, so it goes through the normal applyEdits machinery — same linked-folder
 * confinement, same safety backup, same /undo as every agent edit.
 */
export function applyCodeBlock(
  session: Session,
  target: string,
  content: string
): { saved: string; backupId: string | null } {
  const roots = session.linkedFolders ?? []
  if (!roots.length) throw new Error('Link a folder to this chat first')

  const rel = String(target ?? '').trim().replace(/\\/g, '/')
  if (!rel || rel.includes('..') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    throw new Error('Give a path inside the linked folder (e.g. src/app.ts)')
  }

  const existing = roots.map((r) => path.join(r, rel)).find((c) => fs.existsSync(c))
  let search = ''
  const isNew = !existing
  if (existing) {
    const raw = fs.readFileSync(existing)
    const cur = raw.toString('utf8')
    // same binary guard applyEdits applies — never corrupt a non-UTF-8 file
    if (cur.includes('\0') || !Buffer.from(cur, 'utf8').equals(raw)) {
      throw new Error('That file is not UTF-8 text — refusing to overwrite it.')
    }
    search = cur
  }

  const out = applyEdits(session, [{ path: rel, search, replace: String(content ?? ''), isNew }])
  if (out.errors?.length) throw new Error(out.errors[0])
  return { saved: out.applied[0]?.path ?? rel, backupId: out.backupId }
}

/** Restores the most recent backup of this session. One step back in time. */
export function undoLast(sessionId: string): { restored: number; message: string } {
  const dir = p.backups(sessionId)
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return { restored: 0, message: 'Nothing to undo — no edits were applied yet.' }
  }
  if (!files.length) return { restored: 0, message: 'Nothing to undo — no edits were applied yet.' }

  const latest = files.sort((a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0))[0]
  let entries: BackupEntry[]
  try {
    entries = (JSON.parse(fs.readFileSync(path.join(dir, latest), 'utf8')) as { entries: BackupEntry[] }).entries
  } catch {
    return { restored: 0, message: 'Backup unreadable — nothing changed.' }
  }

  // one entry per edited region — the same file can appear twice in one
  // batch, and the EARLIEST entry holds the true pre-edit content
  const seen = new Set<string>()
  const deduped: BackupEntry[] = []
  for (const e of entries) {
    if (seen.has(e.path)) continue
    seen.add(e.path)
    deduped.push(e)
  }

  let restored = 0
  const failed: BackupEntry[] = []
  for (const e of deduped) {
    try {
      if (e.prev === null) fs.rmSync(e.path, { force: true })
      else fs.writeFileSync(e.path, e.prev, 'utf8')
      restored++
    } catch {
      // locked (EBUSY/EPERM) or now a directory — keep it so a retry works
      failed.push(e)
    }
  }

  const latestPath = path.join(dir, latest)
  if (failed.length) {
    // a partial undo must stay undoable: the backup is rewritten with ONLY
    // the files that could not be restored, so /undo retries just those
    try {
      fs.writeFileSync(latestPath, JSON.stringify({ ts: Date.now(), entries: failed }, null, 2), 'utf8')
    } catch {
      /* the original backup stays as-is — still complete */
    }
    return {
      restored,
      message:
        `Reverted ${restored} file${restored === 1 ? '' : 's'}; ` +
        `${failed.length} could not be written (locked or missing) — run /undo again to retry.`
    }
  }
  fs.rmSync(latestPath, { force: true })
  return { restored, message: `Reverted ${restored} file${restored === 1 ? '' : 's'}.` }
}

/** Newest-first list of every safety copy this chat owns — the /history UI. */
export function listBackups(sessionId: string): BackupInfo[] {
  const dir = p.backups(sessionId)
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
  } catch {
    return []
  }
  const out: BackupInfo[] = []
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as {
        ts?: number
        entries?: BackupEntry[]
      }
      const names = [...new Set((data.entries ?? []).map((e) => path.basename(e.path)))]
      out.push({
        id: f.replace(/\.json$/, ''),
        ts: typeof data.ts === 'number' ? data.ts : parseInt(f, 10) || 0,
        files: names.sort((a, b) => a.localeCompare(b))
      })
    } catch {
      /* unreadable backup — not worth a row */
    }
  }
  return out.sort((a, b) => b.ts - a.ts)
}

/**
 * Restores ONE backup (the /history list, any entry but the newest).
 *
 * Two rules make this safe to press twice:
 * 1. A safety copy of the CURRENT files is written FIRST — so /undo after a
 *    restore takes you right back to what you had, and nothing is ever lost
 *    by rolling back.
 * 2. Every path is re-checked against the session's linked folders. A backup
 *    file is plain JSON on disk; trusting it blindly would let an edited
 *    backup write anywhere on the machine.
 */
export function restoreBackup(session: Session, backupId: string): { restored: number; message: string } {
  const folders = session.linkedFolders ?? []
  const dir = p.backups(session.id)
  if (!/^\d+$/.test(backupId)) return { restored: 0, message: 'Unknown backup — nothing changed.' }
  if (!folders.length) return { restored: 0, message: 'Link a folder to this chat first.' }

  let entries: BackupEntry[]
  try {
    entries = (JSON.parse(fs.readFileSync(path.join(dir, `${backupId}.json`), 'utf8')) as {
      entries: BackupEntry[]
    }).entries
  } catch {
    return { restored: 0, message: 'Backup unreadable — nothing changed.' }
  }

  // confine + dedupe (the earliest entry of a file holds the true original)
  const seen = new Set<string>()
  const wanted: BackupEntry[] = []
  let refused = 0
  for (const e of entries) {
    if (seen.has(e.path)) continue
    seen.add(e.path)
    if (!folders.some((f) => inside(f, e.path))) {
      refused++
      continue
    }
    wanted.push(e)
  }
  if (!wanted.length) return { restored: 0, message: 'Nothing to restore — every entry is outside the linked folders.' }

  // snapshot the current state (skip files we cannot safely read: a binary
  // must never be replaced by a text restore)
  const snap: BackupEntry[] = []
  const ready: BackupEntry[] = []
  for (const e of wanted) {
    let cur: string | null = null
    try {
      if (fs.existsSync(e.path)) {
        const buf = fs.readFileSync(e.path)
        const txt = buf.toString('utf8')
        if (txt.includes('\0') || !Buffer.from(txt, 'utf8').equals(buf)) {
          refused++
          continue
        }
        cur = txt
      }
    } catch {
      refused++
      continue
    }
    snap.push({ path: e.path, prev: cur })
    ready.push(e)
  }
  if (!ready.length) return { restored: 0, message: 'Nothing could be restored safely — nothing changed.' }

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${nextBackupId()}.json`), JSON.stringify({ ts: Date.now(), entries: snap }, null, 2), 'utf8')
  } catch (e) {
    return { restored: 0, message: `Could not snapshot the current files (${(e as Error).message}) — nothing changed.` }
  }

  let restored = 0
  const failed: string[] = []
  for (const e of ready) {
    try {
      if (e.prev === null) fs.rmSync(e.path, { force: true })
      else {
        fs.mkdirSync(path.dirname(e.path), { recursive: true })
        fs.writeFileSync(e.path, e.prev, 'utf8')
      }
      restored++
    } catch {
      failed.push(path.basename(e.path))
    }
  }

  const notes: string[] = []
  if (refused) notes.push(`${refused} skipped (outside the folders or not text)`)
  if (failed.length) notes.push(`${failed.join(', ')} locked`)
  return {
    restored,
    message:
      `Restored ${restored} file${restored === 1 ? '' : 's'}` +
      (notes.length ? ` (${notes.join('; ')})` : '') +
      '. /undo steps back to the state you just left.'
  }
}

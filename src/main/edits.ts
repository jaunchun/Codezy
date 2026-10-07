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
import type { ApplyOutcome } from '../shared/api'
import { p } from './store'

interface BackupEntry {
  path: string
  prev: string | null // null = file didn't exist (new file → delete on undo)
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
 * Applies edits to the session's linked folders. Partial success is allowed:
 * valid files are written, failures are reported per file, and a backup is
 * only created when something was actually written.
 */
export function applyEdits(session: Session, edits: FileEdit[]): ApplyOutcome {
  const applied: ApplyOutcome['applied'] = []
  const errors: string[] = []
  const folders = session.linkedFolders ?? []

  if (!folders.length) return { applied, errors: ['Link a folder to this chat first.'], backupId: null }
  if (!edits.length) return { applied, errors: ['Nothing to apply.'], backupId: null }

  const backups: BackupEntry[] = []

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
      errors.push(`${edit.path}: ${(e as Error).message}`)
    }
  }

  let backupId: string | null = null
  if (backups.length) {
    try {
      const dir = p.backups(session.id)
      fs.mkdirSync(dir, { recursive: true })
      backupId = String(Date.now())
      fs.writeFileSync(path.join(dir, `${backupId}.json`), JSON.stringify({ ts: Date.now(), entries: backups }, null, 2), 'utf8')
    } catch {
      backupId = null // writes succeeded; only the safety copy failed
    }
  }

  return { applied, errors, backupId }
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

  let restored = 0
  for (const e of entries) {
    try {
      if (e.prev === null) fs.rmSync(e.path, { force: true })
      else fs.writeFileSync(e.path, e.prev, 'utf8')
      restored++
    } catch {
      /* file vanished or locked — keep going, report the count we managed */
    }
  }
  fs.rmSync(path.join(dir, latest), { force: true })
  return { restored, message: `Reverted ${restored} file${restored === 1 ? '' : 's'}.` }
}

// ---------------------------------------------------------------------------
// git.ts — /diff for the desktop app: one spawn per call, plain data back.
// Mirrors the terminal's /diff — status file list, --stat summary and the
// unified diff vs HEAD (optionally narrowed to one path). Never throws.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { GitDiff, GitStatus } from '../shared/api'

const empty = (folder: string, error?: string): GitDiff => ({
  ok: !error,
  error,
  folder,
  branch: '',
  files: [],
  stat: '',
  body: ''
})

const run = (dir: string, argv: string[], timeout = 10000) => {
  try {
    return spawnSync('git', ['-C', dir, ...argv], {
      encoding: 'utf8',
      timeout,
      windowsHide: true
    })
  } catch {
    return null // git not installed
  }
}

export function gitDiff(folder: string, pathspec?: string): GitDiff {
  const st = run(folder, ['status', '--porcelain=1', ...(pathspec ? ['--', pathspec] : [])])
  if (!st || st.status !== 0) return empty(folder, `"${folder}" is not a git repository`)

  const files = st.stdout.split('\n').filter(Boolean)
  const br = run(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = br && br.status === 0 ? br.stdout.trim() : ''

  const stat = run(folder, pathspec ? ['diff', 'HEAD', '--stat', '--', pathspec] : ['diff', 'HEAD', '--stat'])
  const body = run(folder, pathspec ? ['diff', 'HEAD', '--', pathspec] : ['diff', 'HEAD'])

  const res = empty(folder)
  res.branch = branch
  res.files = files
  res.stat = (stat?.stdout ?? '').trimEnd()
  res.body = body?.stdout ?? ''
  return res
}

/** Walks up from `folder` looking for `.git` — so we never spawn git at all
 *  in a plain folder instead of waiting for a doomed subprocess.
 *
 *  A volume root is never accepted: a stray `C:\.git` (they do happen) would
 *  otherwise turn every badge fetch in the app into a whole-drive
 *  `git status` — seconds of frozen window for a letter next to a file. */
function inRepo(folder: string): boolean {
  let dir = path.resolve(folder)
  for (let i = 0; i < 8; i++) {
    if (path.dirname(dir) === dir) break // volume root — not a sane worktree
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return true
    } catch {
      return false
    }
    dir = path.dirname(dir)
  }
  return false
}

/**
 * `git status --porcelain=1` for one folder — nothing else (no rev-parse, no
 * diff). The cowork tree calls this for its modified/untracked badges, so it
 * stays deliberately cheap: one spawn, a 2.5s hard cap, and no call at all
 * when the folder is not a repo. spawnSync runs on the main process, so a
 * slow git here would freeze the whole window.
 *
 * Paths come back relative to `folder` (git's default status.relativePaths),
 * which is exactly what the tree joins them against.
 */
export function gitStatus(folder: string): GitStatus {
  const out: GitStatus = { ok: false, folder, files: [] }
  if (!folder || !inRepo(folder)) return out
  const st = run(folder, ['status', '--porcelain=1'], 2500)
  if (!st || st.status !== 0 || st.error) return out
  out.ok = true
  out.files = (st.stdout ?? '').split('\n').filter(Boolean)
  return out
}

// ---------------------------------------------------------------------------
// git.ts — /diff for the desktop app: one spawn per call, plain data back.
// Mirrors the terminal's /diff — status file list, --stat summary and the
// unified diff vs HEAD (optionally narrowed to one path). Never throws.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'
import type { GitDiff } from '../shared/api'

const empty = (folder: string, error?: string): GitDiff => ({
  ok: !error,
  error,
  folder,
  branch: '',
  files: [],
  stat: '',
  body: ''
})

const run = (dir: string, argv: string[]) => {
  try {
    return spawnSync('git', ['-C', dir, ...argv], {
      encoding: 'utf8',
      timeout: 10000,
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

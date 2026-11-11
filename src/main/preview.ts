// ---------------------------------------------------------------------------
// preview.ts — the live site preview.
//
// The chat's linked folder is served over a custom scheme
// (codezy-preview://<sessionId>/<path>) so the preview is a REAL site:
// relative CSS/JS/images resolve the way they do on a web server, and the
// agent's edits show up the moment the page reloads.
//
// Nothing is copied or rewritten — the files on disk ARE the site.
// ---------------------------------------------------------------------------

import { protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Session } from '../shared/types'

export const PREVIEW_SCHEME = 'codezy-preview'

/** Must run BEFORE app.whenReady(). */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf'
}

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** The folders a session may preview. */
function rootsOf(session: Session | null | undefined): string[] {
  return (session?.linkedFolders ?? []).filter((f) => {
    try {
      return fs.existsSync(f)
    } catch {
      return false
    }
  })
}

/**
 * Resolves a preview path inside the session's linked folders. The result
 * is always INSIDE one of them — a path that tries to climb out is
 * rejected, exactly like the file tools do.
 */
export function resolvePreviewPath(
  session: Session | null | undefined,
  relPath: string
): { file: string; root: string } | null {
  const roots = rootsOf(session)
  if (!roots.length) return null
  const clean = String(relPath || '').replace(/^\/+/, '')
  for (const root of roots) {
    const file = path.resolve(root, clean)
    const rel = path.relative(root, file)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue // traversal
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return { file, root }
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * The page to show when the preview opens: index.html if there is one,
 * else the first .html file found (a shallow scan — no deep crawls).
 */
export function defaultPreviewPath(session: Session | null | undefined): string {
  const roots = rootsOf(session)
  for (const root of roots) {
    const index = path.join(root, 'index.html')
    try {
      if (fs.existsSync(index)) return 'index.html'
    } catch {
      /* ignore */
    }
  }
  const found = listPreviewFiles(session)[0]
  return found?.path ?? ''
}

/** Every .html file under the session's folders (capped, shallow). */
export function listPreviewFiles(session: Session | null | undefined): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = []
  const roots = rootsOf(session)
  const walk = (dir: string, depth: number) => {
    if (out.length >= 40 || depth > 3) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= 40) return
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full, depth + 1)
      } else if (/\.html?$/i.test(e.name)) {
        const rel = path.relative(roots[0], full).split(path.sep).join('/')
        out.push({ path: rel, name: e.name })
      }
    }
  }
  for (const root of roots) walk(root, 0)
  // index.html first — it is what a visitor sees
  out.sort((a, b) => (a.path === 'index.html' ? -1 : b.path === 'index.html' ? 1 : a.path.localeCompare(b.path)))
  return out
}

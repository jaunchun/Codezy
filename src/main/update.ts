// ---------------------------------------------------------------------------
// update.ts — the built-in GitHub updater (v2.6).
//
// CODEZY checks jaunchun/Codezy for a newer release, shows a small pill in
// the title bar, downloads the setup EXE in the background and then installs
// it IN PLACE: the NSIS installer runs silently with `--updated /S
// --force-run`, reads the previous InstallLocation from the registry and
// replaces the running app — one install, no second version, no separate
// updater program, no second window.
//
// The release tag is literally "Release" (not semver), so the real version
// comes from the asset file name: CODEZY-Setup-<x.y.z>.exe. Everything the
// tests need is exported as a pure helper; the network functions accept an
// injected fetch so batch21 never touches GitHub.
// ---------------------------------------------------------------------------

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { UpdateCheck, UpdateProgress, UpdateRelease } from '../shared/api'

/** The repo every check/download points at. */
export const UPDATE_REPO = 'jaunchun/Codezy'

/** Asset file name → version. `CODEZY-Setup-2.6.0.exe` → `2.6.0` (null when
 *  the name doesn't carry one — the tag is prose here, never trust it). */
export function parseVersion(name: string): string | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(name))
  if (!m) return null
  return `${m[1]}.${m[2]}.${m[3] ?? '0'}`
}

/** Numeric x.y.z compare (-1/0/1). `"2.10.0"` > `"2.9.0"` — never lexical. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

export function isNewerVersion(a: string, b: string): boolean {
  return compareVersions(a, b) > 0
}

/** Picks the newest CODEZY setup asset from one GitHub release (null when
 *  the release carries none — a tag without an installer isn't an update). */
export function pickAsset(assets: unknown): UpdateRelease | null {
  if (!Array.isArray(assets)) return null
  let best: UpdateRelease | null = null
  for (const raw of assets) {
    const a = raw as { name?: unknown; browser_download_url?: unknown; size?: unknown }
    if (!a || typeof a.name !== 'string') continue
    if (!/\.exe$/i.test(a.name)) continue
    const version = parseVersion(a.name)
    if (!version) continue
    const url = typeof a.browser_download_url === 'string' ? a.browser_download_url : ''
    if (!url) continue
    const cand: UpdateRelease = {
      version,
      name: a.name,
      url,
      size: typeof a.size === 'number' ? a.size : 0
    }
    if (!best || isNewerVersion(cand.version, best.version)) best = cand
  }
  return best
}

/** Full check result from the releases payload + the running version.
 *  Pure: drafts are skipped, the highest setup asset wins, and a release
 *  older-or-equal to `current` reports `available: false` (never a "downgrade
 *  pill" when GitHub is behind a local dev build). */
export function evaluateReleases(payload: unknown, current: string): UpdateCheck {
  const out: UpdateCheck = { ok: true, current, available: false, release: null }
  if (!Array.isArray(payload)) return out
  let best: UpdateRelease | null = null
  for (const raw of payload) {
    const rel = raw as { draft?: unknown; prerelease?: unknown; html_url?: unknown; body?: unknown; assets?: unknown }
    if (!rel || typeof rel !== 'object') continue
    if (rel.draft === true || rel.prerelease === true) continue
    const pick = pickAsset(rel.assets)
    if (!pick) continue
    pick.notes = typeof rel.body === 'string' ? rel.body.slice(0, 400) : ''
    pick.page = typeof rel.html_url === 'string' ? rel.html_url : ''
    if (!best || isNewerVersion(pick.version, best.version)) best = pick
  }
  if (best && isNewerVersion(best.version, current)) {
    out.available = true
    out.release = best
  } else if (best) {
    out.release = null // nothing newer — the pill must stay hidden
  }
  return out
}

/** Hits the GitHub Releases API. `fetchImpl` is injectable for tests;
 *  failures resolve to `{ ok:false, error }` — never throws, because a
 *  check you never see must never disturb the app. */
export async function checkForUpdates(
  current: string,
  fetchImpl: typeof fetch = fetch
): Promise<UpdateCheck> {
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`,
      {
        headers: {
          'user-agent': `CODEZY/${current} (https://github.com/${UPDATE_REPO})`,
          accept: 'application/vnd.github+json'
        },
        signal: AbortSignal.timeout(8000)
      }
    )
    if (!res.ok) {
      return { ok: false, current, available: false, release: null, error: `GitHub responded ${res.status}` }
    }
    return evaluateReleases(await res.json(), current)
  } catch (e) {
    return {
      ok: false,
      current,
      available: false,
      release: null,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

// -- download ----------------------------------------------------------------

/** Streams the setup EXE into `dir` and reports progress. Returns the file
 *  path, or an error string — the caller never guesses. */
export async function downloadUpdate(
  url: string,
  dir: string,
  onProgress: (p: UpdateProgress) => void,
  fetchImpl: typeof fetch = fetch
): Promise<{ path: string } | { error: string }> {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const res = await fetchImpl(url, {
      headers: { 'user-agent': `CODEZY updater` },
      redirect: 'follow',
      signal: AbortSignal.timeout(600_000) // 113 MB on a slow line
    })
    if (!res.ok || !res.body) return { error: `download failed (HTTP ${res.status})` }

    const total = Number(res.headers.get('content-length')) || 0
    const dest = path.join(dir, `CODEZY-update.exe`)
    const tmp = `${dest}.part`
    const out = fs.createWriteStream(tmp)
    const reader = res.body.getReader()
    let received = 0

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.byteLength
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((r) => out.once('drain', () => r()))
        }
        onProgress({ received, total, percent: total ? Math.min(100, Math.round((received / total) * 100)) : -1 })
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve())
      out.on('error', reject)
    })

    if (total && received !== total) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch { /* best effort */ }
      return { error: `incomplete download (${received}/${total} bytes)` }
    }
    fs.renameSync(tmp, dest)
    return { path: dest }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

// -- install -----------------------------------------------------------------

/** Launches the downloaded setup exactly like electron-updater does:
 *  `--updated` (the installer skips its welcome pages and treats this as an
 *  upgrade), `/S` (silent — no window steals focus), `--force-run` (relaunch
 *  the new version when done). NSIS reads the old InstallLocation from the
 *  registry, so the files are replaced in the SAME folder — in place.
 *  Detached + unref'd: the app quits while the installer keeps going. */
export function applyUpdate(setupPath: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(setupPath)) {
        resolve({ ok: false, error: 'update file is gone' })
        return
      }
      const child = spawn(setupPath, ['--updated', '/S', '--force-run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      // 'spawn' / 'error' are mutually exclusive and always fire — resolve on
      // the real outcome so the renderer never reports a start that failed.
      child.once('spawn', () => {
        child.unref()
        resolve({ ok: true })
      })
      child.once('error', (e) => resolve({ ok: false, error: e.message }))
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  })
}

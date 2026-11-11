// ---------------------------------------------------------------------------
// deeplink.ts — `codezy://` deep links (v3.1.5).
//
// Windows hands the URL in argv, macOS via the open-url event, a second
// launch via second-instance argv. Pure parsers live here so batch39 can
// test them without Electron: findDeepLink scans an argv for the first
// codezy:// entry, sessionIdFromLink pulls the session id out of
// codezy://session/<id>. Anything malformed returns null — a deep link is
// a convenience, never a crash surface.
// ---------------------------------------------------------------------------

/** The first `codezy://…` entry in argv, or null. */
export function findDeepLink(argv: readonly string[]): string | null {
  for (const a of argv ?? []) {
    if (typeof a === 'string' && /^codezy:\/\//i.test(a)) return a
  }
  return null
}

/** `codezy://session/<id>` → `<id>`; anything else → null. */
export function sessionIdFromLink(url: string): string | null {
  const m = /^codezy:\/\/session\/([^/?#]+)/i.exec(String(url ?? ''))
  if (!m) return null
  const id = decodeURIComponent(m[1])
  return id || null
}

/** The protocol this app registers (kept next to its parser). */
export const PROTOCOL = 'codezy'

// ---------------------------------------------------------------------------
// windowstate.ts — the window remembers where you put it.
//
// main's createWindow() keeps its explicit `bounds` (the acrylic theme
// rebuild) and otherwise falls back to this saved state: read from
// ~/.codezy/window.json at launch, SANITIZED against the displays that
// exist right now (a window saved on a monitor that got unplugged must
// never open off-screen and unreachable), written back on close — the
// normal (un-maximized) bounds plus the maximized flag.
//
// The geometry rules are exported as a pure helper so batch37 can
// unit-test them from Windows without Electron: invalid shapes fall back
// to the caller's default (centered, untouched), and the restored rect
// only survives if its TITLE STRIP (top rows, where the drag handle
// lives) overlaps some display work area — otherwise the window would
// open where no mouse can ever grab it.
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

/** A display's work area as passed in by `screen.getAllDisplays()`. */
export interface DisplayRect {
  x: number
  y: number
  width: number
  height: number
}

export interface WinSize {
  width: number
  height: number
}

/** Where this state lives: `<dataDir>/window.json`. */
export function windowStateFile(dir: string): string {
  return path.join(dir, 'window.json')
}

/**
 * Saved state → a rect that is SAFE to open with, or null (use the plain
 * defaults and let the window manager center it).
 *
 * Rules, in order:
 *  - garbage in (non-object, non-finite numbers) → null
 *  - width/height clamped: at least `min`, at most the display that holds
 *    the window (a 4K-saved size must fit a laptop screen)
 *  - the top-40px title strip must overlap SOME display work area by at
 *    least `MIN_VISIBLE` px of width — an unplugged-monitor save reverts
 *    to null instead of opening off-screen
 *  - `maximized` only survives as a strict boolean true
 */
export function sanitizeWindowState(
  raw: unknown,
  displays: DisplayRect[],
  min: WinSize,
  fallback: WinSize
): WindowState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const x = num(r.x)
  const y = num(r.y)
  const wRaw = num(r.width)
  const hRaw = num(r.height)
  if (x === null || y === null || wRaw === null || hRaw === null) return null
  if (!Array.isArray(displays) || displays.length === 0) return null

  // size: clamped to sane bounds and to the biggest available work area
  const biggestW = Math.max(...displays.map((d) => d.width))
  const biggestH = Math.max(...displays.map((d) => d.height))
  const width = Math.min(Math.max(wRaw, min.width, 200), Math.max(biggestW, min.width))
  const height = Math.min(Math.max(hRaw, min.height, 120), Math.max(biggestH, min.height))

  // position: the title strip (where the drag handle lives) must be grabbable
  const MIN_VISIBLE = 80
  const stripH = Math.min(40, height)
  const visible = displays.some((d) => {
    const overlapX = Math.min(x + width, d.x + d.width) - Math.max(x, d.x)
    const overlapY = Math.min(y + stripH, d.y + d.height) - Math.max(y, d.y)
    return overlapX >= Math.min(MIN_VISIBLE, width) && overlapY > 0
  })
  if (!visible) return null

  return { x, y, width, height, maximized: r.maximized === true }
}

/** Best-effort read — a missing or corrupt file is simply "no state". */
export function readWindowState(dir: string): Partial<WindowState> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(windowStateFile(dir), 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Partial<WindowState>) : null
  } catch {
    return null
  }
}

/** Best-effort write — never throws into the close path. */
export function writeWindowState(dir: string, state: WindowState): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(windowStateFile(dir), JSON.stringify(state), 'utf8')
    return true
  } catch {
    return false
  }
}

/** The default geometry (createWindow's own constants) — for callers that
 *  want a complete object instead of a fallback. */
export function defaultWindowState(fallback: WinSize): WindowState {
  return { x: 0, y: 0, width: fallback.width, height: fallback.height, maximized: false }
}

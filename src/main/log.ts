// ---------------------------------------------------------------------------
// log.ts — a small append-only main-process log so "it broke on my machine"
// stops being a mystery for a self-published app.
//
// ~/.codezy/logs/main.log gets one timestamped line per event (launch,
// quit, uncaughtException, unhandledRejection); on startup a main.log past
// MAX_BYTES is rotated once to main.old.log (the previous old file is
// overwritten — two files is all this ever needs). Every path is derived
// from the injected data dir and NOTHING here may ever throw into the
// app: a broken log must not break CODEZY.
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'

/** Rotate once the log passes this size (512 KiB — plenty for diagnosis). */
export const MAX_BYTES = 512 * 1024

export function logsDir(dataDir: string): string {
  return path.join(dataDir, 'logs')
}

export function logFile(dataDir: string): string {
  return path.join(logsDir(dataDir), 'main.log')
}

export function oldLogFile(dataDir: string): string {
  return path.join(logsDir(dataDir), 'main.old.log')
}

/** `[2026-10-19 14:03:22] message` — newlines collapse so one event is
 *  always one line (stack traces keep their shape via " — " separators). */
export function formatLine(msg: string): string {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19)
  return `[${t}] ${String(msg).replace(/\r?\n/g, ' — ')}\n`
}

/** Startup rotation: a main.log past `maxBytes` becomes main.old.log once.
 *  Returns whether it rotated; any failure is swallowed (best effort). */
export function rotateIfNeeded(dataDir: string, maxBytes: number = MAX_BYTES): boolean {
  try {
    const f = logFile(dataDir)
    if (!fs.existsSync(f) || fs.statSync(f).size < maxBytes) return false
    fs.mkdirSync(logsDir(dataDir), { recursive: true })
    fs.renameSync(f, oldLogFile(dataDir))
    return true
  } catch {
    return false
  }
}

/** Append one line. Never throws — logging must not be able to take the
 *  app down (including when the data dir is unwritable). */
export function logLine(dataDir: string, msg: string): void {
  try {
    if (!dataDir) return
    fs.mkdirSync(logsDir(dataDir), { recursive: true })
    fs.appendFileSync(logFile(dataDir), formatLine(msg), 'utf8')
  } catch {
    /* best effort, always */
  }
}

// ---------------------------------------------------------------------------
// index.ts — Electron main process: app lifecycle, window, and every IPC
// handler the renderer can call. This is where a UI action ("send message")
// turns into real work (build prompt → stream from Ollama → save to disk).
// ---------------------------------------------------------------------------

import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, screen, shell } from 'electron'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import fs from 'fs'
import { spawn } from 'child_process'
import type { ChatMessage, Project, Settings, Session } from '../shared/types'
import type { ChatTarget } from './ollama'
import {
  createSession,
  deleteSession,
  driveStatus,
  getSettings,
  getDataDir,
  getSession,
  initStore,
  listProjects,
  listSessions,
  listSkills,
  patchSettings,
  readMemory,
  saveProjects,
  saveSession,
  searchSessions,
  writeMemory
} from './store'
import { listOllamaModelDetails, listOpenAIModels, pingOllama, streamChat, contextSizeFor, modelCapabilities, modelSupportsTools } from './ollama'
import { buildMessages, fileTree } from './prompt'
import { webSearch, buildWebContext, looksLikeWebQuery } from './search'
import { gitDiff, gitStatus } from './git'
import { learnFromExchange } from './learn'
import { applyCodeBlock, applyEdits, listBackups, restoreBackup, undoLast } from './edits'
import {
  IMAGE_MIME,
  ideCreate,
  ideDelete,
  ideRead,
  ideRename,
  ideSaveWouldTruncate,
  ideTree,
  ideWrite,
  isImagePath,
  listFiles,
  readFileIn,
  searchFiles
} from './files'
import { listV2Tasks, runV2, stopV2Task, v2Active } from './v2'
import { collectUsage } from './usage'
import { applyUpdate, checkForUpdates, downloadUpdate, UPDATE_REPO } from './update'
import { terminalPlan } from './terminal'
import { readWindowState, sanitizeWindowState, writeWindowState } from './windowstate'
import { logLine, rotateIfNeeded } from './log'
import { syncTray, trayBalloon } from './tray'
import { findDeepLink, PROTOCOL, sessionIdFromLink } from './deeplink'
import {
  PREVIEW_SCHEME,
  defaultPreviewPath,
  listPreviewFiles,
  mimeFor,
  registerPreviewScheme,
  resolvePreviewPath
} from './preview'
import { McpConnection, mcpDisconnectAll, mcpDropSession, mcpGetSession } from './mcp'
import type { UpdateCheck } from '../shared/api'
import type { FileEdit } from '../shared/edits'

let win: BrowserWindow | null = null
const aborts = new Map<string, AbortController>()

// the live site preview — the custom scheme must be declared BEFORE the app
// is ready (Electron requires it), so it happens right here, at import time
registerPreviewScheme()

// one watcher per session whose preview is open: a change in the linked
// folder means the site changed, so the preview reloads
const previewWatchers = new Map<string, { watcher: fs.FSWatcher; timer: NodeJS.Timeout | null }>()

function watchPreview(sessionId: string): void {
  if (previewWatchers.has(sessionId)) return
  const session = getSession(sessionId)
  const root = (session?.linkedFolders ?? [])[0]
  if (!root) return
  let watcher: fs.FSWatcher | null = null
  try {
    watcher = fs.watch(root, { recursive: true }, (_e, filename) => {
      const name = String(filename ?? '')
      // editors write temp files and swap them in — those are noise
      if (/(^|[\\/])\..+~$|\.tmp$|\.swp$|\.lock$/i.test(name)) return
      const entry = previewWatchers.get(sessionId)
      if (!entry) return
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = null
        emit(sessionId, { type: 'previewreload' })
      }, 250)
    })
  } catch {
    return // a folder that cannot be watched (permissions) just means no live reload
  }
  previewWatchers.set(sessionId, { watcher, timer: null })
}

function unwatchPreview(sessionId: string): void {
  const entry = previewWatchers.get(sessionId)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  try {
    entry.watcher.close()
  } catch {
    /* ignore */
  }
  previewWatchers.delete(sessionId)
}
// pending v2 approval dialogs: key = `${sessionId}:${askId}` — main blocks on
// this promise until the renderer's Approve/Deny modal answers.
const v2Asks = new Map<string, { id: number; resolve: (ok: boolean) => void }>()
let v2AskId = 0

/** Opens the renderer confirm dialog and waits for Approve/Deny. */
function askV2(sessionId: string, name: string, args: Record<string, unknown>): Promise<boolean> {
  const askId = ++v2AskId
  return new Promise((resolve) => {
    v2Asks.set(`${sessionId}:${askId}`, { id: askId, resolve })
    emit(sessionId, { type: 'v2ask', askId, name, args })
  })
}

/** Every pending dialog for a session answers "deny" (abort, crash, turn end). */
function settleV2Asks(sessionId: string): void {
  for (const [key, ask] of v2Asks) {
    if (key.startsWith(`${sessionId}:`)) {
      ask.resolve(false)
      v2Asks.delete(key)
    }
  }
}

// -- window -----------------------------------------------------------------

function themeColors(theme: Settings['theme']): string {
  if (theme === 'light') return '#f2f2f7'
  if (theme === 'singularity') return '#04040a' // the canvas paints the scene on top
  return '#0b0b12'
}

function createWindow(bounds?: Electron.Rectangle): void {
  const settings = getSettings()
  const acrylic = settings.theme === 'acrylic'
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    frame: false, // custom title bar drawn by the renderer
    show: false,
    // The acrylic theme needs a see-through window so DWM can blur the
    // desktop behind it (the Windows Terminal look). Solid themes get paint.
    ...(acrylic
      ? {
          transparent: true,
          backgroundColor: '#00000000',
          backgroundMaterial: 'acrylic' as const
        }
      : { backgroundColor: themeColors(settings.theme) }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(settings.alwaysOnTop === true) // coding alongside a chat
  win.webContents.zoomLevel = Number(settings.zoomLevel) || 0 // remembered zoom

  let restoreMaximized = false
  if (bounds) {
    win.setBounds(bounds)
  } else {
    // launch: the last place you left the window — sanitized against the
    // displays that exist NOW (an unplugged-monitor save must never open
    // off-screen with no way to drag it back)
    const saved = sanitizeWindowState(
      readWindowState(getDataDir()),
      screen.getAllDisplays().map((d) => d.workArea),
      { width: 940, height: 600 },
      { width: 1320, height: 840 }
    )
    if (saved) {
      win.setBounds({ x: saved.x, y: saved.y, width: saved.width, height: saved.height })
      restoreMaximized = saved.maximized
    }
  }

  // Closing writes the geometry back: NORMAL bounds + the maximized flag.
  // Captured per window (`self`): the acrylic theme rebuild reassigns the
  // module `win` BEFORE the old window closes.
  const self = win
  self.on('close', (e) => {
    // Tray mode: the ✕ hides instead of quitting — the app stays reachable
    // from the tray icon / menu. A real quit (tray → Quit, ⌘Q, SIGTERM)
    // sets `quitting` first, so it still goes through.
    if (!quitting && getSettings().minimizeToTray === true && !self.isDestroyed()) {
      e.preventDefault()
      self.hide()
      // one hint per launch: "where did my app go?" should never happen
      if (!trayHintShown) {
        trayHintShown = true
        trayBalloon('CODEZY is still running', 'It lives in the tray now — click the icon to come back, right-click to quit.')
      }
      return
    }
    try {
      const b = self.getNormalBounds()
      writeWindowState(getDataDir(), {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        maximized: self.isMaximized()
      })
    } catch {
      // geometry must never block quitting
    }
  })

  // QoL zoom shortcuts: Ctrl/Cmd + '+', '-', '0' scale the whole UI without
  // needing a menu entry. Handled here (not via menu accelerators) so they
  // work in dev and packaged builds alike, and never shadow the renderer's
  // own single-key bindings.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (!mod) return
    const wc = win?.webContents
    if (!wc) return
    const k = input.key.toLowerCase()
    if (k === '=' || k === '+') {
      wc.zoomLevel += 0.5
      e.preventDefault()
    } else if (k === '-') {
      wc.zoomLevel = Math.max(-3, wc.zoomLevel - 0.5)
      e.preventDefault()
    } else if (k === '0') {
      wc.zoomLevel = 0
      e.preventDefault()
    } else {
      return
    }
    // remember it across launches (throttled — key repeat fires fast)
    const level = wc.zoomLevel
    if (zoomSaveTimer) clearTimeout(zoomSaveTimer)
    zoomSaveTimer = setTimeout(() => {
      zoomSaveTimer = null
      patchSettings({ zoomLevel: level })
    }, 600)
  })

  win.once('ready-to-show', () => {
    // startHidden (Settings → behavior): the login-item launch stays in the
    // tray instead of flashing a window. First window only — an explicit
    // reopen (tray, second instance, macOS dock) always shows.
    const s = getSettings()
    const stayHidden = firstWindow && s.startHidden === true && s.minimizeToTray === true
    firstWindow = false
    if (!stayHidden) win?.show()
    if (acrylic) {
      // Electron/Chromium quirk: the DWM acrylic material sometimes only
      // engages after the material is re-set and the window is nudged by a
      // pixel (same workaround Windows Terminal apps hit — see Electron
      // issues #39959 / #46855). Harmless if it already worked.
      setTimeout(() => {
        if (!win) return
        win.setBackgroundColor('#00000000')
        win.setBackgroundMaterial('acrylic')
        const [w, h] = win.getSize()
        win.setSize(w, h + 1)
        win.setSize(w, h)
      }, 120)
    }
    // AFTER the acrylic nudge (it resizes — a setSize on a maximized window
    // would drop it back to normal)
    if (restoreMaximized) setTimeout(() => win?.maximize(), 200)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // never let links hijack the app window — and only ever hand real web
  // links to the OS browser (no file://, no custom protocols)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // resilience: a renderer crash reloads instead of leaving a dead window
  // (capped at 3 — a crash loop must not spin forever); hangs are logged so
  // the log file explains a stuck session.
  win.webContents.on('render-process-gone', (_e, details) => {
    logLine(DATA_DIR, `render-process-gone: ${details.reason} (exit ${details.exitCode})`)
    if (details.reason !== 'clean-exit' && renderReloads < 3 && win) {
      renderReloads++
      win.webContents.reload()
    }
  })
  win.on('unresponsive', () => logLine(DATA_DIR, 'window unresponsive'))
  win.on('responsive', () => logLine(DATA_DIR, 'window responsive again'))

  // Lock the renderer to this app: a navigation anywhere else would load an
  // external page WITH the preload bridge (window.codezy) still attached —
  // reloads of the current page stay allowed, everything else is blocked.
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    const current = win?.webContents.getURL() ?? ''
    const allowed = url === current || (!!dev && url.startsWith(dev))
    if (!allowed) e.preventDefault()
  })
}

// -- helpers ----------------------------------------------------------------

/** Per-chat overrides (session.model / session.effort) win over the settings. */
function targetFor(settings: Settings, session?: Session | null): ChatTarget {
  const model = session?.model ?? settings.activeModel
  const providerId = session?.provider ?? settings.activeProvider
  const effort = session?.effort ?? settings.effort
  if (providerId === 'ollama') {
    return { kind: 'ollama', baseUrl: settings.ollamaUrl, model, effort }
  }
  const provider = settings.providers.find((p) => p.id === providerId)
  if (!provider) throw new Error(`Provider "${providerId}" is not configured`)
  return {
    kind: 'openai',
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    effort
  }
}

/** Sends a generation event to the renderer. Shape matches ChatEvent. */
function emit(
  sessionId: string,
  event:
    | { type: 'delta'; text: string }
    | { type: 'done'; message: ChatMessage }
    | { type: 'error'; message: string }
    | { type: 'aborted' }
    | { type: 'v2tool'; iteration: number; name: string; args: Record<string, unknown>; outcome: string }
    | { type: 'v2step'; iteration: number; phase: 'thinking' | 'running'; name: string; args?: Record<string, unknown> }
    | { type: 'websearch'; query: string; results: number; pages: number }
    | { type: 'notice'; text: string; kind?: 'info' | 'error' }
    | { type: 'previewreload' }
    | { type: 'v2ask'; askId: number; name: string; args: Record<string, unknown> }
): void {
  win?.webContents.send('chat:event', { sessionId, ...event })
}

// -- app lifecycle ----------------------------------------------------------

/** Wait helper for the engine boot loop below. */
function bootWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** First-use engine bootstrap — called when a chat actually needs Ollama,
 *  never on launch. Ping first (an already-running or user-managed Ollama is
 *  left alone — the normal case), otherwise spawn a detached, windowless
 *  `ollama serve` (it outlives the app like any other local service) and wait
 *  for the listener: serve binds in ~1–2 s, so the cost hides inside the model
 *  load that follows the message anyway.
 *
 *  Why not on launch: an eager spawn races the Startup-folder autostart
 *  (`Ollama.lnk`) — on a busy login the launch ping misses within its 2.5 s
 *  timeout and we'd boot a SECOND serve that immediately loses the port fight.
 *  Single-flight: concurrent sends share one attempt; the slot clears when it
 *  settles so a later chat can retry a failed boot. */
let engineBoot: Promise<boolean> | null = null
/** one boot at a time — the sidebar dot and chat share this (a second
 *  `ollama serve` on the same port just dies and confuses the log) */
function ensureOllama(signal?: AbortSignal): Promise<boolean> {
  if (engineBoot) return engineBoot
  engineBoot = (async () => {
    const url = getSettings().ollamaUrl
    if (await pingOllama(url)) return true // already up

    let child: ReturnType<typeof spawn> | null = null
    try {
      child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
    } catch {
      return false // ollama not installed — the sidebar stays offline
    }
    let spawnFailed = false
    child.on('error', () => {
      spawnFailed = true // ENOENT and friends — don't burn the full wait
    })

    for (let i = 0; i < 24; i++) {
      if (signal?.aborted || spawnFailed) return false
      await bootWait(350)
      if (await pingOllama(url)) return true
    }
    return false // spawned but never answered — streamChat surfaces the error
  })().finally(() => {
    engineBoot = null
  })
  return engineBoot
}

// QoL state ------------------------------------------------------------------
// DATA_DIR feeds the log (set once the store exists); `quitting` separates a
// real quit from a tray-hide so the close button can be intercepted.
let DATA_DIR = ''
let quitting = false
let zoomSaveTimer: ReturnType<typeof setTimeout> | null = null
let trayHintShown = false // one "it's in the tray" balloon per launch
let firstWindow = true // startHidden applies to the launch window only
let renderReloads = 0 // cap renderer auto-reloads after a crash

// A crash on a self-published app reaches us, not a bug tracker: keep the
// last words in ~/.codezy/logs/main.log. Log AND continue (no rethrow) —
// the renderer is the UI; a stray main-process rejection must not take the
// whole app down with no trace.
process.on('uncaughtException', (e) => {
  logLine(DATA_DIR, `uncaughtException: ${e.stack ?? e.message}`)
})
process.on('unhandledRejection', (r) => {
  logLine(DATA_DIR, `unhandledRejection: ${r instanceof Error ? (r.stack ?? r.message) : String(r)}`)
})

/** Show + focus the window (tray menu, deep links, notifications). */
function revealWindow(): void {
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) win.show()
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

/** A codezy:// URL arrived (launch argv, second instance, macOS open-url):
 *  focus the window and log the request — opening the session comes later. */
function handleDeepLink(url: string): void {
  logLine(DATA_DIR, `deep link: ${url}`)
  const sessionId = sessionIdFromLink(url)
  if (sessionId) logLine(DATA_DIR, `deep link targets session ${sessionId}`)
  revealWindow()
}

// macOS delivers deep links here, possibly before whenReady — register early
app.on('open-url', (e, url) => {
  e.preventDefault()
  handleDeepLink(url)
})

/** OS "launch at login" follows the setting — applied on boot and on change. */
function applyLoginItem(s: Settings): void {
  try {
    app.setLoginItemSettings({ openAtLogin: s.openAtLogin === true })
  } catch {
    /* not supported everywhere (some Linux DEs) — never fatal */
  }
}

/** The tray follows `minimizeToTray`; called on boot and on every change. */
function syncTrayToSetting(s: Settings): void {
  syncTray(s.minimizeToTray === true, {
    getWindow: () => win,
    showWindow: () => {
      if (win && !win.isDestroyed()) {
        if (!win.isVisible()) win.show()
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    },
    openDataFolder: () => void shell.openPath(DATA_DIR)
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const link = findDeepLink(argv) // a codezy://… launch brings it forward
    if (link) handleDeepLink(link)
    revealWindow()
  })

  app.whenReady().then(() => {
    initStore() // creates ~/.codezy and friends
    DATA_DIR = getDataDir()
    rotateIfNeeded(DATA_DIR) // startup: yesterday's big log → main.old.log
    logLine(DATA_DIR, `launch ${app.getVersion()} on ${process.platform} (${process.arch})`)
    applyLoginItem(getSettings())
    syncTrayToSetting(getSettings())
    // codezy:// deep links — registration needs the packaged exe (a dev
    // build declines quietly, which is fine and logged)
    try {
      if (!app.setAsDefaultProtocolClient(PROTOCOL)) logLine(DATA_DIR, 'protocol registration declined (dev build?)')
    } catch (e) {
      logLine(DATA_DIR, `protocol registration failed: ${e instanceof Error ? e.message : e}`)
    }
    const launchLink = findDeepLink(process.argv)
    if (launchLink) handleDeepLink(launchLink)
    registerIpc()

    // the live site preview: the chat's linked folder, served over
    // codezy-preview://<sessionId>/<path> like a real web server — the
    // files on disk ARE the site, so relative CSS/JS/images just work
    protocol.handle(PREVIEW_SCHEME, async (request) => {
      try {
        const url = new URL(request.url)
        const sessionId = decodeURIComponent(url.hostname)
        const rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html'
        const found = resolvePreviewPath(getSession(sessionId), rel)
        if (!found) return new Response('not found', { status: 404 })
        const data = await fs.promises.readFile(found.file)
        return new Response(data, {
          headers: {
            'content-type': mimeFor(found.file),
            'cache-control': 'no-store',
            'access-control-allow-origin': '*'
          }
        })
      } catch (e) {
        return new Response(String((e as Error)?.message ?? e), { status: 500 })
      }
    })

    createWindow()

    // launch-time engine check → the sidebar status dot only. Booting Ollama
    // is deferred to the first chat that needs it (see ensureOllama): launch
    // must stay quiet, and the renderer keeps polling until it answers either
    // way — so an Ollama that starts on its own (Startup-folder autostart)
    // still flips the dot online with no help from us.
    void pingOllama(getSettings().ollamaUrl).then((ok) => {
      win?.webContents.send('health:ollama', ok ? 'online' : 'offline')
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // MCP children must die with the app — a leaked server process would hold
  // its stdio pipes open after the window is gone.
  app.on('before-quit', () => {
    quitting = true // the close handler must NOT turn this into a hide
    mcpDisconnectAll()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// -- IPC handlers -----------------------------------------------------------

function registerIpc(): void {
  // settings -------------------------------------------------------------
  ipcMain.handle('settings:get', () => getSettings())

  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    // Merge over the file on disk: the TUI may have written settings (a
    // provider it just connected) since this renderer last read them, and
    // only the keys the renderer actually changed may be rewritten.
    const { prev, saved } = patchSettings(patch)

    // QoL: tray + login item + always-on-top track the settings live (flip a
    // toggle in Settings, no restart needed).
    if (prev.minimizeToTray !== saved.minimizeToTray) syncTrayToSetting(saved)
    if (prev.openAtLogin !== saved.openAtLogin) applyLoginItem(saved)
    if (prev.alwaysOnTop !== saved.alwaysOnTop) win?.setAlwaysOnTop(saved.alwaysOnTop === true)

    // Transparent/material is fixed at creation time, so flipping the acrylic
    // theme rebuilds the window (same bounds, ~200 ms).
    const materialChanged = (prev.theme === 'acrylic') !== (saved.theme === 'acrylic')
    if (materialChanged && win) {
      const bounds = win.getBounds()
      const old = win
      win = null
      setTimeout(() => {
        old.close()
        createWindow(bounds)
      }, 150)
    } else if (win && !materialChanged && saved.theme !== 'acrylic') {
      win.setBackgroundColor(themeColors(saved.theme))
    }
    return saved
  })

  // projects -------------------------------------------------------------
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:save', (_e, projects: Project[]) => {
    saveProjects(projects)
  })

  // sessions -------------------------------------------------------------
  ipcMain.handle('sessions:list', () => listSessions())
  ipcMain.handle('sessions:get', (_e, id: string) => getSession(id))
  ipcMain.handle('sessions:save', (_e, session: Session) => saveSession(session))
  ipcMain.handle('sessions:create', (_e, projectId: string | null, title?: string) =>
    createSession(projectId, title)
  )
  ipcMain.handle('sessions:delete', (_e, id: string) => {
    deleteSession(id)
  })
  // Ctrl+Shift+F — message scan across every chat (v3.1), capped in store.ts
  ipcMain.handle('sessions:search', (_e, q: string) => searchSessions(String(q ?? '')))

  // models + health ------------------------------------------------------
  ipcMain.handle('models:list', async () => {
    const s = getSettings()
    const local = await listOllamaModelDetails(s.ollamaUrl)
    // Ask the engine what each model can DO (Ollama /api/show). A model
    // without `tools` cannot run agent mode — the picker badges it and
    // chat:send falls back to edit blocks instead of a raw 400.
    const entries: import('../shared/api').ModelEntry[] = await Promise.all(
      local.map(async (m) => ({
        id: m.id,
        provider: 'ollama',
        providerName: 'Ollama (local)',
        size: m.size,
        quant: m.quant,
        family: m.family,
        parameter: m.parameter,
        tools: modelSupportsTools(await modelCapabilities(s.ollamaUrl, m.id))
      }))
    )
    for (const p of s.providers) {
      const ids = await listOpenAIModels(p)
      entries.push(...ids.map((id) => ({ id, provider: p.id, providerName: p.name })))
    }
    return entries
  })

  ipcMain.handle('health:ollama', async () => (await pingOllama(getSettings().ollamaUrl)) ? 'online' : 'offline')
  ipcMain.handle('health:drive', () => driveStatus())

  // MCP servers (v3) ----------------------------------------------------
  // list = config + a live probe of every enabled server; probe = try one
  // candidate config without saving; save = persist + drop stale sessions.
  ipcMain.handle('mcp:list', async () => {
    const servers = getSettings().mcpServers ?? []
    const out: import('../shared/api').McpStatusEntry[] = []
    for (const s of servers) {
      if (s.enabled === false) {
        out.push({ ...s, status: 'disabled', tools: [] })
        continue
      }
      try {
        const conn = await mcpGetSession(s.name, s, app.getVersion())
        out.push({ ...s, status: 'ok', tools: conn.tools.map((t) => t.name) })
      } catch (e) {
        out.push({ ...s, status: 'error', tools: [], error: (e as Error)?.message ?? String(e) })
      }
    }
    return out
  })

  ipcMain.handle('mcp:probe', async (_e, cfg: import('../shared/types').McpServerConfig) => {
    if (!cfg?.command) return { ok: false, tools: [], error: 'no command' }
    try {
      const conn = new McpConnection(cfg.name || 'server', cfg)
      const tools = await conn.start(app.getVersion())
      conn.close()
      return { ok: true, tools: tools.map((t) => t.name) }
    } catch (e) {
      return { ok: false, tools: [], error: (e as Error)?.message ?? String(e) }
    }
  })

  ipcMain.handle('mcp:save', (_e, servers: import('../shared/types').McpServerConfig[]) => {
    const before = getSettings().mcpServers ?? []
    const clean = (Array.isArray(servers) ? servers : [])
      .filter((s) => s && typeof s.name === 'string' && typeof s.command === 'string')
      .map((s) => ({
        name: String(s.name).slice(0, 60),
        command: String(s.command).slice(0, 400),
        args: Array.isArray(s.args) ? s.args.map(String).slice(0, 64) : [],
        ...(s.env && typeof s.env === 'object' ? { env: s.env } : {}),
        ...(s.enabled === false ? { enabled: false } : {})
      }))
    patchSettings({ mcpServers: clean })
    // drop sessions for removed servers, then every survivor — their config
    // may have changed (restarted with different args = different process)
    for (const s of before) if (!clean.some((c) => c.name === s.name)) mcpDropSession(s.name)
    for (const s of clean) mcpDropSession(s.name)
    return undefined
  })

  // background tasks (v3.1 batch30) — the panel's list + kill. Reads the
  // agent harness's own task maps through the v2 registry cache.
  ipcMain.handle('tasks:list', () => listV2Tasks())
  ipcMain.handle('tasks:stop', (_e, uid: string) => stopV2Task(String(uid)))

  // chat streaming -------------------------------------------------------
  /**
   * Searches the web for this turn when the user asked for it (or the
   * question is about something that changes), and returns the block the
   * model reads. The normal chat has no tools, so this is what gives it a
   * web. Never throws, never blocks long: a slow or blocked search simply
   * means no web block — the reply still goes out.
   */
  async function resolveWebContext(
    session: Session,
    settings: Settings,
    onSearch: (event: { type: 'websearch'; query: string; results: number; pages: number }) => void
  ): Promise<{ block: string } | null> {
    const mode = settings.webSearch ?? 'auto'
    if (mode === 'off') return null
    const last = [...(session.messages ?? [])].reverse().find((m) => m.role === 'user')
    const text = String(last?.content ?? '')
    if (!text.trim()) return null
    if (mode === 'auto' && !looksLikeWebQuery(text)) return null
    try {
      const ctx = await buildWebContext(text)
      if (!ctx) return null
      onSearch({ type: 'websearch', query: ctx.query, results: ctx.hits.length, pages: ctx.pages.length })
      return { block: ctx.block }
    } catch {
      return null
    }
  }

  ipcMain.handle('chat:send', async (_e, sessionId: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    if (aborts.has(sessionId)) return // already generating

    const settings = getSettings()
    const project = session.projectId
      ? listProjects().find((pr) => pr.id === session.projectId) ?? null
      : null

    const target = targetFor(settings, session)
    // thinking mode (long mode): the Thinking button — sampling shifts to the
    // careful end (deep effort's profile) on top of the prompting section that
    // buildMessages already added. targetFor hands back a fresh object per
    // call, so mutating it here never leaks into settings or the session.
    if (settings.thinkingMode) target.effort = 'deep'
    const controller = new AbortController()
    aborts.set(sessionId, controller)

    let acc = ''
    try {
      // first-use engine bootstrap — launch stays quiet, so if the local
      // engine is down when THIS chat actually needs it, bring it up now.
      // One cheap ping when Ollama is already running (the normal case);
      // if it's genuinely absent we spawn it and wait for the listener.
      if (target.kind === 'ollama') {
        await ensureOllama(controller.signal)
        if (controller.signal.aborted) throw new Error('stopped while starting Ollama')
      }

      // Agent mode needs a model that can CALL tools. Ollama answers a tools
      // schema with HTTP 400 ("does not support tools") for models like
      // codellama — that is what killed the turn with an error instead of an
      // edit. Ask the engine first; when it says no, run this turn in the
      // classic flow (which now carries the REAL file contents).
      let agent = v2Active(session, settings)
      let modelNote: string | undefined
      if (agent && target.kind === 'ollama') {
        const caps = await modelCapabilities(target.baseUrl, target.model)
        if (!modelSupportsTools(caps)) {
          agent = false
          modelNote = `${target.model} cannot call tools, so this turn uses the edit-block flow.`
          emit(sessionId, {
            type: 'notice',
            text: `${target.model} can't call tools, so agent mode can't run. CODEZY switched this turn to edit blocks and included your linked files. Pick a tool-capable model (e.g. qwen2.5-coder:7b) for read/search/write tools.`
          })
        }
      }

      const web = await resolveWebContext(session, settings, (ev) =>
        emit(sessionId, ev as Parameters<typeof emit>[1])
      )
      let messages = buildMessages(session, project, settings, web?.block, { agent, modelNote })

      let stats: { promptTokens?: number; completionTokens?: number }
      // agent mode (v2) only engages over a linked folder — without one the
      // chat runs on the normal engine instead of erroring (the folder link
      // is a code-mode thing, plain conversation never needs it)
      if (agent) {
        // agent mode (v2): the shared harness loop — tool calls, safety
        // validation and the per-action approval dialog, all from
        // codezy-cli/lib/harness.mjs (the same core the terminal shell uses)
        try {
          const out = await runV2({
            session,
            settings,
            messages,
            signal: controller.signal,
            emit: (event) => emit(sessionId, event as Parameters<typeof emit>[1]),
            ask: (name, args) => askV2(sessionId, name, args)
          })
          acc = out.reply
          stats = out.stats
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (!/does not support tools|tool.*not supported/i.test(msg)) throw err
          // Old Ollama / an unknown model slipped past /api/show: retry the
          // SAME turn as a normal completion with the files in the prompt.
          agent = false
          modelNote = `${target.model} does not support tools.`
          emit(sessionId, {
            type: 'notice',
            text: `${target.model} does not support tools — CODEZY retried this turn with edit blocks and your real files.`
          })
          messages = buildMessages(session, project, settings, web?.block, { agent, modelNote })
          stats = await streamChat(target, messages, {
            signal: controller.signal,
            onDelta: (text) => {
              acc += text
              emit(sessionId, { type: 'delta', text })
            }
          })
        }
      } else {
        stats = await streamChat(target, messages, {
          signal: controller.signal,
          onDelta: (text) => {
            acc += text
            emit(sessionId, { type: 'delta', text })
          }
        })
      }

      const reply: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: acc,
        ts: Date.now(),
        model: target.model
      }
      session.messages.push(reply)
      // real token counts for /usage
      session.lastUsage = {
        prompt: stats.promptTokens ?? 0,
        completion: stats.completionTokens ?? 0,
        // agent mode always runs with the 65536 tool-calling window
        ctx: agent ? 65536 : contextSizeFor(session.effort ?? settings.effort),
        ts: Date.now()
      }
      saveSession(session)
      emit(sessionId, { type: 'done', message: reply })

      // auto-learning: after the reply is safely out, quietly ask the model
      // if this exchange contained durable facts about the user. Skipped if
      // another chat is mid-stream (Ollama serves one request at a time).
      if (settings.learn) {
        const busyElsewhere = [...aborts.keys()].some((k) => k !== sessionId)
        if (!busyElsewhere) {
          const prior = session.messages[session.messages.length - 2]
          void learnFromExchange(target, prior?.content ?? '', acc)
        }
      }
    } catch (err) {
      const error = err as Error
      if (controller.signal.aborted || error?.name === 'AbortError') {
        emit(sessionId, { type: 'aborted' })
      } else {
        emit(sessionId, { type: 'error', message: error?.message ?? String(err) })
      }
    } finally {
      settleV2Asks(sessionId)
      aborts.delete(sessionId)
    }
  })

  ipcMain.handle('chat:abort', (_e, sessionId: string) => {
    settleV2Asks(sessionId)
    aborts.get(sessionId)?.abort()
  })

  // renderer's Approve/Deny answer for a pending v2 tool request
  ipcMain.handle('chat:v2decision', (_e, askId: number, allowed: boolean) => {
    for (const [key, ask] of v2Asks) {
      if (ask.id === askId) {
        ask.resolve(Boolean(allowed))
        v2Asks.delete(key)
      }
    }
  })

  // memory ---------------------------------------------------------------
  ipcMain.handle('memory:read', () => readMemory())
  ipcMain.handle('memory:write', (_e, content: string) => writeMemory(content))

  // skills ------------------------------------------------------------------
  ipcMain.handle('skills:list', () => listSkills())

  // file edits (accept / decline / undo) ---------------------------------
  ipcMain.handle('edits:apply', (_e, sessionId: string, edits: FileEdit[]) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    return applyEdits(session, edits)
  })
  ipcMain.handle('edits:undo', (_e, sessionId: string) => undoLast(sessionId))
  // /history — the timeline of safety copies, and restoring any single one
  ipcMain.handle('edits:list', (_e, sessionId: string) => listBackups(sessionId))
  ipcMain.handle('edits:restore', (_e, sessionId: string, backupId: string) => {
    const session = getSession(sessionId)
    if (!session) return { restored: 0, message: 'Session not found — nothing changed.' }
    return restoreBackup(session, String(backupId))
  })

  // usage dashboard -------------------------------------------------------
  ipcMain.handle('usage:stats', (_e, range: import('../shared/usage').UsageRange) => collectUsage(range))

  // web search (/search) ---------------------------------------------------
  ipcMain.handle('search:query', (_e, query: string) => webSearch(query))

  // live site preview -----------------------------------------------------
  ipcMain.handle('preview:files', (_e, sessionId: string) => listPreviewFiles(getSession(sessionId)))
  ipcMain.handle('preview:default', (_e, sessionId: string) => defaultPreviewPath(getSession(sessionId)))
  ipcMain.handle('preview:watch', (_e, sessionId: string) => {
    watchPreview(String(sessionId))
    return true
  })
  ipcMain.handle('preview:unwatch', (_e, sessionId: string) => {
    unwatchPreview(String(sessionId))
    return true
  })

  // git (/diff) — changes vs HEAD in the chat's first linked folder --------
  ipcMain.handle('git:diff', (_e, sessionId: string, pathspec?: string) => {
    const session = getSession(sessionId)
    const folder = session?.linkedFolders?.[0]
    if (!folder) {
      return {
        ok: false,
        error: 'Link a folder to this chat first (📁) — /diff reads its git changes.',
        folder: '',
        branch: '',
        files: [],
        stat: '',
        body: ''
      } satisfies import('../shared/api').GitDiff
    }
    return gitDiff(folder, pathspec || undefined)
  })

  // tree badges — just `git status`, confined to this chat's linked folders
  ipcMain.handle('git:status', (_e, sessionId: string, folder: string) => {
    const roots = getSession(sessionId)?.linkedFolders ?? []
    const target = path.resolve(String(folder ?? ''))
    const linked = roots.some((r) => {
      const root = path.resolve(r)
      if (root === target) return true
      const rel = path.relative(root, target)
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    })
    if (!linked) return { ok: false, folder: '', files: [] } satisfies import('../shared/api').GitStatus
    return gitStatus(target)
  })

  // @mention: list / read files inside the chat's linked folders ------------
  ipcMain.handle('files:list', (_e, sessionId: string, query: string) => {
    const session = getSession(sessionId)
    const roots = session?.linkedFolders ?? []
    if (!roots.length) return []
    return listFiles(roots, query)
  })
  ipcMain.handle('files:read', (_e, sessionId: string, target: string) => {
    const session = getSession(sessionId)
    return readFileIn(session?.linkedFolders ?? [], target)
  })
  ipcMain.handle('files:search', (_e, sessionId: string, query: string) => {
    const session = getSession(sessionId)
    const roots = session?.linkedFolders ?? []
    if (!roots.length) return { hits: [], scanned: 0, truncated: false }
    return searchFiles(roots, query)
  })
  // open / reveal files — clicking a chip goes straight to the saved file
  ipcMain.handle('files:open', (_e, target: string) => shell.openPath(target))
  ipcMain.handle('files:show', (_e, target: string) => shell.showItemInFolder(target))

  // IDE pane (v1.5): cowork the linked folders next to the chat ------------
  ipcMain.handle('ide:tree', (_e, sessionId: string, showIgnored?: boolean) => {
    const session = getSession(sessionId)
    return ideTree(session?.linkedFolders ?? [], { showIgnored: !!showIgnored })
  })
  ipcMain.handle('ide:read', (_e, sessionId: string, target: string) => {
    const session = getSession(sessionId)
    return ideRead(session?.linkedFolders ?? [], target)
  })
  ipcMain.handle('ide:write', (_e, sessionId: string, target: string, content: string) => {
    const session = getSession(sessionId)
    // a truncated editor buffer must never overwrite a bigger file — that
    // silently deletes everything past the read cap
    if (ideSaveWouldTruncate(target, content)) {
      throw new Error(
        'That file is over 1 MB — cowork opened it truncated, so saving would delete the rest of it. Use your own editor for files this big.'
      )
    }
    const saved = ideWrite(session?.linkedFolders ?? [], target, content)
    if (saved == null) throw new Error('That path is outside the linked folders')
    return saved
  })
  ipcMain.handle('ide:create', (_e, sessionId: string, target: string, dir: boolean) => {
    const session = getSession(sessionId)
    const made = ideCreate(session?.linkedFolders ?? [], target, dir)
    if (made == null) throw new Error('That path is outside the linked folders')
    return made
  })
  // rename / delete from the file tree — both confined to the linked folders,
  // delete refuses directories so one click can never take a whole tree
  ipcMain.handle('ide:rename', (_e, sessionId: string, from: string, to: string) => {
    const session = getSession(sessionId)
    const moved = ideRename(session?.linkedFolders ?? [], String(from), String(to))
    if (moved == null) {
      throw new Error('Rename refused — outside the linked folders, the file is gone, or the name is taken')
    }
    return moved
  })
  ipcMain.handle('ide:delete', (_e, sessionId: string, target: string) => {
    const session = getSession(sessionId)
    const ok = ideDelete(session?.linkedFolders ?? [], String(target))
    if (!ok) throw new Error('Delete refused — only files inside the linked folders can be removed')
    return true
  })

  // markdown file dumps — a model answering with "heading + code block" per file
  // instead of the patch format — saved into the chat's first linked folder
  ipcMain.handle('files:saveDump', (_e, sessionId: string, files: { path: string; content: string }[]) => {
    const session = getSession(sessionId)
    const roots = session?.linkedFolders ?? []
    if (!roots.length) throw new Error('Link a folder to this chat first')
    const root = roots[0]
    const saved: string[] = []
    for (const f of (files ?? []).slice(0, 40)) {
      const rel = String(f?.path ?? '').replace(/\\/g, '/').trim()
      if (!rel || rel.includes('..') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) continue
      const out = ideWrite(roots, path.join(root, rel), String(f?.content ?? ''))
      if (out) saved.push(out)
    }
    if (!saved.length) throw new Error('No file landed inside the linked folder')
    return saved
  })

  // code-block actions (v3.1): "apply this block to a file" — the WHOLE file
  // is the search text, so a plain code block becomes a full overwrite that
  // still runs through applyEdits: same confinement, same safety backup,
  // same /undo as every agent edit.
  ipcMain.handle('files:applyBlock', (_e, sessionId: string, target: string, content: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Unknown chat')
    return applyCodeBlock(session, target, content)
  })

  // image viewing: local image → data URL (chat thumbs, IDE preview) --------
  ipcMain.handle('images:dataUrl', (_e, target: string) => {
    const mime = IMAGE_MIME[path.extname(target).toLowerCase()]
    if (!mime) return null
    try {
      const st = fs.statSync(target)
      if (st.size > 10_000_000) return null // viewer cap
      return `data:${mime};base64,${fs.readFileSync(target).toString('base64')}`
    } catch {
      return null
    }
  })
  // paste an image from the clipboard → temp file, staged like any attachment
  // (Electron 44: async W3C-style clipboard — read() → ClipboardItem → Blob)
  ipcMain.handle('images:paste', async () => {
    try {
      const items = await clipboard.read()
      const item = items.find((it) => it.types.some((t) => t.startsWith('image/')))
      if (!item) return null
      const mime = item.types.find((t) => t.startsWith('image/')) ?? ''
      if (!mime) return null
      const data = await item.getType(mime)
      if (!('arrayBuffer' in data)) return null // bookmark payload, not bytes
      const buf = Buffer.from(await data.arrayBuffer())
      if (!buf.length || buf.length > 10_000_000) return null
      const dir = path.join(app.getPath('temp'), 'codezy-paste')
      fs.mkdirSync(dir, { recursive: true })
      const ext = (mime.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png'
      const file = path.join(dir, `paste-${Date.now()}.${ext}`)
      fs.writeFileSync(file, buf)
      return file
    } catch {
      return null
    }
  })

  // drag & drop onto the composer: classify folders, read text files (capped)
  ipcMain.handle('files:import', (_e, paths: string[]) => {
    const out: {
      files: { path: string; content: string }[]
      dirs: string[]
      skipped: { path: string; reason: string }[]
    } = { files: [], dirs: [], skipped: [] }
    for (const p of (paths ?? []).slice(0, 30)) {
      try {
        const st = fs.statSync(p)
        if (st.isDirectory()) {
          out.dirs.push(p)
          continue
        }
        // images preview inline — path only, never text-decoded
        if (isImagePath(p)) {
          out.files.push({ path: p, content: '' })
          continue
        }
        if (st.size > 2_000_000) {
          out.skipped.push({ path: p, reason: 'too large (>2 MB)' })
          continue
        }
        const content = fs.readFileSync(p, 'utf8')
        // NUL byte = binary — never paste those into a prompt
        if (content.indexOf('\u0000') !== -1) {
          out.skipped.push({ path: p, reason: 'binary file' })
          continue
        }
        out.files.push({ path: p, content: content.slice(0, 100_000) })
      } catch {
        out.skipped.push({ path: p, reason: 'unreadable' })
      }
    }
    return out
  })

  // project context (/init) ------------------------------------------------
  ipcMain.handle('init:prepare', (_e, sessionId: string) => {
    const session = getSession(sessionId)
    const folder = session?.linkedFolders?.[0]
    if (!folder) return null
    return { folder, tree: fileTree(folder) }
  })
  ipcMain.handle('init:write', (_e, sessionId: string, content: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    const folder = session.linkedFolders?.[0]
    if (!folder) throw new Error('No folder is linked to this chat')
    // fixed filename inside the linked folder — no traversal possible
    const target = path.join(folder, 'CODEZY.md')
    fs.writeFileSync(target, content, 'utf8')
    return target
  })

  // diagnostics folder — the log file lives here (Settings → open logs)
  ipcMain.handle('app:openLogs', () => {
    const dir = path.join(DATA_DIR, 'logs')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* best effort — openPath reports the failure below */
    }
    return shell.openPath(dir)
  })

  // boot the engine from the UI: the sidebar dot is clickable while offline
  ipcMain.handle('app:startOllama', async () => {
    const ok = await ensureOllama()
    return { ok }
  })

  // terminal interface -----------------------------------------------------
  /**
   * The published CLI, when it is installed globally (npm i -g codezy-cli).
   * The INSTALLER ships no CLI — the terminal agent is its own npm package —
   * so this is how the desktop app reaches it without shipping a copy.
   */
  function globalCliEntry(): string | null {
    const roots: string[] = []
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA
      if (appData) roots.push(path.join(appData, 'npm', 'node_modules', 'codezy-cli'))
    } else {
      roots.push('/usr/local/lib/node_modules/codezy-cli', '/usr/lib/node_modules/codezy-cli')
    }
    for (const r of roots) {
      const entry = path.join(r, 'index.mjs')
      try {
        if (fs.existsSync(entry)) return entry
      } catch {
        /* ignore */
      }
    }
    return null
  }

  /** The CLI that ships WITH the app: next to the app in a dev checkout, or
   *  in resources/ in a packaged build (outside the asar — a plain `node`
   *  cannot read a file out of an asar). index.mjs is the 3.2.0 unified REPL;
   *  codezy.mjs is the legacy TUI kept as a fallback for older bundles. */
  function bundledCliEntry(): string | null {
    const candidates = [
      path.join(app.getAppPath(), '..', 'codezy-cli', 'index.mjs'),
      path.join(app.getAppPath(), 'cli', 'index.mjs'),
      process.resourcesPath ? path.join(process.resourcesPath, 'cli', 'index.mjs') : null,
      path.join(app.getAppPath(), '..', 'codezy-cli', 'codezy.mjs'),
      path.join(app.getAppPath(), 'cli', 'codezy.mjs'),
      process.resourcesPath ? path.join(process.resourcesPath, 'cli', 'codezy.mjs') : null
    ].filter((p): p is string => !!p)
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c
      } catch {
        /* ignore */
      }
    }
    return null
  }

  ipcMain.handle('app:openTerminal', async (_e, sessionId?: string) => {
    // WHERE it opens: the chat's linked folder, else the user's home —
    // never the asar (that is not a working directory).
    const session = sessionId ? getSession(String(sessionId)) : null
    const cwd = session?.linkedFolders?.[0] ?? os.homedir()
    // WHAT runs: the CLI that ships with the app → a global install →
    // npx, which fetches the published package on the spot.
    const bundled = bundledCliEntry()
    let cmd: { file: string; args: string[] }
    if (bundled) {
      cmd = { file: 'node', args: [bundled] }
    } else {
      const global = globalCliEntry()
      cmd = global
        ? { file: 'node', args: [global] }
        : { file: 'npx', args: ['-y', '-p', 'codezy-cli', 'codezy'] }
    }
    // Walk the platform plan (terminal.ts): the first terminal that actually
    // SPAWNS wins, a missing binary ('error') falls through to the next
    // attempt, and a total miss reports what it tried instead of silently
    // doing nothing. Windows Terminal first (system theme), then cmd.exe.
    const plan = terminalPlan(process.platform, cwd, cmd)
    for (const a of plan) {
      const outcome = await new Promise<string | null>((resolve) => {
        let c: ReturnType<typeof spawn>
        try {
          c = spawn(a.file, a.args, { detached: true, stdio: 'ignore', cwd: a.cwd ?? cwd })
        } catch (e) {
          resolve(e instanceof Error ? e.message : String(e))
          return
        }
        c.once('spawn', () => {
          c.unref()
          resolve(null)
        })
        c.once('error', (e) => resolve(e.message))
      })
      if (outcome === null) return null // a terminal took it
    }
    return `Could not open a terminal — tried ${plan.map((a) => a.file).join(', ')}`
  })

  // dialogs --------------------------------------------------------------
  ipcMain.handle('dialog:pickFolder', async (_e, title?: string) => {
    const res = await dialog.showOpenDialog(win!, {
      title: title ?? 'Choose a folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('dialog:pickFiles', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled) return []
    return res.filePaths.map((filePath) => {
      // images carry a path only — the renderer previews them, no text mangled
      if (isImagePath(filePath)) return { path: filePath, content: '' }
      try {
        return { path: filePath, content: fs.readFileSync(filePath, 'utf8').slice(0, 100_000) }
      } catch {
        return { path: filePath, content: '' }
      }
    })
  })

  ipcMain.handle('dialog:saveText', async (_e, defaultName: string, content: string) => {
    const json = String(defaultName).toLowerCase().endsWith('.json')
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: defaultName,
      filters: [{ name: json ? 'JSON' : 'Markdown', extensions: [json ? 'json' : 'md'] }]
    })
    if (res.canceled || !res.filePath) return null
    fs.writeFileSync(res.filePath, content, 'utf8')
    return res.filePath
  })

  // window controls (custom title bar) -----------------------------------
  ipcMain.handle('win:minimize', () => win?.minimize())
  ipcMain.handle('win:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  ipcMain.handle('win:close', () => win?.close())
  ipcMain.handle('win:isMaximized', () => win?.isMaximized() ?? false)

  // misc -----------------------------------------------------------------
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
  })

  // in-app update (v2.6) ---------------------------------------------------
  // State for the two-step flow: check remembers what to fetch, download
  // streams it and reports progress, apply starts the silent installer.
  let updateCheck: UpdateCheck | null = null
  let updateFile: string | null = null

  ipcMain.handle('update:check', async () => {
    updateCheck = await checkForUpdates(app.getVersion())
    if (!updateCheck.available) updateFile = null // nothing newer — drop any old file
    return updateCheck
  })

  ipcMain.handle('update:download', async () => {
    const rel = updateCheck?.release
    if (!rel) return { error: 'no update available' }
    const dir = path.join(app.getPath('temp'), 'codezy-update')
    const res = await downloadUpdate(rel.url, dir, (p) => win?.webContents.send('update:progress', p))
    if ('error' in res) return res
    updateFile = res.path
    return res
  })

  ipcMain.handle('update:apply', async () => {
    if (process.platform !== 'win32') {
      // No in-place installer off Windows (NSIS is Windows-only): hand the
      // release page over so a downloaded .dmg/.AppImage still leads to an
      // install instead of a dead button. The app must NOT quit — the user
      // installs manually and the pill stays honest.
      void shell.openExternal(updateCheck?.release?.page ?? `https://github.com/${UPDATE_REPO}/releases`)
      return { ok: false, error: 'opened the release page — auto-install is Windows-only for now' }
    }
    if (!updateFile) return { error: 'update not downloaded yet' }
    const res = await applyUpdate(updateFile)
    if (res.ok) {
      // The installer replaces our files while we're gone — quit right after
      // the spawn lands so NSIS doesn't wait on locks (`--force-run` brings
      // the new version back).
      setTimeout(() => app.quit(), 300)
    }
    return res
  })

  ipcMain.handle('update:openRelease', (_e, url: string) => {
    const fallback = updateCheck?.release?.page ?? `https://github.com/${UPDATE_REPO}/releases`
    const target = typeof url === 'string' && url.startsWith('https://github.com/') ? url : fallback
    void shell.openExternal(target)
  })
}

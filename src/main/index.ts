// ---------------------------------------------------------------------------
// index.ts — Electron main process: app lifecycle, window, and every IPC
// handler the renderer can call. This is where a UI action ("send message")
// turns into real work (build prompt → stream from Ollama → save to disk).
// ---------------------------------------------------------------------------

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import path from 'path'
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
  getSession,
  initStore,
  listProjects,
  listSessions,
  listSkills,
  patchSettings,
  readMemory,
  saveProjects,
  saveSession,
  writeMemory
} from './store'
import { listOllamaModelDetails, listOpenAIModels, pingOllama, streamChat, contextSizeFor } from './ollama'
import { buildMessages, fileTree } from './prompt'
import { webSearch } from './search'
import { gitDiff } from './git'
import { learnFromExchange } from './learn'
import { applyEdits, undoLast } from './edits'
import {
  IMAGE_MIME,
  ideCreate,
  ideRead,
  ideTree,
  ideWrite,
  isImagePath,
  listFiles,
  readFileIn
} from './files'
import { runV2 } from './v2'
import { collectUsage } from './usage'
import type { FileEdit } from '../shared/edits'

let win: BrowserWindow | null = null
const aborts = new Map<string, AbortController>()
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
  return theme === 'light' ? '#f2f2f7' : '#0b0b12'
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

  if (bounds) win.setBounds(bounds)

  win.once('ready-to-show', () => {
    win?.show()
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
    | { type: 'v2ask'; askId: number; name: string; args: Record<string, unknown> }
): void {
  win?.webContents.send('chat:event', { sessionId, ...event })
}

// -- app lifecycle ----------------------------------------------------------

/** Brings the local engine up on launch: ping first (an already-running or
 *  user-managed Ollama is left alone), otherwise spawn a detached, windowless
 *  `ollama serve` — it outlives the app like any other local service. */
function ensureOllama(): void {
  void pingOllama(getSettings().ollamaUrl).then((ok) => {
    if (ok) return
    try {
      const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => {
        /* ollama not installed — the sidebar stays offline and Settings explains */
      })
      child.unref()
    } catch {
      /* ditto — never let a missing binary break startup */
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    initStore() // creates ~/.codezy and friends
    registerIpc()
    createWindow()

    // launch-time engine check → the sidebar status dot. If Ollama isn't up
    // yet, start it ourselves so the first chat never waits on a manual
    // `ollama serve`; the renderer keeps polling until it answers.
    void pingOllama(getSettings().ollamaUrl).then((ok) => {
      win?.webContents.send('health:ollama', ok ? 'online' : 'offline')
      if (!ok) ensureOllama()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
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

  // models + health ------------------------------------------------------
  ipcMain.handle('models:list', async () => {
    const s = getSettings()
    const entries: import('../shared/api').ModelEntry[] = (await listOllamaModelDetails(s.ollamaUrl)).map((m) => ({
      id: m.id,
      provider: 'ollama',
      providerName: 'Ollama (local)',
      size: m.size,
      quant: m.quant,
      family: m.family,
      parameter: m.parameter
    }))
    for (const p of s.providers) {
      const ids = await listOpenAIModels(p)
      entries.push(...ids.map((id) => ({ id, provider: p.id, providerName: p.name })))
    }
    return entries
  })

  ipcMain.handle('health:ollama', async () => (await pingOllama(getSettings().ollamaUrl)) ? 'online' : 'offline')
  ipcMain.handle('health:drive', () => driveStatus())

  // chat streaming -------------------------------------------------------
  ipcMain.handle('chat:send', async (_e, sessionId: string) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    if (aborts.has(sessionId)) return // already generating

    const settings = getSettings()
    const project = session.projectId
      ? listProjects().find((pr) => pr.id === session.projectId) ?? null
      : null

    const messages = buildMessages(session, project, settings)
    const target = targetFor(settings, session)
    const controller = new AbortController()
    aborts.set(sessionId, controller)

    let acc = ''
    try {
      let stats: { promptTokens?: number; completionTokens?: number }
      if (settings.v2) {
        // agent mode (v2): the shared harness loop — tool calls, safety
        // validation and the per-action approval dialog, all from
        // cli/lib/harness.mjs (the same core the terminal shell uses)
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
        ctx: settings.v2 ? 65536 : contextSizeFor(session.effort ?? settings.effort),
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

  // usage dashboard -------------------------------------------------------
  ipcMain.handle('usage:stats', (_e, range: import('../shared/usage').UsageRange) => collectUsage(range))

  // web search (/search) ---------------------------------------------------
  ipcMain.handle('search:query', (_e, query: string) => webSearch(query))

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
  // open / reveal files — clicking a chip goes straight to the saved file
  ipcMain.handle('files:open', (_e, target: string) => shell.openPath(target))
  ipcMain.handle('files:show', (_e, target: string) => shell.showItemInFolder(target))

  // IDE pane (v1.5): cowork the linked folders next to the chat ------------
  ipcMain.handle('ide:tree', (_e, sessionId: string) => {
    const session = getSession(sessionId)
    return ideTree(session?.linkedFolders ?? [])
  })
  ipcMain.handle('ide:read', (_e, sessionId: string, target: string) => {
    const session = getSession(sessionId)
    return ideRead(session?.linkedFolders ?? [], target)
  })
  ipcMain.handle('ide:write', (_e, sessionId: string, target: string, content: string) => {
    const session = getSession(sessionId)
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

  // terminal interface -----------------------------------------------------
  ipcMain.handle('app:openTerminal', () => {
    const root = app.getAppPath()
    const cli = path.join(root, 'cli', 'codezy.mjs')
    if (!fs.existsSync(cli)) return `CLI script not found: ${cli}`
    const plain = (): string | null => {
      try {
        const c = spawn('cmd.exe', ['/k', 'node', cli], {
          detached: true,
          stdio: 'ignore',
          cwd: root
        })
        c.unref()
        return null
      } catch (e) {
        return `Could not open the terminal: ${e instanceof Error ? e.message : e}`
      }
    }
    // Windows Terminal first: it inherits the system theme (acrylic, colors)
    // the same way opencode opens. `-M` = maximized (fills the screen, taskbar
    // stays). Falls back to a plain console window.
    try {
      const wt = spawn(
        'wt.exe',
        ['-M', '-w', 'new', '--title', 'CODEZY', '-d', root, 'cmd', '/k', 'node', path.join('cli', 'codezy.mjs')],
        { detached: true, stdio: 'ignore' }
      )
      wt.on('error', () => plain())
      wt.unref()
      return null
    } catch {
      return plain()
    }
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
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
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
}

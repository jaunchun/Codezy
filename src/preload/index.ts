// ---------------------------------------------------------------------------
// preload/index.ts — the only bridge between web page and backend.
// contextBridge exposes our `codezy` object into the renderer's window, and
// every method is a thin ipcRenderer.invoke/on wrapper around a channel.
// The renderer can ask for things, but has no Node access at all.
// ---------------------------------------------------------------------------

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CodezyApi } from '../shared/api'
import type { ChatEvent, Project, Settings, Session } from '../shared/types'

const api: CodezyApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    save: (projects: Project[]) => ipcRenderer.invoke('projects:save', projects)
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    get: (id: string) => ipcRenderer.invoke('sessions:get', id),
    save: (s: Session) => ipcRenderer.invoke('sessions:save', s),
    create: (projectId: string | null, title?: string) =>
      ipcRenderer.invoke('sessions:create', projectId, title),
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
    search: (q: string) => ipcRenderer.invoke('sessions:search', q)
  },
  models: {
    list: () => ipcRenderer.invoke('models:list')
  },
  health: {
    ollama: () => ipcRenderer.invoke('health:ollama'),
    drive: () => ipcRenderer.invoke('health:drive')
  },
  chat: {
    send: (sessionId: string) => ipcRenderer.invoke('chat:send', sessionId),
    abort: (sessionId: string) => ipcRenderer.invoke('chat:abort', sessionId),
    v2Decision: (askId: number, allowed: boolean) =>
      ipcRenderer.invoke('chat:v2decision', askId, allowed),
    onEvent: (cb) => {
      const listener = (_e: unknown, payload: { sessionId: string } & ChatEvent) => cb(payload)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener) // unsubscribe fn
    }
  },
  memory: {
    read: () => ipcRenderer.invoke('memory:read'),
    write: (content: string) => ipcRenderer.invoke('memory:write', content)
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list')
  },
  edits: {
    apply: (sessionId: string, edits: import('../shared/edits').FileEdit[]) =>
      ipcRenderer.invoke('edits:apply', sessionId, edits),
    undo: (sessionId: string) => ipcRenderer.invoke('edits:undo', sessionId),
    list: (sessionId: string) => ipcRenderer.invoke('edits:list', sessionId),
    restore: (sessionId: string, backupId: string) =>
      ipcRenderer.invoke('edits:restore', sessionId, backupId)
  },
  usage: {
    stats: (range: import('../shared/usage').UsageRange) => ipcRenderer.invoke('usage:stats', range)
  },
  search: {
    query: (q: string) => ipcRenderer.invoke('search:query', q)
  },
  git: {
    diff: (sessionId: string, pathspec?: string) => ipcRenderer.invoke('git:diff', sessionId, pathspec),
    status: (sessionId: string, folder: string) => ipcRenderer.invoke('git:status', sessionId, folder)
  },
  files: {
    list: (sessionId: string, query: string) => ipcRenderer.invoke('files:list', sessionId, query),
    read: (sessionId: string, path: string) => ipcRenderer.invoke('files:read', sessionId, path),
    ingest: (paths: string[]) => ipcRenderer.invoke('files:import', paths),
    saveDump: (sessionId: string, files: { path: string; content: string }[]) =>
      ipcRenderer.invoke('files:saveDump', sessionId, files),
    applyBlock: (sessionId: string, path: string, content: string) =>
      ipcRenderer.invoke('files:applyBlock', sessionId, path, content),
    open: (path: string) => ipcRenderer.invoke('files:open', path),
    show: (path: string) => ipcRenderer.invoke('files:show', path)
  },
  ide: {
    tree: (sessionId: string, showIgnored?: boolean) =>
      ipcRenderer.invoke('ide:tree', sessionId, showIgnored),
    read: (sessionId: string, path: string) => ipcRenderer.invoke('ide:read', sessionId, path),
    write: (sessionId: string, path: string, content: string) =>
      ipcRenderer.invoke('ide:write', sessionId, path, content),
    create: (sessionId: string, path: string, dir: boolean) =>
      ipcRenderer.invoke('ide:create', sessionId, path, dir),
    rename: (sessionId: string, from: string, to: string) =>
      ipcRenderer.invoke('ide:rename', sessionId, from, to),
    delete: (sessionId: string, path: string) => ipcRenderer.invoke('ide:delete', sessionId, path)
  },
  images: {
    dataUrl: (path: string) => ipcRenderer.invoke('images:dataUrl', path),
    paste: () => ipcRenderer.invoke('images:paste')
  },
  // drag & drop: Electron ≥32 removed File.path — the preload resolves it
  filesPath: (file: File) => webUtils.getPathForFile(file),
  init: {
    prepare: (sessionId: string) => ipcRenderer.invoke('init:prepare', sessionId),
    write: (sessionId: string, content: string) => ipcRenderer.invoke('init:write', sessionId, content)
  },
  dialog: {
    pickFolder: (title?: string) => ipcRenderer.invoke('dialog:pickFolder', title),
    pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
    saveText: (defaultName: string, content: string) =>
      ipcRenderer.invoke('dialog:saveText', defaultName, content)
  },
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized')
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    openTerminal: () => ipcRenderer.invoke('app:openTerminal')
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    apply: () => ipcRenderer.invoke('update:apply'),
    onProgress: (cb) => {
      const listener = (_e: unknown, p: import('../shared/api').UpdateProgress) => cb(p)
      ipcRenderer.on('update:progress', listener)
      return () => ipcRenderer.removeListener('update:progress', listener)
    },
    openRelease: (url: string) => ipcRenderer.invoke('update:openRelease', url)
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    probe: (cfg: unknown) => ipcRenderer.invoke('mcp:probe', cfg),
    save: (servers: unknown[]) => ipcRenderer.invoke('mcp:save', servers)
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    stop: (uid: string) => ipcRenderer.invoke('tasks:stop', uid)
  }
}

contextBridge.exposeInMainWorld('codezy', api)

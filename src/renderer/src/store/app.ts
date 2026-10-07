// ---------------------------------------------------------------------------
// store/app.ts — the single source of truth for the React UI.
// It owns: settings, projects, sessions, model list, connection status and
// the streaming state. Slash commands are executed HERE, in the renderer,
// which is still "CODEZY itself" — nothing reaches the model for them.
// ---------------------------------------------------------------------------

import { create } from 'zustand'
import type { ChatMessage, Project, Settings, Session, ConnectionStatus, V2Outcome, EffortLevel, ProviderConfig } from '../../../shared/types'
import type { ModelEntry } from '../../../shared/api'
import { COMMANDS, helpText, isEffort, isTheme, parseInput, themeBase, themePalette } from '../../../shared/commands'
import { PROVIDER_PRESETS } from '../../../shared/providers'
import { parseEdits, stripEditBlocks } from '../../../shared/edits'

const api = () => window.codezy

// Guards: React StrictMode mounts effects twice in dev, which used to
// register the chat-event listener twice → every reply appeared twice.
let initialized = false
let subscribed = false

const uid = (): string =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)

/** Small byte sizes, transcript scale (96 B · 12.4 kB · 1.2 MB). */
const fmtBytes = (b: number): string =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} kB` : `${(b / 1048576).toFixed(1)} MB`

/** Focus mode survives restarts (localStorage — no backend round trip). */
const SIDEBAR_OPEN = (() => {
  try {
    return localStorage.getItem('codezy.sidebar') !== '0'
  } catch {
    return true
  }
})()

export interface Notice {
  id: string
  text: string
  kind?: 'info' | 'error'
  /** persistent action button — stays until clicked (e.g. ↩ Undo after an accept) */
  action?: { label: string; run: () => void | Promise<void> }
}

/** Live agent-mode (v2) tool activity — drives the streaming activity line. */
export interface V2Activity {
  iteration: number
  name: string
  args: Record<string, unknown>
  outcome: V2Outcome
}

/** A pending v2 approval dialog (main is blocked until the user answers). */
export interface V2Ask {
  askId: number
  name: string
  args: Record<string, unknown>
}

export interface AppState {
  ready: boolean
  settings: Settings | null
  projects: Project[]
  sessions: Session[]
  activeId: string | null
  filterProjectId: string | null
  models: ModelEntry[]
  ollama: ConnectionStatus
  drive: { enabled: boolean; folder: string | null; healthy: boolean }
  streaming: boolean
  /** sessions with a live turn — `streaming` mirrors "the visible chat is in
   *  here", so a background chat's run never fakes a thinking composer */
  streamingIds: string[]
  streamText: string
  notices: Notice[]
  /** one-shot text pushed into the composer (starter cards, edit-and-resend) */
  composerDraft: string | null
  /** unsent composer text per chat — switching chats never loses typing */
  chatDrafts: Record<string, string>
  v2Activity: V2Activity | null
  v2Ask: V2Ask | null
  settingsOpen: boolean
  createProjectOpen: boolean
  usageOpen: boolean
  /** agent write for the cowork editor — drops a cursor where the model works */
  aiWrite: { path: string } | null
  /** auto-continuations burned on this turn (reset by every human message) */
  autoContinuations: number

  init(): Promise<void>
  setActive(id: string | null): void
  setFilter(projectId: string | null): void
  newChat(projectId?: string | null): Promise<void>
  removeSession(id: string): Promise<void>
  send(text: string, files?: { path: string; content: string }[], hidden?: boolean): Promise<void>
  stop(): Promise<void>
  setComposerDraft(text: string | null): void
  setChatDraft(id: string, text: string): void
  /** Answers a pending agent-mode (v2) approval dialog. */
  answerV2(allowed: boolean): void
  /** Drops the assistant reply (and anything after it) and asks the model again. */
  regenerate(messageId: string): Promise<void>
  /** Loads a message into the composer and removes it + everything after it. */
  editFrom(messageId: string): Promise<void>
  /** Forks the chat into a new session with history up to (and including) this message. */
  branchFrom(messageId: string): Promise<void>
  /** Pins / unpins a chat to the top of the sidebar. */
  togglePin(id: string): Promise<void>
  /** Per-chat generation overrides — absent fields fall back to the settings. */
  setSessionGen(
    id: string,
    patch: { model?: string; provider?: string; effort?: EffortLevel }
  ): Promise<void>
  linkFolder(folder: string): Promise<void>
  unlinkFolder(folder: string): Promise<void>
  /** Writes a message's proposed edits into the linked folders (with backup). */
  acceptEdits(messageId: string): Promise<void>
  /** Dismisses a message's proposed edits without touching disk. */
  declineEdits(messageId: string): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  /** Re-read settings + models written by another holder (the TUI, …). */
  resync(): Promise<void>
  addNotice(text: string, kind?: Notice['kind'], action?: Notice['action']): void
  dismissNotice(id: string): void
  /** Reverts the last accepted edit batch (the backup written on apply). */
  undoLast(): Promise<void>
  setSettingsOpen(v: boolean): void
  setCreateProjectOpen(v: boolean): void
  setUsageOpen(v: boolean): void
  /** Ctrl+K command palette. */
  paletteOpen: boolean
  setPaletteOpen(v: boolean): void
  /** Ctrl+/ — the keyboard cheat sheet. */
  shortcutsOpen: boolean
  toggleShortcuts(): void
  /** v1.5 — cowork editor pane (file tree + editor next to the chat). */
  ideOpen: boolean
  toggleIde(): void
  /** v2.3 — the file open in cowork, mirrored live (unsaved edits included):
   *  the composer attaches it so the model sees what you're looking at. */
  ideFile: { path: string; content: string } | null
  setIdeFile(f: { path: string; content: string } | null): void
  /** Bumped when files land outside a stream (dump saves) — the cowork tree reloads. */
  ideTick: number
  bumpIdeTick(): void
  /** Ctrl+B focus mode — hides the sidebar. */
  sidebarOpen: boolean
  toggleSidebar(): void
  renameSession(id: string, title: string): Promise<void>
  duplicateSession(id: string): Promise<void>
  exportSession(id: string): Promise<void>
  /** Sidebar Drive button — pick a mirror folder, or open Settings when linked. */
  toggleDrive(): Promise<void>
  addProject(p: { name: string; group: string; rootPath?: string | null }): Promise<void>
  removeProject(id: string): Promise<void>
  reloadProjects(): Promise<void>
}

const PALETTE_THEMES = new Set<string>(['midnight', 'ember', 'mint', 'slate'])

function applyTheme(theme: Settings['theme'], accent: string): void {
  // shared config: the terminal palettes (midnight/ember/mint/slate) ride on
  // the dark surfaces; dark/light/acrylic pick the base mode (accent: midnight)
  document.documentElement.dataset.theme = themeBase(theme)
  document.documentElement.dataset.palette = themePalette(theme)
  applyAccent(theme, accent)
}

/** Surface themes (dark/light/acrylic) follow the custom accent — the inline
 *  value outranks the stylesheet's data-palette rule. The palette THEMES own
 *  theirs so the desktop keeps mirroring the terminal's /theme. accent-2 is
 *  derived so focus rings and gradients track whatever the user picked. */
function applyAccent(theme: Settings['theme'], accent: string): void {
  const root = document.documentElement
  if (PALETTE_THEMES.has(theme)) {
    root.style.removeProperty('--accent')
    root.style.removeProperty('--accent-2')
    return
  }
  root.style.setProperty('--accent', accent)
  root.style.setProperty('--accent-2', `color-mix(in srgb, ${accent} 72%, white)`)
}

/** accessibility: one attribute the whole stylesheet hangs off. */
function applyMotion(reduce: boolean): void {
  document.documentElement.dataset.motion = reduce ? 'off' : 'on'
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 42 ? t.slice(0, 42) + '…' : t || 'New chat'
}

/** ``` fences come in pairs — an odd count means the reply stopped mid-code. */
function unclosedFence(text: string): boolean {
  let n = 0
  for (const line of text.split('\n')) if (/^\s*```/.test(line)) n++
  return n % 2 === 1
}

export const useApp = create<AppState>((set, get) => {
  // set while an /init generation is running — its reply is the context file
  let pendingInit = false
  // tool steps of the current agent run — attached to the reply when it finishes
  let pendingTrace: { name: string; ok: boolean }[] = []
  let steering = false // a new message cut into a running reply (interject)

  // Ollama is started on launch (main process) — booting takes a moment, so
  // keep asking until it answers. Re-armed whenever a run errors out, which
  // is usually the engine dying mid-stream.
  let ollamaWatch: number | null = null
  function armOllamaWatch(): void {
    if (ollamaWatch != null) return
    ollamaWatch = window.setInterval(() => {
      void api()
        .health.ollama()
        .then((st) => {
          if (st !== get().ollama) set({ ollama: st })
          if (st === 'online' && ollamaWatch != null) {
            window.clearInterval(ollamaWatch)
            ollamaWatch = null
          }
        })
        .catch(() => undefined)
    }, 3500)
  }

  // -- streaming events from the backend ------------------------------------
  // Events carry the session they belong to. A chat you switched away from
  // keeps its own turn alive: its reply still lands in its own session, and
  // none of its text or state ever leaks into the chat you're looking at.
  function handleEvent(payload: { sessionId: string } & { type: string } & Record<string, unknown>): void {
    const sid = payload.sessionId
    const mine = sid === get().activeId

    /** this turn ended — drop it from the per-session bookkeeping */
    const endTurn = () => {
      const ids = get().streamingIds.filter((x) => x !== sid)
      const patch: Partial<AppState> = { streamingIds: ids, streaming: ids.includes(get().activeId ?? '') }
      if (mine) Object.assign(patch, { streamText: '', v2Activity: null, v2Ask: null })
      set(patch)
    }

    if (payload.type === 'delta') {
      if (!mine) return // background session — its text lands with the reply
      set({ streamText: get().streamText + (payload.text as string) })
      return
    }

    if (payload.type === 'v2tool') {
      if (!mine) return // tool chatter and cursors belong to the visible chat
      // agent mode: real tool activity → the streaming line shows what runs
      const outcome = (payload.outcome as V2Outcome) ?? 'ok'
      pendingTrace.push({ name: String(payload.name), ok: outcome === 'ok' })
      set({
        v2Activity: {
          iteration: Number(payload.iteration) || 0,
          name: String(payload.name),
          args: (payload.args as Record<string, unknown>) ?? {},
          outcome
        }
      })
      // a file write → the cowork editor drops its "AI writing here" cursor
      const wArgs = payload.args as Record<string, unknown> | undefined
      if (String(payload.name) === 'write_file' && typeof wArgs?.path === 'string') {
        set({ aiWrite: { path: wArgs.path } })
      }
      return
    }

    if (payload.type === 'v2ask') {
      // main is blocked on this promise — always surface it, even for a chat
      // you just switched away from, or the run could never continue
      set({
        v2Ask: {
          askId: Number(payload.askId),
          name: String(payload.name),
          args: (payload.args as Record<string, unknown>) ?? {}
        }
      })
      return
    }

    if (payload.type === 'done') {
      const base = payload.message as ChatMessage
      const wasInit = pendingInit
      // collapse the run's tool activity onto the finished reply (v1.5 preview)
      const trace = pendingTrace
      pendingTrace = []
      const message: ChatMessage = trace.length ? { ...base, trace } : base
      const session = get().sessions.find((s) => s.id === sid) // the run's own chat
      // idempotent: never append the same reply twice
      if (session && !session.messages.some((m) => m.id === message.id)) {
        const updated: Session = { ...session, messages: [...session.messages, message] }
        void api().sessions.save(updated)
        set({ sessions: get().sessions.map((s) => (s.id === updated.id ? updated : s)) })
      }
      endTurn()
      // OS notification — only when you're off doing something else
      try {
        if (get().settings?.notifyDone && !document.hasFocus() && typeof Notification !== 'undefined') {
          new Notification('CODEZY', {
            body: `${session?.title ?? 'Reply'}\n${message.content.slice(0, 140)}`
          })
        }
      } catch {
        /* notifications unavailable — never break the reply for this */
      }
      // auto mode: apply proposed edits right away (always backed up — /undo reverts)
      if (mine && get().settings?.mode === 'auto' && parseEdits(message.content).length) {
        void get().acceptEdits(message.id)
      }
      // /init: this reply IS the project context → write it into the linked folder
      if (pendingInit) {
        pendingInit = false
        const body = message.content.replace(/^```[a-z]*\n?|```$/g, '').trim()
        const initSid = session?.id
        if (!initSid || body.length < 40) {
          get().addNotice('/init received too little text — nothing was saved.', 'error')
        } else {
          void api()
            .init.write(initSid, body)
            .then((p) =>
              get().addNotice(`✓ Project context saved to ${p}\nIt's injected into every future prompt for this folder.`)
            )
            .catch((e: unknown) =>
              get().addNotice(`/init save failed: ${e instanceof Error ? e.message : e}`, 'error')
            )
        }
      }
      // the reply stopped inside an unclosed code fence — the model ran out
      // mid-code. Nudge it to finish: hidden bubble, capped at 3 per message,
      // Settings → behavior → auto-continue. Only fires for the chat you're
      // still in — a background session never talks behind your back.
      if (
        mine &&
        !wasInit &&
        !steering &&
        get().settings?.autoContinue !== false &&
        unclosedFence(message.content) &&
        get().autoContinuations < 3
      ) {
        set({ autoContinuations: get().autoContinuations + 1 })
        void get().send(
          'Continue exactly where you stopped — resume the code block at the cut and do not repeat anything already written.',
          undefined,
          true
        )
      }
      return
    }

    if (payload.type === 'aborted') {
      pendingInit = false
      pendingTrace = []
      // keep whatever the model managed to say — only this chat's own text,
      // never the visible chat's streamText spilling into another session
      const partial = mine ? get().streamText : ''
      const session = mine ? get().sessions.find((s) => s.id === sid) : null
      if (session && partial) {
        const message: ChatMessage = {
          id: uid(),
          role: 'assistant',
          content: partial + (steering ? '\n\n*(cut off by your next message)*' : '\n\n*(stopped)*'),
          ts: Date.now()
        }
        const updated: Session = { ...session, messages: [...session.messages, message] }
        void api().sessions.save(updated)
        set({ sessions: get().sessions.map((s) => (s.id === updated.id ? updated : s)) })
      }
      endTurn()
      return
    }

    if (payload.type === 'error') {
      pendingInit = false
      pendingTrace = []
      get().addNotice(String(payload.message), 'error')
      endTurn()
      // a dead backend is usually Ollama going away — refresh the sidebar dot
      // and keep watching so it flips back the moment the engine returns
      void api()
        .health.ollama()
        .then((st) => {
          if (st !== get().ollama) set({ ollama: st })
          if (st !== 'online') armOllamaWatch()
        })
        .catch(() => undefined)
    }
  }

  // -- slash commands -------------------------------------------------------
  async function runCommand(name: string, args: string): Promise<void> {
    const s = get()
    const settings = s.settings
    if (!settings) return
    const session = s.sessions.find((x) => x.id === s.activeId) ?? null
    const info = COMMANDS.find((c) => c.name === name)

    const patch = async (p: Partial<Settings>) => s.updateSettings(p)
    const saveSession = async (next: Session) => {
      const saved = await api().sessions.save(next)
      set({ sessions: get().sessions.map((x) => (x.id === saved.id ? saved : x)) })
    }

    switch (name) {
      case '/help':
        s.addNotice(helpText())
        break

      case '/clear':
        if (session) await saveSession({ ...session, messages: [] })
        break

      case '/new':
        await s.newChat(args || null)
        break

      case '/model': {
        const models = s.models
        if (!args) {
          s.addNotice(
            `Active: ${settings.activeModel}\n\n` +
              models.map((m) => `• ${m.id}  — ${m.providerName}`).join('\n')
          )
          break
        }
        const found =
          models.find((m) => m.id === args) ??
          models.find((m) => m.id.includes(args) || m.id.startsWith(args))
        if (!found) {
          s.addNotice(`No model matching "${args}". Try /model to list them.`, 'error')
          break
        }
        await patch({ activeModel: found.id, activeProvider: found.provider })
        s.addNotice(`Model set to ${found.id} (${found.providerName})`)
        break
      }

      case '/provider': {
        const list = ['ollama', ...settings.providers.map((p) => p.id)]
        if (!args) {
          s.addNotice(`Active: ${settings.activeProvider}\n\n${list.map((p) => `• ${p}`).join('\n')}`)
          break
        }
        const [prov, ...rest] = args.split(/\s+/)
        // `/provider nebius <key>` — connect Nebius Token Factory in one line
        if (prov === 'nebius') {
          const key = rest.join(' ').trim()
          const connected = settings.providers.some((p) => p.id === 'nebius')
          if (!key && !connected) {
            s.addNotice(
              'Connect first: /provider nebius <api key> — get one at tokenfactory.nebius.com',
              'error'
            )
            break
          }
          if (key) {
            const preset = PROVIDER_PRESETS.find((p) => p.id === 'nebius')
            const provider: ProviderConfig = {
              id: 'nebius',
              name: preset?.name ?? 'Nebius Token Factory',
              baseUrl: preset?.baseUrl ?? 'https://api.tokenfactory.nebius.com/v1',
              apiKey: key
            }
            await patch({
              providers: [...settings.providers.filter((p) => p.id !== 'nebius'), provider],
              activeProvider: 'nebius',
              activeModel: preset?.defaultModel ?? settings.activeModel
            })
            s.addNotice(
              `Connected ${provider.name} · model → ${preset?.defaultModel ?? settings.activeModel}\n` +
                'NVIDIA Nemotron, DeepSeek, Qwen… — /model lists everything'
            )
            break
          }
        }
        if (!list.includes(prov)) {
          s.addNotice(`Unknown provider "${prov}". Available: ${list.join(', ')}`, 'error')
          break
        }
        await patch({ activeProvider: prov })
        s.addNotice(`Provider set to ${prov}`)
        break
      }

      case '/effort':
        if (!args) s.addNotice(`Effort: ${settings.effort}`)
        else if (isEffort(args)) {
          await patch({ effort: args })
          s.addNotice(`Effort set to ${args}`)
        } else s.addNotice('Usage: /effort <light|medium|deep>', 'error')
        break

      case '/mode':
        if (!args)
          s.addNotice(
            `Mode: ${settings.mode ?? 'build'}\n\n` +
              'plan  — the model only plans, never writes files\n' +
              'build — the model proposes edits, you accept or decline them\n' +
              'auto  — edits are applied automatically (backed up, /undo reverts)'
          )
        else if (args === 'plan' || args === 'build' || args === 'auto') {
          await patch({ mode: args })
          s.addNotice(`Mode set to ${args}`)
        } else s.addNotice('Usage: /mode <plan|build|auto>', 'error')
        break

      case '/theme':
        if (!args) s.addNotice(`Theme: ${settings.theme}`)
        else if (isTheme(args)) {
          await patch({ theme: args })
          s.addNotice(`Theme set to ${args}`)
        } else
          s.addNotice(
            'Usage: /theme <dark|light|acrylic|midnight|ember|mint|slate>\n' +
              'dark/light/acrylic = app surfaces · midnight/ember/mint/slate = accent palettes (shared with the terminal)'
          )
        break

      case '/goal':
        if (!session) {
          s.addNotice('Start a chat first.', 'error')
          break
        }
        if (!args || args === 'show') s.addNotice(session.goal ? `Goal: ${session.goal}` : 'No goal set.')
        else if (args === 'clear') await saveSession({ ...session, goal: undefined })
        else await saveSession({ ...session, goal: args })
        break

      case '/btw':
        if (!session) {
          s.addNotice('Start a chat first.', 'error')
          break
        }
        if (!args || args === 'show')
          s.addNotice(
            session.notes?.length ? session.notes.map((n, i) => `${i + 1}. ${n}`).join('\n') : 'No notes yet.'
          )
        else if (args === 'clear') await saveSession({ ...session, notes: [] })
        else {
          await saveSession({ ...session, notes: [...(session.notes ?? []), args] })
          s.addNotice('Note added — it will be in context for every future message.')
        }
        break

      case '/compact':
        if (!session || session.messages.length <= 4) {
          s.addNotice('Nothing to compact yet.')
          break
        }
        await saveSession({ ...session, messages: session.messages.slice(-6) })
        s.addNotice('History compacted — kept the 6 most recent messages.')
        break

      case '/learn':
        if (!args) s.addNotice(`Learning is ${settings.learn ? 'ON' : 'OFF'}`)
        else if (args === 'on' || args === 'off') {
          await patch({ learn: args === 'on' })
          s.addNotice(`Learning ${args === 'on' ? 'enabled' : 'disabled'}`)
        } else s.addNotice('Usage: /learn <on|off>', 'error')
        break

      case '/remember': {
        const fact = args.trim()
        if (!fact) {
          s.addNotice('Usage: /remember <fact>', 'error')
          break
        }
        const existing = await api().memory.read()
        if (existing.toLowerCase().includes(fact.toLowerCase().slice(0, 60))) {
          s.addNotice('Already in memory.')
          break
        }
        const line = `- ${fact}`
        const next = existing.trim()
          ? existing.replace(/\s*$/, '\n') + line + '\n'
          : `# What CODEZY knows about you\n\n${line}\n`
        await api().memory.write(next)
        s.addNotice(`Remembered: ${fact}`)
        break
      }

      case '/memory':
        if (args === 'clear') {
          await api().memory.write('')
          s.addNotice('Memory cleared.')
        } else {
          const content = await api().memory.read()
          s.addNotice(content.trim() || '(memory is empty — CODEZY hasn\'t learned anything yet)')
        }
        break

      case '/drive':
        if (args === 'off') {
          await patch({ driveFolder: null })
          s.addNotice('Drive mirror turned off. Sessions stay local.')
        } else if (args === 'pick' || !args) {
          const folder = await api().dialog.pickFolder('Choose Google Drive folder')
          if (folder) {
            await patch({ driveFolder: folder })
            s.addNotice(`Sessions will be mirrored to:\n${folder}`)
          }
        } else {
          await patch({ driveFolder: args })
          s.addNotice(`Sessions will be mirrored to:\n${args}`)
        }
        set({ drive: await api().health.drive() })
        break

      case '/copy': {
        let text = args.trim()
        const explicit = !!text
        if (!text) {
          const msgs = session?.messages ?? []
          const last = [...msgs].reverse().find((m) => m.role === 'assistant')
          text = last ? stripEditBlocks(last.content).trim() : ''
          if (!text) {
            s.addNotice('Nothing to copy yet — no assistant reply in this chat.', 'error')
            break
          }
        }
        try {
          await navigator.clipboard.writeText(text)
          s.addNotice(
            explicit
              ? `Copied ${text.length} chars to the clipboard.`
              : 'Copied the last reply to the clipboard.'
          )
        } catch {
          s.addNotice('Clipboard copy failed — click the window first, then try again.', 'error')
        }
        break
      }

      case '/diff': {
        if (!session) {
          s.addNotice('Start a chat first.', 'error')
          break
        }
        const res = await api().git.diff(session.id, args.trim() || undefined)
        if (!res.ok) {
          s.addNotice(res.error ?? 'Not a git repository.', 'error')
          break
        }
        if (!res.files.length) {
          s.addNotice(`Working tree clean — nothing to diff. (${res.folder})`)
          break
        }
        const head = `${res.files.length} changed file${res.files.length === 1 ? '' : 's'} vs HEAD${
          res.branch ? ` · ${res.branch}` : ''
        } — ${res.folder}`
        const lines = [head]
        if (res.stat) lines.push(res.stat)
        else {
          // fresh repo without commits (or untracked only) — the status IS the diff
          lines.push(...res.files.slice(0, 40))
          if (res.files.length > 40) lines.push(`… ${res.files.length - 40} more`)
        }
        const untracked = res.files.filter((f) => f.startsWith('??')).length
        if (untracked && res.stat) lines.push(`+ ${untracked} untracked (not in diff)`)
        if (res.body) {
          const body = res.body.split('\n')
          const MAX = 80
          lines.push(...(body.length > MAX ? body.slice(0, MAX) : body))
          if (body.length > MAX)
            lines.push(`… diff truncated at ${MAX} lines — /diff <path> narrows it down`)
        }
        s.addNotice(lines.join('\n'))
        break
      }

      case '/usage':
        // opens the stats dashboard (Overview / Models, heatmap, streaks)
        set({ usageOpen: true })
        break

      case '/undo': {
        if (!session) {
          s.addNotice('Start a chat first.', 'error')
          break
        }
        const res = await api().edits.undo(session.id)
        s.addNotice(res.message)
        break
      }

      case '/export': {
        if (!session) break
        await get().exportSession(session.id)
        break
      }

      case '/skill': {
        if (!session) {
          s.addNotice('Start a chat first.', 'error')
          break
        }
        const names = await api().skills.list()
        if (!args) {
          const rows = names.length
            ? names.map((n) => `• ${n}${session.skill === n ? '  ← active' : ''}`).join('\n')
            : 'none found — drop .md playbooks into the skills folder'
          s.addNotice(
            `${session.skill ? `Active skill: ${session.skill}` : 'No skill active.'}\n\n` +
              `Available skills:\n${rows}\n\n/skill <name> activates · /skill off`
          )
          break
        }
        if (args === 'off') {
          await saveSession({ ...session, skill: null })
          s.addNotice('Skill deactivated — back to plain CODEZY.')
          break
        }
        const name = names.find((n) => n.toLowerCase() === args.toLowerCase())
        if (!name) {
          s.addNotice(`No skill named "${args}". Type /skill to list them.`, 'error')
          break
        }
        await saveSession({ ...session, skill: name })
        s.addNotice(`Skill "${name}" is active for this chat — its playbook rides along in every prompt.`)
        break
      }

      case '/review': {
        if (!session) {
          s.addNotice('Start a chat first.', 'error')
          break
        }
        if (get().streaming) {
          s.addNotice('Wait for the current reply to finish first.', 'error')
          break
        }
        const resolved = new Set(session.resolvedEdits ?? [])
        const pending = session.messages.filter(
          (m) => m.role === 'assistant' && parseEdits(m.content).length > 0 && !resolved.has(m.id)
        )
        if (!pending.length) {
          s.addNotice('Nothing pending to review — every edit bar is resolved. Ask for new edits first.')
          break
        }
        const blocks = pending.map((m) => m.content).join('\n\n')
        const prompt =
          `Review these pending file edits like a senior code reviewer before anything gets written to disk.\n` +
          `Go file by file: correctness, edge cases, security, clarity. Be specific and blunt.\n` +
          `Finish with a verdict line: APPROVE or FIX NEEDED, then the must-fix list.\n` +
          `Reply in prose only — do NOT output ===FILE or ===SEARCH blocks.\n\n` +
          blocks
        // hidden: the long request goes to the model but never draws a bubble
        await s.send(prompt, undefined, true)
        break
      }

      case '/search': {
        if (!args) {
          s.addNotice('Usage: /search <what you want to find on the web>')
          break
        }
        try {
          const hits = await api().search.query(args)
          if (!hits.length) {
            s.addNotice(`No results for "${args}" — try different words.`)
            break
          }
          s.addNotice(
            `${hits.length} result${hits.length === 1 ? '' : 's'} for "${args}":\n\n` +
              hits
                .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
                .join('\n\n')
          )
        } catch (e) {
          s.addNotice(`Search failed: ${e instanceof Error ? e.message : e}`, 'error')
        }
        break
      }

      case '/init': {
        if (!session) {
          s.addNotice('Start a chat first.', 'error')
          break
        }
        if (get().streaming) {
          s.addNotice('Wait for the current reply to finish first.', 'error')
          break
        }
        const prep = await api().init.prepare(session.id)
        if (!prep) {
          s.addNotice('Link a folder to this chat first (📁) — /init describes that project.', 'error')
          break
        }
        const prompt =
          `Generate a project context file for AI assistants working in this folder.\n\n` +
          `Folder: ${prep.folder}\n\nFile tree:\n${prep.tree || '(empty folder)'}\n\n` +
          `Write it in Markdown, max 60 lines:\n` +
          `1. What this project is (infer from the names and structure).\n` +
          `2. Layout — what lives where and why.\n` +
          `3. Conventions to follow (naming, style, frameworks detected).\n` +
          `4. Gotchas — build/run steps if discoverable, generated folders to ignore.\n\n` +
          `Output ONLY the raw Markdown content: no code fences, no commentary before or after.`
        pendingInit = true
        // hidden: the request stays out of the bubbles, the reply shows the context
        await s.send(prompt, undefined, true)
        break
      }

      case '/rewind': {
        if (!session || !session.messages.length) {
          s.addNotice('Nothing to rewind — this chat is empty.')
          break
        }
        const total = session.messages.length
        if (!args) {
          const tail = session.messages.slice(-8)
          const start = total - tail.length + 1
          const rows = tail.map((m, i) => {
            const excerpt = m.content.replace(/\s+/g, ' ').trim().slice(0, 58)
            return `${String(start + i).padStart(3)}. ${m.role === 'user' ? 'you   ' : 'CODEZY'}  ${excerpt}`
          })
          s.addNotice(`${total} messages in this chat — /rewind <n> drops that many:\n\n${rows.join('\n')}`)
          break
        }
        const n = Number.parseInt(args, 10)
        if (!Number.isFinite(n) || n < 1 || n > total) {
          s.addNotice(`Usage: /rewind <1..${total}>`, 'error')
          break
        }
        if (get().streaming) {
          s.addNotice('Wait for the current reply to finish first.', 'error')
          break
        }
        await saveSession({ ...session, messages: session.messages.slice(0, total - n) })
        s.addNotice(`Rewound ${n} message${n === 1 ? '' : 's'} — ${total - n} left.`)
        break
      }

      case '/fast': {
        const turningOn = settings.effort !== 'light'
        await patch({ effort: turningOn ? 'light' : 'medium' })
        s.addNotice(turningOn ? 'Fast mode ON — effort light.' : 'Fast mode OFF — effort medium.')
        break
      }

      case '/add-dir': {
        if (!session) {
          s.addNotice('Start a chat first.', 'error')
          break
        }
        if (!args) {
          s.addNotice('Usage: /add-dir <folder path> — links another folder to this chat.', 'error')
          break
        }
        const linked = session.linkedFolders ?? []
        if (linked.includes(args)) {
          s.addNotice(`Already linked: ${args}`)
          break
        }
        await get().linkFolder(args)
        s.addNotice(`Linked folder: ${args}\n\n${linked.length + 1} folder(s) on this chat.`)
        break
      }

      case '/doctor': {
        const ok = (v: boolean) => (v ? '✓' : '✗')
        const provider = settings.activeProvider ?? 'ollama'
        const rows: string[] = []
        rows.push(`${ok(!!settings.activeModel)}  model        ${settings.activeModel}`)
        if (provider === 'ollama') {
          const oll = await api().health.ollama()
          rows.push(
            `${ok(oll === 'online')}  endpoint     ${
              oll === 'online' ? 'Ollama online' : 'Ollama not reachable — start it with: ollama serve'
            }`
          )
        } else {
          const p = (settings.providers ?? []).find((x) => x.id === provider)
          const keyed = !!(p?.apiKey && p?.baseUrl)
          rows.push(`${ok(keyed)}  endpoint     ${keyed ? `${provider} · key set` : `${provider} is missing baseUrl/apiKey in settings`}`)
        }
        const folders = session?.linkedFolders ?? []
        rows.push(
          `${ok(folders.length > 0)}  folder       ${
            folders.length ? folders.join('\n               ') : 'not linked — folder button or /add-dir <folder>'
          }`
        )
        const mem = (await api().memory.read()).trim()
        rows.push(
          `${ok(true)}  memory       ${settings.learn ? (mem ? `on · ${fmtBytes(mem.length)}` : 'on · empty') : 'injection off (/learn on)'}`
        )
        const skills = await api().skills.list()
        rows.push(`  skills       ${skills.length} installed`)
        rows.push(`  effort       ${settings.effort} · theme ${settings.theme ?? 'dark'}`)
        rows.push(`  sessions     ${get().sessions.length}`)
        rows.push('')
        rows.push('first ✗ above is the thing to fix')
        s.addNotice(rows.join('\n'))
        break
      }

      case '/cost': {
        const msgs = session?.messages ?? []
        const users = msgs.filter((m) => m.role === 'user').length
        const bots = msgs.length - users
        const chars = msgs.reduce((n, m) => n + m.content.length, 0)
        const est = Math.max(Math.round(chars / 4), 0)
        const local = (settings.activeProvider ?? 'ollama') === 'ollama'
        const rows = [
          `${settings.activeModel} · ${settings.effort}`,
          '',
          `turns          ${users} user · ${bots} assistant · ${msgs.length} messages`,
          `transcript     ${fmtBytes(chars)} of text — about ${est} tokens`,
          '',
          local
            ? 'cost           local model — no per-call cost'
            : `cost           billed by ${settings.activeProvider} (tokens × their price)`,
          '',
          '/usage opens the full stats dashboard.'
        ]
        s.addNotice(rows.join('\n'))
        break
      }

      default:
        s.addNotice(`${name} is scheduled for ${info ? `phase ${info.phase}` : 'a later phase'}.`)
    }
  }

  return {
    ready: false,
    settings: null,
    projects: [],
    sessions: [],
    activeId: null,
    filterProjectId: null,
    models: [],
    ollama: 'checking',
    drive: { enabled: false, folder: null, healthy: false },
    streaming: false,
    streamingIds: [],
    streamText: '',
    notices: [],
    composerDraft: null,
    chatDrafts: {},
    v2Activity: null,
    v2Ask: null,
    aiWrite: null,
    autoContinuations: 0,
    settingsOpen: false,
    paletteOpen: false,
    shortcutsOpen: false,
    ideOpen: false,
    ideFile: null,
    ideTick: 0,
    sidebarOpen: SIDEBAR_OPEN,
    createProjectOpen: false,
    usageOpen: false,

    async init() {
      if (initialized) return // StrictMode double-mount guard
      initialized = true
      const settings = await api().settings.get()
      applyTheme(settings.theme, settings.accent)
      applyMotion(settings.reduceMotion ?? false)
      const [projects, sessions, models, ollama, drive] = await Promise.all([
        api().projects.list(),
        api().sessions.list(),
        api().models.list(),
        api().health.ollama(),
        api().health.drive()
      ])
      if (!subscribed) {
        api().chat.onEvent(handleEvent)
        subscribed = true
      }
      set({ settings, projects, sessions, models, ollama, drive, ready: true, activeId: sessions[0]?.id ?? null })
      if (ollama !== 'online') armOllamaWatch() // auto-started on launch — poll until it's up
    },

    setActive(id) {
      // the composer's thinking/stop state belongs to the chat you're looking
      // at — switching away from a streaming chat shows a normal composer
      set({
        activeId: id,
        streamText: '',
        notices: [],
        streaming: get().streamingIds.includes(id ?? '')
      })
    },

    setFilter(projectId) {
      set({ filterProjectId: get().filterProjectId === projectId ? null : projectId })
    },

    async newChat(projectId = null) {
      const session = await api().sessions.create(projectId)
      set({ sessions: [session, ...get().sessions], activeId: session.id, notices: [], streamText: '' })
    },

    async removeSession(id) {
      await api().sessions.delete(id)
      const sessions = get().sessions.filter((s) => s.id !== id)
      set({ sessions, activeId: get().activeId === id ? (sessions[0]?.id ?? null) : get().activeId })
    },

    async send(text, files, hidden) {
      const trimmed = text.trim()
      if (!trimmed) return
      if (!hidden) set({ autoContinuations: 0 }) // a human turn resets the budget

      // internal/background sends keep the old rule: never interrupt a reply
      if (hidden && get().streaming) return

      // 1. slash command? → runs right away, even while the model is writing
      const parsed = parseInput(trimmed)
      if (parsed.kind === 'command') {
        await runCommand(parsed.name, parsed.args)
        return
      }

      // 1b. "#fact" → straight into memory, same shortcut as the terminal TUI
      if (parsed.kind === 'remember') {
        await runCommand('/remember', parsed.fact)
        return
      }

      // 2. interject: cut into the running reply — the partial text is kept
      //    as a "(cut off)" message, then this message starts the next turn.
      //    Only when the VISIBLE chat is the one generating — another chat's
      //    turn never hijacks (or blocks) what you're typing here.
      if (get().streamingIds.includes(get().activeId ?? '')) {
        steering = true
        const running = get().activeId
        if (running) await api().chat.abort(running)
        for (let i = 0; i < 80 && get().streaming; i++) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        steering = false
        if (get().streaming) {
          get().addNotice('The reply has not stopped yet — try again in a moment.', 'error')
          return
        }
      }

      // 3. otherwise: make sure a session exists, persist the user message,
      //    then ask the backend to stream a reply
      let sessionId = get().activeId
      let session = get().sessions.find((s) => s.id === sessionId) ?? null
      if (!session) {
        await get().newChat(get().filterProjectId)
        sessionId = get().activeId
        session = get().sessions.find((s) => s.id === sessionId)!
      }

      const message: ChatMessage = {
        id: uid(),
        role: 'user',
        content: trimmed,
        ts: Date.now(),
        files: files?.length ? files : undefined,
        hidden: hidden || undefined
      }
      const updated: Session = {
        ...session,
        messages: [...session.messages, message],
        title: session.messages.length === 0 ? titleFrom(trimmed) : session.title
      }
      const saved = await api().sessions.save(updated)
      set({
        sessions: get().sessions.map((s) => (s.id === saved.id ? saved : s)),
        streaming: true,
        streamingIds: [...new Set([...get().streamingIds, saved.id])],
        streamText: '',
        notices: [],
        usageOpen: false // sending a message closes the in-chat usage window
      })
      await api().chat.send(saved.id)
    },

    async stop() {
      const id = get().activeId
      if (!id || !get().streamingIds.includes(id)) return
      await api().chat.abort(id)
      // the reply may have already died server-side (crash, dropped stream) —
      // a phantom "thinking" must never outlive the stop press
      await new Promise((r) => setTimeout(r, 800))
      const ids = get().streamingIds
      if (ids.includes(id)) {
        const rest = ids.filter((x) => x !== id)
        const patch: Partial<AppState> = { streamingIds: rest, streaming: rest.includes(get().activeId ?? '') }
        if (get().activeId === id) Object.assign(patch, { streamText: '', v2Activity: null, v2Ask: null })
        set(patch)
      }
    },

    setComposerDraft(text) {
      set({ composerDraft: text })
    },
    setChatDraft(id, text) {
      set({ chatDrafts: { ...get().chatDrafts, [id]: text } })
    },

    answerV2(allowed) {
      const ask = get().v2Ask
      set({ v2Ask: null })
      if (ask) void api().chat.v2Decision(ask.askId, allowed)
    },

    async regenerate(messageId) {
      const state = get()
      if (state.streaming) return
      const session = state.sessions.find((x) => x.id === state.activeId)
      if (!session) return
      const idx = session.messages.findIndex((m) => m.id === messageId)
      if (idx < 1) {
        state.addNotice('There is no earlier request to re-ask.', 'error')
        return
      }
      // keep everything BEFORE the reply — the request itself stays in history
      const saved = await api().sessions.save({ ...session, messages: session.messages.slice(0, idx) })
      set({
        sessions: get().sessions.map((x) => (x.id === saved.id ? saved : x)),
        streaming: true,
        streamingIds: [...new Set([...get().streamingIds, saved.id])],
        streamText: '',
        notices: [],
        usageOpen: false
      })
      await api().chat.send(saved.id)
    },

    async editFrom(messageId) {
      const state = get()
      if (state.streaming) return
      const session = state.sessions.find((x) => x.id === state.activeId)
      if (!session) return
      const idx = session.messages.findIndex((m) => m.id === messageId)
      const msg = session.messages[idx]
      if (!msg || msg.role !== 'user') return
      // truncate the conversation at this message, hand its text to the composer
      const saved = await api().sessions.save({ ...session, messages: session.messages.slice(0, idx) })
      set({
        sessions: get().sessions.map((x) => (x.id === saved.id ? saved : x)),
        composerDraft: msg.content
      })
    },

    async branchFrom(messageId) {
      const state = get()
      const src = state.sessions.find((x) => x.id === state.activeId)
      if (!src) return
      const idx = src.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return
      const now = Date.now()
      const copy: Session = {
        ...src,
        id: uid(),
        title: `${src.title} (branch)`,
        createdAt: now,
        updatedAt: now,
        messages: src.messages.slice(0, idx + 1),
        resolvedEdits: [],
        lastUsage: undefined,
        pinned: false
      }
      const saved = await api().sessions.save(copy)
      set({ sessions: [saved, ...get().sessions], activeId: saved.id })
    },

    async togglePin(id) {
      const session = get().sessions.find((x) => x.id === id)
      if (!session) return
      const saved = await api().sessions.save({ ...session, pinned: !session.pinned })
      set({ sessions: get().sessions.map((x) => (x.id === id ? saved : x)) })
    },

    async setSessionGen(id, patch) {
      const session = get().sessions.find((x) => x.id === id)
      if (!session) return
      const next: Session = { ...session }
      if (patch.model !== undefined) next.model = patch.model
      if (patch.provider !== undefined) next.provider = patch.provider
      if (patch.effort !== undefined) next.effort = patch.effort
      const saved = await api().sessions.save(next)
      set({ sessions: get().sessions.map((x) => (x.id === id ? saved : x)) })
    },

    async linkFolder(folder) {
      const session = get().sessions.find((x) => x.id === get().activeId)
      if (!session) return
      const updated: Session = {
        ...session,
        linkedFolders: [...new Set([...(session.linkedFolders ?? []), folder])]
      }
      const saved = await api().sessions.save(updated)
      set({ sessions: get().sessions.map((x) => (x.id === saved.id ? saved : x)) })
    },

    async unlinkFolder(folder) {
      const session = get().sessions.find((x) => x.id === get().activeId)
      if (!session) return
      const updated: Session = {
        ...session,
        linkedFolders: (session.linkedFolders ?? []).filter((f) => f !== folder)
      }
      const saved = await api().sessions.save(updated)
      set({ sessions: get().sessions.map((x) => (x.id === saved.id ? saved : x)) })
    },

    async acceptEdits(messageId) {
      const state = get()
      const session = state.sessions.find((x) => x.id === state.activeId)
      if (!session) {
        state.addNotice('No active chat.', 'error')
        return
      }
      const msg = session.messages.find((m) => m.id === messageId)
      if (!msg) {
        state.addNotice('That message is no longer in this chat.', 'error')
        return
      }
      const edits = parseEdits(msg.content)
      if (!edits.length) {
        state.addNotice('No file edits found in this message.', 'error')
        return
      }

      // no folder linked to THIS chat yet → walk straight into picking one
      if (!session.linkedFolders?.length) {
        const folder = await api().dialog.pickFolder('Link a folder — the edits will be written there')
        if (!folder) {
          state.addNotice('No folder picked — nothing was written.', 'error')
          return
        }
        const linkedSaved = await api().sessions.save({ ...session, linkedFolders: [folder] })
        set({ sessions: get().sessions.map((x) => (x.id === linkedSaved.id ? linkedSaved : x)) })
        state.addNotice(`Folder linked: ${folder}`)
      }

      // re-read: the link above rewrote the session (don't clobber it later)
      const active = get().sessions.find((x) => x.id === session.id) ?? session

      const res = await api().edits.apply(active.id, edits).catch(() => null)
      if (!res) {
        state.addNotice('Accept failed — the write engine did not respond.', 'error')
        return
      }
      if (!res.applied.length) {
        // nothing landed → keep the bar so the user can retry after fixing
        state.addNotice(`Edit failed — nothing was written:\n${res.errors.join('\n')}`, 'error')
        return
      }

      // the writes landed → the cowork editor drops its cursor on the last file
      const lastEdit = edits[edits.length - 1]
      if (lastEdit?.path) set({ aiWrite: { path: lastEdit.path } })

      // mark resolved (hides the bar) only for what actually happened
      const saved = await api().sessions.save({
        ...active,
        resolvedEdits: [...new Set([...(active.resolvedEdits ?? []), messageId])]
      })
      set({ sessions: get().sessions.map((x) => (x.id === saved.id ? saved : x)) })

      const ok =
        `✓ Applied ${res.applied.length} file${res.applied.length === 1 ? '' : 's'}:\n` +
        res.applied.map((a) => a.path).join('\n')
      if (res.errors.length) {
        state.addNotice(`${ok}\n\nFailed:\n${res.errors.join('\n')}\n\nBackup kept — /undo reverts.`, 'error')
      } else {
        // action toast: the ↩ Undo pill stays until clicked (or the next send)
        state.addNotice(`${ok}\n\nBackup kept — /undo reverts.`, 'info', {
          label: 'Undo',
          run: () => get().undoLast()
        })
      }
    },

    async declineEdits(messageId) {
      const state = get()
      const session = state.sessions.find((x) => x.id === state.activeId)
      if (!session) return
      const saved = await api().sessions.save({
        ...session,
        resolvedEdits: [...new Set([...(session.resolvedEdits ?? []), messageId])]
      })
      set({ sessions: get().sessions.map((x) => (x.id === saved.id ? saved : x)) })
      state.addNotice('Edits declined — nothing was written.')
    },

    async updateSettings(patch) {
      const current = get().settings
      if (!current) return
      const next = { ...current, ...patch }
      if (patch.theme || patch.accent) applyTheme(next.theme, next.accent)
      if (patch.reduceMotion !== undefined) applyMotion(next.reduceMotion ?? false)
      // Send ONLY the changed keys — main merges them over the settings on
      // disk, so this renderer's copy can never wipe what the TUI saved.
      // May reject if the acrylic theme swap is rebuilding the window.
      const saved = await api().settings.set(patch).catch(() => next)
      set({ settings: saved })
      try {
        // models first — a drive hiccup must never skip the model refresh
        if (patch.ollamaUrl || patch.providers) set({ models: await api().models.list() })
      } catch {
        /* window mid-recreation — the fresh renderer re-reads everything anyway */
      }
      try {
        set({ drive: await api().health.drive() })
      } catch {
        /* drive status is cosmetic — same reasoning as above */
      }
    },

    async resync() {
      // Re-read what other holders (the TUI, the settings dialog elsewhere)
      // may have changed — settings first (fast), then the model list.
      try {
        set({ settings: await api().settings.get() })
      } catch {
        return
      }
      try {
        set({ models: await api().models.list() })
      } catch {
        /* endpoint timed out — keep the current list */
      }
    },

    addNotice(text, kind = 'info', action) {
      const notice: Notice = { id: uid(), text, kind, action }
      set({ notices: [...get().notices, notice] })
    },

    dismissNotice(id) {
      set({ notices: get().notices.filter((n) => n.id !== id) })
    },

    async undoLast() {
      const state = get()
      const session = state.sessions.find((x) => x.id === state.activeId)
      if (!session) {
        state.addNotice('Start a chat first.', 'error')
        return
      }
      const res = await api().edits.undo(session.id)
      state.addNotice(res.message)
    },

    setSettingsOpen(v) {
      set({ settingsOpen: v })
    },

    setCreateProjectOpen(v) {
      set({ createProjectOpen: v })
    },

    setUsageOpen(v) {
      set({ usageOpen: v })
    },

    setPaletteOpen(v) {
      set({ paletteOpen: v })
    },
    toggleShortcuts() {
      set({ shortcutsOpen: !get().shortcutsOpen })
    },
    toggleIde() {
      set({ ideOpen: !get().ideOpen })
    },
    setIdeFile(f) {
      // identical content → skip, so stray effects don't re-render the tree
      const cur = get().ideFile
      if (cur === f) return
      if (cur && f && cur.path === f.path && cur.content === f.content) return
      set({ ideFile: f })
    },
    bumpIdeTick() {
      set({ ideTick: get().ideTick + 1 })
    },

    toggleSidebar() {
      const v = !get().sidebarOpen
      try {
        localStorage.setItem('codezy.sidebar', v ? '1' : '0')
      } catch {
        /* private mode — stay in memory */
      }
      set({ sidebarOpen: v })
    },

    async renameSession(id, title) {
      const session = get().sessions.find((x) => x.id === id)
      if (!session) return
      const clean = title.trim()
      if (!clean || clean === session.title) return
      const saved = await api().sessions.save({ ...session, title: clean })
      set({ sessions: get().sessions.map((x) => (x.id === id ? saved : x)) })
    },

    async duplicateSession(id) {
      const src = get().sessions.find((x) => x.id === id)
      if (!src) return
      const now = Date.now()
      const saved = await api().sessions.save({
        ...src,
        id: uid(),
        title: `${src.title} copy`,
        createdAt: now,
        updatedAt: now
      })
      set({ sessions: [saved, ...get().sessions], activeId: saved.id })
    },

    async exportSession(id) {
      const state = get()
      const session = state.sessions.find((x) => x.id === id)
      if (!session) return
      const md = [
        `# ${session.title}`,
        '',
        ...session.messages
          .filter((m) => !m.hidden)
          .map(
            (m) => `**${m.role === 'user' ? 'You' : 'CODEZY'}** · ${new Date(m.ts).toLocaleString()}\n\n${m.content}\n`
          )
      ].join('\n')
      const path = await api().dialog.saveText(`${session.title.replace(/[^\w-]+/g, '_')}.md`, md)
      if (path) state.addNotice(`Exported to ${path}`)
    },

    async toggleDrive() {
      const state = get()
      if (state.drive.enabled) {
        // already mirrored → Settings is where it's managed
        state.setSettingsOpen(true)
        return
      }
      const folder = await api().dialog.pickFolder('Choose Google Drive folder')
      if (!folder) return
      await state.updateSettings({ driveFolder: folder })
      set({ drive: await api().health.drive() })
      state.addNotice(`Sessions will be mirrored to:\n${folder}`)
    },

    async addProject(p) {
      const project: Project = {
        id: uid(),
        name: p.name.trim(),
        group: p.group.trim() || 'General',
        rootPath: p.rootPath ?? null,
        context: '',
        createdAt: Date.now()
      }
      const projects = [...get().projects, project]
      await api().projects.save(projects)
      set({ projects })
    },

    async removeProject(id) {
      const projects = get().projects.filter((p) => p.id !== id)
      await api().projects.save(projects)
      set({ projects })
    },

    async reloadProjects() {
      set({ projects: await api().projects.list() })
    }
  }
})

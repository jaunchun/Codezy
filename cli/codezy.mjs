#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CODEZY terminal interface — an opencode / Claude-Code-style TUI on top of
// local Ollama (or any OpenAI-compatible endpoint). Full-screen chat renderer
// with the footer and input pinned to the bottom, markdown replies with
// highlighted code blocks, streaming with Esc to stop, multi-line input
// (shift+enter), web search, skills, usage stats, save/resume, and a real
// file-edit flow (===FILE → confirm → backup → /undo) inside a linked folder.
// Plain Node (no dependencies) — `node cli\codezy.mjs`.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawnSync } from 'node:child_process'

import { EFFORTS, isEffort, contextSizeFor, listOllamaModels, listOpenAIModels, streamChat, fmtSize, pingOllama } from './lib/engine.mjs'
import { wrapPlain, renderMd } from './lib/md.mjs'
import { webSearch } from './lib/search.mjs'
import { fileTree, parseEdits, stripEditBlocks, applyEdits, undoLast } from './lib/edits.mjs'
import { collectUsage, heatLines } from './lib/usage.mjs'

const HOME = path.join(os.homedir(), '.codezy')

function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return fallback
  }
}

// -- settings + folders -------------------------------------------------------

const DEFAULT_SETTINGS = {
  ollamaUrl: 'http://127.0.0.1:11434',
  activeProvider: 'ollama',
  activeModel: 'qwen2.5-coder:7b',
  effort: 'medium',
  mode: 'build',
  providers: [],
  dataDir: '',
  driveFolder: null,
  learn: true
}
let settings = readJson(path.join(HOME, 'settings.json'), DEFAULT_SETTINGS)
// if the app moved its data folder, prefer the settings that live inside it
if (settings.dataDir && settings.dataDir !== HOME) {
  settings = { ...settings, ...readJson(path.join(settings.dataDir, 'settings.json'), {}) }
}
/** What we last read or wrote — keys that differ are THIS session's changes. */
let baseline = { ...settings }

/** The shared settings file the desktop app writes too. */
function settingsFile() {
  return path.join(settings.dataDir && settings.dataDir !== HOME ? settings.dataDir : HOME, 'settings.json')
}
/** Only the keys this TUI actually changed (vs the last read or write). */
function dirtySettings() {
  const dirty = {}
  for (const k of Object.keys(settings)) {
    if (JSON.stringify(settings[k]) !== JSON.stringify(baseline[k])) dirty[k] = settings[k]
  }
  return dirty
}
/** Adopt settings another holder (the desktop app) wrote for keys we never
 *  touched — a provider connected over there shows up here without a restart.
 *  Returns true when anything actually changed. */
function syncSettings() {
  let disk
  try {
    disk = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    return false // no file yet or unreadable — keep what we have
  }
  const dirty = dirtySettings()
  let changed = false
  for (const k of Object.keys(disk)) {
    if (k in dirty) continue
    if (JSON.stringify(settings[k]) === JSON.stringify(disk[k])) continue
    settings[k] = disk[k]
    baseline[k] = disk[k]
    changed = true
  }
  return changed
}
/** Persist to the same shared file the desktop app writes — <dataDir>/
 *  settings.json when the data folder moved, otherwise ~/.codezy/settings.json.
 *  Only OUR changed keys land on top of what's already there: writing the full
 *  in-memory copy would wipe settings another app saved after we started. */
function saveSettings(patch = {}) {
  Object.assign(settings, patch)
  try {
    const file = settingsFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const dirty = dirtySettings()
    fs.writeFileSync(file, JSON.stringify({ ...readJson(file, {}), ...dirty }, null, 2))
    Object.assign(baseline, dirty) // those keys are persisted now
    return true
  } catch (e) {
    notice(`could not save settings: ${e.message}`)
    return false
  }
}
const CONFIG_FILE = path.join(
  settings.dataDir && settings.dataDir !== HOME ? settings.dataDir : HOME,
  'settings.json'
)
const DATA = settings.dataDir || HOME

/** Copy text to the system clipboard — clip.exe / pbcopy / wl-copy|xclip|xsel. */
function copyToClipboard(text) {
  try {
    if (process.platform === 'win32') {
      // a BOM tells clip.exe to treat stdin as UTF-8 (emoji survive)
      const r = spawnSync('clip', [], { input: '\ufeff' + text, timeout: 5000, windowsHide: true })
      return r.status === 0
    }
    if (process.platform === 'darwin') {
      return spawnSync('pbcopy', [], { input: text, timeout: 5000 }).status === 0
    }
    for (const argv of [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']]) {
      try {
        if (spawnSync(argv[0], argv.slice(1), { input: text, timeout: 5000 }).status === 0) return true
      } catch {
        // try the next tool
      }
    }
    return false
  } catch {
    return false
  }
}
const DIRS = {
  sessions: path.join(DATA, 'sessions'),
  skills: path.join(DATA, 'skills'),
  saves: path.join(DATA, 'terminal'),
  backups: path.join(DATA, 'backups', 'terminal'),
  memory: path.join(DATA, 'memory.md')
}

const BASE = `You are CODEZY, running in the user's terminal. Be direct and practical.
Answer in plain markdown; use fenced code blocks with a language tag.
When you propose changing files, output edits in this exact format:

===FILE: relative/path.ext
===SEARCH
exact lines to find (verbatim)
===REPLACE
new lines
===END

Rules for edits: only propose them when this prompt has a "## Linked folders"
section (otherwise there is nowhere to write). Paths are relative to that
folder. For a NEW file put the single word EMPTY as the search content.
Never invent paths. If you are unsure, say so in one sentence.`

// -- session state ------------------------------------------------------------

let history = [] // [{role, content, ts, model?}] — what this terminal said
let notes = [] // /btw background notes (always in context, never a turn)
let activeSkill = null
let pendingEdits = null // skipped proposal — /review, /apply work on it
let pendingFrom = null // the assistant message that proposed pendingEdits
const resolvedMsgs = new Set() // proposals already accepted/declined
let effort = isEffort(settings.effort) ? settings.effort : 'medium'
let mode = ['plan', 'build', 'auto'].includes(settings.mode) ? settings.mode : 'build'
let linkFolder = process.cwd() // the folder the model may read and edit
let currentSaveId = null // terminal save loaded now (avoids double counting)
let loadedAppId = null // app session loaded now (same)
let ctxPct = 0 // of the last built prompt, shown in the status line
let lastSystem = ''
let lastStats = null // {prompt, completion, ts} of the latest generation
let abortCtl = null // AbortController while streaming — Esc aborts it
let pasting = false // inside a bracketed-paste block

// -- CLI flags (documented in `codezy --help`, dispatched by cli/index.mjs) ----

{
  const argv = process.argv.slice(2)
  const val = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') ? argv[i + 1] : null
  }
  const model = val('model')
  if (model) settings.activeModel = model
  const dir = val('dir') ?? val('root')
  if (dir) linkFolder = path.resolve(dir)
}

// -- styling -----------------------------------------------------------------

const DIM = '\x1b[2m' // dim secondary text
const RED = '\x1b[38;2;255;90;90m'
const GREEN = '\x1b[38;2;120;220;150m'
const YELLOW = '\x1b[38;2;255;200;60m'
/** Small byte sizes, transcript scale (96 B · 12.4 kB · 1.2 MB). */
const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} kB` : `${(b / 1048576).toFixed(1)} MB`)
const RESET = '\x1b[0m'

// Palette themes — /theme swaps the accent + band colors together (semantic
// colors above stay put). #hex / RGB → truecolor escapes via applyTheme(),
// which runs before the splash prints and again on every theme change.
const THEMES = {
  midnight: { accent: '#3d9bff', band: [42, 42, 50], fg: [232, 232, 238] },
  ember: { accent: '#ff8a3d', band: [48, 38, 34], fg: [240, 232, 226] },
  mint: { accent: '#3ddc97', band: [30, 46, 42], fg: [228, 240, 236] },
  slate: { accent: '#a8b3cf', band: [38, 40, 47], fg: [230, 232, 238] }
}
const isTheme = (t) => !!t && Object.hasOwn(THEMES, t)
let ACCENT = ''
let BAND_BG = ''
let BAND_FG = ''
function applyTheme(name) {
  const t = THEMES[name] ?? THEMES.midnight
  const ch = [1, 3, 5].map((i) => parseInt(t.accent.slice(i, i + 2), 16)).join(';')
  ACCENT = `\x1b[38;2;${ch}m`
  BAND_BG = `\x1b[48;2;${t.band.join(';')}m`
  BAND_FG = `\x1b[38;2;${t.fg.join(';')}m`
}
applyTheme(isTheme(settings.theme) ? settings.theme : 'midnight')

// CODEZY_TTY=1 forces the interactive path when stdout is a pipe — lets the
// renderer be tested headlessly (piped regression still runs without it)
const TTY = !!process.stdout.isTTY || !!process.env.CODEZY_TTY

// full window width — nothing is capped, so rules/cards/bands always span
// edge to edge of whatever size the terminal is
const width = () => process.stdout.columns || 80
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

// Shaded input band: full-width dark row with an accent edge (opencode-style).
// Used for the splash input box, chat bubbles and every prompt row — defined
// up here because the splash prints one before the input section loads.
// BAND_BG / BAND_FG are set by applyTheme() above.
const PLACEHOLDER = `${DIM}Ask anything... "explain this function"${RESET}`
const cols = () => process.stdout.columns || 80
const center = (s) => ' '.repeat(Math.max(Math.floor((cols() - plain(s).length) / 2), 0)) + s
/** cursorCol 0 = finalized (no cursor); >0 parks the cursor at that column. */
function band(content, cursorCol) {
  const used = 2 + plain(content).length // edge + space + text
  const pad = Math.max(cols() - used - 1, 0)
  return (
    `${BAND_BG}${ACCENT}▌${BAND_FG} ${content}${' '.repeat(pad)}${RESET}` +
    (cursorCol ? `\x1b[${cursorCol}G` : '')
  )
}

// Block wordmark for the start screen; the plain name is the fallback on
// narrow or short terminals where the banner would wrap or scroll away.
const GLYPHS = {
  C: [' ██████', '██     ', '██     ', '██     ', '██     ', ' ██████'],
  O: [' █████ ', '██   ██', '██   ██', '██   ██', '██   ██', ' █████ '],
  D: ['███████', '██   ██', '██   ██', '██   ██', '██   ██', '███████'],
  E: ['██████', '██    ', '████  ', '██    ', '██    ', '██████'],
  Z: ['███████', '     ██', '    ██ ', '   ██  ', '  ██   ', '███████'],
  Y: ['██  ██', '██  ██', ' ████ ', '  ██  ', '  ██  ', '  ██  ']
}
const WORDMARK = Array.from({ length: 6 }, (_, r) =>
  'CODEZY'.split('').map((ch) => GLYPHS[ch][r]).join(' ')
)
const TITLE = cols() >= 50 && (process.stdout.rows || 24) >= 20 ? WORDMARK.join('\n') : 'CODEZY'

/** Bordered card, opencode-style. rows: [{ text, color }] — text is padded
 *  before coloring so the box edge never drifts. */
function card(title, rows) {
  const inner = Math.max(width() - 2, 46)
  const dashes = Math.max(inner - plain(title).length - 5, 3)
  const out = [`${DIM}╭─${RESET} ${ACCENT}${title}${RESET} ${DIM}${'─'.repeat(dashes)}╮${RESET}`]
  for (const { text, color = '' } of rows) {
    const t = text.slice(0, inner - 4).padEnd(inner - 4)
    out.push(`${DIM}│${RESET} ${color}${t}${RESET} ${DIM}│${RESET}`)
  }
  out.push(`${DIM}╰${'─'.repeat(Math.max(inner - 2, 3))}╯${RESET}`)
  return out.join('\n')
}

/** Current git branch of the linked folder (cwd when unlinked), cached for 5s
 *  so the status bar can ask on every frame without spawning git each time. */
let gitCache = { key: '', val: '', at: 0 }
function gitBranch(dir) {
  const now = Date.now()
  if (gitCache.key === dir && now - gitCache.at < 5000) return gitCache.val
  let val = ''
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true
    })
    if (r.status === 0) val = r.stdout.trim()
  } catch {
    // git missing or dir gone — no branch shown
  }
  gitCache = { key: dir, val, at: now }
  return val
}

/** Bottom status bar: shortcuts on the left, `model · effort · N msgs · ctx %`
 *  on the right — segments drop off (model first) until the line fits. */
function statusLine() {
  const left = overlay
    ? `${DIM}↑↓ select · enter accept · esc close${RESET}`
    : vimOn && chatMode
      ? (vimMode === 'n'
          ? `${YELLOW}-- NORMAL --`
          : `${ACCENT}-- INSERT --`) + `${RESET}${DIM} · /help · ctrl+c exit${RESET}`
      : `${DIM}/help · ctrl+c exit${RESET}`
  const leftLen = plain(left).length
  const msg = `${history.length} msgs`
  const ctx = `ctx ${ctxPct}%`
  const opts = [
    { p: ctx, c: `${DIM}${ctx}${RESET}` },
    { p: `${msg} · ${ctx}`, c: `${DIM}${msg} · ${ctx}${RESET}` },
    { p: `${effort} · ${msg} · ${ctx}`, c: `${DIM}${YELLOW}${effort}${RESET}${DIM} · ${msg} · ${ctx}${RESET}` },
    {
      p: `${settings.activeModel} · ${effort} · ${msg} · ${ctx}`,
      c: `${ACCENT}${settings.activeModel}${RESET}${DIM} · ${YELLOW}${effort}${RESET}${DIM} · ${msg} · ${ctx}${RESET}`
    }
  ]
  const br = gitBranch(linkFolder || process.cwd())
  if (br) {
    opts.push({
      p: `${br} · ${settings.activeModel} · ${effort} · ${msg} · ${ctx}`,
      c:
        `${ACCENT}${br}${RESET}${DIM} · ${ACCENT}${settings.activeModel}${RESET}${DIM} · ` +
        `${YELLOW}${effort}${RESET}${DIM} · ${msg} · ${ctx}${RESET}`
    })
  }
  let pick = opts[0]
  for (const o of opts) if (leftLen + o.p.length + 4 <= width()) pick = o
  const pad = Math.max(width() - leftLen - pick.p.length - 1, 2)
  return `${left}${' '.repeat(pad)}${pick.c}`
}

/** Thinking spinner (piped mode only — the renderer draws its own line). */
function startSpinner() {
  if (!TTY) return () => {}
  const frames = ['✳', '✸', '✶', '✻']
  let i = 0
  const draw = () =>
    process.stdout.write(`\r\x1b[2K${ACCENT}${frames[i++ % frames.length]}${RESET} ${DIM}thinking…${RESET}`)
  draw()
  const id = setInterval(draw, 140)
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(id)
    process.stdout.write('\r\x1b[2K')
  }
}

// -- prompt assembly ----------------------------------------------------------

/** System prompt: base → plan note → memory → skill → notes → linked folder. */
function buildSystem(includeFolders = true) {
  const sections = [BASE]
  if (mode === 'plan') {
    sections.push(
      '## Mode: PLAN\nYou are in PLAN mode. Do NOT output ===FILE edit blocks. Explain the approach as a short numbered plan the user can approve — writing happens only after mode is build or auto.'
    )
  }
  if (settings.learn !== false) {
    let mem = ''
    try {
      mem = fs.readFileSync(DIRS.memory, 'utf8')
    } catch {
      // no memory file yet
    }
    if (mem.trim()) sections.push(`## What you know about the user\n${mem.trim()}`)
  }
  if (activeSkill) {
    let sk = ''
    try {
      sk = fs.readFileSync(path.join(DIRS.skills, `${activeSkill}.md`), 'utf8')
    } catch {
      // skill file vanished
    }
    if (sk.trim()) sections.push(`## Active skill: ${activeSkill}\n${sk.trim()}`)
  }
  if (notes.length) sections.push(`## Background notes\n${notes.map((n) => `- ${n}`).join('\n')}`)
  if (includeFolders && linkFolder) {
    const tree = fileTree(linkFolder)
    let ctx = ''
    try {
      ctx = fs.readFileSync(path.join(linkFolder, 'CODEZY.md'), 'utf8').trim()
    } catch {
      // no CODEZY.md — /init makes one
    }
    const head = `Folder: ${linkFolder}\n${tree || '(empty or unreadable)'}`
    const block = ctx ? `## Linked folders\n${head}\n\nCODEZY.md (project context):\n${ctx}` : `## Linked folders\n${head}`
    sections.push(block.slice(0, 12000))
  }
  return sections.join('\n\n')
}

/** Ollama or the active OpenAI-compatible provider. */
function chatTarget() {
  if (settings.activeProvider && settings.activeProvider !== 'ollama') {
    const p = (settings.providers || []).find((x) => x.id === settings.activeProvider)
    if (p) return { kind: 'openai', baseUrl: p.baseUrl, apiKey: p.apiKey, model: settings.activeModel, effort }
  }
  return { kind: 'ollama', baseUrl: settings.ollamaUrl, model: settings.activeModel, effort }
}

/** Estimated context use of the last built prompt, in percent. */
function ctxOf(system) {
  const chars = system.length + history.reduce((n, m) => n + String(m.content).length, 0)
  return Math.min(99, Math.max(0, Math.round((chars / 4 / contextSizeFor(effort)) * 100)))
}

function refreshCtx() {
  lastSystem = buildSystem()
  ctxPct = ctxOf(lastSystem)
}

/**
 * History → messages, trimmed from the oldest end until it fits the budget
 * (port of prompt.ts): oversized messages are shrunk head+tail, never dropped
 * whole — otherwise the oldest message (usually the attached code) vanishes.
 */
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i
const IMG_MAX = 24 * 1024 * 1024 // base64 bloat is handled by the API, cap file size

/** Real image-file paths mentioned in a message — drag-dropped, pasted as a
 *  path, or typed. Plain words that end in .png don't exist → skipped. */
function imagePathsIn(text) {
  const out = []
  const seen = new Set()
  const re = /"([^"\n]+)"|'([^'\n]+)'|([^\s"']+)/g
  let m
  while ((m = re.exec(text))) {
    const tok = m[1] ?? m[2] ?? m[3]
    if (!tok) continue
    // Quoted tokens are taken as-is. A bare token may be only the FIRST WORD
    // of an unquoted path that contains spaces (drag-dropped from a folder
    // like "My Projects/logo.png") — walk forward across the following words
    // until one resolves to a real image file, longest candidate first.
    const candidates = [tok]
    if (!m[1] && !m[2]) {
      let acc = tok
      let tail = re.lastIndex
      for (let k = 1; k <= 6; k++) {
        const next = /^\s+(\S+)/.exec(text.slice(tail))
        if (!next) break
        acc += ` ${next[1]}` // one more word of the unquoted path
        tail += next[0].length
        candidates.push(acc)
      }
    }
    for (const cand of candidates) {
      if (!IMG_EXT.test(cand)) continue // extension sits on the LAST word
      const abs = path.resolve(cand)
      if (seen.has(abs)) continue
      try {
        const st = fs.statSync(abs)
        if (st.isFile() && st.size > 0 && st.size <= IMG_MAX) {
          seen.add(abs)
          out.push(abs)
          break // this token resolved — don't try longer candidates
        }
      } catch {
        // not a real file — try the next (longer) candidate
      }
    }
    if (out.length >= 6) break
  }
  return out
}

function buildMessages(system) {
  const numCtx = contextSizeFor(effort)
  let budget = numCtx * 4 - system.length
  const perMsgCap = Math.max(1500, Math.floor(numCtx * 4 * 0.35))
  const kept = []
  for (const raw of [...history].reverse()) {
    let content = String(raw.content)
    if (content.length > perMsgCap) {
      const head = Math.floor(perMsgCap * 0.7)
      content = content.slice(0, head) + '\n…[truncated for context window]…\n' + content.slice(-(perMsgCap - head))
    }
    const size = content.length + 64
    if (size > budget) break
    budget -= size
    const msg = { role: raw.role, content }
    if (raw.role === 'user' && raw.images?.length) {
      // files are read fresh at send time — saves store paths, never base64
      const b64 = []
      for (const p of raw.images) {
        try {
          if (fs.statSync(p).size <= IMG_MAX) b64.push(fs.readFileSync(p).toString('base64'))
        } catch {
          // vanished or unreadable — send the text without it
        }
      }
      if (b64.length) msg.images = b64
    }
    kept.push(msg)
  }
  kept.reverse()
  return [{ role: 'system', content: system }, ...kept]
}

/** Dim single-line notice, routed through say() (chat screen or console). */
function notice(s) {
  say(`${DIM}  ${s}${RESET}`)
}

/**
 * Auto-compact: near the context limit, summarize the older history into one
 * pair of messages so nothing important is lost to trimming. Esc cancels.
 */
async function maybeCompact(system, force = false) {
  const numCtx = contextSizeFor(effort)
  if (history.length < 6) {
    if (force) notice('nothing to compact yet')
    return
  }
  const chars = system.length + history.reduce((n, m) => n + String(m.content).length, 0)
  if (!force && chars / 4 < numCtx * 0.85) return
  const old = history.slice(0, Math.max(history.length - 4, 1))
  const keep = history.slice(old.length)
  notice(`context ~${Math.round(chars / 4)}/${numCtx} tokens — compacting ${old.length} messages…`)
  try {
    let summary = ''
    const convo = old.map((m) => `${m.role}: ${String(m.content).slice(0, 6000)}`).join('\n\n')
    await streamChat(
      chatTarget(),
      [
        {
          role: 'user',
          content:
            `Summarize this conversation for an AI assistant that will continue it. ` +
            `Keep decisions, file paths, code state and open tasks. Max 15 lines, no preamble.\n\n${convo}`
        }
      ],
      { signal: abortCtl?.signal, onDelta: (t) => (summary += t) }
    )
    if (!summary.trim()) throw new Error('empty summary')
    history = [
      { role: 'user', content: `[earlier conversation, compacted by CODEZY]\n${summary.trim()}`, ts: Date.now() },
      { role: 'assistant', content: 'Understood — continuing from that summary.', ts: Date.now() },
      ...keep
    ]
    notice(`compacted ${old.length} messages → summary · ${history.length} left in context`)
  } catch (e) {
    if (abortCtl?.signal.aborted) throw e // Esc during compact = stop the send
    notice(`compact failed (${e.message}) — dropping the oldest messages instead`)
    history = history.slice(Math.floor(history.length * 0.4))
  }
}

// -- chat --------------------------------------------------------------------

/**
 * One generation. opts.ephemeral = utility calls (/init, /review): the reply
 * is drawn but nothing is added to history. Esc (TTY) aborts and keeps the
 * partial reply.
 */
async function streamReply(userText, opts = {}) {
  const ephemeral = !!opts.ephemeral
  const system = opts.system ?? buildSystem()
  const target = chatTarget()
  const live = TTY && chatMode
  const t0 = Date.now()
  let pushedUser = false
  let attached = 0
  let final = ''
  let stop = () => {}

  abortCtl = new AbortController()
  try {
    if (!ephemeral) {
      await maybeCompact(system)
      const imgs = imagePathsIn(userText)
      history.push({
        role: 'user',
        content: userText,
        ts: Date.now(),
        ...(imgs.length ? { images: imgs } : {})
      })
      attached = imgs.length
      pushedUser = true
    }
    const messages = buildMessages(system)
    lastSystem = system
    ctxPct = ctxOf(system)

    stop = live ? () => {} : startSpinner()
    if (live) {
      if (!ephemeral) {
        const mark = attached ? `\n📷 ${attached} image${attached === 1 ? '' : 's'} attached` : ''
        chat.push({ k: 'msg', t: userText + mark })
      }
      chat.push({ k: 'text', t: '' })
      thinking = true
      animStart()
      render()
    } else if (!TTY && !ephemeral) {
      process.stdout.write('\n')
    }

    let first = true
    const stats = await streamChat(target, messages, {
      signal: abortCtl.signal,
      onDelta: (piece) => {
        final += piece
        if (first) {
          first = false
          if (!live) stop() // pipe: spinner line becomes the reply
        }
        if (live) {
          chat[chat.length - 1].t = stripEditBlocks(final) // blocks never render raw
          renderSoon()
        } else {
          process.stdout.write(piece) // pipe + TTY-start-screen: tokens as they come
        }
      }
    })
    stop()

    if (stats?.promptTokens) lastStats = { prompt: stats.promptTokens, completion: stats.completionTokens, ts: Date.now() }
    if (!ephemeral) history.push({ role: 'assistant', content: final, ts: Date.now(), model: target.model })

    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    const parts = [`${ACCENT}${target.model}${RESET}`, `${secs}s`]
    if (!ephemeral) parts.push(`${history.length} msgs`)
    if (stats?.completionTokens) parts.push(`${stats.completionTokens} tok`)
    const meta = `${DIM}  ${parts.join(`${RESET}${DIM} · `)}${RESET}`

    if (live) {
      thinking = false
      animStop()
      chat[chat.length - 1].t = stripEditBlocks(final)
      chat.push({ k: 'raw', t: `${meta}\n` })
      render()
    } else if (!ephemeral) {
      console.log(`\n${meta}`)
      console.log('')
    } else if (!live) {
      process.stdout.write('\n') // end the reply line (TTY start screen / pipe)
    }

    const edits = ephemeral || mode === 'plan' ? [] : parseEdits(final)
    return { text: final, edits, stopped: false }
  } catch (e) {
    stop()
    const wasAborted = !!abortCtl?.signal.aborted
    thinking = false
    animStop()

    if (wasAborted) {
      if (pushedUser) {
        if (final) history.push({ role: 'assistant', content: final, ts: Date.now(), model: target.model })
        else history.pop() // nothing came back — drop the user turn
      }
      const drawn = live && chat.length && chat[chat.length - 1].k === 'text'
      if (drawn) {
        chat[chat.length - 1].t = stripEditBlocks(final)
        chat.push({ k: 'raw', t: `${YELLOW}  stopped${RESET}\n` })
        render()
      } else if (!live && !ephemeral && final) {
        console.log(`\n${YELLOW}  stopped${RESET}`)
      }
      return { text: final, edits: [], stopped: true }
    }

    if (pushedUser) history.pop()
    const drawn = live && chat.length && chat[chat.length - 1].k === 'text'
    if (drawn) {
      chat.push({ k: 'raw', t: `${RED}  error: ${e.message}${RESET}\n` })
      render()
    } else {
      console.log(`${RED}  error: ${e.message}${RESET}`)
    }
    throw e
  } finally {
    abortCtl = null
  }
}

// -- welcome -----------------------------------------------------------------

// window/tab title (Windows Terminal + modern conhost honor this)
process.stdout.write('\x1b]0;CODEZY terminal\x07')

// -- opencode-style start screen -------------------------------------------
// Block wordmark, a shaded two-row input box under it, keybind hints, a yellow
// tip, and a footer spread across the corners. SPLASH_ABOVE / SPLASH_BELOW are
// the exact line counts around the live box row — SPLASH_TOP and SPLASH_UP are
// derived from them, so growing the banner can never desync the prompt cursor.

let pkg = { version: '0.0.0' }
try {
  pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
} catch {
  // no package.json next to the script — keep the fallback version
}

const home = os.homedir()
const cwd = process.cwd()
const shortCwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd

const hints = `${DIM}↑ history   ctrl+p commands${RESET}`
const tipFull = `${YELLOW}●${RESET} Tip ${DIM}Run /sessions to load one of your app chats as context${RESET}`
const tipShort = `${YELLOW}●${RESET} Tip ${DIM}/sessions loads a saved chat${RESET}`
const tip =
  plain(tipFull).length < cols() - 1 ? tipFull : plain(tipShort).length < cols() - 1 ? tipShort : ''

// corner-spread footer: cwd left, version right — long paths get cut from the
// left so the line can never wrap and desync the splash line counts
const footRoom = Math.max(cols() - pkg.version.length - 3, 8)
const footCwd = shortCwd.length > footRoom ? `…${shortCwd.slice(-(footRoom - 1))}` : shortCwd
const footer =
  `${footCwd}${' '.repeat(Math.max(cols() - footCwd.length - pkg.version.length - 1, 2))}` +
  `${DIM}${pkg.version}${RESET}`

// row 2 of the input box: chat · model · effort [· branch], trimmed so it never wraps
const metaBranch = gitBranch(linkFolder || process.cwd())
const metaFull = metaBranch
  ? `chat · ${settings.activeModel} · ${effort} · ${metaBranch}`
  : `chat · ${settings.activeModel} · ${effort}`
let metaPlain = metaFull
if (metaPlain.length > cols() - 4) metaPlain = `chat · ${settings.activeModel} · ${effort}`
if (metaPlain.length > cols() - 4) metaPlain = `chat · ${settings.activeModel}`
if (metaPlain.length > cols() - 4) metaPlain = `chat · ${settings.activeModel.slice(0, Math.max(cols() - 12, 6))}…`
const metaContent =
  metaPlain === metaFull
    ? metaBranch
      ? `${ACCENT}chat${RESET} · ${settings.activeModel} · ${YELLOW}${effort}${RESET} · ${ACCENT}${metaBranch}${RESET}`
      : `${ACCENT}chat${RESET} · ${settings.activeModel} · ${YELLOW}${effort}${RESET}`
    : `${ACCENT}chat${RESET}${metaPlain.slice(4)}`

const SPLASH_ABOVE = ['', ...TITLE.split('\n'), '', '']
const SPLASH_BELOW = [
  band(metaContent, 0),
  '',
  `${' '.repeat(Math.max(cols() - plain(hints).length - 1, 0))}${hints}`,
  '',
  tip ? center(tip) : '',
  '',
  footer,
  ''
]

for (const l of SPLASH_ABOVE) console.log(l ? center(`${ACCENT}${l.trimEnd()}${RESET}`) : '')
console.log(band(PLACEHOLDER, plain(PLACEHOLDER).length + 3))
for (const l of SPLASH_BELOW) console.log(l)

// -- input -------------------------------------------------------------------
// Real terminals get an opencode-style input box: a shaded band with an accent
// ▌ edge + typed text, with the placeholder showing while the line is empty
// placeholder showing while the line is empty (backspace edits, up/down walks
// history, shift+enter adds a line, ctrl+c wipes or exits, esc stops a
// streaming reply). Piped input keeps the readline path.

const lineQueue = []
const waiters = []
let stdinClosed = false
let dsrWait = null // pending cursor-position report (\x1b[6n) reader
let rl = null
let rawBuf = ''
let rawCol = 0 // cursor offset within rawBuf — arrows, home/end, vim motions
let rawHist = []
let rawIdx = 0
// vim mode (/vim on): esc → normal, i/a/o → insert. The count prefix (3w, 2x)
// and the pending operator (d…) live only between two normal-mode keys.
let vimOn = settings.vim === true
let vimMode = 'i' // starts in insert so typing works the moment you enable it
let vimCount = ''
let vimOp = ''
let lastEscTs = 0 // first esc stamps the time — a second one opens /rewind
let picked = [] // (unused legacy slot — /sessions fills pickedApp/pickedTerm)
let pickedApp = []
let pickedTerm = []

/** Replace the input wholesale — the cursor always lands at the end. */
function setBuf(t) {
  rawBuf = t
  rawCol = t.length
}
/** Insert text at the cursor (typing, paste, shift+enter). */
function insertBuf(t) {
  rawBuf = rawBuf.slice(0, rawCol) + t + rawBuf.slice(rawCol)
  rawCol += t.length
}
/** Backspace: delete the char before the cursor. */
function delBack() {
  if (rawCol > 0) {
    rawBuf = rawBuf.slice(0, rawCol - 1) + rawBuf.slice(rawCol)
    rawCol--
  }
}
/** Delete the char at the cursor (vim x, the Del key). */
function delAt() {
  if (rawCol < rawBuf.length) rawBuf = rawBuf.slice(0, rawCol) + rawBuf.slice(rawCol + 1)
}
function moveCol(d) {
  rawCol = Math.max(0, Math.min(rawBuf.length, rawCol + d))
}
/** Offset of the current line's start / end (the \n itself belongs to neither). */
function lineStart(off = rawCol) {
  return rawBuf.lastIndexOf('\n', Math.max(off - 1, -1)) + 1
}
function lineEnd(off = rawCol) {
  const i = rawBuf.indexOf('\n', off)
  return i === -1 ? rawBuf.length : i
}
/** Word motions over [\w]+ runs — newlines count as separators. */
function wordFwd(from) {
  let i = from
  const n = rawBuf.length
  if (i >= n) return n
  if (/[\w]/.test(rawBuf[i] ?? '')) while (i < n && /[\w]/.test(rawBuf[i])) i++
  while (i < n && !/[\w]/.test(rawBuf[i])) i++
  return i
}
function wordBack(from) {
  let i = from
  while (i > 0 && !/[\w]/.test(rawBuf[i - 1])) i--
  while (i > 0 && /[\w]/.test(rawBuf[i - 1])) i--
  return i
}

// The preview box printed under the wordmark IS the first input: it sits
// SPLASH_UP lines above the cursor (meta row, hints, tip, footer, blanks).
// After the first submit the splash ends and prompts appear at the cursor.
// Both counts come from the printed line arrays, so they always agree.
const SPLASH_UP = SPLASH_BELOW.length + 1
const SPLASH_TOP = SPLASH_ABOVE.length
let splashLive = TTY

// -- chat screen renderer ----------------------------------------------------
// After the first send the whole viewport is redrawn from `chat`: messages
// fill from the top and the footer + input band stay pinned to the bottom
// rows, so the conversation uses the whole window like opencode. The input
// may span several rows (shift+enter) — everything above shifts up with it.

let chat = [] // [{ k: 'msg' | 'text' | 'raw', t }]
let chatMode = false
let thinking = false
let animFrame = 0
let animTimer = null
let renderTimer = null
// -- overlay (ctrl+p commands · ctrl+r history · @file suggestions) ----------
// The overlay shares the input line as its filter box: whatever you type is
// the query, ↑/↓ move the selection, enter/tab accept, esc closes. In chat
// mode render() stacks its rows directly above the input band; on the splash
// screen they replace the meta/hint/tip/footer block below the box, which is
// restored when the overlay closes. The drawBox invariant: the cursor always
// ends on the box's input row (palette or not).

let overlay = null // { kind: 'cmds' | 'hist' | 'files', sel, top }
let palShown = false // a palette is currently printed below the splash box
let footRowsShown = 1 // overlay + input rows last drawn (chat mode)
let filesCache = null // { dir, list } of the linked folder's files

const atToken = () => {
  const m = rawBuf.match(/(?:^|\s)@([\w./\\-]*)$/)
  return m ? { text: m[1], start: rawBuf.length - m[0].length + (m[0][0] === ' ' ? 1 : 0) } : null
}

/** Linked folder's files (bounded walk, cached until the folder changes). */
function fileList() {
  if (!linkFolder) return []
  if (filesCache?.dir === linkFolder) return filesCache.list
  const out = []
  const skip = new Set(['node_modules', '.git', 'out', 'dist', '.next', 'build', '__pycache__', 'vendor'])
  const walk = (dir, rel, depth) => {
    if (depth > 6 || out.length >= 4000) return
    let ents = []
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (out.length >= 4000) break
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), r, depth + 1)
      } else if (e.isFile()) out.push(r)
    }
  }
  walk(linkFolder, '', 0)
  filesCache = { dir: linkFolder, list: out }
  return out
}

/** Current selection items for the open overlay (query = the input line). */
function overlayItems() {
  if (!overlay) return []
  if (overlay.kind === 'cmds') {
    const q = rawBuf.replace(/^\//, '').toLowerCase()
    return COMMANDS.filter((x) => !q || x.c.slice(1).includes(q) || x.d.toLowerCase().includes(q)).map((x) => ({
      label: x.c,
      hint: x.d,
      value: x.c + (/^[<[]/.test(x.d) ? ' ' : '')
    }))
  }
  if (overlay.kind === 'hist') {
    const q = rawBuf.toLowerCase()
    const seen = new Set()
    const out = []
    for (let i = rawHist.length - 1; i >= 0 && out.length < 60; i--) {
      const h = rawHist[i]
      if (seen.has(h)) continue
      seen.add(h)
      if (!q || h.toLowerCase().includes(q)) out.push({ label: h.replace(/\n/g, ' ⏎ '), hint: '', value: h })
    }
    return out
  }
  if (overlay.kind === 'pick') {
    const q = rawBuf.toLowerCase()
    return (overlay.items ?? []).filter(
      (x) => !q || x.label.toLowerCase().includes(q) || (x.hint ?? '').toLowerCase().includes(q)
    )
  }
  if (overlay.kind === 'value') return [] // the typed value lives in the input box
  const tok = atToken()
  if (!tok) return []
  const q = tok.text.toLowerCase()
  return fileList()
    .filter((p) => p.toLowerCase().includes(q))
    .slice(0, 60)
    .map((p) => ({ label: p, hint: '', value: `${rawBuf.slice(0, tok.start)}@${p} ` }))
}

/** Styled rows for the open overlay (selection window kept on screen). */
function overlayRows() {
  if (!overlay) return []
  const items = overlayItems()
  const cap = Math.max(Math.min(8, (process.stdout.rows || 24) - 10), 3)
  overlay.sel = items.length ? Math.min(Math.max(overlay.sel, 0), items.length - 1) : -1
  if (overlay.sel >= 0) {
    if (overlay.sel < overlay.top) overlay.top = overlay.sel
    if (overlay.sel >= overlay.top + cap) overlay.top = overlay.sel - cap + 1
  }
  const isPrompt = overlay.kind === 'pick' || overlay.kind === 'value'
  const name = isPrompt
    ? overlay.title ?? overlay.kind
    : { cmds: 'commands', hist: 'history', files: '@files' }[overlay.kind]
  const verbs = {
    cmds: '↑↓ move · enter accept · esc close',
    hist: '↑↓ move · enter accept · esc close',
    files: '↑↓ move · tab accept · esc close',
    pick: 'type to filter · ↑↓ move · enter select · esc cancel',
    value: 'type the value · enter ok · esc cancel'
  }
  const rows = [`${DIM}─ ${name} · ${verbs[overlay.kind]}${RESET}`]
  if (!items.length && overlay.kind !== 'value') rows.push(`${DIM}  (no matches)${RESET}`)
  items.slice(overlay.top, overlay.top + cap).forEach((it, i) => {
    const on = overlay.top + i === overlay.sel
    let label = it.label
    const hint = it.hint ? `  ${it.hint}` : ''
    const room = Math.max(cols() - plain(label).length - plain(hint).length - 6, 8)
    if (label.length > room) label = `…${label.slice(-(room - 1))}`
    if (on) {
      const pad = Math.max(cols() - plain(label).length - plain(hint).length - 4, 1)
      rows.push(
        `${BAND_BG} ${ACCENT}▶ ${RESET}${label}${RESET}${hint}${RESET}${' '.repeat(pad)}${RESET}`
      )
    } else {
      rows.push(`  ${ACCENT}· ${RESET}${DIM}${label}${hint}${RESET}`)
    }
  })
  return rows
}

/** Files open themselves the moment the input ends with an @path token. */
function autoOverlay() {
  const tok = atToken()
  if (tok && !overlay) overlay = { kind: 'files', sel: 0, top: 0 }
  else if (!tok && overlay?.kind === 'files') overlay = null
}

function openOverlay(kind) {
  if (overlay?.kind === kind) return closeOverlay() // ctrl+p toggles
  overlay = { kind, sel: 0, top: 0 }
  drawBox()
}

function closeOverlay() {
  if (!overlay) return
  overlay = null
  drawBox()
}

function acceptOverlay() {
  const items = overlayItems()
  const it = items[overlay.sel]
  if (it) setBuf(it.value)
  closeOverlay()
}

/** Interactive picker — resolves the chosen item's value, null on esc/cancel.
 *  The input line stays free as a live filter and is restored afterwards.
 *  During a command the cursor sits below the splash footer — hop it back to
 *  the box first (the DSR hop askRaw uses), so drawBox's invariant holds. */
async function pickItem(title, items) {
  await hopToBox()
  return new Promise((resolve) => {
    overlay = { kind: 'pick', title, items, sel: 0, top: 0, savedBuf: rawBuf, resolve }
    drawBox()
  })
}

/** One-line value prompt drawn in the input box — resolves the text, null on esc. */
async function valuePrompt(title) {
  await hopToBox()
  return new Promise((resolve) => {
    const saved = rawBuf
    setBuf('')
    overlay = { kind: 'value', title, sel: -1, top: 0, savedBuf: saved, resolve }
    drawBox()
  })
}

/** Settle a pick/value overlay: restore the input, redraw, then resolve — and
 *  on the splash screen return to the command area below the footer, where
 *  the rest of the handler's output belongs (askRaw hops back up afterwards). */
function finishOverlay(v) {
  const r = overlay.resolve
  setBuf(overlay.savedBuf ?? '')
  overlay = null
  drawBox()
  if (splashLive) process.stdout.write(`\x1b[${SPLASH_UP}B\r`)
  r(v)
}

/** Move the cursor from the command area back to the splash box row. */
async function hopToBox() {
  if (!splashLive) return // chat mode redraws from home — no hopping
  const row = await queryRow()
  const up = row ? row - (SPLASH_TOP + 1) : SPLASH_UP
  if (up > 0) process.stdout.write(`\x1b[${up}A`)
}

/** Keys handled while an overlay is open — always consumed. */
function overlayKey(s) {
  if (!overlay) return false
  if (s === '\x1b[A' || s === '\x1bOA') {
    overlay.sel--
    drawBox()
    return true
  }
  if (s === '\x1b[B' || s === '\x1bOB') {
    overlay.sel++
    drawBox()
    return true
  }
  if (s === '\t' || s === '\x19') {
    if (overlay.resolve) finishOverlay(overlay.kind === 'value' ? rawBuf : (overlayItems()[overlay.sel]?.value ?? null))
    else acceptOverlay()
    return true
  }
  if (s === '\x1b' || s === '\x10') {
    if (overlay.resolve) finishOverlay(null) // esc / ctrl+p cancel a picker
    else closeOverlay()
    return true
  }
  if (s === '\x12') {
    if (overlay.resolve) return true // pickers/prompts never swap to history
    overlay = { kind: 'hist', sel: 0, top: 0 } // ctrl+r swaps to history
    drawBox()
    return true
  }
  if (s === '\x03') {
    if (overlay.resolve) {
      finishOverlay(null)
      return true
    }
    rawBuf = '' // ctrl+c wipes input and closes the palette in one go
    rawCol = 0
    closeOverlay()
    return true
  }
  if (s === '\x7f' || s === '\b') {
    if (rawBuf) {
      rawBuf = rawBuf.slice(0, -1)
      rawCol = rawBuf.length
      drawBox()
    }
    return true
  }
  if (s === '\n' || s.startsWith('\x1b')) return true // swallow newlines/escapes
  rawBuf += s
  rawCol = rawBuf.length
  drawBox()
  return true
}

function say(s) {
  if (TTY && chatMode) {
    chat.push({ k: 'raw', t: s })
    render()
  } else {
    console.log(s)
  }
}

/**
 * The input band as rows (band-styled) + the cursor column (1-based) on the
 * LAST row. Long lines show their tail; very tall inputs show only the tail
 * rows so the footer never gets pushed off-screen.
 */
function inputRows() {
  const rowsTotal = process.stdout.rows || 24
  if (!rawBuf) return { rows: [PLACEHOLDER], col: plain(PLACEHOLDER).length + 3, row: 0 } // cursor at the end
  const before = rawBuf.slice(0, Math.min(rawCol, rawBuf.length))
  const cLine = before.split('\n').length - 1 // 0-based line the cursor sits on
  const cCol = before.length - (before.lastIndexOf('\n') + 1)
  let lines = rawBuf.split('\n')
  const cap = Math.max(rowsTotal - 3, 1)
  let hidden = 0
  if (lines.length > cap) {
    hidden = lines.length - (cap - 1)
    lines = [`${hidden} earlier line${hidden === 1 ? '' : 's'}…`, ...lines.slice(hidden)]
  }
  const lim = Math.max(cols() - 8, 8)
  const shown = lines.map((t) => (plain(t).length > lim ? `…${t.slice(-(lim - 1))}` : t))
  // where the cursor lands in the visible window (the hidden-lines header
  // shifts rows by one; tail-truncated rows shift the column)
  const visLine = Math.max(Math.min(hidden > 0 ? cLine - hidden + 1 : cLine, shown.length - 1), 0)
  const full = plain(shown[visLine] ?? '')
  const src = (lines[visLine] ?? '').length > lim ? lines[visLine] : '' // truncation source
  let col
  if (src && plain(src).length > lim) {
    const off = plain(src).length - (lim - 1) // visible text = '…' + tail
    col = cCol <= off ? 3 : 3 + (cCol - off)
  } else col = Math.min(cCol, full.length) + 3
  return { rows: shown, col, row: visLine }
}

function chatRows() {
  const w = cols()
  const rows = []
  for (const e of chat) {
    if (e.k === 'msg') {
      for (const t of wrapPlain(e.t, w - 2)) rows.push(band(t, 0))
    } else if (e.k === 'text') {
      rows.push(...renderMd(e.t, w))
    } else {
      // raw lines (meta, notices, cards): only wrap the ones that overflow
      for (const t of e.t.split('\n')) {
        if (plain(t).length > w) rows.push(...wrapPlain(t, w))
        else rows.push(t)
      }
    }
  }
  return rows
}

function render() {
  if (!TTY || !chatMode) return
  const rows = Math.max(process.stdout.rows || 24, 8)
  const all = chatRows()
  if (thinking)
    all.push(`${ACCENT}${['✳', '✸', '✶', '✻'][animFrame % 4]}${RESET} ${DIM}thinking… · esc to stop${RESET}`)
  const inp = inputRows()
  const over = overlayRows()
  const keep = Math.max(rows - 1 - inp.rows.length - over.length, 1) // content · overlay · input · status
  const view = all.length > keep ? all.slice(all.length - keep) : all
  const pad = Math.max(keep - view.length, 0)
  let out = '\x1b[H\x1b[2J'
  if (view.length) out += view.join('\r\n')
  out += '\r\n'.repeat(pad + 1) // always break before the overlay / input box
  if (over.length) out += over.join('\r\n') + '\r\n'
  // the input box, shaded like every other band; after the status bar is
  // drawn below it the cursor hops back onto the box's last row
  out += inp.rows.map((t, i) => band(t, i === inp.row ? inp.col : 0)).join('\r\n')
  out += '\r\n'
  out += statusLine()
  // park on the cursor's row (status line sits one row below the input)
  out += `\x1b[${1 + inp.rows.length - 1 - inp.row}A\x1b[${inp.col}G`
  footRowsShown = over.length + inp.rows.length
  process.stdout.write(out)
}

function renderSoon() {
  if (renderTimer) return
  renderTimer = setTimeout(() => {
    renderTimer = null
    render()
  }, 50)
}

function animStart() {
  animStop()
  if (!TTY) return
  animTimer = setInterval(() => {
    animFrame++
    render()
  }, 150)
}

function animStop() {
  if (animTimer) clearInterval(animTimer)
  animTimer = null
}

function drawBox() {
  autoOverlay() // an @path token opens (or closes) the file list by itself
  if (chatMode) {
    const inp = inputRows()
    const over = overlayRows()
    const total = over.length + inp.rows.length
    if (total !== footRowsShown) return render() // footprint changed
    // rewrite only the overlay + input rows: up to the first one, clear, redraw
    let out = '\r'
    if (total > 1) out += `\x1b[${total - 1}A`
    over.forEach((t) => {
      out += `\x1b[2K${t}\r\n`
    })
    inp.rows.forEach((t, i) => {
      out += `\x1b[2K${band(t, i === inp.row ? inp.col : 0)}`
      if (i < inp.rows.length - 1) out += '\r\n'
    })
    // when the cursor isn't on the last written row, hop back up to it
    if (inp.row < inp.rows.length - 1) out += `\x1b[${inp.rows.length - 1 - inp.row}A\x1b[${inp.col}G`
    process.stdout.write(out)
    return
  }
  // splash: rewrite the box (cursor invariant = its input row), then keep the
  // palette area below it in sync — an open overlay replaces meta/hints/tip/
  // footer, closing restores them. \x1b[0J handles whatever used to be there.
  const content = rawBuf || PLACEHOLDER
  const col = rawBuf ? rawCol + 3 : plain(PLACEHOLDER).length + 3
  const over = overlayRows()
  let out = `\r\x1b[2K${band(content, col)}`
  if (over.length) {
    out += `\r\x1b[1B\x1b[0J${over.join('\r\n')}\r\n\x1b[${over.length + 1}A\x1b[${col}G`
    palShown = true
  } else if (palShown) {
    out += `\r\x1b[1B\x1b[0J${SPLASH_BELOW.join('\r\n')}\r\n\x1b[${SPLASH_UP}A\x1b[${col}G`
    palShown = false
  }
  process.stdout.write(out)
}

function rawSubmit() {
  const value = rawBuf
  if (!value) {
    drawBox() // Enter on an empty line does nothing, like opencode
    return
  }
  rawHist.push(value)
  rawIdx = rawHist.length
  setBuf('')
  if (overlay) closeOverlay() // un-hide whatever the palette covered first
  if (value.startsWith('/')) {
    // commands cut into a running reply — stop the stream so they run now
    if (abortCtl) stopStream()
    // commands print below the splash footer; the next prompt jumps back up
    if (splashLive) process.stdout.write(`\x1b[${SPLASH_UP}B\r`)
  } else if (splashLive) {
    // first send: the chat renderer takes over and wipes the start screen
    splashLive = false
    chatMode = true
  }
  const w = waiters.shift()
  if (w) w(value)
  else lineQueue.push(value)
}

function pasteOff() {
  try {
    process.stdout.write('\x1b[?2004l')
  } catch {
    // never mind
  }
}

function rawQuit() {
  animStop()
  if (renderTimer) clearTimeout(renderTimer)
  if (splashLive) process.stdout.write(`\x1b[${SPLASH_UP}B\r`) // bye below the footer
  process.stdout.write(`\r\x1b[2K${DIM}bye${RESET}\r\n`)
  try {
    process.stdin.setRawMode(false)
  } catch {
    // already cooked
  }
  pasteOff()
  process.exit(0)
}

/** Esc during a streaming reply → abort, keep the partial text. */
function stopStream() {
  if (abortCtl) abortCtl.abort()
}

/** Bracketed paste: keep the payload as literal text (newlines = new lines). */
function applyPaste(s) {
  let t = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r\n|\r/g, '\n')
  if (splashLive) t = t.replace(/\n+/g, ' ') // the splash box is one line
  insertBuf(t)
  drawBox()
}

function keyInput(s) {
  // Enter may arrive glued to typed text: submit at the first CR, then the rest
  const ri = s.indexOf('\r')
  if (ri !== -1) {
    const head = s.slice(0, ri)
    const tail = s.slice(ri + 1)
    if (head) insertBuf(head.replace(/\r/g, ''))
    if (overlay) {
      if (overlay.kind === 'files') {
        closeOverlay() // @file list: Enter sends the message
        rawSubmit()
      } else if (overlay.resolve) {
        const items = overlayItems()
        finishOverlay(overlay.kind === 'value' ? rawBuf : (items[overlay.sel]?.value ?? null))
      } else acceptOverlay() // pick the highlighted row into the input
    } else rawSubmit()
    if (tail && !tail.startsWith('\n')) keyInput(tail)
    return
  }
  if (overlay && overlayKey(s)) return // palette swallows every key
  if (s === '\n') {
    // shift+enter (WT sends LF): a new line in the message — never in splash
    if (!splashLive && waiters.length) {
      insertBuf('\n')
      drawBox()
    }
    return
  }
  if (s === '\x7f' || s === '\b') {
    if (rawBuf) {
      delBack()
      drawBox()
    }
    return
  }
  if (s === '\x03') {
    // ctrl+c wipes what you typed, or exits on an empty line
    if (rawBuf) {
      setBuf('')
      drawBox()
      return
    }
    rawQuit()
  }
  if (s === '\x04') {
    if (!rawBuf) rawQuit()
    return
  }
  if (s === '\x1b[A') {
    if (rawHist.length) {
      rawIdx = Math.max(rawIdx - 1, 0)
      setBuf(rawHist[rawIdx] ?? '')
      drawBox()
    }
    return
  }
  if (s === '\x1b[B') {
    if (rawHist.length) {
      rawIdx = Math.min(rawIdx + 1, rawHist.length)
      setBuf(rawHist[rawIdx] ?? '')
      drawBox()
    }
    return
  }
  // cursor movement — left/right, home/end, ctrl+a/ctrl+e, and Del
  if (s === '\x1b[D' || s === '\x1bOD') {
    moveCol(-1)
    drawBox()
    return
  }
  if (s === '\x1b[C' || s === '\x1bOC') {
    moveCol(1)
    drawBox()
    return
  }
  if (s === '\x1b[H' || s === '\x1b[1~' || s === '\x01') {
    rawCol = lineStart()
    drawBox()
    return
  }
  if (s === '\x1b[F' || s === '\x1b[4~' || s === '\x05') {
    rawCol = lineEnd()
    drawBox()
    return
  }
  if (s === '\x1b[3~') {
    delAt()
    drawBox()
    return
  }
  if (s === '\x10') {
    openOverlay('cmds') // ctrl+p — command palette
    return
  }
  if (s === '\x12') {
    openOverlay('hist') // ctrl+r — search what you sent before
    return
  }
  if (s === '\x1b' || s === '\x1b\x1b') {
    // bare Esc: vim → normal mode; otherwise a second press (within 700ms)
    // opens the /rewind turn picker — like Claude Code's esc esc. Two escs
    // glued into one chunk count as the double press.
    if (vimOn) {
      vimMode = 'n'
      vimCount = ''
      vimOp = ''
      rawCol = Math.min(rawCol, Math.max(rawBuf.length - 1, 0)) // sit on a char
      drawBox()
      return
    }
    const glued = s === '\x1b\x1b'
    if (chatMode && history.length && (glued || Date.now() - lastEscTs < 700)) {
      lastEscTs = 0
      void openRewind()
      return
    }
    lastEscTs = Date.now()
    return
  }
  if (s.startsWith('\x1b') || s === '\t') return // other escapes / tab: ignore
  if (vimOn && vimMode === 'n') {
    // fast typing can land as one chunk — feed it through normal mode key by
    // key, and whatever lands after an i/a/o (or a paste) inserts as usual
    for (const ch of s) {
      if (vimOn && vimMode === 'n') handleVimKey(ch)
      else insertBuf(ch)
    }
    drawBox()
    return
  }
  insertBuf(s)
  drawBox()
}

/** Vim normal-mode keys: motions (with counts), x, dd/dw/d$, i/a/I/A/o/O, j/k. */
function handleVimKey(s) {
  if (s.length !== 1) return // multi-byte sequences are not normal-mode keys
  const done = () => {
    vimCount = ''
    drawBox()
  }
  // count prefix — digits before the motion (0 is home unless a count is pending)
  if ((s >= '1' && s <= '9') || (vimCount && s === '0')) {
    vimCount += s
    drawBox()
    return
  }
  if (vimOp) {
    const op = vimOp
    vimOp = ''
    if (op === 'd') {
      if (s === 'd') {
        // dd — drop the whole input line (the \n with it)
        const a = lineStart()
        const b = lineEnd()
        rawBuf = rawBuf.slice(0, a) + rawBuf.slice(b < rawBuf.length ? b + 1 : b)
        rawCol = Math.min(a, rawBuf.length)
      } else if (s === 'w') {
        // dw — delete to the start of the next word
        const to = wordFwd(rawCol)
        rawBuf = rawBuf.slice(0, rawCol) + rawBuf.slice(to)
      } else if (s === '$' || s === 'D') {
        rawBuf = rawBuf.slice(0, rawCol) + rawBuf.slice(lineEnd())
      }
    }
    done()
    return
  }
  const n = Math.max(parseInt(vimCount || '1', 10), 1)
  switch (s) {
    case '0':
      rawCol = lineStart()
      break
    case 'h':
      moveCol(-n)
      break
    case 'l':
      moveCol(n)
      break
    case '^':
      rawCol = lineStart() + ((rawBuf.slice(lineStart()).match(/^ */) ?? [''])[0].length)
      break
    case '$':
      rawCol = lineEnd()
      break
    case 'w':
      for (let i = 0; i < n; i++) rawCol = wordFwd(rawCol)
      break
    case 'b':
      for (let i = 0; i < n; i++) rawCol = wordBack(rawCol)
      break
    case 'x':
      for (let i = 0; i < n; i++) delAt()
      break
    case 'D':
      rawBuf = rawBuf.slice(0, rawCol) + rawBuf.slice(lineEnd())
      break
    case 'd':
      vimOp = 'd' // wait for dd / dw / d$
      drawBox()
      return
    case 'i':
      vimMode = 'i'
      break
    case 'I':
      rawCol = lineStart()
      vimMode = 'i'
      break
    case 'a':
      rawCol = Math.min(rawCol + 1, lineEnd())
      vimMode = 'i'
      break
    case 'A':
      rawCol = lineEnd()
      vimMode = 'i'
      break
    case 'o': {
      const e = lineEnd()
      rawBuf = rawBuf.slice(0, e) + '\n' + rawBuf.slice(e)
      rawCol = e + 1
      vimMode = 'i'
      break
    }
    case 'O': {
      const a = lineStart()
      rawBuf = rawBuf.slice(0, a) + '\n' + rawBuf.slice(a)
      rawCol = a
      vimMode = 'i'
      break
    }
    case 'j':
      moveLine(1)
      done()
      return
    case 'k':
      moveLine(-1)
      done()
      return
    default:
      break // unknown key in normal mode: ignore it
  }
  done()
}

/** j/k — keep the column when stepping between input lines. */
function moveLine(d) {
  const before = rawBuf.slice(0, rawCol)
  const idx = before.split('\n').length - 1
  const colIn = before.length - (before.lastIndexOf('\n') + 1)
  const lines = rawBuf.split('\n')
  const to = idx + d
  if (to < 0 || to >= lines.length) return
  let off = 0
  for (let i = 0; i < to; i++) off += lines[i].length + 1
  rawCol = Math.min(off + colIn, off + lines[to].length)
}

/** esc esc (and /rewind): pick an earlier turn and drop everything after it. */
async function openRewind() {
  const turns = history.map((m, i) => ({ m, i })).filter((x) => x.m.role === 'user')
  if (!turns.length) {
    notice('nothing to rewind — no turns in this chat yet')
    return
  }
  const excerpt = (t) => plain(t).replace(/\s+/g, ' ').trim().slice(0, 56) || '(empty)'
  if (TTY) {
    const items = turns.map((t, k) => ({
      label: `turn ${k + 1} · ${excerpt(t.m.content)}`,
      hint: new Date(t.m.ts ?? Date.now()).toLocaleTimeString(),
      value: t.i
    }))
    const v = await pickItem(`rewind · ${turns.length} turns · pick to jump back`, items)
    if (v === null) notice('rewind cancelled')
    else doRewind(v)
    return
  }
  // piped: the numbered list is the picker
  say('')
  say(
    card(
      'rewind',
      turns.map((t, k) => ({ text: `  ${k + 1}`.padEnd(6) + excerpt(t.m.content), color: DIM }))
    )
  )
  say('')
}

/** Drop the selected user turn and everything after it, then redraw. */
function doRewind(userIdx) {
  const drop = history.length - userIdx
  history = history.slice(0, userIdx)
  if (pendingFrom && !history.includes(pendingFrom)) {
    pendingEdits = null
    pendingFrom = null
  }
  rebuildChat()
  refreshCtx()
  notice(`rewound ${drop} message${drop === 1 ? '' : 's'} — ${history.length} left · files untouched, /undo reverts edits`)
}

function queryRow() {
  // ask the terminal where the cursor is (1-based row); null on timeout
  return new Promise((resolve) => {
    if (!TTY) return resolve(null)
    const w = { buf: '', resolve, timer: null }
    w.timer = setTimeout(() => {
      if (dsrWait === w) {
        dsrWait = null
        resolve(null)
      }
    }, 250)
    dsrWait = w
    process.stdout.write('\x1b[6n')
  })
}

async function askRaw() {
  if (chatMode) {
    // full redraw: conversation on top, footer + input band pinned below
    render()
    return new Promise((resolve) => {
      waiters.push(resolve)
    })
  }
  // splash: jump back to the preview box under the wordmark — measure the
  // cursor in case a command printed below it since the last prompt
  const row = await queryRow()
  const up = row ? row - (SPLASH_TOP + 1) : SPLASH_UP
  return new Promise((resolve) => {
    waiters.push(resolve)
    if (up > 0) process.stdout.write(`\x1b[${up}A`)
    drawBox()
  })
}

function askLine() {
  // queued lines first — stdin may have hit EOF while we were streaming, and
  // the remaining lines (like /quit) still have to be served
  if (lineQueue.length) {
    console.log(statusLine())
    return Promise.resolve(lineQueue.shift())
  }
  if (stdinClosed) return Promise.resolve('') // piped input ended — no hang
  console.log(statusLine())
  return new Promise((resolve) => {
    waiters.push(resolve)
    rl.setPrompt(`${ACCENT}❯ ${RESET}`)
    rl.prompt()
  })
}

if (TTY) {
  // one global reader: keys typed while the model is talking are dropped
  // (except Esc = stop). Bracketed paste keeps pasted newlines literal.
  process.stdin.setRawMode?.(true) // optional: pipes have no raw mode
  process.stdin.resume()
  process.stdout.write('\x1b[?2004h')
  const dec = new TextDecoder()
  process.stdin.on('data', (c) => {
    let s = dec.decode(c, { stream: true })
    if (dsrWait) {
      dsrWait.buf += s
      const m = dsrWait.buf.match(/\x1b\[(\d+);(\d+)R/)
      if (!m) return // wait for the rest of the report
      s = dsrWait.buf.slice(m.index + m[0].length)
      const w = dsrWait
      dsrWait = null
      clearTimeout(w.timer)
      w.resolve(Number(m[1]))
      if (!s) return
    }
    // bracketed paste: swallow the markers, keep the payload
    if (s.includes('\x1b[200~')) {
      s = s.slice(s.indexOf('\x1b[200~') + '\x1b[200~'.length)
      pasting = true
    }
    if (s.includes('\x1b[201~')) {
      s = s.slice(0, s.indexOf('\x1b[201~'))
      pasting = false
    }
    if (pasting) {
      if (waiters.length || overlay) applyPaste(s)
      return
    }
    // a picker/prompt keeps input flowing even while no ask() is pending
    if (waiters.length || overlay) keyInput(s)
    else if (abortCtl && s === '\x1b') stopStream() // bare Esc while streaming
  })
  // redraw at the new size (conversation rewrapped, footer still pinned)
  process.stdout.on('resize', () => {
    if (chatMode && !thinking) render()
    else if (chatMode) renderSoon()
  })
} else {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  // Lines can arrive while nobody is asking (piped input, fast Enter): queue
  // them instead of letting readline drop them, and hand the next one over.
  rl.on('line', (l) => {
    const w = waiters.shift()
    if (w) w(l)
    else lineQueue.push(l)
  })

  // Ctrl+C: exit cleanly (nothing typed) or wipe the line (something typed)
  rl.on('SIGINT', () => {
    if (rl.line) {
      rl.write(null, { ctrl: true, name: 'u' })
      return
    }
    console.log(`\n${DIM}bye${RESET}`)
    rl.close()
    process.exit(0)
  })

  // Ctrl+D / piped input ending: wake a pending ask with an empty line so no
  // top-level await is left unsettled; the loop then stops asking
  rl.on('close', () => {
    stdinClosed = true
    const w = waiters.shift()
    if (w) w('')
  })
}

const ask = TTY ? askRaw : askLine

// -- sessions ----------------------------------------------------------------

const when = (ts) => (ts ? new Date(ts).toLocaleString() : '')

/** App sessions from ~/.codezy/sessions, plus Drive-only mirrored copies. */
function listAppSessions() {
  const out = []
  const load = (dir, kind) => {
    try {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const s = readJson(path.join(dir, f), null)
        if (s?.id) {
          out.push({
            kind,
            id: s.id,
            title: s.title || 'untitled',
            count: (s.messages || []).length,
            updated: s.updatedAt || 0,
            data: s
          })
        }
      }
    } catch {
      // folder missing — fine
    }
  }
  load(DIRS.sessions, 'app')
  if (settings.driveFolder) {
    const before = new Set(out.map((x) => x.id))
    load(path.join(settings.driveFolder, 'CODEZY', 'sessions'), 'drive')
    // drop duplicates (drive copy of a session we already have locally)
    const seen = new Set()
    for (let i = out.length - 1; i >= 0; i--) {
      if (seen.has(out[i].id)) out.splice(i, 1)
      else seen.add(out[i].id)
    }
    void before
  }
  return out.sort((a, b) => b.updated - a.updated)
}

/** Terminal saves from ~/.codezy/terminal (written by /save). */
function listTermSaves() {
  const out = []
  try {
    for (const f of fs.readdirSync(DIRS.saves).filter((x) => x.endsWith('.json'))) {
      const s = readJson(path.join(DIRS.saves, f), null)
      if (s?.id) {
        out.push({
          id: s.id,
          title: s.title || 'untitled',
          count: (s.history || []).length,
          updated: s.savedAt || 0,
          data: s
        })
      }
    }
  } catch {
    // no saves yet
  }
  return out.sort((a, b) => b.updated - a.updated)
}

/** Redraw the chat screen from history (used by /open and /resume). */
function rebuildChat() {
  chat = []
  for (const m of history) {
    if (m.role === 'user') chat.push({ k: 'msg', t: String(m.content) })
    else if (m.role === 'assistant') chat.push({ k: 'text', t: stripEditBlocks(String(m.content)) })
  }
  if (chat.length && TTY) {
    splashLive = false
    chatMode = true
    render()
  }
}

// -- edit flow ---------------------------------------------------------------

function reviewPrompt(edits) {
  const blocks = edits
    .map((e) => `===FILE: ${e.path}\n===SEARCH\n${e.isNew ? 'EMPTY' : e.search}\n===REPLACE\n${e.replace}\n===END`)
    .join('\n\n')
  return (
    `Review these pending file edits like a senior code reviewer before anything gets written to disk.\n` +
    `Go file by file: correctness, edge cases, security, clarity. Be specific and blunt.\n` +
    `Finish with a verdict line: APPROVE or FIX NEEDED, then the must-fix list.\n` +
    `Reply in prose only — do NOT output ===FILE or ===SEARCH blocks.\n\n${blocks}`
  )
}

/** Newest unresolved assistant message that proposed edits. */
function lastAssistantEdits() {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role !== 'assistant') continue
    const e = parseEdits(String(m.content))
    if (e.length) return resolvedMsgs.has(m) ? null : e
  }
  return null
}

function doApply(edits) {
  const res = applyEdits(linkFolder ? [linkFolder] : [], edits, DIRS.backups)
  // show files relative to the linked folder — a 100-char absolute path wraps
  // ugly (and splits) in an 80-col terminal; 'hello.txt' says it better
  const base = linkFolder || process.cwd()
  for (const a of res.applied) {
    const rel = path.relative(base, a.path)
    const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : a.path
    notice(`✓ wrote ${shown}${a.isNew ? ' (new file)' : ''}`)
  }
  for (const e of res.errors) say(`${RED}  ✗ ${e}${RESET}`)
  if (res.backupId) notice('backed up first · /undo reverts this batch')
  if (pendingFrom) resolvedMsgs.add(pendingFrom)
  pendingEdits = null
  pendingFrom = null
}

/** 'd' in the confirm loop: a real unified diff of search → replace per file
 *  (git diff --no-index; falls back to red/green blocks when git is missing). */
function showProposalDiff(edits) {
  say('')
  for (const e of edits) {
    const old = path.join(os.tmpdir(), `codezy-prop-${process.pid}-old.txt`)
    const neu = path.join(os.tmpdir(), `codezy-prop-${process.pid}-new.txt`)
    let ok = false
    try {
      fs.writeFileSync(old, e.isNew && e.search === 'EMPTY' ? '' : e.search)
      fs.writeFileSync(neu, e.replace)
      const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--', old, neu], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      })
      const out = r.stdout ?? ''
      if ((r.status !== 0 && r.status !== 1) || !out) throw new Error('no diff')
      say(`  ${ACCENT}${e.path}${RESET}${DIM}${e.isNew ? ' (new file)' : ''}${RESET}`)
      for (const l of out.split('\n')) {
        if (l.startsWith('diff --git') || l.startsWith('index ')) continue
        if (l.startsWith('--- ')) say(`  ${DIM}--- ${e.isNew ? '/dev/null' : e.path}${RESET}`)
        else if (l.startsWith('+++ ')) say(`  ${DIM}+++ ${e.path}${RESET}`)
        else if (l.startsWith('@@')) say(`  ${ACCENT}${l}${RESET}`)
        else if (l[0] === '+') say(`  ${GREEN}${l}${RESET}`)
        else if (l[0] === '-') say(`  ${RED}${l}${RESET}`)
        else say(`  ${DIM}${l}${RESET}`)
      }
      ok = true
    } catch {
      // git unavailable or no textual change — fall through to plain blocks
    } finally {
      try {
        fs.rmSync(old, { force: true })
        fs.rmSync(neu, { force: true })
      } catch {
        // temp cleanup is best effort
      }
    }
    if (!ok) {
      say(`  ${ACCENT}${e.path}${RESET}${DIM}${e.isNew ? ' (new file)' : ''}${RESET}`)
      if (!e.isNew) for (const l of String(e.search).split('\n')) say(`  ${RED}- ${l}${RESET}`)
      for (const l of String(e.replace).split('\n')) say(`  ${GREEN}+ ${l}${RESET}`)
    }
  }
  say('')
}

/** Confirm flow: card with the files, then y/n/a/d/s/r until decided. */
async function proposeEdits(edits) {
  pendingEdits = edits
  const last = history[history.length - 1]
  pendingFrom = last?.role === 'assistant' ? last : null
  const rows = edits.map((e) => ({ text: `  ${e.isNew ? '+' : '~'} ${e.path}   +${e.added} -${e.removed}` }))
  rows.push({ text: '' })
  rows.push({ text: '  y apply · n decline · a always · d diff · s skip · r review', color: DIM })
  say('')
  say(card(`new edit${edits.length > 1 ? 's' : ''} · ${edits.length} file${edits.length > 1 ? 's' : ''}`, rows))
  say('')
  for (;;) {
    const answer = (await ask()).trim().toLowerCase()
    if (answer === 'r') {
      try {
        await streamReply(reviewPrompt(edits), { ephemeral: true })
        notice('verdict above · y apply · n decline · a always · d diff · s skip')
      } catch {
        // review failed — printed already; ask again
      }
      continue
    }
    if (answer === 'd' || answer === 'diff') {
      showProposalDiff(edits)
      notice('y apply · n decline · a always · s skip · r review')
      continue
    }
    if (answer === 'a' || answer === 'always') {
      mode = 'auto' // accept everything else this session without asking
      notice('auto-approve on for this session — future edits apply immediately')
      doApply(edits)
      return
    }
    if (answer === 'y' || answer === 'yes') {
      doApply(edits)
      return
    }
    if (answer === 's' || answer === 'skip') {
      notice('skipped — /apply writes them later, /review inspects them')
      return
    }
    // decline: everything else. A message typed by mistake goes back to input.
    pendingEdits = null
    if (pendingFrom) resolvedMsgs.add(pendingFrom)
    pendingFrom = null
    notice('declined — nothing written')
    if (answer && answer !== 'n' && answer !== 'no') lineQueue.push(answer)
    return
  }
}

// -- help --------------------------------------------------------------------

/** Every slash command — one table that feeds /help and the ctrl+p palette. */
const COMMANDS = [
  { c: '/help', d: 'this list', g: 0 },
  { c: '/sessions', d: 'app chats + terminal saves (/open · /resume)', g: 0 },
  { c: '/resume', d: '[n] restore a terminal save (no n → picker)', g: 0 },
  { c: '/open', d: '[n] load an app chat as context (no n → picker)', g: 0 },
  { c: '/save', d: '[title] save this session', g: 0 },
  { c: '/copy', d: '[text] copy the last reply to the clipboard', g: 0 },
  { c: '/export', d: '[path] save this transcript as markdown', g: 0 },
  { c: '/remember', d: '<fact> save a memory — or just type #fact', g: 0 },
  { c: '/rewind', d: '[n] jump back to an earlier turn (esc esc)', g: 0 },
  { c: '/new', d: 'fresh context (clears chat, notes, skill)', g: 0 },
  { c: '/clear', d: 'alias of /new', g: 0 },
  { c: '/model', d: '[id] list or switch model (ollama + providers)', g: 1 },
  { c: '/provider', d: '[id|nebius <key>] switch — or connect Nebius', g: 1 },
  { c: '/effort', d: '<light|medium|deep> context + sampling', g: 1 },
  { c: '/mode', d: '<plan|build|auto> file-edit mode', g: 1 },
  { c: '/fast', d: 'toggle fast mode (effort light <-> medium)', g: 1 },
  { c: '/vim', d: '<on|off> modal editing: esc · hjkl · x · dd · i/a/o', g: 1 },
  { c: '/theme', d: '[name] accent + band palette (midnight|ember|mint|slate)', g: 1 },
  { c: '/settings', d: 'view and edit the shared config file', g: 1 },
  { c: '/link', d: '<dir|off> folder the model may read and edit', g: 1 },
  { c: '/undo', d: 'revert the last applied edits', g: 1 },
  { c: '/search', d: '<query> web search (DuckDuckGo)', g: 2 },
  { c: '/init', d: 'generate CODEZY.md for the linked folder', g: 2 },
  { c: '/skill', d: '[name|off] prompt playbooks', g: 2 },
  { c: '/review', d: 'review the edits the model proposed', g: 2 },
  { c: '/apply', d: 'write the proposal you skipped', g: 2 },
  { c: '/diff', d: '[path] git changes vs HEAD in the linked folder', g: 2 },
  { c: '/doctor', d: 'check the environment: endpoint, model, git, data', g: 2 },
  { c: '/cost', d: 'tokens this session used (last call included)', g: 2 },
  { c: '/btw', d: '<note|show|clear> background notes, always in context', g: 2 },
  { c: '/usage', d: 'usage stats + 12-week heatmap', g: 2 },
  { c: '/compact', d: 'summarize history to free context', g: 2 },
  { c: '/quit', d: 'exit (ctrl+c works too)', g: 3 }
]

function helpCard() {
  say('')
  const rows = []
  for (const g of [0, 1, 2]) {
    if (g) rows.push({ text: '' })
    for (const x of COMMANDS.filter((x) => x.g === g)) rows.push({ text: `  ${x.c.padEnd(19)}${x.d}` })
  }
  rows.push({ text: '' })
  rows.push({ text: '  esc                stop a streaming reply' })
  rows.push({ text: '  shift+enter        newline in your message' })
  rows.push({ text: '  ctrl+c             wipe input · exit on an empty line' })
  rows.push({ text: '  ctrl+p             command palette — filter and run' })
  rows.push({ text: '  ctrl+r             search what you sent before' })
  rows.push({ text: '  @                  file suggestions from the linked folder' })
  rows.push({ text: '  ! cmd run a shell command, output joins the context' })
  rows.push({ text: '  # fact             remember something (same as /remember)' })
  rows.push({ text: '  esc esc            jump back to an earlier turn (/rewind)' })
  rows.push({ text: `  anything else      chat with ${settings.activeModel}`, color: DIM })
  say(card('commands', rows))
  say('')
}

// -- REPL --------------------------------------------------------------------

/** `!cmd` — run a shell command right here: print it, then put the output in
 *  context so the next message can talk about it (Claude Code's `!`). */
function runShell(cmd) {
  let r = null
  try {
    r = spawnSync(cmd, {
      shell: true,
      cwd: linkFolder || process.cwd(),
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
  } catch (e) {
    r = null
  }
  const out = r ? `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() : String(r?.error ?? 'command failed')
  const code = r ? (r.status ?? (r.error ? 1 : 0)) : 1
  const all = out ? out.split(/\r?\n/) : ['(no output)']
  const rows = [{ text: `  $ ${cmd}`.slice(0, 999), color: ACCENT }, { text: '' }]
  for (const l of all.slice(0, 30)) rows.push({ text: `  ${l}`, color: code === 0 ? '' : RED })
  if (all.length > 30) rows.push({ text: `  … ${all.length - 30} more lines`, color: DIM })
  rows.push({ text: '' })
  rows.push({ text: `  exit ${code} · output added to context`, color: DIM })
  say('')
  say(card(`! ${cmd}`.slice(0, 52), rows))
  say('')
  history.push({
    role: 'user',
    content: `Ran in the terminal (${linkFolder || process.cwd()}):\n$ ${cmd}\n${out.slice(0, 6000)}`,
    ts: Date.now(),
    shell: true
  })
  refreshCtx()
}

/** `#fact` and /remember — append to memory.md, injected while learn is on. */
function rememberFact(fact) {
  try {
    fs.mkdirSync(path.dirname(DIRS.memory), { recursive: true })
    fs.appendFileSync(DIRS.memory, `- ${fact}\n`)
    notice(
      settings.learn === false
        ? `remembered — "${fact}" · injection is OFF (turn learn on in /settings)`
        : `remembered — "${fact}"`
    )
  } catch (e) {
    notice(`could not save memory: ${e?.message ?? e}`)
  }
}

refreshCtx()

for (;;) {
  if (!lineQueue.length && stdinClosed) break
  const line = (await ask()).trim()
  if (!line) continue

  if (line === '/quit' || line === '/exit') break

  if (syncSettings()) refreshCtx() // pick up what the desktop app changed first

  // `!cmd` runs a shell command; `#fact` saves a memory — before chat/commands
  if (line[0] === '!' && line.length > 1) {
    runShell(line.slice(1).trim())
    continue
  }
  if (line[0] === '#' && line.slice(1).trim()) {
    rememberFact(line.slice(1).trim())
    continue
  }

  // plain chat ---------------------------------------------------------------
  if (line[0] !== '/') {
    try {
      const res = await streamReply(line)
      if (res.edits.length) {
        if (mode === 'auto') doApply(res.edits) // auto mode: backup + apply
        else await proposeEdits(res.edits)
      }
    } catch {
      // streamReply already printed the error
    }
    continue
  }

  const sp = line.indexOf(' ')
  const cmd = sp === -1 ? line : line.slice(0, sp)
  const args = sp === -1 ? '' : line.slice(sp + 1).trim()

  if (cmd === '/help') {
    helpCard()
    continue
  }

  if (cmd === '/sessions') {
    pickedTerm = listTermSaves()
    pickedApp = listAppSessions()
    say('')
    if (!pickedTerm.length && !pickedApp.length) {
      say(`${DIM}  no sessions found in ${DIRS.sessions}${RESET}`)
    } else {
      if (pickedTerm.length) {
        say(
          card(
            'terminal saves · /resume <n>',
            pickedTerm.map((s, i) => ({
              text: `  ${String(i + 1).padStart(2)}. ${s.title}  (${s.count} msgs, ${when(s.updated)})`
            }))
          )
        )
        say('')
      }
      if (pickedApp.length) {
        say(
          card(
            'app chats · /open <n>',
            pickedApp.map((s, i) => ({
              text: `  ${String(i + 1).padStart(2)}. ${s.title}  (${s.count} msgs, ${when(s.updated)})${
                s.kind === 'drive' ? '  [drive]' : ''
              }`
            }))
          )
        )
        say('')
      }
    }
    continue
  }

  if (cmd === '/open') {
    if (!pickedApp.length) pickedApp = listAppSessions()
    let sel = Number.parseInt(args, 10)
    if (!args && TTY) {
      if (!pickedApp.length) {
        notice('no app chats found — /sessions lists what exists')
        continue
      }
      sel = await pickItem(
        `open · ${pickedApp.length} chat${pickedApp.length === 1 ? '' : 's'}`,
        pickedApp.map((s, i) => ({
          label: s.title,
          hint: `${s.count} msgs · ${when(s.updated)}${s.kind === 'drive' ? ' · drive' : ''}`,
          value: i + 1
        }))
      )
      if (!sel) continue
    }
    const s = pickedApp[sel - 1]
    if (!s) {
      say(`${DIM}  run /sessions first, then /open <n>${RESET}`)
      continue
    }
    history = (s.data.messages || [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content, ts: m.ts, model: m.model }))
    notes = s.data.notes ?? []
    activeSkill = s.data.skill ?? null
    pendingEdits = null
    pendingFrom = null
    resolvedMsgs.clear()
    currentSaveId = null
    loadedAppId = s.id
    lastStats = s.data.lastUsage ?? null
    rebuildChat()
    refreshCtx()
    notice(`loaded "${s.title}" — ${history.length} messages${s.kind === 'drive' ? ' (from Drive)' : ''} in context`)
    continue
  }

  if (cmd === '/resume') {
    if (!pickedTerm.length) pickedTerm = listTermSaves()
    let sel = Number.parseInt(args, 10)
    if (!args && TTY) {
      // no number typed → pick from the list instead of counting rows
      if (!pickedTerm.length) {
        notice('no terminal saves yet — /save <title> makes one')
        continue
      }
      sel = await pickItem(
        `resume · ${pickedTerm.length} save${pickedTerm.length === 1 ? '' : 's'}`,
        pickedTerm.map((s, i) => ({
          label: s.title,
          hint: `${s.count} msgs · ${when(s.updated)}`,
          value: i + 1
        }))
      )
      if (!sel) continue
    }
    const s = pickedTerm[sel - 1]
    if (!s) {
      say(`${DIM}  run /sessions first, then /resume <n>${RESET}`)
      continue
    }
    const d = s.data
    history = Array.isArray(d.history) ? d.history : []
    notes = d.notes ?? []
    activeSkill = d.skill ?? null
    pendingEdits = d.pending ?? null
    pendingFrom = null
    resolvedMsgs.clear()
    if (isEffort(d.effort)) effort = d.effort
    if (['plan', 'build', 'auto'].includes(d.mode)) mode = d.mode
    if (d.model) settings.activeModel = d.model
    if (d.provider) settings.activeProvider = d.provider
    if (d.linkFolder) linkFolder = d.linkFolder
    currentSaveId = d.id
    loadedAppId = null
    lastStats = d.lastUsage ?? null
    rebuildChat()
    refreshCtx()
    notice(`resumed "${d.title}" — ${history.length} messages${pendingEdits ? ', proposal pending' : ''}`)
    continue
  }

  if (cmd === '/save') {
    if (!history.length) {
      notice('nothing to save yet — say something first')
      continue
    }
    const firstUser = history.find((m) => m.role === 'user')?.content || 'terminal chat'
    const title = args || firstUser.replace(/\s+/g, ' ').slice(0, 48)
    const id = currentSaveId || `t${Date.now().toString(36)}`
    const data = {
      id,
      title,
      savedAt: Date.now(),
      model: settings.activeModel,
      provider: settings.activeProvider,
      effort,
      mode,
      notes,
      skill: activeSkill,
      linkFolder,
      pending: pendingEdits,
      lastUsage: lastStats,
      history
    }
    try {
      fs.mkdirSync(DIRS.saves, { recursive: true })
      fs.writeFileSync(path.join(DIRS.saves, `${id}.json`), JSON.stringify(data, null, 2), 'utf8')
      currentSaveId = id
      notice(`saved "${title}" → ${id}.json · /sessions lists it, /resume restores it`)
    } catch (e) {
      say(`${RED}  save failed: ${e.message}${RESET}`)
    }
    continue
  }

  if (cmd === '/model' || cmd === '/models') {
    const oll = await listOllamaModels(settings.ollamaUrl)
    if (!args) {
      if (TTY) {
        // interactive picker: ↑↓ to choose, type to filter — value is the id
        const provOf = new Map(oll.map((m) => [m.id, 'ollama']))
        const items = oll.map((m) => {
          const info = [fmtSize(m.size), m.quant].filter(Boolean).join(' · ')
          return { label: m.id, hint: info ? `ollama · ${info}` : 'ollama', value: m.id }
        })
        for (const p of settings.providers || []) {
          for (const id of await listOpenAIModels(p)) {
            if (provOf.has(id)) continue
            provOf.set(id, p.id)
            items.push({ label: id, hint: p.name || p.id, value: id })
          }
        }
        if (!items.length) {
          notice(`ollama unreachable at ${settings.ollamaUrl} — /model <id> sets one directly`)
          continue
        }
        const v = await pickItem(`model · active ${settings.activeModel}`, items)
        if (v === null) {
          notice('model unchanged')
          continue
        }
        settings.activeModel = v
        settings.activeProvider = provOf.get(v) ?? 'ollama'
        refreshCtx()
        saveSettings()
        notice(`model → ${v} (${settings.activeProvider})`)
        continue
      }
      const rows = [{ text: `  active: ${settings.activeModel}  (${settings.activeProvider})`, color: ACCENT }, { text: '' }]
      for (const m of oll) {
        const active = m.id === settings.activeModel && settings.activeProvider === 'ollama'
        const info = [fmtSize(m.size), m.quant].filter(Boolean).join(' · ')
        rows.push({ text: `${active ? ' >' : '  '} ${m.id}${info ? `   ${info}` : ''}`, color: active ? undefined : DIM })
      }
      if (!oll.length) rows.push({ text: `  (ollama unreachable at ${settings.ollamaUrl})`, color: DIM })
      for (const p of settings.providers || []) {
        const list = await listOpenAIModels(p)
        rows.push({ text: '' })
        rows.push({ text: `  ${p.name || p.id}:`, color: DIM })
        if (!list.length) rows.push({ text: '    (no models found)', color: DIM })
        for (const id of list) {
          const active = id === settings.activeModel && settings.activeProvider === p.id
          rows.push({ text: `${active ? ' >' : '  '}   ${id}`, color: active ? undefined : DIM })
        }
      }
      say('')
      say(card('models', rows))
      say('')
      continue
    }
    const find = (list) => list.find((x) => x.id === args) ?? list.find((x) => x.id.includes(args) || x.id.startsWith(args))
    const om = find(oll)
    if (om) {
      settings.activeModel = om.id
      settings.activeProvider = 'ollama'
      refreshCtx()
      saveSettings()
      notice(`model → ${om.id} (ollama)`)
      continue
    }
    let matched = null
    for (const p of settings.providers || []) {
      const id = find(await listOpenAIModels(p))
      if (id) {
        matched = { p, id }
        break
      }
    }
    if (matched) {
      settings.activeModel = matched.id
      settings.activeProvider = matched.p.id
      refreshCtx()
      saveSettings()
      notice(`model → ${matched.id} (${matched.p.name || matched.p.id})`)
    } else {
      notice(`no model matching "${args}" — /model lists everything`)
    }
    continue
  }

  if (cmd === '/provider') {
    const list = ['ollama', ...(settings.providers || []).map((p) => p.id)]
    if (!args) {
      const rows = [{ text: `  active: ${settings.activeProvider}`, color: ACCENT }, { text: '' }]
      rows.push({ text: `  ${settings.activeProvider === 'ollama' ? '>' : ' '} ollama   ${settings.ollamaUrl}` })
      for (const p of settings.providers || []) {
        rows.push({
          text: `  ${settings.activeProvider === p.id ? '>' : ' '} ${p.id}   ${p.name || p.id} · ${p.baseUrl}${
            p.apiKey ? '' : ' · no key'
          }`
        })
      }
      rows.push({ text: '' })
      rows.push({ text: '  connect: /provider nebius <api key>   (tokenfactory.nebius.com)', color: DIM })
      say('')
      say(card('provider', rows))
      say('')
      continue
    }
    const [prov, ...rest] = args.split(/\s+/)
    if (prov === 'nebius') {
      const key = rest.join(' ').trim()
      const connected = (settings.providers || []).some((p) => p.id === 'nebius')
      if (!key && !connected) {
        notice('connect first: /provider nebius <api key> — get one at tokenfactory.nebius.com')
        continue
      }
      if (key) {
        // upsert the preset + hook up a known-good NVIDIA model straight away
        settings.providers = [
          ...(settings.providers || []).filter((p) => p.id !== 'nebius'),
          {
            id: 'nebius',
            name: 'Nebius Token Factory',
            baseUrl: 'https://api.tokenfactory.nebius.com/v1',
            apiKey: key
          }
        ]
        settings.activeProvider = 'nebius'
        settings.activeModel = 'nvidia/Nemotron-3_5-Lightning'
        refreshCtx()
        saveSettings()
        notice(`connected Nebius Token Factory · model → ${settings.activeModel} — /model lists everything`)
        continue
      }
    }
    if (list.includes(prov)) {
      settings.activeProvider = prov
      refreshCtx()
      saveSettings()
      notice(`provider → ${prov} — /model picks its models`)
      continue
    }
    notice(`unknown provider "${prov}" — /provider lists what's connected`)
    continue
  }

  if (cmd === '/effort') {
    const alias = ({ l: 'light', m: 'medium', d: 'deep' })[args] ?? args
    if (!args) {
      if (TTY) {
        const v = await pickItem(
          `effort · ${effort}`,
          Object.keys(EFFORTS).map((k) => ({
            label: k,
            hint: `temp ${EFFORTS[k].temperature} · ctx ${contextSizeFor(k)}`,
            value: k
          }))
        )
        if (v === null) notice('effort unchanged')
        else if (v !== effort) {
          effort = v
          refreshCtx()
          saveSettings({ effort: v })
          notice(`effort → ${effort} · ctx ${contextSizeFor(effort)} · temp ${EFFORTS[effort].temperature}`)
        }
        continue
      }
      notice(`effort: ${effort} · temp ${EFFORTS[effort].temperature} · ctx ${contextSizeFor(effort)} tokens`)
      continue
    }
    if (isEffort(alias)) {
      effort = alias
      refreshCtx()
      saveSettings({ effort: alias })
      notice(`effort → ${effort} · ctx ${contextSizeFor(effort)} · temp ${EFFORTS[effort].temperature}`)
    } else {
      say(`${RED}  usage: /effort <light|medium|deep>${RESET}`)
    }
    continue
  }

  if (cmd === '/fast') {
    const next = effort === 'light' ? 'medium' : 'light'
    effort = next
    refreshCtx()
    saveSettings({ effort: next })
    notice(
      next === 'light'
        ? 'fast mode ON — effort light · /fast restores medium'
        : `fast mode OFF — effort ${next} · /effort deep for maximum thinking`
    )
    continue
  }

  if (cmd === '/vim') {
    if (args === 'on' || args === 'off') {
      vimOn = args === 'on'
      vimMode = 'i'
      saveSettings({ vim: vimOn })
      notice(
        vimOn
          ? 'vim mode on — esc normal · h j k l w b 0 $ · x · dd/dw · i a o · enter submits'
          : 'vim mode off'
      )
    } else if (args) {
      say(`${RED}  usage: /vim <on|off>${RESET}`)
    } else {
      notice(`vim mode: ${vimOn ? 'on' : 'off'} — /vim on|off`)
    }
    continue
  }

  if (cmd === '/rewind') {
    const turns = history.map((m, i) => ({ m, i })).filter((x) => x.m.role === 'user')
    if (!turns.length) {
      notice('nothing to rewind — no turns in this chat yet')
      continue
    }
    if (args) {
      const n = parseInt(args, 10)
      const t = Number.isFinite(n) && n >= 1 ? turns[n - 1] : null
      if (!t) {
        say(`${RED}  usage: /rewind [turn number] — plain /rewind opens the list${RESET}`)
        continue
      }
      doRewind(t.i)
      continue
    }
    await openRewind()
    continue
  }

  if (cmd === '/remember') {
    if (!args) {
      let mem = ''
      try {
        mem = fs.readFileSync(DIRS.memory, 'utf8').trim()
      } catch {
        // no memory file yet
      }
      if (!mem) notice('no memories yet — /remember <fact>, or just type #fact')
      else {
        say('')
        say(card('memory', mem.split('\n').slice(0, 30).map((l) => ({ text: `  ${l}`, color: DIM }))))
        say('')
      }
      continue
    }
    rememberFact(args)
    continue
  }

  if (cmd === '/export') {
    if (!history.length) {
      notice('nothing to export yet — chat first')
      continue
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    const file = args
      ? path.resolve(args)
      : path.join(linkFolder || process.cwd(), `codezy-export-${stamp}.md`)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const head = [
        '# CODEZY session',
        '',
        `- date: ${new Date().toISOString()}`,
        `- model: ${settings.activeModel} · effort ${effort} · provider ${settings.activeProvider}`,
        `- messages: ${history.length}`,
        ''
      ].join('\n')
      const body = history
        .map((m) => `## ${m.role === 'user' ? 'You' : 'CODEZY'}\n\n${String(m.content ?? '')}\n`)
        .join('\n')
      fs.writeFileSync(file, `${head}\n${body}`)
      notice(`exported ${history.length} messages → ${file}`)
    } catch (e) {
      notice(`export failed: ${e?.message ?? e}`)
    }
    continue
  }

  if (cmd === '/cost') {
    const users = history.filter((m) => m.role === 'user').length
    const bots = history.length - users
    const chars = history.reduce((n, m) => n + String(m.content ?? '').length, 0)
    const est = Math.max(Math.round(chars / 4), 0)
    const local = (settings.activeProvider ?? 'ollama') === 'ollama'
    const rows = [
      { text: `  ${settings.activeModel} · ${effort} · ctx ${ctxPct}%`, color: ACCENT },
      { text: '' },
      { text: `  turns         ${users} user · ${bots} assistant · ${history.length} messages` },
      { text: `  transcript    ${fmtBytes(chars)} of text — about ${est} tokens` },
      {
        text: `  last call     ${lastStats ? `${lastStats.prompt} prompt · ${lastStats.completion} completion` : 'none yet'}`,
        color: lastStats ? '' : DIM
      },
      { text: '' },
      {
        text: local
          ? '  cost          local model — no per-call cost'
          : `  cost          billed by ${settings.activeProvider} (tokens × their price)`,
        color: local ? GREEN : YELLOW
      },
      { text: '  /usage shows the full 12-week history', color: DIM }
    ]
    say('')
    say(card('cost', rows))
    say('')
    continue
  }

  if (cmd === '/doctor') {
    const rows = []
    const row = (good, label, detail) =>
      rows.push({
        text: `  ${good ? GREEN : RED}${good ? '✓' : '✗'}${RESET} ${label.padEnd(11)}${DIM}${detail}${RESET}`
      })
    const major = Number(process.version.slice(1).split('.')[0])
    row(major >= 18, 'node', `${process.version}${major >= 18 ? '' : ' — v18+ required'}`)
    let settingsOk = true
    try {
      JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'))
    } catch {
      settingsOk = false
    }
    row(settingsOk, 'settings', settingsOk ? path.join(DATA, 'settings.json') : 'unreadable — delete it to reset')
    let writable = true
    try {
      const probe = path.join(DATA, '.doctor-probe')
      fs.writeFileSync(probe, 'ok')
      fs.rmSync(probe, { force: true })
    } catch {
      writable = false
    }
    row(writable, 'data dir', writable ? DATA : `${DATA} is not writable`)
    const provider = settings.activeProvider || 'ollama'
    if (provider === 'ollama') {
      const url = settings.ollamaUrl || 'http://127.0.0.1:11434'
      const up = await pingOllama(url)
      row(up, 'endpoint', up ? `Ollama at ${url}` : `${url} unreachable — try: ollama serve`)
    } else {
      const p = (settings.providers ?? []).find((x) => x.id === provider)
      const keyed = !!(p?.apiKey && p?.baseUrl)
      row(keyed, 'endpoint', keyed ? `${provider} · ${p.baseUrl} · key set` : `${provider} is missing baseUrl/apiKey in settings`)
    }
    row(true, 'model', `${settings.activeModel} · effort ${effort}`)
    const g = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    const gv = g.status === 0 ? String(g.stdout ?? '').trim().replace('git version ', '') : null
    row(!!gv, 'git', gv ? `git ${gv}` : 'git is not on PATH — /diff and /init need it')
    if (linkFolder) row(fs.existsSync(linkFolder), 'folder', linkFolder)
    else rows.push({ text: `  ${DIM}· folder not linked — /link <dir>${RESET}` })
    let memSize = 0
    try {
      memSize = fs.statSync(DIRS.memory).size
    } catch {
      // no memory file yet
    }
    rows.push({ text: `  ${DIM}· memory       ${settings.learn === false ? 'injection off' : 'on'} · ${fmtBytes(memSize)}${RESET}` })
    let skills = 0
    try {
      skills = fs.readdirSync(DIRS.skills).filter((f) => f.endsWith('.md')).length
    } catch {
      // no skills dir yet
    }
    rows.push({ text: `  ${DIM}· skills       ${skills} installed${RESET}` })
    rows.push({ text: `  ${DIM}· terminal     ${cols()} cols${RESET}` })
    rows.push({ text: '' })
    rows.push({ text: `  ${DIM}first ✗ above is the thing to fix${RESET}` })
    say('')
    say(card('doctor', rows))
    say('')
    continue
  }

  if (cmd === '/mode') {
    const MODE_DESC = {
      plan: 'model only plans, never outputs edits',
      build: 'model proposes edits, you confirm each',
      auto: 'edits applied immediately (backed up, /undo reverts)'
    }
    if (!args) {
      if (TTY) {
        const v = await pickItem(
          `mode · ${mode}`,
          ['plan', 'build', 'auto'].map((k) => ({ label: k, hint: MODE_DESC[k], value: k }))
        )
        if (v === null) notice('mode unchanged')
        else if (v !== mode) {
          mode = v
          saveSettings({ mode: v })
          notice(`mode → ${mode}`)
        }
        continue
      }
      say('')
      say(
        card('mode', [
          { text: `  current: ${mode}`, color: ACCENT },
          { text: '' },
          { text: '  plan   — model only plans, never outputs edits' },
          { text: '  build  — model proposes edits, you confirm each' },
          { text: '  auto   — edits applied immediately (backed up, /undo reverts)', color: DIM }
        ])
      )
      say('')
      continue
    }
    if (['plan', 'build', 'auto'].includes(args)) {
      mode = args
      saveSettings({ mode: args })
      notice(`mode → ${args}`)
    } else {
      say(`${RED}  usage: /mode <plan|build|auto>${RESET}`)
    }
    continue
  }

  if (cmd === '/theme') {
    const names = Object.keys(THEMES)
    if (args) {
      if (isTheme(args)) {
        applyTheme(args)
        saveSettings({ theme: args })
        notice(`theme → ${args} · accent ${THEMES[args].accent}`)
      } else if (args === 'dark' || args === 'light' || args === 'acrylic') {
        notice(`${args} is an app theme — in the terminal pick a palette: ${names.join('|')}`)
      } else {
        say(`${RED}  usage: /theme <${names.join('|')}>${RESET}`)
      }
      continue
    }
    if (TTY) {
      const cur = isTheme(settings.theme) ? settings.theme : 'midnight'
      const v = await pickItem(
        `theme · ${cur}`,
        names.map((n) => ({ label: n, hint: `accent ${THEMES[n].accent}`, value: n }))
      )
      if (v === null) notice('theme unchanged')
      else if (v !== cur) {
        applyTheme(v)
        saveSettings({ theme: v })
        notice(`theme → ${v} · accent ${THEMES[v].accent}`)
      }
      continue
    }
    say('')
    say(
      card(
        'theme',
        names.map((n) => ({
          text: `  ${(settings.theme ?? 'midnight') === n ? ' >' : '  '} ${n}   ${THEMES[n].accent}`,
          color: (settings.theme ?? 'midnight') === n ? undefined : DIM
        }))
      )
    )
    say('')
    continue
  }

  if (cmd === '/settings') {
    const ENTRIES = [
      { key: 'effort', label: 'effort', get: () => effort, choices: () => Object.keys(EFFORTS) },
      { key: 'mode', label: 'mode', get: () => mode, choices: () => ['plan', 'build', 'auto'] },
      { key: 'theme', label: 'theme', get: () => settings.theme ?? 'midnight', choices: () => Object.keys(THEMES) },
      { key: 'ollamaUrl', label: 'ollama url', get: () => settings.ollamaUrl, text: true },
      { key: 'learn', label: 'learn (memory)', get: () => (settings.learn ? 'on' : 'off'), choices: () => ['on', 'off'] },
      { key: 'dataDir', label: 'data dir', get: () => DATA, info: true },
      { key: 'file', label: 'config file', get: () => CONFIG_FILE, info: true }
    ]
    if (args) {
      say(`${RED}  usage: /settings — pick a key to edit${RESET}`)
      continue
    }
    if (TTY) {
      const e = await pickItem(
        `settings · ${CONFIG_FILE.split(path.sep).pop()}`,
        ENTRIES.map((x) => ({ label: x.label, hint: String(x.get()), value: x.key }))
      )
      if (!e) continue
      const entry = ENTRIES.find((x) => x.key === e)
      if (entry.info) {
        notice(`${entry.label}: ${entry.get()}`)
        continue
      }
      if (entry.choices) {
        const v = await pickItem(`${entry.label} · current ${entry.get()}`, entry.choices().map((c) => ({ label: c, hint: '', value: c })))
        if (!v || v === entry.get()) continue
        if (entry.key === 'effort') {
          effort = v
          refreshCtx()
        }
        if (entry.key === 'mode') mode = v
        if (entry.key === 'theme') applyTheme(v)
        saveSettings({ [entry.key]: entry.key === 'learn' ? v === 'on' : v })
        notice(`${entry.label} → ${v}`)
        continue
      }
      // free-text value (ollama url)
      const v = await valuePrompt(`${entry.label} · current ${entry.get()}`)
      if (!v || !v.trim()) continue
      saveSettings({ [entry.key]: v.trim() })
      notice(`${entry.label} → ${v.trim()}`)
      continue
    }
    say('')
    say(
      card(
        'settings',
        [
          ...ENTRIES.map((x) => ({ text: `  ${x.label.padEnd(13)}${x.get()}` })),
          { text: '' },
          { text: '  shared with the desktop app — edit keys via /effort /mode /theme /model', color: DIM }
        ]
      )
    )
    say('')
    continue
  }

  if (cmd === '/link') {
    if (!args) {
      notice(
        linkFolder
          ? `linked: ${linkFolder} — file tree + CODEZY.md in context, edits write here`
          : 'not linked — the model cannot write files'
      )
      continue
    }
    if (args === 'off') {
      linkFolder = null
      refreshCtx()
      notice('unlinked — no file writes allowed')
      continue
    }
    const dir = path.resolve(args.startsWith('~') ? path.join(os.homedir(), args.slice(1)) : args)
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('not a folder')
      linkFolder = dir
      refreshCtx()
      const tree = fileTree(dir)
      notice(`linked ${dir}`)
      if (tree) say(`${DIM}${tree.split('\n').slice(0, 8).join('\n')}${tree.split('\n').length > 8 ? '\n…' : ''}${RESET}`)
      else notice('(empty folder)')
    } catch (e) {
      say(`${RED}  cannot link ${args}: ${e.message}${RESET}`)
    }
    continue
  }

  if (cmd === '/undo') {
    const r = undoLast(DIRS.backups)
    notice(r.message)
    continue
  }

  if (cmd === '/search') {
    if (!args) {
      say(`${DIM}  usage: /search <what you want to find on the web>${RESET}`)
      continue
    }
    try {
      const hits = await webSearch(args)
      if (!hits.length) {
        notice(`no results for "${args}" — try different words`)
        continue
      }
      say('')
      say(`${ACCENT}${hits.length} result${hits.length === 1 ? '' : 's'} for "${args}"${RESET}`)
      hits.forEach((h, i) => {
        say(`${DIM}${i + 1}.${RESET} ${h.title}`)
        say(`   ${DIM}${h.url}${RESET}`)
        if (h.snippet) say(`   ${h.snippet}`)
      })
      say('')
    } catch (e) {
      say(`${RED}  search failed: ${e.message}${RESET}`)
    }
    continue
  }

  if (cmd === '/copy') {
    let text = args
    if (!text) {
      const last = [...history].reverse().find((m) => m.role === 'assistant')
      text = last ? stripEditBlocks(String(last.content)).trim() : ''
      if (!text) {
        notice('nothing to copy yet — no assistant reply in this session')
        continue
      }
    }
    if (copyToClipboard(text)) {
      notice(`copied ${text.length} chars${args ? '' : ' (last reply)'} to the clipboard`)
    } else {
      notice('clipboard copy failed — no clipboard tool found on this system')
    }
    continue
  }

  if (cmd === '/init') {
    if (!linkFolder) {
      say(`${RED}  link a folder first: /link <dir>${RESET}`)
      continue
    }
    const folder = linkFolder
    notice(`generating CODEZY.md in ${folder}…`)
    try {
      const prompt =
        `Generate a project context file for AI assistants working in this folder.\n\n` +
        `Folder: ${folder}\n\nFile tree:\n${fileTree(folder) || '(empty folder)'}\n\n` +
        `Write it in Markdown, max 60 lines:\n` +
        `1. What this project is (infer from the names and structure).\n` +
        `2. Layout — what lives where and why.\n` +
        `3. Conventions to follow (naming, style, frameworks detected).\n` +
        `4. Gotchas — build/run steps if discoverable, generated folders to ignore.\n\n` +
        `Output ONLY the raw Markdown content: no code fences, no commentary before or after.`
      // no folder section in this prompt → the model can't propose edits,
      // it just writes the markdown (same flow as the app's /init)
      const res = await streamReply(prompt, { ephemeral: true, system: buildSystem(false) })
      if (!res.text.trim()) {
        notice('model returned nothing — nothing written')
        continue
      }
      let content = res.text.trim()
      content = content.replace(/^```[a-zA-Z0-9_+.#-]*\r?\n/, '').replace(/\r?\n```\s*$/, '').trim() + '\n'
      const target = path.join(folder, 'CODEZY.md')
      const exists = fs.existsSync(target)
      const out = applyEdits(
        [folder],
        [
          {
            path: 'CODEZY.md',
            isNew: !exists,
            search: exists ? fs.readFileSync(target, 'utf8') : '',
            replace: content
          }
        ],
        DIRS.backups
      )
      for (const a of out.applied) notice(`wrote ${path.basename(a.path)}${exists ? ' (previous version backed up)' : ''} · /undo reverts`)
      for (const e of out.errors) say(`${RED}  ✗ ${e}${RESET}`)
    } catch {
      // error printed by streamReply
    }
    continue
  }

  if (cmd === '/skill') {
    let names = []
    try {
      names = fs
        .readdirSync(DIRS.skills)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3))
        .sort()
    } catch {
      // no skills folder
    }
    if (!args) {
      if (!names.length) {
        notice(`no skills found — drop .md playbooks into ${DIRS.skills}`)
        continue
      }
      say('')
      say(
        card(
          'skills',
          names.map((n) => ({ text: `  ${n === activeSkill ? '> ' : '  '}${n}`, color: n === activeSkill ? ACCENT : '' }))
        )
      )
      say('')
      notice(activeSkill ? `active skill: ${activeSkill} · /skill off deactivates` : 'no skill active — /skill <name> activates')
      continue
    }
    if (args === 'off') {
      activeSkill = null
      refreshCtx()
      notice('skill off — plain CODEZY')
      continue
    }
    const name = names.find((n) => n.toLowerCase() === args.toLowerCase())
    if (!name) {
      say(`${RED}  no skill named "${args}" — /skill lists them${RESET}`)
      continue
    }
    activeSkill = name
    refreshCtx()
    notice(`skill "${name}" active — its playbook rides along in every prompt`)
    continue
  }

  if (cmd === '/review') {
    const edits = pendingEdits ?? lastAssistantEdits()
    if (!edits || !edits.length) {
      notice('nothing to review — ask for file edits first (build mode).')
      continue
    }
    if (!pendingEdits) pendingEdits = edits
    notice(`reviewing ${edits.length} file edit${edits.length === 1 ? '' : 's'}…`)
    try {
      await streamReply(reviewPrompt(edits), { ephemeral: true })
      notice('verdict above · /apply writes them · /undo reverts after')
    } catch {
      // error printed
    }
    continue
  }

  if (cmd === '/apply') {
    if (!pendingEdits) {
      notice('no pending edits — /review or a fresh proposal puts some here')
      continue
    }
    await proposeEdits(pendingEdits)
    continue
  }

  if (cmd === '/btw') {
    if (!args || args === 'show') {
      if (!notes.length) notice('no background notes yet')
      else {
        say('')
        notes.forEach((n, i) => say(`${ACCENT}${i + 1}.${RESET} ${n}`))
        say('')
      }
      continue
    }
    if (args === 'clear') {
      notes = []
      refreshCtx()
      notice('background notes cleared')
      continue
    }
    notes.push(args)
    refreshCtx()
    notice(`note added — always in context (${notes.length} total)`)
    continue
  }

  if (cmd === '/usage') {
    const chats = []
    const addDir = (dir, pick) => {
      try {
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
          const id = f.replace(/\.json$/, '')
          if (id === loadedAppId || id === currentSaveId) continue // counted live below
          const s = readJson(path.join(dir, f), null)
          if (s) chats.push(pick(s))
        }
      } catch {
        // folder missing
      }
    }
    addDir(DIRS.sessions, (s) => ({ messages: s.messages ?? [], lastUsage: s.lastUsage }))
    addDir(DIRS.saves, (s) => ({ messages: (s.history ?? []).map((m) => ({ ...m, ts: m.ts ?? s.savedAt })), lastUsage: s.lastUsage }))
    chats.push({ messages: history, lastUsage: lastStats })
    const u = collectUsage(chats, settings.activeModel)
    const rows = [
      { text: `  chats ${u.chats} · messages ${u.messages} · ~${u.tokens.toLocaleString('en-US')} est. tokens` },
      {
        text: `  today ${u.today} · streak ${u.currentStreak}d (best ${u.longestStreak}d)${
          u.peakHour !== null ? ` · peak ${u.peakHour}:00` : ''
        }`
      }
    ]
    if (u.favoriteModel) rows.push({ text: `  favourite: ${u.favoriteModel}` })
    rows.push({ text: '' })
    for (const m of u.models.slice(0, 6)) {
      rows.push({ text: `  ${m.id} — ${m.messages} replies · ~${m.tokens.toLocaleString('en-US')} tok`, color: DIM })
    }
    if (u.lastUsage) rows.push({ text: `  last call: ${u.lastUsage.prompt} prompt / ${u.lastUsage.completion} completion tokens` })
    say('')
    say(card('usage', rows))
    say('')
    say(`${DIM}  last 12 weeks${RESET}`)
    for (const l of heatLines(u.heat, DIM, ACCENT, RESET)) say(l)
    say(`${DIM}  · ░ ▒ █ = more messages that day${RESET}`)
    say('')
    continue
  }

  if (cmd === '/diff') {
    const dir = linkFolder || process.cwd()
    const run = (argv) => {
      try {
        return spawnSync('git', ['-C', dir, ...argv], { encoding: 'utf8', timeout: 10000, windowsHide: true })
      } catch {
        return null
      }
    }
    const st = run(['status', '--porcelain=1'])
    if (!st || st.status !== 0) {
      say(`${DIM}  ${dir} is not a git repository${pendingEdits ? ' — proposal pending: /review' : ''}${RESET}`)
      continue
    }
    const changed = st.stdout.split('\n').filter(Boolean)
    if (!changed.length) {
      notice('working tree clean — nothing to diff')
      continue
    }
    const branch = gitBranch(dir)
    const stat = run(args ? ['diff', 'HEAD', '--stat', '--', args] : ['diff', 'HEAD', '--stat'])
    const body = run(args ? ['diff', 'HEAD', '--', args] : ['diff', 'HEAD'])
    const statOut = (stat?.stdout ?? '').trimEnd()
    const bodyOut = body?.stdout ?? ''
    say('')
    say(
      `  ${ACCENT}${changed.length} changed file${changed.length === 1 ? '' : 's'}` +
        `${RESET}${DIM} vs HEAD${branch ? ` · ${branch}` : ''}${RESET}`
    )
    if (args && !bodyOut.trim()) {
      say(`${DIM}  no tracked changes for "${args}"${RESET}`)
      const un = changed.filter((l) => l.slice(3).includes(args))
      for (const l of un.slice(0, 40)) say(`  ${DIM}${l}${RESET}`)
      say('')
      continue
    }
    if (!statOut && !bodyOut) {
      // no commits yet (or only untracked files) — the status list IS the diff
      for (const l of changed.slice(0, 60)) say(`  ${DIM}${l}${RESET}`)
      if (changed.length > 60) notice(`… ${changed.length - 60} more`)
      say('')
      continue
    }
    for (const l of statOut.split('\n').filter(Boolean)) say(`  ${DIM}${l}${RESET}`)
    const untracked = changed.filter((l) => l.startsWith('??'))
    if (untracked.length && !args) say(`  ${DIM}+ ${untracked.length} untracked (not in diff)${RESET}`)
    const MAX = 240
    let lines = bodyOut.split('\n')
    const trunc = lines.length > MAX
    if (trunc) lines = lines.slice(0, MAX)
    for (const l of lines) {
      const t = l[0]
      if (t === '+') say(`  ${GREEN}${l}${RESET}`)
      else if (t === '-') say(`  ${RED}${l}${RESET}`)
      else if (l.startsWith('@@')) say(`  ${ACCENT}${l}${RESET}`)
      else if (l.startsWith('diff --git') || l.startsWith('index ') || l.startsWith('--- ') || l.startsWith('+++ '))
        say(`  ${DIM}${l}${RESET}`)
      else say(`  ${l}`)
    }
    if (trunc) notice(`diff truncated at ${MAX} lines — /diff <path> narrows it down`)
    say('')
    continue
  }

  if (cmd === '/compact') {
    if (history.length < 4) {
      notice('nothing to compact yet')
      continue
    }
    try {
      await maybeCompact(buildSystem(), true)
      refreshCtx()
    } catch {
      // compact reported its own failure / Esc
    }
    continue
  }

  if (cmd === '/new' || cmd === '/clear') {
    history = []
    notes = []
    activeSkill = null
    pendingEdits = null
    pendingFrom = null
    resolvedMsgs.clear()
    currentSaveId = null
    loadedAppId = null
    lastStats = null
    chat = []
    refreshCtx()
    notice('fresh context — screen cleared')
    continue
  }

  say(`${DIM}  unknown command "${cmd}" — try /help${RESET}`)
}

if (TTY && chatMode) {
  animStop()
  if (renderTimer) clearTimeout(renderTimer)
  process.stdout.write(`\r\x1b[2K${DIM}bye${RESET}\r\n`)
} else {
  console.log(`${DIM}bye${RESET}`)
}
pasteOff()
if (rl) rl.close()
else process.stdin.pause() // release stdin so the TTY REPL can actually exit

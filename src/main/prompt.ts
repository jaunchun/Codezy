// ---------------------------------------------------------------------------
// prompt.ts — assembles what actually gets sent to the model.
// Order (matches the design): base instructions → memory → project context →
// active skill → /goal → /btw notes → chat history (trimmed to fit).
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import type { ChatMessage, Project, Settings, Session } from '../shared/types'
import { readMemory, p } from './store'
import { contextSizeFor } from './ollama'
import { v2Active } from './v2'

const BASE_INSTRUCTIONS = `You are CODEZY, a coding assistant running locally on the user's machine.
Be direct and practical. Prefer small, correct code over long explanations.

How to answer:
- Lead with the answer or the change itself; keep prose short and skimmable.
- When the user asks you to change or improve code that is already in front of
  you (in this prompt, attached, or read with a tool), MAKE the change — output
  the edit block(s). Do not answer with a list of suggestions unless they asked
  for advice only.
- Put code in fenced blocks that carry the language tag.
- Never invent file contents, APIs, flags or line numbers you have not been
  shown here — if you need to see a file first, say exactly that.
- When a request is ambiguous, ask ONE short question instead of guessing.

You CAN create and change files on this machine — never reply that you cannot
save or write files. When the user asks to create, save, or change a file, say a
line or two and end your reply with the edit block(s) in exactly this format:

===FILE: relative/path.ext
===SEARCH
exact lines to find (verbatim)
===REPLACE
new lines
===END

Rules for edits:
- NEW file: the ===SEARCH content is the single word EMPTY, and ===REPLACE
  contains the COMPLETE file — never truncated, no "..." placeholders.
- Existing file: ===SEARCH is copied verbatim from the file (indentation
  included) and must match exactly one place.
- Keep each SEARCH/REPLACE block to one contiguous hunk of ~40 lines or less,
  anchored on unique text. Several small blocks beat one giant rewrite; for an
  existing file, never send the whole file back as SEARCH.
- If you cannot reproduce the exact text, widen the SEARCH by a line or two of
  surrounding context rather than shrinking it or paraphrasing.
- Paths: when this prompt has a "## Linked folders" section, use paths relative
  to that folder and follow its file tree. If no folder is linked yet, use the
  plain filename the user expects (for example clicker_game.py) — accepting the
  edit makes the app ask where to save it. Never invent directories.
- The user always confirms before anything is written, so when they ask you to
  save something, output the block — never refuse, never say you cannot save,
  never tell them to copy the code by hand. This holds even if an earlier
  message in this conversation refused — that was a mistake; output the block
  now. If you are unsure what content they want, ask one short question.
- The ===FILE: path line is MANDATORY at the start of every block — a block
  without it is ignored by the app. Never skip it.

Example of changing an existing file:

===FILE: main.py
===SEARCH
print('start')
print('end')
===REPLACE
print('start')
print('middle')
print('end')
===END`

/** ~4 characters per token — used to guess how much text fits in context. */
const CHARS_PER_TOKEN = 4

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  'coverage',
  '.idea',
  '.vscode'
])

/** Shallow file tree of a linked folder (depth 2, junk dirs skipped). */
export function fileTree(dir: string, maxEntries = 120): string {
  const out: string[] = []
  const walk = (current: string, rel: string, depth: number): void => {
    if (depth > 2 || out.length >= maxEntries) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxEntries) return
      const name = entry.name
      if (name.startsWith('.') && name !== '.env.example') continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        out.push(`${rel}${name}/`)
        walk(path.join(current, name), `${rel}${name}/`, depth + 1)
      } else {
        out.push(`${rel}${name}`)
      }
    }
  }
  walk(dir, '', 1)
  return out.join('\n')
}

/** Files a model WITHOUT tools should be able to see, because the entire
 *  point of linking a folder is that the model can work on it. */
const CONTENT_EXT = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro',
  '.json', '.jsonc', '.md', '.mdx', '.txt', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.php', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1',
  '.sql', '.svg', '.xml', '.env.example'
])

/** Never put credentials in front of the model, even from a linked folder. */
const SECRET_FILE = /^(\.env(\..+)?|\.npmrc|\.netrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|.*\.(pem|key|p12|pfx|keystore))$/i

/** Cap so one huge file (or a whole node_modules tree) can never crowd out
 *  the conversation. The model is told when a file was cut. */
const FOLDER_CONTENT_BUDGET = 14000
const MAX_CONTENT_FILE_BYTES = 64 * 1024

/** The text files inside `folder`, root level first, hidden/junk/secret files
 *  skipped. Ordering is deterministic: files before directories, then name. */
function collectContentFiles(
  dir: string,
  rel: string,
  depth: number,
  out: { rel: string; abs: string; size: number }[],
  limit = 60
): void {
  if (depth > 3 || out.length >= limit) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (out.length >= limit) return
    const name = entry.name
    if (name.startsWith('.')) continue
    const abs = path.join(dir, name)
    const nextRel = `${rel}${name}`
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      collectContentFiles(abs, `${nextRel}/`, depth + 1, out, limit)
      continue
    }
    if (!entry.isFile() || SECRET_FILE.test(name)) continue
    if (!CONTENT_EXT.has(path.extname(name).toLowerCase())) continue
    try {
      const st = fs.statSync(abs)
      if (st.size > MAX_CONTENT_FILE_BYTES) continue
      out.push({ rel: nextRel, abs, size: st.size })
    } catch {
      /* unreadable — skip */
    }
  }
}

/** The REAL file contents of a linked folder, for the classic (no-tools)
 *  flow. Without this the model only has a file tree and its own rule says
 *  "never invent file contents" — so it refuses to edit and suggests instead. */
export function readFolderContents(folder: string, maxChars = FOLDER_CONTENT_BUDGET): string {
  const files: { rel: string; abs: string; size: number }[] = []
  collectContentFiles(folder, '', 1, files)
  const parts: string[] = []
  let used = 0
  for (const f of files) {
    let text: string
    try {
      text = fs.readFileSync(f.abs, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue // binary that slipped past the ext check
    const block = `--- ${f.rel} ---\n${text.trimEnd()}\n`
    if (used + block.length > maxChars) {
      const room = maxChars - used
      if (room > 500) parts.push(`${block.slice(0, room)}\n…[truncated — ask the user to paste the rest if you need it]`)
      else parts.push('…[more files omitted to fit the context window]')
      break
    }
    parts.push(block)
    used += block.length
  }
  return parts.join('\n')
}

/** Attachment content is hidden in the UI chip — expanded only for the model.
 *  Images become real vision input (data URLs on `.images`); text files keep
 *  the inline-block expansion. */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}
/** Beyond this a base64 payload would dwarf the whole conversation. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Reads an image attachment as a data URL. Order: an existing data URL in
 *  the attachment content (paste path), then the real file on disk, then raw
 *  base64 in the content. Returns null when unreadable or over the cap. */
function imageDataUrl(f: { path: string; content: string }): string | null {
  const mime = IMAGE_MIME[path.extname(f.path || '').toLowerCase()] ?? 'image/png'
  if (/^data:image\//i.test(f.content)) return f.content
  try {
    const st = fs.statSync(f.path)
    if (st.size > MAX_IMAGE_BYTES) return null
    return `data:${mime};base64,${fs.readFileSync(f.path).toString('base64')}`
  } catch {
    /* not on disk — fall through to raw base64 in content */
  }
  if (f.content && f.content.length > 64 && /^[A-Za-z0-9+/=\s]+$/.test(f.content)) {
    return `data:${mime};base64,${f.content.replace(/\s+/g, '')}`
  }
  return null
}

/** Exported for batch24 tests. */
export function expandMessage(msg: ChatMessage): ChatMessage {
  if (!msg.files?.length) return msg
  const images: string[] = []
  const blocks = msg.files.map((f) => {
    if (!IMAGE_EXT.has(path.extname(f.path || '').toLowerCase())) {
      return `Attached file: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
    }
    const data = imageDataUrl(f)
    if (data) {
      images.push(data)
      return `Attached image: ${f.path} (you can see the picture itself — it is attached as vision input)`
    }
    return `Attached image: ${f.path} (could not be embedded — file missing or larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB; do not assume its contents)`
  })
  return {
    ...msg,
    content: `${msg.content}\n\n${blocks.join('\n\n')}`,
    ...(images.length ? { images: [...(msg.images ?? []), ...images] } : {})
  }
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Per-project standing orders: <folder>/.codezy/instructions.md (v3.1).
 *  CODEZY.md stays the /init-generated context file; this one is the file the
 *  project owner keeps in the repo — always/never rules, how to run and test.
 *  Read-only, capped, and only ever read from that exact path inside folder. */
export function readProjectInstructions(folder: string, max = 4000): string {
  const t = safeRead(path.join(folder, '.codezy', 'instructions.md')).trim()
  if (!t) return ''
  return t.length > max ? `${t.slice(0, max)}\n…[project instructions truncated]` : t
}

/**
 * Builds the final message array. Called by the main process right before
 * streaming, so the renderer never needs to know about memory/context files.
 */
export interface BuildOptions {
  /** Resolved by the caller: agent mode really runs this turn (the model can
   *  call tools). Defaults to v2Active(session, settings). */
  agent?: boolean
  /** Why agent mode could not run (e.g. the model has no tool support) —
   *  stated in the setup card so the model does not promise tools it lacks. */
  modelNote?: string
}

/** The facts a small model must never lose: what is linked, what it can
 *  change, and whether the web is really available this turn. Used in the
 *  system prompt AND repeated in the turn pin right before the question. */
function setupFacts(
  session: Session,
  settings: Settings,
  agent: boolean,
  modelNote: string | undefined,
  hasWeb: boolean
): string[] {
  const folders = session.linkedFolders ?? []
  const facts: string[] = []
  if (folders.length) {
    facts.push(`FOLDER LINKED: ${folders.join(' | ')} — this chat can READ and CHANGE files there.`)
  } else {
    facts.push(
      'FOLDER: none linked yet. You can still create a file with a ===FILE block and a plain filename — the app asks where to save it.'
    )
  }
  if (agent) {
    facts.push(
      'FILES: real tools — list_dir, read_file, write_file, edit_file, glob, grep_search, run_command. Use them; do NOT output ===FILE blocks in this mode.'
    )
    facts.push(
      'WEB: real tools — web_search and web_fetch. Search for anything current or web-related; never reply that you cannot browse the web.'
    )
  } else {
    facts.push(
      'FILES: edit-block mode is ON. Output ===FILE blocks (format above); the app shows an accept card and writes the file. Never reply that you cannot write or change files.'
    )
    const webMode = settings.webSearch ?? 'auto'
    if (webMode === 'off') {
      facts.push(
        'WEB: turned OFF by the user right now. Do not claim you can search this turn; if the answer needs current facts, say the web chip is off and they can set it to auto.'
      )
    } else if (hasWeb) {
      facts.push(
        'WEB: ON — the live results are attached directly below the question. Answer from them and cite the URLs; never say you cannot search the web.'
      )
    } else {
      facts.push(
        'WEB: ON (auto) — the app searches the internet when a question needs current facts and attaches the results below the question. If you need a search and none is attached, say "search the web for …" so the app runs one. Never claim you have no web access.'
      )
    }
  }
  if (modelNote) facts.push(`MODEL: ${modelNote}`)
  facts.push(
    'These are REAL capabilities, not hypothetical: do not tell the user you lack access to their files, folders, or the internet.'
  )
  return facts
}

function setupSection(facts: string[]): string {
  return (
    '## Your actual setup — REAL, right now\n' +
    facts.map((f) => `- ${f}`).join('\n') +
    '\nAnswer as the agent described here; never contradict this card.'
  )
}

/** The linked folder(s): a tree always, plus the REAL file contents in the
 *  classic flow — a model that cannot read files but is told not to invent
 *  their contents will otherwise refuse to edit and suggest instead. */
function folderSection(session: Session, agent: boolean): string | null {
  const folders = session.linkedFolders ?? []
  if (!folders.length) return null
  const blocks = folders.map((folder) => {
    const tree = fileTree(folder)
    const ctx = safeRead(path.join(folder, 'CODEZY.md')).trim()
    const proj = readProjectInstructions(folder)
    const head =
      `Folder: ${folder}\n` +
      (agent
        ? 'This folder is LINKED. Use read_file to open any file below.'
        : 'This folder is LINKED and you can change it. Its REAL file contents follow the tree.') +
      `\n\nTree:\n${tree || '(empty or unreadable)'}`
    let block = ctx ? `${head}\n\nCODEZY.md (project context):\n${ctx}` : head
    if (!agent) {
      const body = readFolderContents(folder)
      if (body) block += `\n\nFile contents (the real files — edit these directly):\n\n${body}`
    }
    if (proj) {
      block += `\n\n.codezy/instructions.md (project instructions — standing rules for THIS project, follow them):\n${proj}`
    }
    return block
  })
  return `## Linked folders — LINKED, real files\n${blocks.join('\n\n')}`.slice(0, 24000)
}

export function buildMessages(
  session: Session,
  project: Project | null,
  settings: Settings,
  /** Live web results for this turn (the normal chat has no tools, so the
   *  main process searched and read the pages for the model). */
  web?: string,
  opts: BuildOptions = {}
): ChatMessage[] {
  const agent = opts.agent ?? v2Active(session, settings)
  const hasWeb = !!web?.trim()
  const facts = setupFacts(session, settings, agent, opts.modelNote, hasWeb)
  const sections: string[] = [BASE_INSTRUCTIONS, setupSection(facts)]
  // The folder is the workspace — put it BEFORE the generic guidance, with
  // its real files in the no-tools flow.
  const folders = folderSection(session, agent)
  if (folders) sections.push(folders)

  // 0. mode — plan mode forbids edit blocks entirely
  if ((settings.mode ?? 'build') === 'plan') {
    sections.push(
      '## Mode: PLAN\nYou are in PLAN mode. Do NOT output ===FILE edit blocks. Explain the approach as a short numbered plan the user can approve — writing happens only after they switch to build/auto mode.'
    )
  }

  // 0a. thinking mode (long mode) — the app's Thinking button: a hard problem
  // deserves care, not speed. This is the prompting half; the sampling half
  // shifts the target to the careful end in chat:send.
  if (settings.thinkingMode) {
    sections.push(
      '## Thinking mode\n' +
        'The user turned on THINKING (long mode) — this deserves care, not speed. Before answering: ' +
        'restate the problem to yourself in one line, sketch a short plan, and when more than one ' +
        'reasonable approach exists, name the alternative you rejected and why. Work through it step ' +
        'by step, verify your reasoning before presenting it, check edge cases, and state your ' +
        'assumptions. Slower and thorough beats fast and wrong.'
    )
  }

  // 0b. agent mode (v2) — name the tools so the model never claims it has none
  // (same check as the router: no linked folder = plain chat, no tools)
  if (agent) {
    sections.push(
      '## Tools\n' +
        'You run with tools: list_dir, read_file, write_file, edit_file, glob, grep_search, run_command, web_search, web_fetch, todo_write.\n' +
        '- web_search queries the internet (DuckDuckGo) and returns titles, URLs and snippets. USE IT for ' +
        'anything current or web-related (releases, prices, docs, news, downloads) and whenever you are unsure. ' +
        'You DO have internet access through it — never claim you cannot search the web or lack that tool.\n' +
        '- web_fetch opens one URL and returns its text (HTML stripped to prose). After web_search, fetch the ' +
        '1–3 most promising links instead of answering from the snippets alone.\n' +
        '- todo_write saves your checklist (pending / in_progress / done). For any task with more than two steps, ' +
        'save the plan first and update it as you finish each step — the user watches the list.\n' +
        '- write_file, edit_file and run_command always ask the user for approval first; say in one short line what you are about to do.\n' +
        'How to work with the tools:\n' +
        '- Explore BEFORE you act: list_dir or grep_search to find the right file, read_file to see it. Never ' +
        'rewrite a file you have not read in this conversation, and never guess its contents.\n' +
        '- In this mode file changes go through write_file — do NOT output ===FILE / ===SEARCH edit blocks; ' +
        'those belong to the no-tools mode.\n' +
        '- Keep going until the task is actually done — real tasks take several tool steps; do not stop after ' +
        'one. When the tools make it possible, verify your work: re-read the changed file, grep for the symbol ' +
        'you touched, or run the project\'s tests/build with run_command when it has one.\n' +
        '- Finish with a short summary: what you changed and how you verified it. If something failed, say what ' +
        'you tried and the error you got.'
    )
  }

  // 0c. the web — the RESULTS ride with the question (see the end of this
  // function), but the model must be told it HAS the web, or it falls back
  // on "I cannot browse the internet" while the results sit right there
  if (web?.trim()) {
    sections.push(
      '## Web access\n' +
        'The turn below the user\'s question carries LIVE web results — titles, URLs, ' +
        'snippets and page text fetched from the internet a moment ago. Answer the ' +
        'question FROM them and cite the URLs you used. Never reply that you cannot ' +
        'browse the web, that you have no internet access, or that your information ' +
        'is out of date: the results are right there.'
    )
  }

  // 0d. standing instructions from the user — always close to the top, so a
  // small model cannot lose them under a long transcript
  if (settings.instructions?.trim()) {
    sections.push(`## Instructions from you\n${settings.instructions.trim()}`)
  }

  // 1. what CODEZY learned about the user
  if (settings.learn) {
    const memory = readMemory()
    if (memory.trim()) sections.push(`## What you know about the user\n${memory}`)
  }

  // 2. project context (like CLAUDE.md) + user profile
  if (project) {
    const ctx = project.context?.trim() || safeRead(p.projectContext(project.id))
    if (ctx) sections.push(`## Project: ${project.name}\n${ctx}`)
  }

  // 3. active skill, if one is on
  if (session.skill) {
    const skill = safeRead(`${p.skills()}/${session.skill}.md`)
    if (skill) sections.push(`## Active skill: ${session.skill}\n${skill}`)
  }

  // 4. the current goal — always last among instructions so it wins
  if (session.goal?.trim()) sections.push(`## Current goal\n${session.goal.trim()}`)

  // 5. /btw background notes
  if (session.notes?.length) sections.push(`## Background notes\n${session.notes.map((n) => `- ${n}`).join('\n')}`)

  const system: ChatMessage = {
    id: 'system',
    role: 'system',
    content: sections.join('\n\n'),
    ts: Date.now()
  }
  // 6. history, trimmed from the oldest end until it fits the budget.
  //    Oversized messages are SHRUNK (head + tail kept) rather than dropped,
  //    otherwise the oldest message — usually the attached code — vanishes
  //    and the model "forgets" what it's supposed to work on.
  //    No artificial cap: local runs get the full window, so history is only
  //    trimmed when we'd actually overflow the model's real context.
  const numCtx = contextSizeFor(session.effort ?? settings.effort)
  let budget = numCtx * CHARS_PER_TOKEN - system.content.length
  const perMsgCap = Math.max(1500, Math.floor(numCtx * CHARS_PER_TOKEN * 0.35))

  const history = [...session.messages].reverse() // newest first
  const kept: ChatMessage[] = []
  for (const raw of history) {
    const expanded = expandMessage(raw)
    let content = expanded.content
    if (content.length > perMsgCap) {
      const head = Math.floor(perMsgCap * 0.7)
      content =
        content.slice(0, head) +
        '\n…[truncated for context window]…\n' +
        content.slice(-(perMsgCap - head))
    }
    const size = content.length + 64
    if (size > budget) break
    budget -= size
    kept.push({ ...expanded, content })
  }
  kept.reverse() // restore chronological order

  const msgs: ChatMessage[] = [system, ...kept]

  // The setup + web ride RIGHT BEFORE the question, not only inside the
  // system prompt: a 7B weighs the newest turn far more than the oldest, and
  // "I cannot access your files / browse the web" is a very strong prior.
  const pinParts = [
    '## Session state — LIVE, read this before answering',
    facts.map((f) => `- ${f}`).join('\n')
  ]
  if (hasWeb) {
    pinParts.push('## Web results — LIVE, fetched from the internet just now', String(web).trim())
  }
  const pin: ChatMessage = {
    id: 'session-state',
    role: 'user',
    content: pinParts.join('\n\n'),
    ts: Date.now()
  }
  let lastUser = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser > 0) msgs.splice(lastUser, 0, pin)
  else msgs.push(pin)

  return msgs
}

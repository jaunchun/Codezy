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

const BASE_INSTRUCTIONS = `You are CODEZY, a coding assistant running locally on the user's machine.
Be direct and practical. Prefer small, correct code over long explanations.

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

/** Attachment content is hidden in the UI chip — expanded only for the model. */
function expandMessage(msg: ChatMessage): ChatMessage {
  if (!msg.files?.length) return msg
  const blocks = msg.files
    .map((f) => `Attached file: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n')
  return { ...msg, content: `${msg.content}\n\n${blocks}` }
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Builds the final message array. Called by the main process right before
 * streaming, so the renderer never needs to know about memory/context files.
 */
export function buildMessages(session: Session, project: Project | null, settings: Settings): ChatMessage[] {
  const sections: string[] = [BASE_INSTRUCTIONS]

  // 0. mode — plan mode forbids edit blocks entirely
  if ((settings.mode ?? 'build') === 'plan') {
    sections.push(
      '## Mode: PLAN\nYou are in PLAN mode. Do NOT output ===FILE edit blocks. Explain the approach as a short numbered plan the user can approve — writing happens only after they switch to build/auto mode.'
    )
  }

  // 0b. agent mode (v2) — name the tools so the model never claims it has none
  if (settings.v2) {
    sections.push(
      '## Tools\n' +
        'You run with tools: list_dir, read_file, write_file, grep_search, run_command, web_search, todo_write.\n' +
        '- web_search queries the internet (DuckDuckGo) and returns titles, URLs and snippets. USE IT for ' +
        'anything current or web-related (releases, prices, docs, news, downloads) and whenever you are unsure. ' +
        'You DO have internet access through it — never claim you cannot search the web or lack that tool.\n' +
        '- todo_write saves your checklist (pending / in_progress / done). For any task with more than two steps, ' +
        'save the plan first and update it as you finish each step — the user watches the list.\n' +
        '- write_file and run_command always ask the user for approval first; say in one short line what you are about to do.'
    )
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

  // 6. linked folders — a shallow file tree so the model knows what exists,
  //    plus the CODEZY.md context file that /init generates for the project
  if (session.linkedFolders?.length) {
    const blocks = session.linkedFolders.map((folder) => {
      const tree = fileTree(folder)
      const ctx = safeRead(path.join(folder, 'CODEZY.md')).trim()
      const head = `Folder: ${folder}\n${tree || '(empty or unreadable)'}`
      return ctx ? `${head}\n\nCODEZY.md (project context):\n${ctx}` : head
    })
    sections.push(`## Linked folders\n${blocks.join('\n\n')}`.slice(0, 12000))
  }

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

  return [system, ...kept]
}

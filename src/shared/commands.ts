// ---------------------------------------------------------------------------
// commands.ts — slash commands, handled by CODEZY itself.
// Why here (shared/) and not inside the model? A 7B model is unreliable at
// meta-instructions, so /goal, /model, /theme … are parsed by the app before
// anything reaches the model. Being in shared/ means the desktop app AND the
// future CLI use the exact same command definitions.
// ---------------------------------------------------------------------------

import type { EffortLevel, ThemeName } from './types'

export interface CommandInfo {
  name: string
  args: string
  description: string
  phase: 1 | 2 | 3 // helps /help mark what's available already
}

export const COMMANDS: CommandInfo[] = [
  { name: '/help', args: '', description: 'List every command', phase: 1 },
  { name: '/clear', args: '', description: 'Clear the current chat (stays in the session list)', phase: 1 },
  { name: '/new', args: '[project]', description: 'Start a new chat', phase: 1 },
  { name: '/model', args: '[id]', description: 'Show or switch the active model', phase: 1 },
  { name: '/provider', args: '[id|nebius key]', description: 'Switch providers — or connect Nebius Token Factory', phase: 1 },
  { name: '/effort', args: '<light|medium|deep>', description: 'How much thinking power to spend', phase: 1 },
  { name: '/mode', args: '<plan|build|auto>', description: 'plan = advice only · build = you accept edits · auto = apply them', phase: 1 },
  {
    name: '/theme',
    args: '<dark|light|acrylic|midnight|ember|mint|slate>',
    description: 'Switch the app theme or terminal accent palette',
    phase: 1
  },
  { name: '/copy', args: '[text]', description: 'Copy the last reply to the clipboard', phase: 1 },
  { name: '/rewind', args: '[n]', description: 'Drop the last messages — step back in this chat', phase: 1 },
  { name: '/fast', args: '', description: 'Toggle fast mode: effort light ↔ medium', phase: 1 },
  { name: '/diff', args: '[path]', description: 'Git changes vs HEAD in the linked folder', phase: 3 },
  { name: '/goal', args: '<text|show|clear>', description: 'Set the active goal the model must follow', phase: 1 },
  { name: '/btw', args: '<note|show|clear>', description: 'Add a background note that is always in context (not a message)', phase: 1 },
  { name: '/compact', args: '', description: 'Trim old history so the 7B context never overflows', phase: 1 },
  { name: '/learn', args: '<on|off>', description: 'Let CODEZY remember things about you', phase: 1 },
  { name: '/remember', args: '<fact>', description: 'Teach CODEZY a fact it must never forget', phase: 1 },
  { name: '/memory', args: '[clear]', description: 'Show (or clear) what CODEZY learned about you', phase: 1 },
  { name: '/drive', args: '<folder|off>', description: 'Mirror sessions into a Google Drive folder', phase: 1 },
  { name: '/export', args: '', description: 'Export this chat as Markdown', phase: 1 },
  { name: '/usage', args: '', description: 'Context window, token counts and session stats', phase: 1 },
  { name: '/doctor', args: '', description: 'Check the environment: model, endpoint, folder, memory', phase: 1 },
  { name: '/cost', args: '', description: 'Tokens this chat used — transcript estimate, last reply', phase: 1 },
  { name: '/skill', args: '<name|off>', description: 'Activate a skill (prompt playbook)', phase: 2 },
  { name: '/undo', args: '', description: 'Revert the last file edit CODEZY made', phase: 1 },
  { name: '/review', args: '', description: 'Review the pending edits like a code reviewer', phase: 2 },
  { name: '/search', args: '<query>', description: 'Search the internet (DuckDuckGo, no key)', phase: 3 },
  { name: '/add-dir', args: '<folder>', description: 'Link another folder to this chat', phase: 1 },
  { name: '/init', args: '', description: 'Generate a context file for the linked project folder', phase: 3 }
]

export type ParsedCommand =
  | { kind: 'command'; name: string; args: string }
  | { kind: 'remember'; fact: string }
  | { kind: 'chat'; text: string }

/** Splits "/goal ship the parser" into {name:'/goal', args:'ship the parser'}.
 *  "#fact" becomes {kind:'remember'} — the TUI's memory shortcut, same here. */
export function parseInput(raw: string): ParsedCommand {
  const text = raw.trim()
  if (text.startsWith('#') && text.length > 1) return { kind: 'remember', fact: text.slice(1).trim() }
  if (!text.startsWith('/')) return { kind: 'chat', text: raw }
  // only treat it as a command when the first word is a known command
  // (letters + hyphen — "/add-dir" is a command, "/usr/local" is a path)
  const match = text.match(/^\/([a-z][a-z-]*)(\s+(.*))?$/i)
  if (!match) return { kind: 'chat', text: raw }
  const name = `/${match[1].toLowerCase()}`
  const known = COMMANDS.some((c) => c.name === name)
  if (!known) return { kind: 'chat', text: raw } // e.g. "/usr/local" is a path, not a command
  return { kind: 'command', name, args: (match[3] ?? '').trim() }
}

export function helpText(): string {
  const pad = Math.max(...COMMANDS.map((c) => c.name.length))
  return COMMANDS.map((c) => {
    const usage = c.args ? `${c.name} ${c.args}` : c.name
    return `${usage.padEnd(pad + c.args.length + 1)}  ${c.description}`
  }).join('\n')
}

export function isEffort(v: string): v is EffortLevel {
  return v === 'light' || v === 'medium' || v === 'deep'
}

/** Every theme, in palette order — surfaces first, terminal accents after. */
export const THEME_NAMES: ThemeName[] = [
  'dark',
  'light',
  'acrylic',
  'midnight',
  'ember',
  'mint',
  'slate'
]

export function isTheme(v: string): v is ThemeName {
  return (THEME_NAMES as string[]).includes(v)
}

/** Which surface a theme paints: terminal palettes ride on the dark base. */
export function themeBase(v: ThemeName): 'dark' | 'light' | 'acrylic' {
  return v === 'light' ? 'light' : v === 'acrylic' ? 'acrylic' : 'dark'
}

/** Which accent palette a theme uses — dark/light/acrylic keep midnight blue. */
export function themePalette(v: ThemeName): 'midnight' | 'ember' | 'mint' | 'slate' {
  return v === 'ember' || v === 'mint' || v === 'slate' ? v : 'midnight'
}

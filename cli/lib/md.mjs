// ---------------------------------------------------------------------------
// md.mjs — terminal markdown renderer for model replies.
// wrapPlain measures against plain text (ANSI-safe); renderMd turns markdown
// into colored terminal lines: headings, bold/italic, inline code, links,
// lists, quotes, rules, and fenced code blocks with a language tag and a
// tiny syntax highlighter — the terminal twin of the app's code cards.
// ---------------------------------------------------------------------------

const A = '\x1b[38;2;61;155;255m' // accent #3d9bff
const D = '\x1b[2m' // dim
const BOLD = '\x1b[1m'
const ITAL = '\x1b[3m'
const CODE_FG = '\x1b[38;2;120;220;160m' // green inline/code text
const STR_FG = '\x1b[38;2;255;200;60m' // amber strings
const NUM_FG = '\x1b[38;2;130;200;255m' // cyan numbers
const COM_FG = '\x1b[38;2;110;125;145m' // gray comments
const OFF = '\x1b[0m'

export const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

/**
 * Word-wrap that preserves leading indentation (bands/meta depend on it)
 * and measures ANSI-colored text by its visible length.
 */
export function wrapPlain(text, w) {
  const out = []
  for (const para of String(text).split('\n')) {
    const indent = (para.match(/^[ \t]*/) || [''])[0]
    const body = para.slice(indent.length)
    const lim = Math.max(w - 1 - indent.length, 8)
    let cur = ''
    const push = () => {
      out.push(indent + cur)
      cur = ''
    }
    for (const word of body.split(' ')) {
      const cand = cur === '' ? word : `${cur} ${word}`
      if (plain(cand).length <= lim) {
        cur = cand
        continue
      }
      if (cur !== '') push()
      if (plain(word).length <= lim) cur = word
      else {
        let rest = word
        while (plain(rest).length > lim) {
          out.push(indent + rest.slice(0, lim))
          rest = rest.slice(lim)
        }
        cur = rest
      }
    }
    push()
  }
  return out
}

// -- syntax highlighting -----------------------------------------------------
// One pass, alternation order matters: strings first (so "http://x" inside a
// string doesn't look like a comment), then comments, numbers, keywords.

const HL_RE =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|#[^\n]*|--[^\n]*$|;[^\n]*$)|(\b\d+(?:\.\d+)?\b)|\b(const|let|var|function|return|if|else|for|while|class|new|import|from|export|await|async|def|elif|lambda|True|False|None|null|undefined|true|false|self|this|fn|pub|use|type|interface|struct|impl|match|case|switch|break|continue|try|catch|except|raise|print|require|module|package|static|public|private|void|int|string|bool|float)\b/g

/** Colors one line of code. Input must be plain (no ANSI). */
function hl(line) {
  return line.replace(HL_RE, (m, str, com, num, kw) => {
    if (str) return STR_FG + m + CODE_FG
    if (com) return COM_FG + m
    if (num) return NUM_FG + m
    if (kw) return BOLD + m + '\x1b[22m' + CODE_FG
    return m
  })
}

// -- inline markdown ---------------------------------------------------------

/** bold / italic / inline code / links — single non-overlapping pass. */
function inline(s) {
  return s.replace(
    /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\(([^)]+)\)/g,
    (m, code, b1, b2, i1, i2, ltext, lhref) => {
      if (code) return CODE_FG + code + '\x1b[39m'
      if (b1 || b2) return BOLD + (b1 ?? b2) + '\x1b[22m'
      if (i1 || i2) return ITAL + (i1 ?? i2) + '\x1b[23m'
      if (ltext) return A + ltext + '\x1b[39m' + ' ' + D + '(' + lhref + ')' + OFF
      return m
    }
  )
}

// -- fenced code blocks ------------------------------------------------------

/** Draws ```lang ... ``` as a bordered block that fits `w` columns. */
function codeBlock(lang, codeLines, w) {
  const inner = Math.max(w - 6, 16)
  const label = lang || 'code'
  const topDash = Math.max(inner - label.length - 1, 3)
  const out = [`${D}╭─ ${A}${label}${D} ${'─'.repeat(topDash)}╮${RESET_L}`]
  for (const raw of codeLines) {
    // hard-wrap long code lines by visible length, highlight after slicing
    const pieces = []
    let rest = raw
    if (rest === '') pieces.push('')
    else
      while (rest.length > inner) {
        pieces.push(rest.slice(0, inner))
        rest = rest.slice(inner)
      }
    pieces.push(rest)
    for (const p of pieces) out.push(`${D}│${RESET_L} ${CODE_FG}${hl(p)}${RESET_L} ${D}│${RESET_L}`)
  }
  out.push(`${D}╰${'─'.repeat(inner + 2)}╯${RESET_L}`)
  return out
}
const RESET_L = OFF

// -- main renderer -----------------------------------------------------------

const LIST_RE = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/

/**
 * Renders markdown text into an array of terminal lines, each ≤ w columns
 * (visible). Unclosed constructs while streaming are handled gracefully.
 */
export function renderMd(text, w) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // fenced code block
    const fence = line.match(/^\s*```(\S*)\s*$/)
    if (fence) {
      const lang = fence[1] || ''
      const code = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // skip closing fence (if present — streaming)
      out.push(...codeBlock(lang, code, w))
      continue
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      const style = level === 1 ? BOLD + A : level === 2 ? A : BOLD
      for (const t of wrapPlain(h[2], w - 2)) out.push(`${style}${inline(t)}${OFF}`)
      i++
      continue
    }

    // horizontal rule
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(D + '─'.repeat(Math.min(w, 60)) + OFF)
      i++
      continue
    }

    // blockquote
    const q = line.match(/^\s*>\s?(.*)$/)
    if (q) {
      const wrapped = wrapPlain(q[1], w - 3)
      wrapped.forEach((t, idx) =>
        out.push(`${D}${idx === 0 ? '▌' : ' '}${' '}${OFF}${D}${t}${OFF}`)
      )
      i++
      continue
    }

    // list item
    const li = line.match(LIST_RE)
    if (li) {
      const marker = li[1] ? `${A}▪${OFF}` : `${A}${li[2]}.${OFF}`
      const indent = (line.match(/^\s*/) || [''])[0]
      const wrapped = wrapPlain(li[3], w - indent.length - 3)
      wrapped.forEach((t, idx) => {
        const pad = ' '.repeat(indent.length)
        out.push(idx === 0 ? `${pad}${marker} ${inline(t)}` : `${pad}  ${inline(t)}`)
      })
      i++
      continue
    }

    // plain paragraph
    for (const t of wrapPlain(line, w)) out.push(inline(t))
    i++
  }
  return out
}

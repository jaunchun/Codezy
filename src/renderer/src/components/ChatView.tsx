import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js'
import { useApp } from '../store/app'
import type { ChatMessage } from '../../../shared/types'
import { stripEditBlocks } from '../../../shared/edits'
import {
  CubeLogo,
  IconBranch,
  IconChevronDown,
  IconChevronUp,
  IconClip,
  IconCopy,
  IconDownload,
  IconPencil,
  IconQuote,
  IconRefresh,
  IconTrash,
  IconX
} from './Icons'
import EditCard from './EditCard'
import UsagePanel from './UsageModal'
import TasksPanel from './TasksPanel'

const stamp = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** One-shot starter prompts for the empty state (Claude-style cards). */
const STARTERS = [
  { label: 'Explain code', desc: 'walk me through a file', text: 'Explain what this code does:\n\n' },
  { label: 'Fix a bug', desc: 'something is broken', text: 'I have a bug. ' },
  { label: 'Write something', desc: 'script, function, tool', text: 'Write a script that ' },
  { label: 'Plan a project', desc: 'structure before code', text: 'Help me plan this project: ' }
]

/** lang → file extension for the save/apply default names. */
const LANG_EXT: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'mjs', cjs: 'cjs',
  py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java', kt: 'kt',
  c: 'c', h: 'h', cpp: 'cpp', cs: 'cs', swift: 'swift', php: 'php',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  json: 'json', yaml: 'yaml', yml: 'yml', toml: 'toml', ini: 'ini', xml: 'xml', svg: 'svg',
  sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'ps1', powershell: 'ps1', bat: 'bat', cmd: 'bat',
  sql: 'sql', md: 'md', markdown: 'md', txt: 'txt', dockerfile: 'dockerfile', lua: 'lua'
}
const snippetName = (lang: string) => `snippet.${LANG_EXT[lang.toLowerCase()] ?? 'txt'}`

/** A code block with the language tag, line numbers and copy feedback.
 *  Starts COLLAPSED (faded ~3-line preview) — click to expand the full code.
 *  v3.1: **save** anywhere, and **apply into the linked folder** (backed up
 *  like every edit — /undo reverts it) when the chat has a folder linked.
 *  Exported for batch26 tests. */
export function CodeBlock({ lang, code, sessionId }: { lang: string; code: string; sessionId: string | null }) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const [applyOpen, setApplyOpen] = useState(false)
  const [applyPath, setApplyPath] = useState('')
  const [busy, setBusy] = useState(false)
  let html: string | null = null
  try {
    if (hljs.getLanguage(lang)) html = hljs.highlight(code, { language: lang }).value
  } catch {
    html = null
  }
  const lines = code.split('\n')
  // read (not subscribe): linking a folder re-renders ChatView, which
  // re-renders this block — no per-block store subscription during streaming
  const roots = sessionId ? (useApp.getState().sessions.find((x) => x.id === sessionId)?.linkedFolders ?? []) : []
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    void navigator.clipboard.writeText(code).catch(() => undefined)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  const save = (e: React.MouseEvent) => {
    e.stopPropagation()
    void window.codezy.dialog
      .saveText(snippetName(lang), code)
      .then((p) => {
        if (p) useApp.getState().addNotice(`Saved the block to ${p}`)
      })
      .catch(() => undefined)
  }
  const apply = async () => {
    if (!sessionId || busy) return
    const target = applyPath.trim()
    if (!target) return
    setBusy(true)
    try {
      await window.codezy.files.applyBlock(sessionId, target, code)
      useApp.getState().addNotice(`Wrote ${target} — /undo reverts this write`)
      setApplyOpen(false)
      setApplyPath('')
    } catch (err) {
      useApp.getState().addNotice(`Could not write ${target}: ${err instanceof Error ? err.message : err}`, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className={`codeblock${open ? ' open' : ''}`}
      title={open ? undefined : 'Click to expand the full code'}
      onClick={() => {
        if (!open) setOpen(true)
      }}
    >
      <header
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <span>
          {lang.toUpperCase()}
          {lines.length > 1 ? ` · ${lines.length} lines` : ''}
          {` · ${new Blob([code]).size} B`}
        </span>
        <span className="code-tools">
          <button className="copy" title="Copy the whole block" onClick={copy}>
            <IconCopy style={{ width: 12, height: 12 }} />
            {copied ? 'copied' : 'copy'}
          </button>
          <button className="copy" title="Save the block as a file…" onClick={save}>
            <IconDownload style={{ width: 12, height: 12 }} />
            save
          </button>
          {sessionId && roots.length > 0 && (
            <button
              className="copy"
              title="Write the block into the linked folder — backed up like every edit, /undo reverts it"
              onClick={(e) => {
                e.stopPropagation()
                setApplyPath((p) => p || snippetName(lang))
                setApplyOpen((v) => !v)
              }}
            >
              <IconPencil style={{ width: 12, height: 12 }} />
              apply
            </button>
          )}
          <button
            className="copy"
            title={open ? 'Collapse' : 'Expand the full code'}
            onClick={(e) => {
              e.stopPropagation()
              setOpen((v) => !v)
            }}
          >
            {open ? <IconChevronUp style={{ width: 12, height: 12 }} /> : <IconChevronDown style={{ width: 12, height: 12 }} />}
          </button>
        </span>
      </header>
      {applyOpen && (
        <div className="code-apply" onClick={(e) => e.stopPropagation()}>
          <input
            type="text"
            autoFocus
            aria-label="Path inside the linked folder"
            placeholder={`path inside the linked folder (e.g. src/${snippetName(lang)})`}
            value={applyPath}
            onChange={(e) => setApplyPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void apply()
              if (e.key === 'Escape') setApplyOpen(false)
            }}
          />
          <button className="copy" disabled={busy || !applyPath.trim()} onClick={() => void apply()}>
            {busy ? 'writing…' : 'write'}
          </button>
          <button className="copy" aria-label="Cancel" onClick={() => setApplyOpen(false)}>
            ✕
          </button>
        </div>
      )}
      <div className="code-body">
        {lines.length > 1 && (
          <div className="line-nums" aria-hidden>
            {lines.map((_, i) => (
              <span key={i}>{i + 1}</span>
            ))}
          </div>
        )}
        <pre>
          {html ? (
            <code dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <code>{code}</code>
          )}
        </pre>
      </div>
    </div>
  )
}

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i

/** Inline image attachment: thumbnail → click for a full-size lightbox. */
function ImageThumb({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  useEffect(() => {
    let alive = true
    void window.codezy.images.dataUrl(path).then((u) => {
      if (alive) setSrc(u)
    })
    return () => {
      alive = false
    }
  }, [path])
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  const name = path.split(/[\\/]/).pop() ?? path
  if (!src) return <span className="chip attach-chip">{name}</span>
  return (
    <>
      <button className="img-thumb" title={`${name} — click to view`} onClick={() => setFull(true)}>
        <img src={src} alt={name} />
      </button>
      {full && (
        <div className="lightbox" onClick={() => setFull(false)} role="dialog" aria-label={name}>
          <img src={src} alt={name} onClick={(e) => e.stopPropagation()} />
          <button className="lightbox-close" aria-label="Close image" onClick={() => setFull(false)}>
            <IconX />
          </button>
        </div>
      )}
    </>
  )
}

/**
 * A reply that dumps files as "heading + code block" (models that ignore the
 * patch format) — find every candidate so the card can save them to the folder.
 */
function extractDumps(content: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = []
  const seen = new Set<string>()
  const lines = content.split('\n')
  const asFile = (raw: string): string | null => {
    const t = raw
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\*\*(.+?)\*\*$/, '$1')
      .replace(/^`(.+)`$/, '$1')
      .trim()
      .replace(/[:.,]+$/, '')
      .trim()
    if (!/\.[A-Za-z0-9]{1,8}$/.test(t)) return null
    const rel = t.replace(/\\/g, '/')
    if (rel.includes('..') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || /\s/.test(rel)) return null
    return rel
  }
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const isHeading = /^#{1,6}\s+\S/.test(line) || /^\*\*[^*]+\*\*$/.test(line) || /^`[^`]+`$/.test(line)
    if (!isHeading) continue
    const rel = asFile(line)
    if (!rel || seen.has(rel)) continue
    // the code fence usually follows within a couple of lines
    let j = i + 1
    while (j < lines.length && j <= i + 4 && !lines[j].trim().startsWith('```')) j++
    if (j >= lines.length || j > i + 4 || !lines[j].trim().startsWith('```')) continue
    const code: string[] = []
    let k = j + 1
    for (; k < lines.length; k++) {
      if (lines[k].trim().startsWith('```')) break
      code.push(lines[k])
    }
    if (k >= lines.length || !code.length) continue
    seen.add(rel)
    out.push({ path: rel, content: code.join('\n') })
  }
  return out
}

/** "N files in this reply — Save all" card for markdown file dumps. */
function FileDumpCard({
  content,
  roots,
  onSaved
}: {
  content: string
  roots: string[]
  onSaved: () => void
}) {
  const s = useApp()
  const files = useMemo(() => extractDumps(content), [content])
  const [done, setDone] = useState(false)
  if (done || !files.length || !roots.length || !s.activeId) return null
  const save = async () => {
    try {
      const written = await window.codezy.files.saveDump(s.activeId!, files)
      const folder = roots[0].split(/[\\/]/).pop() ?? roots[0]
      s.addNotice(`Saved ${written.length} file${written.length === 1 ? '' : 's'} to ${folder}`)
      setDone(true)
      onSaved()
    } catch (e) {
      s.addNotice(`Save failed: ${e instanceof Error ? e.message : e}`, 'error')
    }
  }
  return (
    <div className="dump-card">
      <div className="dump-head">
        <IconDownload />
        <span>
          {files.length} file{files.length === 1 ? '' : 's'} in this reply
        </span>
        <button className="btn primary" onClick={() => void save()}>
          Save all
        </button>
      </div>
      <ul className="dump-list">
        {files.map((f) => (
          <li key={f.path}>{f.path}</li>
        ))}
      </ul>
    </div>
  )
}

/** "142ms" / "1.4s" for a tool step's wall time. */
const fmtMs = (ms: number): string => (ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`)
/** "612 B" / "4.2 KB" / "1.1 MB" for a tool result's size. */
const fmtSize = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

/** Persistent record of the agent's tool steps — collapsed gray line, expands on click. */
function TraceLine({ trace }: { trace: { name: string; ok: boolean; ms?: number; size?: number }[] }) {
  const [open, setOpen] = useState(false)
  const failed = trace.filter((t) => !t.ok).length
  return (
    <div className="trace">
      <button className="trace-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`trace-caret${open ? ' open' : ''}`} aria-hidden>
          <IconChevronDown />
        </span>
        {`${trace.length} tool step${trace.length === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`}
      </button>
      {open && (
        <ol className="trace-list">
          {trace.map((t, i) => (
            <li key={`${t.name}-${i}`} className={t.ok ? undefined : 'bad'}>
              <span aria-hidden>{t.ok ? '✓' : '✕'}</span>
              {t.name.replace(/_/g, ' ')}
              {/* v3.1 visibility: which MCP server + how long + how big */}
              {t.name.startsWith('mcp__') ? (
                <span className="trace-chip mcp">{t.name.split('__')[1]}</span>
              ) : null}
              {t.ms != null ? <span className="trace-chip">{fmtMs(t.ms)}</span> : null}
              {t.size != null ? <span className="trace-chip">{fmtSize(t.size)}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function AssistantText({ text, sessionId }: { text: string; sessionId: string | null }) {
  // the ===FILE edit blocks are rendered by the styled EditCard, not markdown
  const prose = stripEditBlocks(text)
  if (!prose.trim()) return null
  return (
    <div className="msg assistant md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // react-markdown gives us <pre><code class="language-x">… — unwrap it
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const raw = String(children ?? '').replace(/\n$/, '')
            const lang = /language-(\w+)/.exec(className ?? '')?.[1]
            if (!lang) return <code className="inline">{children}</code>
            return <CodeBlock lang={lang} code={raw} sessionId={sessionId} />
          }
        }}
      >
        {prose}
      </ReactMarkdown>
    </div>
  )
}

/** Human label for one agent-mode (v2) tool step on the streaming line. */
function v2ActivityLabel(a: { name: string; args: Record<string, unknown>; outcome: string }): string {
  const arg = (k: string) => String(a.args?.[k] ?? '')
  if (a.outcome === 'denied') return `✗ ${a.name} — you denied it`
  if (a.outcome === 'rejected') return `✗ ${a.name} — blocked by the safety check`
  if (a.outcome === 'error') return `✗ ${a.name} failed`
  if (a.outcome === 'unknown') return `✗ unknown tool: ${a.name}`
  switch (a.name) {
    case 'list_dir':
      return `listing ${arg('path') || '.'}…`
    case 'read_file':
      return `reading ${arg('path')}…`
    case 'write_file':
      return `writing ${arg('path')}…`
    case 'grep_search':
      return `searching for ${arg('pattern')}…`
    case 'run_command':
      return `running \`${arg('command').slice(0, 56)}\`…`
    case 'web_search':
      return 'searching the web…'
    case 'todo_write':
      return 'updating todos…'
    default:
      // MCP tools arrive namespaced as mcp__<server>__<tool> (v3)
      if (a.name.startsWith('mcp__')) {
        const [, server, tool] = a.name.split('__')
        return `calling ${server}/${tool}…`
      }
      return `${a.name}…`
  }
}

/** The three things people ask a fresh reply for — one tap, no typing. */
const FOLLOWUPS: { label: string; text: string }[] = [
  { label: 'Continue', text: 'Continue - pick up exactly where you stopped.' },
  { label: 'Explain', text: 'Explain what you just did and why, in a few short lines.' },
  { label: 'Review it', text: 'Review what you just changed like a code reviewer: bugs, edge cases, missing tests.' },
  { label: 'Add tests', text: 'What should be tested for the change you just made? Add the tests if the project has a test setup.' }
]

/** Quick follow-up chips under the newest reply (idle only — never while streaming). */
function QuickFollow() {
  const streaming = useApp((s) => s.streaming)
  const send = useApp((s) => s.send)
  return (
    <div className="followups" role="group" aria-label="Quick follow-ups">
      {FOLLOWUPS.map((f) => (
        <button key={f.label} className="followup" disabled={streaming} onClick={() => void send(f.text)}>
          {f.label}
        </button>
      ))}
    </div>
  )
}

/** Copy / quote / branch / regenerate / edit-and-resend - on message hover. */
function MsgActions({ message, canRegen }: { message: ChatMessage; canRegen: boolean }) {
  const s = useApp()
  const isUser = message.role === 'user'
  // delete is destructive → first click arms it, a second one commits
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 2600)
    return () => window.clearTimeout(t)
  }, [armed])
  const copy = () => {
    const prose = isUser ? message.content : stripEditBlocks(message.content).trim() || message.content
    void navigator.clipboard.writeText(prose).catch(() => undefined)
  }
  // quote into the composer — prefers the text you selected inside the message
  const quote = () => {
    const sel = window.getSelection()?.toString().trim()
    const src = (sel || message.content).trim()
    const lines = src.split('\n')
    const body =
      lines.slice(0, 10).map((l) => `> ${l}`).join('\n') + (lines.length > 10 ? '\n> …' : '')
    s.setComposerDraft(`${body}\n\n`)
  }
  return (
    <div className="msg-actions">
      <button className="act-btn" data-tip="Copy message" aria-label="Copy message" onClick={copy}>
        <IconCopy />
      </button>
      <button
        className="act-btn"
        data-tip="Quote into the composer — uses the selected text when you highlighted part of this message"
        aria-label="Quote into the composer"
        onClick={quote}
      >
        <IconQuote />
      </button>
      {!isUser && (
        <button
          className="act-btn"
          data-tip="Branch — new chat with the history up to this reply"
          aria-label="Branch from this reply"
          onClick={() => void s.branchFrom(message.id)}
        >
          <IconBranch />
        </button>
      )}
      {canRegen && (
        <button
          className="act-btn"
          data-tip="Regenerate — same request, new reply"
          aria-label="Regenerate"
          onClick={() => void s.regenerate(message.id)}
        >
          <IconRefresh />
        </button>
      )}
      {isUser && !s.streaming && (
        <button
          className="act-btn"
          data-tip="Edit and resend — this message and everything after it move back to the composer"
          aria-label="Edit and resend"
          onClick={() => void s.editFrom(message.id)}
        >
          <IconPencil />
        </button>
      )}
      {!s.streaming && (
        <button
          className={`act-btn${armed ? ' armed' : ''}`}
          data-tip={
            armed
              ? 'Click again to delete this message and everything after it'
              : 'Delete this message and everything after it'
          }
          aria-label="Delete from here"
          onClick={(e) => {
            e.stopPropagation()
            if (!armed) {
              setArmed(true)
              return
            }
            setArmed(false)
            void s.deleteFrom(message.id)
          }}
        >
          <IconTrash />
        </button>
      )}
    </div>
  )
}

// CSS Custom Highlight API — supported in Electron's Chromium; the bar hides
// itself if a future runtime ever lacks it
const cssHighlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
  .Highlight
const supportsFind = !!cssHighlights && typeof HighlightCtor === 'function'

export default function ChatView() {
  const { sessions, activeId, streamText, streaming, usageOpen, tasksOpen, setComposerDraft, v2Activity, scrollTarget } = useApp()
  const session = sessions.find((x) => x.id === activeId)
  const bottom = useRef<HTMLDivElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  // only chase the bottom while the user is already there — scrolling up to
  // read must never be yanked back down mid-generation
  const stick = useRef(true)
  const pinnedTo = useRef<string | null>(null)
  const [showJump, setShowJump] = useState(false)

  // in-chat find (Ctrl+F) — CSS Custom Highlight API, so the message list
  // itself never re-renders while you type a query
  const [findOpen, setFindOpen] = useState(false)
  const [findQ, setFindQ] = useState('')
  const [findIdx, setFindIdx] = useState(0)
  const [findCount, setFindCount] = useState(0)
  const findRanges = useRef<Range[]>([])
  const findInput = useRef<HTMLInputElement>(null)

  const stepFind = (dir: 1 | -1) => {
    const n = findRanges.current.length
    if (!n) return
    const next = (findIdx + dir + n) % n
    setFindIdx(next)
    const el = findRanges.current[next]?.startContainer.parentElement
    el?.scrollIntoView({ block: 'center', behavior: 'auto' })
  }

  const closeFind = () => {
    setFindOpen(false)
    setFindQ('')
    setFindIdx(0)
  }

  // recompute matches whenever the query, focus index or visible text changes
  useEffect(() => {
    if (!supportsFind) return
    const hl = cssHighlights!
    const clearAll = () => {
      hl.delete('chat-find')
      hl.delete('chat-find-cur')
      findRanges.current = []
      setFindCount(0)
    }
    if (!findOpen || !findQ.trim() || !session || !chatRef.current) {
      clearAll()
      return
    }
    const walker = document.createTreeWalker(chatRef.current, NodeFilter.SHOW_TEXT)
    const needle = findQ.trim().toLowerCase()
    const ranges: Range[] = []
    let node: Node | null
    while ((node = walker.nextNode())) {
      // skip UI chrome (action buttons, stamps, the find bar itself)
      if (node.parentElement?.closest('button, .msg-actions, .stamp, .find-bar, .chip')) continue
      const text = node.textContent ?? ''
      const lower = text.toLowerCase()
      let from = 0
      for (;;) {
        const at = lower.indexOf(needle, from)
        if (at === -1) break
        const r = new Range()
        r.setStart(node, at)
        r.setEnd(node, at + needle.length)
        ranges.push(r)
        from = at + needle.length
      }
    }
    findRanges.current = ranges
    setFindCount(ranges.length)
    const cur = Math.min(findIdx, Math.max(0, ranges.length - 1))
    if (cur !== findIdx) setFindIdx(cur)
    if (ranges.length) {
      hl.set('chat-find', new HighlightCtor!(...ranges))
      hl.set('chat-find-cur', new HighlightCtor!(ranges[cur]))
    } else {
      clearAll()
    }
  }, [findOpen, findQ, findIdx, activeId, session?.messages.length, streamText])

  // Ctrl+F opens the bar, Escape closes it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        if (!supportsFind) return
        // the cowork editor owns Ctrl+F while focus is inside it
        if (document.activeElement?.closest('.ide-pane')) return
        e.preventDefault()
        setFindOpen(true)
        setFindIdx(0)
        requestAnimationFrame(() => {
          findInput.current?.focus()
          findInput.current?.select()
        })
      }
      if (e.key === 'Escape') setFindOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (pinnedTo.current !== (activeId ?? null)) {
      pinnedTo.current = activeId ?? null
      stick.current = true // new chat → start pinned
      setShowJump(false)
    }
    // instant while tokens stream in: smooth animations can't keep pace with
    // 40 tokens/sec and would leave the view lagging behind the text
    if (stick.current) bottom.current?.scrollIntoView({ behavior: streamText ? 'auto' : 'smooth' })
  }, [session?.messages.length, streamText, activeId, usageOpen, tasksOpen])

  // a generation just started (you sent something) → follow it from the start
  useEffect(() => {
    if (streaming) {
      stick.current = true
      setShowJump(false)
    }
  }, [streaming])

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
    setShowJump(!stick.current)
  }

  // cross-chat search (v3.1): a picked hit sets scrollTarget — scroll the
  // message into view and flash it, then clear the target so re-renders don't
  // re-trigger the jump
  const [flashId, setFlashId] = useState<string | null>(null)
  useEffect(() => {
    if (!scrollTarget || scrollTarget.sessionId !== activeId) return
    const want = scrollTarget.messageId
    const el = [...document.querySelectorAll<HTMLElement>('[data-mid]')].find((n) => n.dataset.mid === want)
    el?.scrollIntoView({ block: 'center', behavior: 'auto' })
    setFlashId(want)
    const t = window.setTimeout(() => useApp.getState().clearScrollTarget(), 500)
    return () => window.clearTimeout(t)
  }, [scrollTarget, activeId])
  // the ring fades on its own clock — decoupled from the target so clearing
  // scrollTarget above can never cancel the fade
  useEffect(() => {
    if (!flashId) return
    const t = window.setTimeout(() => setFlashId(null), 2200)
    return () => window.clearTimeout(t)
  }, [flashId])

  const jump = () => {
    stick.current = true
    setShowJump(false)
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p

  const lastAssistantId = session
    ? [...session.messages].reverse().find((m) => m.role === 'assistant' && !m.hidden)?.id
    : null

  // live activity: once the model starts emitting edit blocks it is proposing
  // files — say so instead of the generic "writing…" hint
  const proposing = streaming && streamText.includes('===FILE')

  return (
    <>
      {showJump && <div className="chat-fade" aria-hidden />}
      {findOpen && supportsFind && (
        <div className="find-bar" role="search">
          <input
            ref={findInput}
            value={findQ}
            placeholder="Find in chat…"
            onChange={(e) => {
              setFindQ(e.target.value)
              setFindIdx(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                stepFind(e.shiftKey ? -1 : 1)
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                closeFind()
              }
            }}
          />
          <span className="find-count">
            {findQ.trim() ? (findCount ? `${Math.min(findIdx + 1, findCount)}/${findCount}` : '0/0') : '–'}
          </span>
          <button data-tip="Previous match — Shift+Enter" aria-label="Previous match" onClick={() => stepFind(-1)}>
            <IconChevronUp style={{ width: 13, height: 13 }} />
          </button>
          <button data-tip="Next match — Enter" aria-label="Next match" onClick={() => stepFind(1)}>
            <IconChevronDown style={{ width: 13, height: 13 }} />
          </button>
          <button data-tip="Close — Esc" aria-label="Close find" onClick={closeFind}>
            <IconX style={{ width: 13, height: 13 }} />
          </button>
        </div>
      )}
      <div className="chat" ref={chatRef} onScroll={onScroll}>
        {!session || session.messages.length === 0 ? (
          <div className="empty-state">
            <CubeLogo withBrackets />
            <div className="name">CODEZY</div>
            <div>
              Ask anything… try <b>/help</b> for commands
              {session?.goal ? ` · goal: ${session.goal}` : ''}
            </div>
            <div className="starter-grid">
              {STARTERS.map((st) => (
                <button key={st.label} className="starter-card" onClick={() => setComposerDraft(st.text)}>
                  <b>{st.label}</b>
                  <span>{st.desc}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          session.messages
            .filter((m) => !m.hidden)
            .map((m: ChatMessage) =>
            m.role === 'user' ? (
              <div key={m.id} className={`msg-row user${flashId === m.id ? ' flash' : ''}`} data-mid={m.id}>
                <div className="msg">
                  {m.files?.length ? (
                    <div
                      className="row"
                      style={{ justifyContent: 'flex-start', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}
                    >
                      {m.files.map((f) =>
                        IMG_RE.test(f.path) ? (
                          <ImageThumb key={f.path} path={f.path} />
                        ) : (
                          <button
                            key={f.path}
                            className="chip attach-chip"
                            title={`${f.path} — click to open the saved file`}
                            onClick={() => void window.codezy.files.open(f.path)}
                          >
                            <IconClip style={{ width: 12, height: 12 }} />
                            {baseName(f.path)}
                          </button>
                        )
                      )}
                    </div>
                  ) : null}
                  <div className="bubble">{m.content}</div>
                  <div className="stamp">{stamp(m.ts)}</div>
                  <MsgActions message={m} canRegen={false} />
                </div>
              </div>
            ) : (
              <div key={m.id} className={`msg-row${flashId === m.id ? ' flash' : ''}`} data-mid={m.id}>
                <div className="msg">
                  {m.trace?.length ? <TraceLine trace={m.trace} /> : null}
                  <AssistantText text={m.content} sessionId={session?.id ?? null} />
                  <div className="stamp">
                    {stamp(m.ts)}
                    {m.model ? ` · ${m.model}` : ''}
                  </div>
                  <MsgActions message={m} canRegen={m.id === lastAssistantId && !streaming} />
                  {m.id === lastAssistantId && !streaming && m.content.trim() && <QuickFollow />}
                  <EditCard message={m} />
                  <FileDumpCard
                    content={m.content}
                    roots={session?.linkedFolders ?? []}
                    onSaved={() => useApp.getState().bumpIdeTick()}
                  />
                </div>
              </div>
            )
          )
        )}

        {streaming && streamText && (
          <div className="msg-row">
            <div className="msg">
              <AssistantText text={streamText} sessionId={session?.id ?? null} />
              {proposing ? (
                <div className="activity">
                  <span className="act-dot" aria-hidden />
                  proposing file edits — a review card appears when the reply finishes
                </div>
              ) : (
                <div className="stamp writing">writing…</div>
              )}
            </div>
          </div>
        )}
        {streaming && !streamText && (
          <div className="msg-row">
            <div className="msg">
              <div className="activity">
                <span className="act-dot" aria-hidden />
                {v2Activity ? v2ActivityLabel(v2Activity) : 'thinking…'}
              </div>
            </div>
          </div>
        )}

        {showJump && (
          <button className="jump-bottom" onClick={jump} title="Jump to the latest message" aria-label="Jump to the latest message">
            <IconChevronDown style={{ width: 15, height: 15 }} />
          </button>
        )}

        {/* batch30 — the agent's background children (kill / read output) */}
        {tasksOpen && <TasksPanel />}

        {/* /usage → the stats dashboard as a small window inside the chat */}
        {usageOpen && <UsagePanel />}

        <div ref={bottom} />
      </div>
    </>
  )
}

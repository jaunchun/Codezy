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
  IconX
} from './Icons'
import EditCard from './EditCard'
import UsagePanel from './UsageModal'

const stamp = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** One-shot starter prompts for the empty state (Claude-style cards). */
const STARTERS = [
  { label: 'Explain code', desc: 'walk me through a file', text: 'Explain what this code does:\n\n' },
  { label: 'Fix a bug', desc: 'something is broken', text: 'I have a bug. ' },
  { label: 'Write something', desc: 'script, function, tool', text: 'Write a script that ' },
  { label: 'Plan a project', desc: 'structure before code', text: 'Help me plan this project: ' }
]

/** A code block with the language tag, line numbers and copy feedback.
 *  Starts COLLAPSED (faded ~3-line preview) — click to expand the full code. */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  let html: string | null = null
  try {
    if (hljs.getLanguage(lang)) html = hljs.highlight(code, { language: lang }).value
  } catch {
    html = null
  }
  const lines = code.split('\n')
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    void navigator.clipboard.writeText(code).catch(() => undefined)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
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
        </span>
        <span className="code-tools">
          <button className="copy" title="Copy the whole block" onClick={copy}>
            <IconCopy style={{ width: 12, height: 12 }} />
            {copied ? 'copied' : 'copy'}
          </button>
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

/** Persistent record of the agent's tool steps — collapsed gray line, expands on click. */
function TraceLine({ trace }: { trace: { name: string; ok: boolean }[] }) {
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
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function AssistantText({ text }: { text: string }) {
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
            return <CodeBlock lang={lang} code={raw} />
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
      return `${a.name}…`
  }
}

/** Copy / quote / branch / regenerate / edit-and-resend — on message hover. */
function MsgActions({ message, canRegen }: { message: ChatMessage; canRegen: boolean }) {
  const s = useApp()
  const isUser = message.role === 'user'
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
  const { sessions, activeId, streamText, streaming, usageOpen, setComposerDraft, v2Activity } = useApp()
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
  }, [session?.messages.length, streamText, activeId, usageOpen])

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
              <div key={m.id} className="msg-row user">
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
              <div key={m.id} className="msg-row">
                <div className="msg">
                  {m.trace?.length ? <TraceLine trace={m.trace} /> : null}
                  <AssistantText text={m.content} />
                  <div className="stamp">
                    {stamp(m.ts)}
                    {m.model ? ` · ${m.model}` : ''}
                  </div>
                  <MsgActions message={m} canRegen={m.id === lastAssistantId && !streaming} />
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
              <AssistantText text={streamText} />
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

        {/* /usage → the stats dashboard as a small window inside the chat */}
        {usageOpen && <UsagePanel />}

        <div ref={bottom} />
      </div>
    </>
  )
}

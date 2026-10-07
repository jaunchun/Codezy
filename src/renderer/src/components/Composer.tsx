import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store/app'
import type { EffortLevel } from '../../../shared/types'
import type { FileRef } from '../../../shared/api'
import { COMMANDS, THEME_NAMES } from '../../../shared/commands'
import ModelPicker from './ModelPicker'
import { IconClip, IconCode, IconLinkFolder, IconSend, IconStop, IconTrash } from './Icons'

interface Attachment {
  path: string
  content: string
}

/** Finds a trailing "@query" before the caret: returns its start + query. */
function detectMention(text: string, caret: number): { start: number; q: string } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  return m ? { start: m.index + m[1].length, q: m[2] } : null
}

const EFFORTS: { id: EffortLevel; label: string; title: string }[] = [
  { id: 'light', label: 'light', title: 'fast, casual sampling — temperature 0.9' },
  { id: 'medium', label: 'medium', title: 'balanced — temperature 0.6' },
  { id: 'deep', label: 'deep', title: 'careful and thorough — temperature 0.2, longer replies' }
]

const MODES: { id: 'plan' | 'build' | 'auto'; label: string; title: string }[] = [
  { id: 'plan', label: 'plan', title: 'Plan mode — the model only advises, never writes files' },
  { id: 'build', label: 'build', title: 'Build mode — edits are proposed, you accept or decline them' },
  { id: 'auto', label: 'auto', title: 'Auto mode — edits are applied right away (backed up, /undo reverts)' }
]

export default function Composer() {
  const s = useApp()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [cmdIdx, setCmdIdx] = useState(0)
  const [cmdDismissed, setCmdDismissed] = useState(false)
  // "@" file mention: active range in the text, debounced result list
  const [mention, setMention] = useState<{ start: number; q: string } | null>(null)
  const [mentionList, setMentionList] = useState<FileRef[]>([])
  const [mentionIdx, setMentionIdx] = useState(0)
  const mentionTimer = useRef<number | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  // "/cmd arg" suggestions + drag-drop + per-chat draft bookkeeping
  const [argIdx, setArgIdx] = useState(0)
  const [skillNames, setSkillNames] = useState<string[]>([])
  const [dropping, setDropping] = useState(false)
  const lastChat = useRef<string | null>(null)

  const session = s.sessions.find((x) => x.id === s.activeId)
  const folders = session?.linkedFolders ?? []

  // context meter: rough tokens for this conversation — a plain usage
  // counter, no denominator: local models are not artificially capped
  const effort = session?.effort ?? s.settings?.effort ?? 'medium'
  const ctxUsed = Math.round((session?.messages.reduce((n, m) => n + m.content.length, 0) ?? 0) / 4)
  const fmtTok = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`)

  // clear staged attachments when you switch chats
  useEffect(() => {
    setFiles([])
  }, [s.activeId])

  // pick up one-shot drafts (starter cards, edit-and-resend)
  const draft = s.composerDraft
  useEffect(() => {
    if (draft == null) return
    setText(draft)
    setFiles([])
    setCmdDismissed(false)
    setCmdIdx(0)
    requestAnimationFrame(() => {
      resize()
      ta.current?.focus()
    })
    s.setComposerDraft(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  // skill names for "/skill <name>" argument completion (loaded once)
  useEffect(() => {
    void window.codezy.skills
      .list()
      .then((list) => setSkillNames(list))
      .catch(() => undefined)
  }, [])

  // stash the unsent draft of the chat you're leaving and restore the new
  // chat's draft — switching conversations never loses what you typed
  useEffect(() => {
    const prev = lastChat.current
    if (prev != null && prev !== s.activeId) s.setChatDraft(prev, text)
    lastChat.current = s.activeId
    if (draft != null) return // a one-shot draft (starter card, edit-resend) wins this slot
    const saved = s.activeId ? (s.chatDrafts[s.activeId] ?? '') : ''
    if (saved !== text) {
      setText(saved)
      requestAnimationFrame(resize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.activeId])

  function resize() {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
  }

  // "/" popup: visible only while the command name is UNFINISHED. Once the
  // name is complete (e.g. "/usage") the popup hides itself — otherwise
  // Enter kept re-filling the name and the command could never be sent.
  const cmdQuery = useMemo(() => {
    const t = text.trim().toLowerCase()
    if (!t.startsWith('/') || t.includes(' ')) return null
    return COMMANDS.filter((c) => c.name.startsWith(t) && c.name !== t)
  }, [text])
  const showCmd = !!cmdQuery && cmdQuery.length > 0 && !cmdDismissed
  const showMention = !!mention && mentionList.length > 0

  // "/cmd arg" suggestions — kick in once the command name gets a space
  // ("/model l…"), so the name popup and the argument popup never collide
  const argSuggest = useMemo(() => {
    const m = /^\/([a-z]+)\s(\S*)$/.exec(text.trim())
    if (!m) return null
    const q = m[2].toLowerCase()
    const mk = (values: { value: string; label?: string }[]) => ({
      cmd: m[1],
      values: values.filter((v) => v.value.toLowerCase().includes(q)).slice(0, 8)
    })
    switch (m[1]) {
      case 'model':
        return mk(s.models.map((x) => ({ value: x.id, label: x.providerName })))
      case 'effort':
        return mk(EFFORTS.map((x) => ({ value: x.id, label: x.title })))
      case 'mode':
        return mk(MODES.map((x) => ({ value: x.id, label: x.title })))
      case 'theme':
        return mk(THEME_NAMES.map((t) => ({ value: t })))
      case 'skill':
        return mk(skillNames.map((n) => ({ value: n })))
      default:
        return null
    }
  }, [text, s.models, skillNames])
  const argList = argSuggest?.values ?? []
  const showArgs = argList.length > 0 && !cmdDismissed

  async function submit() {
    const value = text.trim()
    if (!value) return
    // the file open in cowork rides along with the message (shown as a chip
    // below the input) — otherwise the model has to ask you to paste the code
    const picked = s.ideOpen && s.ideFile ? s.ideFile : null
    const payload =
      picked && !files.some((f) => f.path === picked.path)
        ? [...files, { path: picked.path, content: picked.content.slice(0, 100_000) }]
        : files
    setText('')
    setFiles([])
    setCmdIdx(0)
    setMention(null)
    setMentionList([])
    requestAnimationFrame(resize)
    await s.send(value, payload)
  }

  /** Replaces the @query with the picked file and stages it as an attachment. */
  async function pickMention(file: FileRef) {
    const el = ta.current
    if (!el || !mention) return
    const value = el.value
    const caret = el.selectionStart ?? value.length
    const insertAt = mention.start
    const next = value.slice(0, insertAt) + '@' + file.name + ' ' + value.slice(caret)
    const after = insertAt + file.name.length + 2 // '@' + name + ' '
    setText(next)
    setMention(null)
    setMentionList([])
    setMentionIdx(0)
    // its content rides along with the message (expandMessage in main/prompt.ts)
    if (s.activeId && !files.some((f) => f.path === file.path)) {
      const content = await window.codezy.files.read(s.activeId, file.path)
      if (content != null) setFiles((prev) => [...prev, { path: file.path, content }])
    }
    requestAnimationFrame(() => {
      resize()
      el.focus()
      el.setSelectionRange(after, after)
    })
  }

  /** Replaces the "/cmd partial" argument with the picked value. */
  function pickArg(value: string) {
    const m = /^\/([a-z]+)\s(\S*)$/.exec(text.trim())
    if (!m) return
    setText(`/${m[1]} ${value} `)
    setArgIdx(0)
    setCmdDismissed(true) // hides the popup so Enter now sends the command
    requestAnimationFrame(() => {
      resize()
      ta.current?.focus()
    })
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // "@" file mention navigation takes priority while it's open
    if (showMention) {
      const list = mentionList
      const idx = Math.min(mentionIdx, list.length - 1)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIdx(Math.min(idx + 1, list.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIdx(Math.max(idx - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        void pickMention(list[idx])
        return
      }
      if (e.key === 'Escape') {
        setMention(null)
        setMentionList([])
        return
      }
    }
    // command popup navigation takes priority while it's open
    if (showCmd) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCmdIdx((i) => Math.min(i + 1, cmdQuery!.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCmdIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const picked = cmdQuery![cmdIdx] ?? cmdQuery![0]
        setText(`${picked.name} `)
        setCmdIdx(0)
        requestAnimationFrame(resize)
        return
      }
      if (e.key === 'Escape') {
        setCmdDismissed(true)
        return
      }
    }
    // "/cmd arg" suggestion navigation
    if (showArgs) {
      const idx = Math.min(argIdx, argList.length - 1)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setArgIdx(Math.min(idx + 1, argList.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setArgIdx(Math.max(idx - 1, 0))
        return
      }
      if (
        (e.key === 'Enter' || e.key === 'Tab') &&
        (e.currentTarget.selectionStart ?? 0) === text.length
      ) {
        e.preventDefault()
        pickArg(argList[idx].value)
        return
      }
      if (e.key === 'Escape') {
        setCmdDismissed(true)
        return
      }
    }
    // Enter sends (or Ctrl+Enter when "Enter makes a newline" is set)
    const enterSends = s.settings?.enterSends !== false
    if (e.key === 'Enter' && enterSends && !e.shiftKey) {
      e.preventDefault()
      void submit()
      return
    }
    if (e.key === 'Enter' && !enterSends && e.ctrlKey && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  /** Drop files in → stage their contents; drop folders → link them to this chat. */
  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDropping(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.codezy.filesPath(f))
      .filter((p): p is string => !!p)
    if (!paths.length) return
    const res = await window.codezy.files.ingest(paths)
    if (res.files.length) {
      setFiles((prev) => [...prev, ...res.files.filter((f) => !prev.some((p) => p.path === f.path))])
    }
    for (const d of res.dirs) {
      if (folders.includes(d)) continue
      if (!s.activeId) await s.newChat(s.filterProjectId)
      await s.linkFolder(d)
    }
    if (res.skipped.length) {
      s.addNotice(`Skipped ${res.skipped.length} dropped file(s) — binary or larger than 2 MB`)
    }
  }

  async function linkFolder() {
    // linking no longer requires a project — it attaches to this chat
    if (!s.activeId) await s.newChat(s.filterProjectId)
    const folder = await window.codezy.dialog.pickFolder('Link folder to this chat')
    if (folder) await s.linkFolder(folder)
  }

  return (
    <div
      className={`composer-wrap${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!dropping && e.dataTransfer.types.includes('Files')) setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => void onDrop(e)}
    >
      {/* "@" file mention — workspace files from the linked folders */}
      {showMention && (
        <div className="cmd-popup">
          <div className="cmd-head">
            <span>
              Files{mention!.q ? ` matching “${mention!.q}”` : ' in linked folders'}
            </span>
            <span className="cmd-head-hint">@ to search</span>
          </div>
          {mentionList.map((f, i) => (
            <button
              key={f.path}
              className={`cmd-item ${i === Math.min(mentionIdx, mentionList.length - 1) ? 'sel' : ''}`}
              onMouseEnter={() => setMentionIdx(i)}
              onClick={() => void pickMention(f)}
            >
              <span className="cmd-name mention-name">@{f.name}</span>
            </button>
          ))}
          <div className="cmd-foot">↑↓ navigate · ↵ attach the file · esc dismiss</div>
        </div>
      )}

      {/* "/" command menu */}
      {showCmd && (
        <div className="cmd-popup">
          <div className="cmd-head">
            <span>Commands</span>
            <span className="cmd-head-hint">keep typing to filter</span>
          </div>
          {cmdQuery!.map((c, i) => (
            <button
              key={c.name}
              className={`cmd-item ${i === cmdIdx ? 'sel' : ''}`}
              onMouseEnter={() => setCmdIdx(i)}
              onClick={() => {
                setText(`${c.name} `)
                setCmdIdx(0)
                requestAnimationFrame(resize)
                ta.current?.focus()
              }}
            >
              <span className="cmd-name">{c.name}</span>
              <span className="cmd-desc">{c.description}</span>
              {c.args && <span className="cmd-usage">{c.args}</span>}
            </button>
          ))}
          <div className="cmd-foot">↑↓ navigate · ↵ insert · esc dismiss</div>
        </div>
      )}

      {/* linked folders of this chat */}
      {folders.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {folders.map((f) => (
            <span key={f} className="chip attach-chip" title={f}>
              <IconLinkFolder style={{ width: 12, height: 12 }} />
              {f.split(/[\\/]/).pop()}
              <IconTrash
                style={{ width: 12, height: 12, cursor: 'pointer' }}
                onClick={() => void s.unlinkFolder(f)}
              />
            </span>
          ))}
        </div>
      )}

      {/* staged attachments (become chips on the sent bubble) */}
      {files.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {files.map((f, i) => (
            <span key={i} className="chip attach-chip" title={f.path}>
              <IconClip style={{ width: 12, height: 12 }} />
              {f.path.split(/[\\/]/).pop()}
              <IconTrash
                style={{ width: 12, height: 12, cursor: 'pointer' }}
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
              />
            </span>
          ))}
        </div>
      )}

      {/* the file open in cowork — included with the next message while Cowork is open */}
      {s.ideOpen && s.ideFile && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span
            className="chip attach-chip ide-chip"
            title={`${s.ideFile.path} — included with your next message (close Cowork to stop)`}
          >
            <IconCode style={{ width: 12, height: 12 }} />
            {s.ideFile.path.split(/[\\/]/).pop()}
          </span>
        </div>
      )}

      {/* "/cmd arg" suggestions — models, effort, theme, mode, skills */}
      {showArgs && argSuggest && (
        <div className="cmd-popup">
          <div className="cmd-head">
            <span>
              /{argSuggest.cmd} <span className="cmd-head-hint">argument</span>
            </span>
            <span className="cmd-head-hint">tab / ↵ insert</span>
          </div>
          {argList.map((v, i) => (
            <button
              key={v.value}
              className={`cmd-item ${i === Math.min(argIdx, argList.length - 1) ? 'sel' : ''}`}
              onMouseEnter={() => setArgIdx(i)}
              onClick={() => pickArg(v.value)}
            >
              <span className="cmd-name">{v.value}</span>
              {v.label && <span className="cmd-desc">{v.label}</span>}
            </button>
          ))}
          <div className="cmd-foot">↑↓ navigate · ↵ insert · esc dismiss</div>
        </div>
      )}

      <div className="composer">
        <textarea
          ref={ta}
          value={text}
          placeholder={
            s.settings?.enterSends !== false
              ? 'Ask anything… (Shift+Enter for a new line, / for commands)'
              : 'Ask anything… (Ctrl+Enter to send, / for commands)'
          }
          onChange={(e) => {
            const value = e.target.value
            const caret = e.target.selectionStart ?? value.length
            setText(value)
            setCmdDismissed(false)
            setCmdIdx(0)
            setArgIdx(0)
            resize()
            // "@" mention → debounced file lookup in the linked folders
            const hit = detectMention(value, caret)
            if (hit && s.activeId) {
              setMention(hit)
              setMentionIdx(0)
              if (mentionTimer.current) window.clearTimeout(mentionTimer.current)
              const sid = s.activeId
              mentionTimer.current = window.setTimeout(() => {
                void window.codezy.files
                  .list(sid, hit.q)
                  .then((list) => setMentionList(list))
                  .catch(() => setMentionList([]))
              }, 90)
            } else {
              setMention(null)
              setMentionList([])
            }
          }}
          onKeyDown={onKey}
          onPaste={(e) => {
            // paste an image straight from the clipboard — it stages as an attachment
            const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'))
            if (!item) return
            e.preventDefault()
            void window.codezy.images.paste().then((p) => {
              if (p) setFiles((prev) => [...prev.filter((f) => f.path !== p), { path: p, content: '' }])
            })
          }}
        />

        <div className="composer-tools">
          <button
            className="chip icon-chip"
            data-tip="Attach files"
            onClick={async () => setFiles(await window.codezy.dialog.pickFiles())}
          >
            <IconClip style={{ width: 13, height: 13 }} />
          </button>

          <button className="chip icon-chip" data-tip="Link a folder to this chat" onClick={() => void linkFolder()}>
            <IconLinkFolder style={{ width: 13, height: 13 }} />
          </button>

          <ModelPicker />

          {/* effort — circle badge "E", expands into the options on hover */}
          <div className="seg-fab" title="Effort — sampling temperature (hover to choose)">
            <span className="seg-badge">E</span>
            <div className="segmented">
              {EFFORTS.map((e) => (
                <button
                  key={e.id}
                  className={effort === e.id ? 'on' : ''}
                  title={e.title}
                  onClick={() =>
                    void (s.activeId
                      ? s.setSessionGen(s.activeId, { effort: e.id })
                      : s.updateSettings({ effort: e.id }))
                  }
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>

          {/* mode — circle badge "M" (plan / build / auto), popover on hover */}
          <div className="seg-fab seg-fab-right" title="Mode — plan, build or auto (hover to choose)">
            <span className="seg-badge">M</span>
            <div className="segmented mode-seg">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  data-mode={m.id}
                  className={(s.settings?.mode ?? 'build') === m.id ? 'on' : ''}
                  title={m.title}
                  onClick={() => void s.updateSettings({ mode: m.id })}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <span className="grow" />

          <span
            className="ctx-meter tip-wrap"
            data-tip="Approximate conversation size (chars ÷ 4) — local models run uncapped, nothing is trimmed until the real window fills"
          >
            <span className="ctx-label">≈{fmtTok(ctxUsed)}</span>
          </span>

          {s.streaming ? (
            <>
              {text.trim() ? (
                <button
                  className="send interject"
                  data-tip="Send now — cuts into the reply"
                  onClick={() => void submit()}
                >
                  <IconSend />
                </button>
              ) : null}
              <button className="send stop" data-tip="Stop generating" onClick={() => void s.stop()}>
                <IconStop />
              </button>
            </>
          ) : (
            <button className="send" data-tip="Send — Enter" disabled={!text.trim()} onClick={() => void submit()}>
              <IconSend />
            </button>
          )}
        </div>
      </div>

      <div className="hint">
        {s.ollama === 'offline'
          ? 'Ollama is not running — start it with `ollama serve`'
          : 'CODEZY runs locally · your chats never leave this machine'}
      </div>
    </div>
  )
}

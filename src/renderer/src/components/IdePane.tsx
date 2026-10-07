import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../store/app'
import type { IdeNode } from '../../../shared/api'
import { IconChevronDown, IconFolder, IconPlus, IconRefresh, IconX } from './Icons'

const isImg = (p: string): boolean => /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(p)

const normPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
/** Absolute, root-anchored, or suffix match — the agent passes paths in any form. */
function sameFile(agentPath: string, target: string, rootFolders: string[]): boolean {
  const a = normPath(agentPath)
  const t = normPath(target)
  if (a === t || t.endsWith('/' + a) || a.endsWith('/' + t)) return true
  const anchor = rootFolders.map(normPath).find((r) => t.startsWith(r + '/'))
  return anchor ? t === anchor + '/' + a : false
}

/** Ancestor directory paths of `target` (segment-safe prefix check). */
function dirsTo(nodes: IdeNode[], target: string): string[] {
  const out: string[] = []
  const walk = (list: IdeNode[]): void => {
    for (const n of list) {
      if (!n.dir) continue
      const inSub = target.startsWith(n.path.endsWith('/') || n.path.endsWith('\\') ? n.path : n.path + '/')
      if (inSub) {
        out.push(n.path)
        walk(n.children ?? [])
      }
    }
  }
  walk(nodes)
  return out
}

function TreeNode({
  node,
  depth,
  openDirs,
  onDir,
  onFile,
  active,
  matchAi
}: {
  node: IdeNode
  depth: number
  openDirs: Set<string>
  onDir: (path: string) => void
  onFile: (node: IdeNode) => void
  active: string | null
  /** the file the model is currently writing → a blinking dot on the node */
  matchAi: ((path: string) => boolean) | null
}) {
  const pad = 8 + depth * 13
  if (node.dir) {
    const isOpen = openDirs.has(node.path)
    return (
      <div>
        <button className="ide-dir" style={{ paddingLeft: pad }} onClick={() => onDir(node.path)}>
          <span className={`ide-caret${isOpen ? ' open' : ''}`} aria-hidden>
            <IconChevronDown />
          </span>
          <IconFolder />
          <span className="ide-label">{node.name}</span>
        </button>
        {isOpen &&
          (node.children ?? []).map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              openDirs={openDirs}
              onDir={onDir}
              onFile={onFile}
              active={active}
              matchAi={matchAi}
            />
          ))}
      </div>
    )
  }
  return (
    <button
      className={`ide-file${active === node.path ? ' active' : ''}`}
      style={{ paddingLeft: pad + 18 }}
      title={node.path}
      onClick={() => onFile(node)}
    >
      <span className="ide-label">
        {node.name}
        {matchAi?.(node.path) && <span className="ide-ai-dot" title="The model is writing here" />}
      </span>
    </button>
  )
}

/**
 * v1.5 cowork pane: a file tree + editor for the chat's linked folders.
 * You type on the same files the agent writes — save with Ctrl+S, and the
 * tree refreshes after every agent run.
 */
export default function IdePane() {
  const s = useApp()
  const open = s.ideOpen
  const toggle = s.toggleIde
  const session = s.sessions.find((x) => x.id === s.activeId)
  const roots = session?.linkedFolders ?? []

  const [tree, setTree] = useState<IdeNode[]>([])
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set())
  const [curPath, setCurPath] = useState<string | null>(null)
  const [curName, setCurName] = useState('')
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [imgSrc, setImgSrc] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)
  const wasStreaming = useRef(false)
  const [aiActive, setAiActive] = useState(false)
  const [ov, setOv] = useState<{ x: number; y: number; h: number } | null>(null)
  const charW = useRef(0)

  const refresh = useCallback(() => {
    if (!s.activeId) {
      setTree([])
      return
    }
    void window.codezy.ide
      .tree(s.activeId)
      .then((t) => {
        setTree(t)
        // roots start expanded; re-expanding after refresh keeps your place
        setOpenDirs((prev) => {
          const next = new Set(prev)
          for (const n of t) if (n.dir) next.add(n.path)
          return next
        })
      })
      .catch(() => setTree([]))
  }, [s.activeId])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh, s.ideTick])

  // the agent just finished a run → its writes show up in the tree
  useEffect(() => {
    if (wasStreaming.current && !s.streaming && open) refresh()
    wasStreaming.current = s.streaming
  }, [s.streaming, open, refresh])

  // the file open in cowork mirrors into the store on every change (unsaved
  // edits included) — the composer attaches it so the model actually knows
  // what you're looking at instead of asking you to paste the code
  useEffect(() => {
    const next = curPath && !imgSrc ? { path: curPath, content } : null
    const cur = useApp.getState().ideFile
    if ((cur?.path ?? null) === (next?.path ?? null) && (cur?.content ?? null) === (next?.content ?? null)) return
    useApp.getState().setIdeFile(next)
  }, [curPath, imgSrc, content])

  const matchAi = useCallback(
    (p: string) => !!s.aiWrite && sameFile(s.aiWrite.path, p, roots),
    [s.aiWrite, roots]
  )

  // the model just wrote a file → if it's the open one (and you haven't got
  // unsaved edits), reload it live and park a blinking cursor at the end —
  // watching the agent type. A dot also lands on the tree node for a few sec.
  useEffect(() => {
    const w = s.aiWrite
    if (!w || !curPath || imgSrc || !s.activeId) return
    if (!sameFile(w.path, curPath, roots)) return
    let cancelled = false
    setAiActive(true)
    if (content === saved) {
      void window.codezy.ide.read(s.activeId, curPath).then((text) => {
        if (!cancelled && text != null) {
          setContent(text)
          setSaved(text)
        }
      })
    }
    const t = setTimeout(() => {
      setAiActive(false)
      setOv(null)
    }, 3000)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires per write event only
  }, [s.aiWrite])

  // park the overlay cursor at the end of the text — grid math the textarea
  // allows because white-space: pre (no soft wrapping) and a mono font
  const measure = useCallback(() => {
    const el = ta.current
    if (!el || !aiActive) {
      setOv(null)
      return
    }
    const cs = getComputedStyle(el)
    const lineHeight = parseFloat(cs.lineHeight) || 20
    const padL = parseFloat(cs.paddingLeft) || 12
    const padT = parseFloat(cs.paddingTop) || 10
    if (charW.current <= 0) {
      const probe = document.createElement('span')
      probe.style.position = 'absolute'
      probe.style.visibility = 'hidden'
      probe.style.whiteSpace = 'pre'
      probe.style.fontFamily = cs.fontFamily
      probe.style.fontSize = cs.fontSize
      probe.style.fontWeight = cs.fontWeight
      probe.textContent = 'x'.repeat(100)
      document.body.appendChild(probe)
      charW.current = probe.getBoundingClientRect().width / 100 || 7.5
      probe.remove()
    }
    let line = 0
    let col = 0
    for (const ch of content) {
      if (ch === '\n') {
        line++
        col = 0
      } else if (ch === '\t') col += 2 - (col % 2)
      else col++
    }
    const x = padL + col * charW.current - el.scrollLeft
    const y = padT + line * lineHeight - el.scrollTop
    const cw = el.clientWidth || Number.MAX_SAFE_INTEGER // jsdom reports 0
    const chh = el.clientHeight || Number.MAX_SAFE_INTEGER
    const visible = x >= padL - charW.current && x <= cw && y >= -lineHeight && y <= chh
    setOv(visible ? { x, y, h: lineHeight } : null)
  }, [content, aiActive])

  useEffect(() => {
    measure()
  }, [measure])

  // focus the editor when a new file lands in it
  useEffect(() => {
    if (curPath && !imgSrc) ta.current?.focus()
  }, [curPath, imgSrc])

  const toggleDir = (path: string) =>
    setOpenDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const openFile = async (node: IdeNode) => {
    if (node.dir) return toggleDir(node.path)
    if (curPath && !imgSrc && content !== saved) {
      if (!window.confirm(`Discard unsaved changes in ${curName}?`)) return
    }
    setOpenDirs((prev) => {
      const next = new Set(prev)
      for (const d of dirsTo(tree, node.path)) next.add(d)
      return next
    })
    if (isImg(node.path)) {
      const u = await window.codezy.images.dataUrl(node.path)
      setCurPath(node.path)
      setCurName(node.name)
      setImgSrc(u)
      setContent('')
      setSaved('')
      return
    }
    if (!s.activeId) return
    const text = await window.codezy.ide.read(s.activeId, node.path)
    if (text == null) {
      s.addNotice(`Cannot read ${node.name}`, 'error')
      return
    }
    setCurPath(node.path)
    setCurName(node.name)
    setImgSrc(null)
    setContent(text)
    setSaved(text)
  }

  const save = async () => {
    if (!s.activeId || !curPath || imgSrc) return
    setBusy(true)
    try {
      await window.codezy.ide.write(s.activeId, curPath, content)
      setSaved(content)
      s.addNotice(`Saved ${curName}`)
    } catch (e) {
      s.addNotice(`Save failed: ${e instanceof Error ? e.message : e}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const createFile = async () => {
    if (!s.activeId || !newName.trim() || !tree.length) return
    const rel = newName.trim().replace(/^[/\\]+/, '').replace(/\\/g, '/')
    const target = `${tree[0].path}/${rel}`
    try {
      const made = await window.codezy.ide.create(s.activeId, target, false)
      setAdding(false)
      setNewName('')
      refresh()
      const text = await window.codezy.ide.read(s.activeId, made)
      setCurPath(made)
      setCurName(rel)
      setImgSrc(null)
      setContent(text ?? '')
      setSaved(text ?? '')
    } catch (e) {
      s.addNotice(`Could not create the file: ${e instanceof Error ? e.message : e}`, 'error')
    }
  }

  const linkFolder = async () => {
    if (!s.activeId) await s.newChat(s.filterProjectId)
    const folder = await window.codezy.dialog.pickFolder('Link folder to this chat')
    if (folder) {
      await s.linkFolder(folder)
      refresh()
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const el = e.currentTarget
      const a = el.selectionStart ?? 0
      const b = el.selectionEnd ?? a
      setContent(content.slice(0, a) + '  ' + content.slice(b))
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
    }
  }

  if (!open) return null

  return (
    <aside className="ide-pane" aria-label="Cowork editor">
      <div className="ide-head">
        <span className="ide-title">Cowork</span>
        <span className="ide-scope" title="Files the agent works on with you">
          {roots.length ? `${roots.length} folder${roots.length === 1 ? '' : 's'}` : 'no folder'}
        </span>
        <button className="ide-mini" data-tip="New file" aria-label="New file" onClick={() => setAdding((v) => !v)}>
          <IconPlus />
        </button>
        <button className="ide-mini" data-tip="Refresh" aria-label="Refresh tree" onClick={refresh}>
          <IconRefresh />
        </button>
        <button className="ide-mini" data-tip="Close — Ctrl+E" aria-label="Close cowork editor" onClick={toggle}>
          <IconX />
        </button>
      </div>

      {adding && (
        <div className="ide-new">
          <input
            autoFocus
            placeholder="src/new-file.ts — Enter creates"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createFile()
              if (e.key === 'Escape') setAdding(false)
            }}
          />
        </div>
      )}

      <div className="ide-tree" role="tree" aria-label="Linked folder files">
        {!roots.length ? (
          <div className="ide-empty">
            <span>Link a folder to cowork on its files with the agent.</span>
            <button className="btn primary" onClick={() => void linkFolder()}>
              Link folder
            </button>
          </div>
        ) : (
          tree.map((n) => (
            <TreeNode
              key={n.path}
              node={n}
              depth={0}
              openDirs={openDirs}
              onDir={toggleDir}
              onFile={(x) => void openFile(x)}
              active={curPath}
              matchAi={matchAi}
            />
          ))
        )}
      </div>

      <div className="ide-editor">
        {!curPath && <div className="ide-hint">Pick a file — the agent writes here too.</div>}
        {curPath && imgSrc && (
          <div className="ide-image">
            <div className="ide-path" title={curPath}>
              <span>{curName}</span>
            </div>
            <img src={imgSrc} alt={curName} />
          </div>
        )}
        {curPath && !imgSrc && (
          <>
            <div className="ide-path" title={curPath}>
              <span>{curName}</span>
              {content !== saved && <span className="ide-dot" title="Unsaved changes" />}
              {aiActive && (
                <span className="ide-ai-chip">
                  <span className="ide-ai-dot" aria-hidden />
                  model writing
                </span>
              )}
            </div>
            <div className="ide-ta-wrap">
              <textarea
                ref={ta}
                value={content}
                spellCheck={false}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={onKey}
                onScroll={measure}
              />
              {aiActive && ov && (
                <span className="ide-ai-cursor" style={{ left: ov.x, top: ov.y, height: ov.h }} aria-hidden />
              )}
            </div>
            <div className="ide-status">
              <span>{content.split('\n').length} lines</span>
              <span className="grow" />
              <button
                className="btn primary"
                disabled={content === saved || busy}
                onClick={() => void save()}
              >
                Save
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

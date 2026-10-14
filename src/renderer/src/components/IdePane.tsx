import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store/app'
import type { IdeNode } from '../../../shared/api'
import {
  IconChevronDown,
  IconFolder,
  IconMinus,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX
} from './Icons'

const isImg = (p: string): boolean => /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(p)

const normPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

/** `XY path` from `git status --porcelain` → the badge letter + repo path. */
function badgeOf(line: string): { rel: string; letter: string } | null {
  const xy = line.slice(0, 2)
  let rel = line.slice(3)
  if (!rel) return null
  const arrow = rel.indexOf(' -> ') // rename: keep the destination
  if (arrow >= 0) rel = rel.slice(arrow + 4)
  if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1) // quoted spaces
  const letter = xy.includes('?')
    ? '?'
    : xy.includes('A')
      ? 'A'
      : xy.includes('D')
        ? 'D'
        : xy.includes('R')
          ? 'R'
          : xy.includes('M')
            ? 'M'
            : (xy.trim()[0] ?? 'M')
  return { rel, letter }
}

/** Every directory path in a tree (used by expand-all / filter-unhiding). */
function allDirs(nodes: IdeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (!n.dir) continue
    out.push(n.path)
    allDirs(n.children ?? [], out)
  }
  return out
}

/** Keeps a file when its name/path matches, and every directory above it. */
function filterTree(nodes: IdeNode[], q: string): IdeNode[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return nodes
  const out: IdeNode[] = []
  for (const n of nodes) {
    if (n.dir) {
      const kids = filterTree(n.children ?? [], needle)
      if (kids.length) out.push({ ...n, children: kids })
      else if (n.name.toLowerCase().includes(needle)) out.push(n)
    } else if (n.name.toLowerCase().includes(needle) || n.path.toLowerCase().includes(needle)) {
      out.push(n)
    }
  }
  return out
}
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

/** Every file node in a tree — flat, marker rows dropped (for quick-open). */
function flattenFiles(nodes: IdeNode[], out: IdeNode[] = []): IdeNode[] {
  for (const n of nodes) {
    if (n.more !== undefined) continue
    if (n.dir) flattenFiles(n.children ?? [], out)
    else out.push(n)
  }
  return out
}

/** Subsequence match: "mgc" finds "main.tsx" — cheap, order-preserving. */
function fuzzy(hay: string, needle: string): boolean {
  let i = 0
  for (const ch of needle) {
    i = hay.indexOf(ch, i)
    if (i === -1) return false
    i++
  }
  return true
}

function TreeNode({
  node,
  depth,
  openDirs,
  onDir,
  onFile,
  active,
  matchAi,
  badge,
  onCtx
}: {
  node: IdeNode
  depth: number
  openDirs: Set<string>
  onDir: (path: string) => void
  onFile: (node: IdeNode) => void
  active: string | null
  /** the file the model is currently writing → a blinking dot on the node */
  matchAi: ((path: string) => boolean) | null
  /** git letter for this path (M/A/D/?) or null */
  badge: ((path: string) => string | null) | null
  /** right-click → the row's action menu */
  onCtx: (e: React.MouseEvent, node: IdeNode) => void
}) {
  const pad = 8 + depth * 13

  // a "N more files" marker row — it explains a cap, it never opens anything
  if (node.more !== undefined) {
    return (
      <span className="ide-more" style={{ paddingLeft: pad + 18 }} title="Files left out by the tree cap">
        {node.name}
      </span>
    )
  }

  if (node.dir) {
    const isOpen = openDirs.has(node.path)
    return (
      <div>
        <button
          className="ide-dir"
          style={{ paddingLeft: pad }}
          onClick={() => onDir(node.path)}
          onContextMenu={(e) => onCtx(e, node)}
        >
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
              badge={badge}
              onCtx={onCtx}
            />
          ))}
      </div>
    )
  }
  const st = badge?.(node.path) ?? null
  return (
    <button
      className={`ide-file${active === node.path ? ' active' : ''}`}
      style={{ paddingLeft: pad + 18 }}
      title={node.path}
      onClick={() => onFile(node)}
      onContextMenu={(e) => onCtx(e, node)}
    >
      <span className="ide-label">{node.name}</span>
      {st && (
        <span className="ide-badge" data-st={st} title={badgeTitle(st)}>
          {st}
        </span>
      )}
      {matchAi?.(node.path) && <span className="ide-ai-dot" title="The model is writing here" />}
    </button>
  )
}

const badgeTitle = (st: string): string =>
  st === '?'
    ? 'Untracked (git)'
    : st === 'M'
      ? 'Modified (git)'
      : st === 'A'
        ? 'Added (git)'
        : st === 'D'
          ? 'Deleted (git)'
          : st === 'R'
            ? 'Renamed (git)'
            : 'Changed in git'

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
  /** stable identity for `roots` — the array itself is rebuilt every render */
  const rootKey = roots.join('\u0000')

  const [tree, setTree] = useState<IdeNode[]>([])
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set())
  const [curPath, setCurPath] = useState<string | null>(null)
  const [curName, setCurName] = useState('')
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [imgSrc, setImgSrc] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  // tree filter + rename + find-in-file (all local to the pane)
  const [treeFilter, setTreeFilter] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameTo, setRenameTo] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const [findQ, setFindQ] = useState('')
  // v2.6 — what the "+" creates, where it lands, and the row's action menu
  const [addMode, setAddMode] = useState<'file' | 'dir'>('file')
  const [addBase, setAddBase] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [ctx, setCtx] = useState<{ x: number; y: number; node: IdeNode } | null>(null)
  const [showIgnored, setShowIgnored] = useState(
    () => localStorage.getItem('codezy.ideIgnored') === '1'
  )
  const [showGit, setShowGit] = useState(() => localStorage.getItem('codezy.ideGit') !== '0')
  const [gitBadges, setGitBadges] = useState<Record<string, string>>({})
  const [caret, setCaret] = useState({ line: 1, col: 1 })
  const [wrap, setWrap] = useState(() => localStorage.getItem('codezy.ideWrap') === '1')
  // Ctrl+P: jump straight to a file by name (works while typing in the editor)
  const [quick, setQuick] = useState(false)
  const [quickQ, setQuickQ] = useState('')
  const [quickIdx, setQuickIdx] = useState(0)
  const ta = useRef<HTMLTextAreaElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const wasStreaming = useRef(false)
  // per-chat editor buffer: switching chats stashes the old one and restores
  // the new chat's own file (nothing is lost, nothing leaks across chats)
  const stash = useRef(
    new Map<
      string,
      { path: string | null; name: string; content: string; saved: string; truncated: boolean; img: string | null }
    >()
  )
  const lastSid = useRef<string | null>(null)
  const [aiActive, setAiActive] = useState(false)
  const [ov, setOv] = useState<{ x: number; y: number; h: number } | null>(null)
  const charW = useRef(0)

  /**
   * git letters for the tree (M/A/D/?) — one `git status` per linked root.
   * Failures (not a repo, git missing, timeout) simply leave no badges: the
   * pane must work in a plain folder. Same for a bridge without the git half
   * (an older preload, a bare mock) — badges are optional, a crash is not.
   */
  const refreshGit = useCallback(() => {
    const id = s.activeId
    // at most three roots: every call is one blocking git status in main, and
    // badges are a nicety — a frozen window for a letter is not a trade worth
    // making on a five-folder chat
    const folders = roots.slice(0, 3)
    if (!id || !showGit || !folders.length || typeof window.codezy.git?.status !== 'function') {
      setGitBadges({})
      return
    }
    void Promise.all(folders.map((r) => window.codezy.git.status(id, r)))
      .then((res) => {
        const map: Record<string, string> = {}
        for (const st of res) {
          if (!st.ok) continue
          for (const line of st.files) {
            const b = badgeOf(line)
            if (b) map[normPath(`${st.folder}/${b.rel}`)] = b.letter
          }
        }
        setGitBadges(map)
      })
      .catch(() => setGitBadges({}))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rootKey stands in for roots
  }, [s.activeId, showGit, rootKey])

  const refresh = useCallback(() => {
    if (!s.activeId) {
      setTree([])
      setGitBadges({})
      return
    }
    void window.codezy.ide
      .tree(s.activeId, showIgnored)
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
    refreshGit()
  }, [s.activeId, showIgnored, refreshGit])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh, s.ideTick])

  // the agent just finished a run → its writes show up in the tree
  useEffect(() => {
    if (wasStreaming.current && !s.streaming && open) refresh()
    wasStreaming.current = s.streaming
  }, [s.streaming, open, refresh])

  // switching chats swaps the whole editor buffer: stash what chat A had
  // open and restore chat B's own file — without this the composer would
  // attach A's file (path + contents) to B's next message, and B's editor
  // would keep showing A's file against B's file tree
  useEffect(() => {
    const prev = lastSid.current
    if (prev && prev !== s.activeId) {
      stash.current.set(prev, { path: curPath, name: curName, content, saved, truncated, img: imgSrc })
    }
    const st = s.activeId ? stash.current.get(s.activeId) : undefined
    setCurPath(st ? st.path : null)
    setCurName(st?.name ?? '')
    setContent(st?.content ?? '')
    setSaved(st?.saved ?? '')
    setTruncated(st?.truncated ?? false)
    setImgSrc(st?.img ?? null)
    lastSid.current = s.activeId
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per chat switch only
  }, [s.activeId])

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

  // -- tree filter: only matching files (and the folders holding them) ------
  const shown = useMemo(() => filterTree(tree, treeFilter), [tree, treeFilter])
  // a filter must not hide behind collapsed folders — force them open while
  // it is active, then hand control back to the user
  const forcedOpen = useMemo(
    () => (treeFilter.trim() ? new Set(allDirs(shown)) : null),
    [shown, treeFilter]
  )
  const effOpen = forcedOpen ?? openDirs
  const expandAll = () => setOpenDirs(new Set(allDirs(tree)))
  const collapseAll = () => setOpenDirs(new Set())

  // -- Ctrl+P: jump to a file by name, straight from anywhere in the pane ----
  const quickMatches = useMemo(() => {
    const files = flattenFiles(tree)
    const q = quickQ.trim().toLowerCase()
    if (!q) return files.slice(0, 40)
    const scored: { f: IdeNode; s: number }[] = []
    for (const f of files) {
      const n = f.name.toLowerCase()
      const p = f.path.toLowerCase()
      if (n.startsWith(q)) scored.push({ f, s: 0 })
      else if (n.includes(q)) scored.push({ f, s: 1 })
      else if (p.includes(q)) scored.push({ f, s: 2 })
      else if (fuzzy(n, q)) scored.push({ f, s: 3 })
    }
    scored.sort((a, b) => a.s - b.s || a.f.name.length - b.f.name.length || a.f.name.localeCompare(b.f.name))
    return scored.slice(0, 40).map((x) => x.f)
  }, [tree, quickQ])

  const quickOpen = (f: IdeNode) => {
    setQuick(false)
    void openFile(f)
  }

  // -- find in the open file: next/prev match selects it in the textarea ----
  const lineCount = useMemo(() => content.split('\n').length, [content])
  const findMatches = useMemo(() => {
    const needle = findQ.trim().toLowerCase()
    if (!needle || imgSrc) return [] as number[]
    const hay = content.toLowerCase()
    const out: number[] = []
    let i = hay.indexOf(needle)
    while (i !== -1 && out.length < 500) {
      out.push(i)
      i = hay.indexOf(needle, i + needle.length)
    }
    return out
  }, [content, findQ, imgSrc])

  /** Selects the match that starts at (or after) `from`, wrapping around. */
  const selectMatch = (dir: 1 | -1) => {
    const el = ta.current
    const list = findMatches
    if (!el || !list.length) return
    const caret = el.selectionStart ?? 0
    let idx: number
    if (dir === 1) idx = list.findIndex((p) => p > caret)
    else {
      const before = list.filter((p) => p < caret)
      idx = before.length ? list.indexOf(before[before.length - 1]) : list.length - 1
    }
    if (idx < 0) idx = 0
    const at = list[idx]
    el.focus()
    el.setSelectionRange(at, at + findQ.trim().length)
    // scroll it roughly into the middle of the pane
    const line = content.slice(0, at).split('\n').length
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 18
    el.scrollTop = Math.max(0, (line - 6) * lh)
    if (gutter.current) gutter.current.scrollTop = el.scrollTop
  }

  // Ctrl+F inside the editor opens the find bar (the chat's own Ctrl+F only
  // fires when the chat has focus — this one belongs to the pane)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        const inEditor = !!document.activeElement?.closest('.ide-pane')
        if (!inEditor || !curPath || imgSrc) return
        e.preventDefault()
        setFindOpen(true)
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setQuick(true)
        setQuickQ('')
        setQuickIdx(0)
      }
      if (e.key === 'Escape') {
        setFindOpen(false)
        setQuick(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, curPath, imgSrc])

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
      void window.codezy.ide.read(s.activeId, curPath).then((res) => {
        if (!cancelled && res != null) {
          setContent(res.content)
          setSaved(res.content)
          setTruncated(res.truncated)
        }
      })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires per write event only
  }, [s.aiWrite])

  // The cursor lives as long as the run does: the agent can think (or run a
  // command) for many seconds between writes, and the old fixed timer went
  // dark mid-work. While the chat still generates it stays on; once the run
  // goes quiet, a short grace shows where the last write landed.
  useEffect(() => {
    if (!aiActive) return
    const busy = s.streaming || (s.activeId ? s.streamingIds.includes(s.activeId) : false)
    if (busy) return
    const t = setTimeout(() => {
      setAiActive(false)
      setOv(null)
    }, 6000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run lifecycle only
  }, [aiActive, s.streaming, s.streamingIds, s.activeId])

  // park the overlay cursor at the end of the text — grid math the textarea
  // allows because white-space: pre (no soft wrapping) and a mono font
  const measure = useCallback(() => {
    const el = ta.current
    if (!el || !aiActive || wrap) {
      // wrapped lines have no single grid position — the caret dot would lie
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
    // a long end-line can park the column off-screen too — pull the view to
    // it (only while the agent writes; a plain manual scroll is never fought)
    const x0 = padL + col * charW.current
    const vw0 = el.clientWidth || Number.MAX_SAFE_INTEGER
    if (aiActive && x0 - el.scrollLeft > vw0) {
      el.scrollLeft = Math.max(0, x0 - vw0 + charW.current * 2)
    } else if (aiActive && x0 - el.scrollLeft < padL - charW.current) {
      el.scrollLeft = Math.max(0, x0 - padL)
    }
    const x = padL + col * charW.current - el.scrollLeft
    const y = padT + line * lineHeight - el.scrollTop
    const cw = el.clientWidth || Number.MAX_SAFE_INTEGER // jsdom reports 0
    const chh = el.clientHeight || Number.MAX_SAFE_INTEGER
    const visible = x >= padL - charW.current && x <= cw && y >= -lineHeight && y <= chh
    setOv(visible ? { x, y, h: lineHeight } : null)
  }, [content, aiActive, wrap])

  useEffect(() => {
    measure()
  }, [measure])

  // Live follow — the cursor parks at the END of the text, so drag the view
  // there whenever new text lands: measure()'s visibility test hides an
  // off-screen cursor, which is exactly how it used to vanish on any file
  // taller than the pane. Only on content change, so the agent's writes pull
  // the view along while a manual scroll stays untouched between them.
  useEffect(() => {
    if (!aiActive || wrap) return
    const el = ta.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measure tracks content/aiActive/wrap itself
  }, [content, aiActive])

  // focus the editor when a new file lands in it
  useEffect(() => {
    if (curPath && !imgSrc) ta.current?.focus()
  }, [curPath, imgSrc])

  // a fresh file starts at Ln 1, Col 1 — the old file's caret must not carry
  useEffect(() => {
    setCaret({ line: 1, col: 1 })
  }, [curPath])

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
      setTruncated(false)
      return
    }
    if (!s.activeId) return
    const res = await window.codezy.ide.read(s.activeId, node.path)
    if (res == null) {
      s.addNotice(`Cannot read ${node.name}`, 'error')
      return
    }
    setCurPath(node.path)
    setCurName(node.name)
    setImgSrc(null)
    setTruncated(res.truncated)
    if (res.truncated) s.addNotice(`${node.name} is over 1 MB — opened read-only (head + tail shown)`, 'error')
    setContent(res.content)
    setSaved(res.content)
  }

  const save = async () => {
    if (!s.activeId || !curPath || imgSrc) return
    if (truncated) {
      // the buffer is only the first MB — writing it over the file would
      // delete the rest (main refuses too; this says why, before the attempt)
      s.addNotice(`${curName} is over 1 MB and was opened truncated — cowork won't save over the rest of it.`, 'error')
      return
    }
    setBusy(true)
    try {
      await window.codezy.ide.write(s.activeId, curPath, content)
      setSaved(content)
      refreshGit() // just saved → it is (or stays) modified in git now
      s.addNotice(`Saved ${curName}`)
    } catch (e) {
      s.addNotice(`Save failed: ${e instanceof Error ? e.message : e}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const createEntry = async () => {
    const base = addBase ?? tree[0]?.path
    if (!s.activeId || !newName.trim() || !base) return
    const rel = newName.trim().replace(/^[/\\]+/, '').replace(/\\/g, '/')
    const target = `${base}/${rel}`
    try {
      const made = await window.codezy.ide.create(s.activeId, target, addMode === 'dir')
      setAdding(false)
      setNewName('')
      setAddBase(null)
      // the folder we just made (or the file's folder) must be visible
      setOpenDirs((prev) => {
        const next = new Set(prev)
        next.add(base)
        return next
      })
      refresh()
      if (addMode === 'dir') {
        s.addNotice(`Created folder ${rel}`)
        return
      }
      const res = await window.codezy.ide.read(s.activeId, made)
      setCurPath(made)
      setCurName(rel.split('/').pop() ?? rel)
      setImgSrc(null)
      setTruncated(res?.truncated ?? false)
      setContent(res?.content ?? '')
      setSaved(res?.content ?? '')
      refreshGit()
    } catch (e) {
      s.addNotice(`Could not create it: ${e instanceof Error ? e.message : e}`, 'error')
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

  /** Rename any row — the target is set by the file bar or the row menu. */
  const doRename = async () => {
    const from = renameTarget
    if (!s.activeId || !from || !renameTo.trim()) {
      setRenaming(false)
      setRenameTarget(null)
      return
    }
    const slash = Math.max(from.lastIndexOf('/'), from.lastIndexOf('\\'))
    const dir = slash >= 0 ? from.slice(0, slash + 1) : ''
    const clean = renameTo.trim().replace(/^[/\\]+/, '').replace(/\\/g, '/')
    const target = dir + clean
    try {
      const moved = await window.codezy.ide.rename(s.activeId, from, target)
      setRenaming(false)
      setRenameTarget(null)
      if (curPath === from) {
        setCurPath(moved)
        setCurName(clean.split('/').pop() ?? clean)
      }
      refresh()
      s.addNotice(`Renamed to ${clean}`)
    } catch (e) {
      s.addNotice(`Rename failed: ${e instanceof Error ? e.message : e}`, 'error')
      setRenaming(false)
      setRenameTarget(null)
    }
  }

  /** Delete any row (files only — the backend refuses directories). */
  const doDelete = async (target: string, label: string) => {
    if (!s.activeId) return
    if (!window.confirm(`Delete ${label}? This cannot be undone from CODEZY.`)) return
    try {
      await window.codezy.ide.delete(s.activeId, target)
      if (curPath === target) {
        setCurPath(null)
        setCurName('')
        setContent('')
        setSaved('')
        setImgSrc(null)
        setTruncated(false)
      }
      refresh()
      s.addNotice(`Deleted ${label}`)
    } catch (e) {
      s.addNotice(`Delete failed: ${e instanceof Error ? e.message : e}`, 'error')
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

  /** Live line/column for the status bar (from the caret, not the mouse). */
  const updateCaret = () => {
    const el = ta.current
    if (!el) return
    const pos = el.selectionStart ?? 0
    const before = content.slice(0, pos)
    const nl = before.lastIndexOf('\n')
    setCaret({ line: (before.match(/\n/g)?.length ?? 0) + 1, col: pos - nl })
  }

  const toggleWrap = () =>
    setWrap((w) => {
      localStorage.setItem('codezy.ideWrap', w ? '0' : '1')
      return !w
    })

  // -- the row action menu -------------------------------------------------
  useEffect(() => {
    if (!ctx) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtx(null)
    }
    // close on a click ANYWHERE ELSE. A press inside the menu must NOT close
    // it: unmounting the row between mousedown and click would eat the click
    // (the button is gone by the time `click` fires).
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null
      if (el && typeof el.closest === 'function' && el.closest('.ide-ctx')) return
      setCtx(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctx])

  const copyPath = (p: string) => {
    void navigator.clipboard?.writeText(p)
    setCtx(null)
    s.addNotice('Path copied')
  }

  if (!open) return null

  return (
    <aside className="ide-pane" aria-label="Cowork editor">
      <div className="ide-head">
        <span className="ide-title">Cowork</span>
        <span className="ide-scope" title="Files the agent works on with you">
          {roots.length ? `${roots.length} folder${roots.length === 1 ? '' : 's'}` : 'no folder'}
        </span>
        <button
          className="ide-mini"
          data-tip="New file"
          aria-label="New file"
          onClick={() => {
            setAddMode('file')
            setAddBase(null)
            setRenaming(false)
            setAdding((v) => !v)
          }}
        >
          <IconPlus />
        </button>
        <button
          className="ide-mini"
          data-tip="New folder"
          aria-label="New folder"
          onClick={() => {
            setAddMode('dir')
            setAddBase(null)
            setRenaming(false)
            setAdding((v) => !v)
          }}
        >
          <IconFolder />
        </button>
        <button className="ide-mini" data-tip="Refresh" aria-label="Refresh tree" onClick={refresh}>
          <IconRefresh />
        </button>
        <button className="ide-mini" data-tip="Close — Ctrl+E" aria-label="Close cowork editor" onClick={toggle}>
          <IconX />
        </button>
      </div>

      {/* filter + expand/collapse — a200-file tree is otherwise a scroll hunt */}
      <div className="ide-tools">
        <IconSearch style={{ width: 12, height: 12, flex: 'none', opacity: 0.6 }} />
        <input
          value={treeFilter}
          placeholder="Filter files…"
          onChange={(e) => setTreeFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setTreeFilter('')
          }}
        />
        <button className="ide-mini" data-tip="Expand all folders" aria-label="Expand all" onClick={expandAll}>
          <IconPlus />
        </button>
        <button className="ide-mini" data-tip="Collapse all folders" aria-label="Collapse all" onClick={collapseAll}>
          <IconMinus />
        </button>
        <button
          className={`ide-chip${showGit ? ' on' : ''}`}
          data-tip="Git badges: modified / added / untracked"
          aria-pressed={showGit}
          onClick={() => {
            const v = !showGit
            setShowGit(v)
            localStorage.setItem('codezy.ideGit', v ? '1' : '0')
            if (v) refreshGit()
            else setGitBadges({})
          }}
        >
          git
        </button>
        <button
          className={`ide-chip${showIgnored ? ' on' : ''}`}
          data-tip="Also show ignored folders (dist, venv, .vscode…)"
          aria-pressed={showIgnored}
          onClick={() => setShowIgnored((v) => !v)}
        >
          ignored
        </button>
      </div>

      {(adding || renaming) && (
        <div className="ide-new">
          <input
            autoFocus
            placeholder={
              renaming
                ? `${renameTarget ? renameTarget.split(/[\\/]/).pop() : curName} → new name — Enter to rename`
                : addMode === 'dir'
                  ? 'src/new-folder — Enter creates the folder'
                  : 'src/new-file.ts — Enter creates'
            }
            value={renaming ? renameTo : newName}
            onChange={(e) => (renaming ? setRenameTo(e.target.value) : setNewName(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void (renaming ? doRename() : createEntry())
              if (e.key === 'Escape') {
                setAdding(false)
                setRenaming(false)
                setAddBase(null)
                setRenameTarget(null)
              }
            }}
          />
        </div>
      )}

      <div className="ide-tree" role="tree" aria-label="Linked folder files">
        {/* Ctrl+P — every file of the linked folders, one keystroke away */}
        {quick && roots.length > 0 && (
          <div className="ide-quick" role="dialog" aria-label="Go to file">
            <input
              autoFocus
              value={quickQ}
              placeholder="Go to file — type, Enter opens, Esc closes"
              onChange={(e) => {
                setQuickQ(e.target.value)
                setQuickIdx(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setQuick(false)
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setQuickIdx((i) => Math.min(i + 1, Math.max(0, quickMatches.length - 1)))
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setQuickIdx((i) => Math.max(i - 1, 0))
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const hit = quickMatches[quickIdx]
                  if (hit) quickOpen(hit)
                }
              }}
            />
            <div className="ide-quick-list">
              {quickMatches.length === 0 ? (
                <div className="ide-quick-empty">No file matches “{quickQ}”.</div>
              ) : (
                quickMatches.map((f, i) => (
                  <button
                    key={f.path}
                    className={`ide-quick-row${i === quickIdx ? ' on' : ''}`}
                    title={f.path}
                    onMouseEnter={() => setQuickIdx(i)}
                    onClick={() => quickOpen(f)}
                  >
                    <span className="ide-quick-name">{f.name}</span>
                    <span className="ide-quick-dir">{f.path.split(/[\\/]/).slice(-2, -1)[0] ?? ''}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {!roots.length ? (
          <div className="ide-empty">
            <span>Link a folder to cowork on its files with the agent.</span>
            <button className="btn primary" onClick={() => void linkFolder()}>
              Link folder
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div className="ide-empty">
            <span>No file matches “{treeFilter}”.</span>
            <button className="btn" onClick={() => setTreeFilter('')}>
              Clear filter
            </button>
          </div>
        ) : (
          shown.map((n) => (
            <TreeNode
              key={n.path}
              node={n}
              depth={0}
              openDirs={effOpen}
              onDir={toggleDir}
              onFile={(x) => void openFile(x)}
              active={curPath}
              matchAi={matchAi}
              badge={showGit && Object.keys(gitBadges).length ? (p) => gitBadges[normPath(p)] ?? null : null}
              onCtx={(e, node) => {
                e.preventDefault()
                e.stopPropagation()
                // keep the menu inside the window — it opens at the cursor
                setCtx({
                  x: Math.max(4, Math.min(e.clientX, window.innerWidth - 215)),
                  y: Math.max(4, Math.min(e.clientY, window.innerHeight - 330)),
                  node
                })
              }}
            />
          ))
        )}
      </div>

      {/* right-click menu — reveal / open / copy / rename / delete / create */}
      {ctx && (
        <div
          className="ide-ctx"
          style={{ left: ctx.x, top: ctx.y }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {!ctx.node.dir && (
            <button
              role="menuitem"
              onClick={() => {
                const n = ctx.node
                setCtx(null)
                void openFile(n)
              }}
            >
              Open
            </button>
          )}
          {ctx.node.dir && (
            <button
              role="menuitem"
              onClick={() => {
                toggleDir(ctx.node.path)
                setCtx(null)
              }}
            >
              {openDirs.has(ctx.node.path) ? 'Collapse' : 'Expand'}
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => {
              void window.codezy.files.show(ctx.node.path)
              setCtx(null)
            }}
          >
            Show in Explorer
          </button>
          {!ctx.node.dir && (
            <button
              role="menuitem"
              onClick={() => {
                void window.codezy.files.open(ctx.node.path)
                setCtx(null)
              }}
            >
              Open with system app
            </button>
          )}
          <button role="menuitem" onClick={() => copyPath(ctx.node.path)}>
            Copy path
          </button>
          <div className="ide-ctx-sep" />
          {ctx.node.dir && (
            <>
              <button
                role="menuitem"
                onClick={() => {
                  setAddMode('file')
                  setAddBase(ctx.node.path)
                  setNewName('')
                  setRenaming(false)
                  setAdding(true)
                  setCtx(null)
                }}
              >
                New file in this folder
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setAddMode('dir')
                  setAddBase(ctx.node.path)
                  setNewName('')
                  setRenaming(false)
                  setAdding(true)
                  setCtx(null)
                }}
              >
                New folder in here
              </button>
            </>
          )}
          <button
            role="menuitem"
            onClick={() => {
              setRenameTarget(ctx.node.path)
              setRenameTo(ctx.node.name)
              setRenaming(true)
              setAdding(false)
              setCtx(null)
            }}
          >
            Rename
          </button>
          {!ctx.node.dir && (
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                const n = ctx.node
                setCtx(null)
                void doDelete(n.path, n.name)
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}

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
              {content !== saved && !truncated && <span className="ide-dot" title="Unsaved changes" />}
              {truncated && (
                <span className="ide-ai-chip" title="Over 1 MB — opened read-only so a save can't delete the rest">
                  read-only · truncated
                </span>
              )}
              {aiActive && (
                <span className="ide-ai-chip">
                  <span className="ide-ai-dot" aria-hidden />
                  model writing
                </span>
              )}
              <span className="grow" />
              <button
                className="ide-mini"
                data-tip="Find in file — Ctrl+F"
                aria-label="Find in file"
                onClick={() => setFindOpen((v) => !v)}
              >
                <IconSearch />
              </button>
              <button
                className="ide-mini"
                data-tip="Rename file"
                aria-label="Rename file"
                onClick={() => {
                  setRenameTarget(curPath)
                  setRenameTo(curName)
                  setRenaming(true)
                  setAdding(false)
                }}
              >
                <IconPencil />
              </button>
              <button
                className="ide-mini danger"
                data-tip="Delete file"
                aria-label="Delete file"
                onClick={() => curPath && void doDelete(curPath, curName)}
              >
                <IconTrash />
              </button>
            </div>

            {findOpen && (
              <div className="ide-find" role="search">
                <input
                  autoFocus
                  value={findQ}
                  placeholder="Find in file…"
                  onChange={(e) => setFindQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      selectMatch(e.shiftKey ? -1 : 1)
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setFindOpen(false)
                      ta.current?.focus()
                    }
                  }}
                />
                <span className="ide-find-count">
                  {findQ.trim() ? (findMatches.length ? `${findMatches.length} hits` : '0 hits') : ''}
                </span>
                <button aria-label="Previous match" onClick={() => selectMatch(-1)}>
                  ↑
                </button>
                <button aria-label="Next match" onClick={() => selectMatch(1)}>
                  ↓
                </button>
                <button aria-label="Close find" onClick={() => setFindOpen(false)}>
                  <IconX style={{ width: 12, height: 12 }} />
                </button>
              </div>
            )}

            <div className={`ide-ta-wrap${wrap ? ' wrap' : ''}`}>
              {/* line numbers scroll with the buffer — hidden on giant files,
                  and whenever soft-wrap is on (a wrapped line would drift out
                  of step with its number) */}
              {lineCount <= 6000 && !wrap && (
                <div className="ide-gutter" ref={gutter} aria-hidden>
                  {Array.from({ length: lineCount }, (_, i) => (
                    <span key={i}>{i + 1}</span>
                  ))}
                </div>
              )}
              <textarea
                ref={ta}
                value={content}
                spellCheck={false}
                readOnly={truncated}
                onChange={(e) => {
                  setContent(e.target.value)
                  updateCaret()
                }}
                onKeyUp={updateCaret}
                onClick={updateCaret}
                onSelect={updateCaret}
                onKeyDown={onKey}
                onScroll={() => {
                  measure()
                  if (gutter.current && ta.current) gutter.current.scrollTop = ta.current.scrollTop
                }}
              />
              {aiActive && ov && (
                <span className="ide-ai-cursor" style={{ left: ov.x, top: ov.y, height: ov.h }} aria-hidden />
              )}
            </div>
            <div className="ide-status">
              <span>
                {lineCount} lines · {content.length.toLocaleString()} chars
              </span>
              <span className="ide-pos" data-tip="Caret position">
                Ln {caret.line}, Col {caret.col}
              </span>
              <span className="grow" />
              <button
                className={`ide-chip${wrap ? ' on' : ''}`}
                aria-pressed={wrap}
                data-tip="Wrap long lines (no horizontal scroll)"
                onClick={toggleWrap}
              >
                wrap
              </button>
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

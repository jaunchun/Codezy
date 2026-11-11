import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../store/app'
import { IconRefresh, IconX } from './Icons'

/** Viewport widths — the preview is a REAL viewport, so a phone-width
 *  frame shows whether the site actually works on a phone. */
const SIZES: { id: string; label: string; width: number }[] = [
  { id: 'fit', label: 'fit', width: 0 },
  { id: 'desktop', label: 'desktop', width: 1280 },
  { id: 'tablet', label: 'tablet', width: 820 },
  { id: 'phone', label: 'phone', width: 390 }
]

/**
 * The live site preview.
 *
 * The chat's linked folder is served over codezy-preview://<sessionId>/<path>
 * (main serves the real files), so the preview is the site itself: relative
 * CSS, JS and images resolve, and every time the agent writes a file the
 * watcher tells us to reload — you watch it change while it works.
 *
 * It can also point at a running dev server (http://localhost:3000) for
 * the projects that need one.
 */
export default function PreviewPane() {
  const s = useApp()
  const session = s.sessions.find((x) => x.id === s.activeId)
  const open = s.previewOpen
  const [page, setPage] = useState('')
  const [files, setFiles] = useState<{ path: string; name: string }[]>([])
  const [size, setSize] = useState('fit')
  const [nonce, setNonce] = useState(0)
  const [external, setExternal] = useState('')
  const [showList, setShowList] = useState(false)

  // the pages in the folder + the live-reload watcher, while the pane is open
  useEffect(() => {
    if (!open || !session) return
    let live = true
    void window.codezy.preview.files(session.id).then((f) => {
      if (live) setFiles(f)
    })
    void window.codezy.preview.default(session.id).then((p) => {
      if (live) setPage((cur) => cur || p)
    })
    void window.codezy.preview.watch(session.id)
    return () => {
      live = false
      void window.codezy.preview.unwatch(session.id)
    }
  }, [open, session?.id])

  // a change in the folder means the site changed — reload it
  useEffect(() => {
    if (!session) return
    return window.codezy.chat.onEvent((p) => {
      if (p.type === 'previewreload' && p.sessionId === session.id) setNonce((n) => n + 1)
    })
  }, [session?.id])

  const src = useMemo(() => {
    if (external.trim()) return external.trim()
    if (!session || !page) return ''
    return `codezy-preview://${session.id}/${page.replace(/^\/+/, '')}`
  }, [external, session?.id, page])

  if (!open) return null

  const width = SIZES.find((z) => z.id === size)?.width ?? 0
  const linked = (session?.linkedFolders ?? []).length > 0

  return (
    <aside className="preview-pane" aria-label="Live site preview">
      <div className="preview-head">
        <span className="preview-title">Preview</span>
        <span className="preview-scope" title={session?.linkedFolders?.[0] ?? 'no folder linked'}>
          {linked ? (session?.linkedFolders?.[0] ?? '').split(/[\\/]/).pop() : 'no folder linked'}
        </span>
        <div className="preview-sizes">
          {SIZES.map((z) => (
            <button
              key={z.id}
              className={`preview-size${size === z.id ? ' on' : ''}`}
              data-tip={z.label}
              onClick={() => setSize(z.id)}
            >
              {z.label}
            </button>
          ))}
        </div>
        <button
          className="preview-mini"
          data-tip="Reload the preview"
          aria-label="Reload preview"
          onClick={() => setNonce((n) => n + 1)}
        >
          <IconRefresh />
        </button>
        <button
          className="preview-mini"
          data-tip="Close the preview"
          aria-label="Close preview"
          onClick={() => s.setPreviewOpen(false)}
        >
          <IconX />
        </button>
      </div>

      <div className="preview-bar">
        <input
          className="preview-url"
          value={external || page}
          placeholder={linked ? 'index.html — or paste a dev-server URL' : 'link a folder to preview a site'}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value
            setExternal(v)
            if (v.startsWith('http')) setPage('')
            else {
              setExternal('')
              setPage(v)
            }
          }}
        />
        {files.length > 1 && (
          <button
            className="preview-mini"
            data-tip="Other pages"
            aria-label="Other pages"
            onClick={() => setShowList((v) => !v)}
          >
            {files.length}
          </button>
        )}
      </div>

      {showList && files.length > 1 && (
        <div className="preview-list">
          {files.map((f) => (
            <button
              key={f.path}
              className={`preview-file${f.path === page ? ' on' : ''}`}
              onClick={() => {
                setPage(f.path)
                setExternal('')
                setShowList(false)
              }}
            >
              {f.path}
            </button>
          ))}
        </div>
      )}

      <div className="preview-stage">
        {src ? (
          <div className="preview-frame" style={width ? { width } : undefined}>
            <iframe
              key={`${src}#${nonce}`}
              className="preview-iframe"
              title="Live site preview"
              src={src}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            />
          </div>
        ) : (
          <div className="preview-empty">
            {linked
              ? 'No page to preview yet — the agent writes one, and it shows up here.'
              : 'Link a folder to this chat and the site it builds shows up here, live.'}
          </div>
        )}
      </div>
    </aside>
  )
}

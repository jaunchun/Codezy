import { useEffect, useMemo, useRef } from 'react'
import { useApp } from '../store/app'
import { parseEditsLive, diffLines, type DiffLine } from '../../../shared/edits'
import { IconX } from './Icons'

/**
 * v3.1.7 — the live edit panel: what the agent is writing, right now.
 *
 * While the reply streams, the ===FILE blocks are parsed *including* the
 * trailing one that has no ===END yet (parseEditsLive), so the diff grows
 * token by token — you watch the change land before the review card. A
 * blinking caret sits at the tail of the last streamed line.
 *
 * After the stream ends it keeps showing the last assistant reply's edits
 * (the same parse the review card uses) until the user closes the panel.
 */
export default function LiveCodePane() {
  const liveOpen = useApp((s) => s.liveOpen)
  const streaming = useApp((s) => s.streaming)
  const streamText = useApp((s) => s.streamText)
  const setLiveOpen = useApp((s) => s.setLiveOpen)
  const session = useApp((s) => s.sessions.find((x) => x.id === s.activeId) ?? null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // while streaming: the live text; after: the last assistant reply's edits
  const source = useMemo(() => {
    if (streaming && streamText.includes('===FILE')) return streamText
    if (!streaming) {
      const last = [...(session?.messages ?? [])].reverse().find((m) => m.role === 'assistant')
      if (last?.content.includes('===FILE')) return last.content
    }
    return ''
  }, [streaming, streamText, session])

  const edits = useMemo(() => (source ? parseEditsLive(source) : []), [source])
  const rows = useMemo(
    () => edits.map((e) => ({ edit: e, lines: e.isNew ? diffLines('', e.replace) : diffLines(e.search, e.replace) })),
    [edits]
  )

  const live = streaming && edits.some((e) => e.streaming)
  const streamingPath = live ? edits[edits.length - 1]?.path : null

  // stick to the tail while the diff grows
  useEffect(() => {
    if (liveOpen && streaming && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [rows, liveOpen, streaming])

  if (!liveOpen) return null

  return (
    <section className="live-pane" aria-label="Live edits">
      <div className="live-head">
        <span className="live-title">live edits</span>
        <span className="live-file-count">
          {edits.length === 0
            ? 'waiting for the agent…'
            : `${edits.length} file${edits.length === 1 ? '' : 's'}${live ? ' · streaming' : ''}`}
        </span>
        <button
          className="live-mini"
          data-tip="Close the live panel"
          aria-label="Close live edits"
          onClick={() => setLiveOpen(false)}
        >
          <IconX />
        </button>
      </div>
      <div className="live-body" ref={bodyRef}>
        {edits.length === 0 && (
          <div className="live-empty">
            nothing yet — the panel opens on its own as soon as the agent starts writing a file
          </div>
        )}
        {rows.map(({ edit, lines }, i) => (
          <div className="live-file" key={`${edit.path}:${i}`}>
            <div className="live-file-head">
              <span className="live-path">{edit.path}</span>
              <span className="live-counts">
                {edit.awaitingReplace ? 'new' : `${edit.added}+ ${edit.removed}-`}
              </span>
            </div>
            <div className="diff">
              {lines.length === 0 && (
                <div className="diff-line more">
                  <span className="gl" />
                  <span className="tx">writing…</span>
                </div>
              )}
              {lines.map((line, j) => (
                <DiffRow
                  key={j}
                  line={line}
                  caret={edit.path === streamingPath && j === lines.length - 1}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function DiffRow({ line, caret }: { line: DiffLine; caret: boolean }) {
  const mark = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
  return (
    <div className={`diff-line ${line.type}`}>
      <span className="gl">{mark}</span>
      <span className="tx">
        {line.text}
        {caret && <span className="live-caret" aria-hidden />}
      </span>
    </div>
  )
}

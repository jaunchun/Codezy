import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store/app'
import { fmtHour, fmtNum, funFact, shortModel, type UsageRange, type UsageStats } from '../../../shared/usage'

const RANGES: { id: UsageRange; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: '30d', label: '30d' },
  { id: '7d', label: '7d' }
]

function Card({ k, v, hint, i }: { k: string; v: string; hint?: string; i: number }) {
  return (
    <div className="usage-card" style={{ animationDelay: `${60 + i * 45}ms` }} title={hint}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  )
}

/** Contribution-style activity grid: 12 weeks × 7 days, intensity per count. */
function Heatmap({ stats, cutoffDays }: { stats: UsageStats; cutoffDays: number }) {
  const cut = Date.now() - cutoffDays * 86_400_000
  return (
    <div className="heat" role="img" aria-label="Daily activity">
      {stats.heatmap.map((d, i) => {
        const ts = Date.parse(`${d.day}T12:00:00`)
        const level = d.count === 0 ? 0 : d.count <= 1 ? 1 : d.count <= 3 ? 2 : d.count <= 6 ? 3 : 4
        const inRange = cutoffDays === 0 || ts >= cut
        return (
          <i
            key={d.day}
            className={`lvl${level}${inRange ? '' : ' out'}`}
            style={{ animationDelay: `${140 + i * 4}ms` }}
            title={`${d.day} · ${d.count} message${d.count === 1 ? '' : 's'} (~${fmtNum(d.tokens)} tokens)`}
          />
        )
      })}
    </div>
  )
}

function Overview({ stats }: { stats: UsageStats }) {
  const cutoffDays = stats.range === 'all' ? 0 : stats.range === '30d' ? 30 : 7
  return (
    <>
      <div className="usage-grid">
        <Card i={0} k="Sessions" v={fmtNum(stats.sessions)} />
        <Card i={1} k="Messages" v={fmtNum(stats.messages)} />
        <Card i={2} k="Total tokens" v={fmtNum(stats.tokens)} hint="estimated (~4 chars/token)" />
        <Card i={3} k="Active days" v={fmtNum(stats.activeDays)} />
        <Card i={4} k="Current streak" v={`${stats.currentStreak}d`} />
        <Card i={5} k="Longest streak" v={`${stats.longestStreak}d`} />
        <Card i={6} k="Peak hour" v={fmtHour(stats.peakHour)} />
        <Card i={7} k="Favorite model" v={shortModel(stats.favoriteModel)} />
      </div>

      <Heatmap stats={stats} cutoffDays={cutoffDays} />
      <div className="usage-fact">{funFact(stats.tokens)}</div>
    </>
  )
}

function Models({ stats }: { stats: UsageStats }) {
  const [memChars, setMemChars] = useState<number | null>(null)
  const u = stats.lastUsage
  const pct = u && u.ctx ? Math.round((u.prompt / u.ctx) * 100) : 0

  useEffect(() => {
    void window.codezy.memory.read().then((m) => setMemChars(m.length))
  }, [])

  return (
    <>
      <div className="usage-grid">
        <Card i={0} k="Active model" v={shortModel(stats.activeModel)} hint={stats.activeModel} />
        <Card i={1} k="Provider" v={stats.provider === 'ollama' ? 'Ollama' : stats.provider} />
        <Card i={2} k="Effort" v={stats.effort} hint={`${stats.contextWindow.toLocaleString()}-token window · effort only changes temperature`} />
        <Card i={3} k="Context window" v={fmtNum(stats.contextWindow)} />
        <Card
          i={4}
          k="Last reply"
          v={u ? fmtNum(u.prompt + u.completion) : '—'}
          hint={u ? `${u.prompt} prompt + ${u.completion} generated · ${pct}% of window` : 'no generation yet'}
        />
        <Card i={5} k="Memory" v={memChars === null ? '…' : `${fmtNum(memChars)} ch`} hint="size of memory.md" />
        <Card i={6} k="Messages" v={fmtNum(stats.messages)} hint="in the selected range" />
        <Card i={7} k="Tokens" v={fmtNum(stats.tokens)} hint="estimated in the selected range" />
      </div>

      {stats.models.length > 0 ? (
        <div className="usage-table">
          <div className="tr th">
            <span>Model</span>
            <span className="num">Messages</span>
            <span className="num">Tokens</span>
            <span className="num">Last used</span>
          </div>
          {stats.models.map((m, i) => (
            <div className="tr" key={m.id} style={{ animationDelay: `${160 + i * 50}ms` }}>
              <span title={m.id}>{m.id}</span>
              <span className="num">{fmtNum(m.messages)}</span>
              <span className="num">{fmtNum(m.tokens)}</span>
              <span className="num">
                {new Date(m.lastUsed).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="usage-fact">No model activity in this range yet.</div>
      )}
    </>
  )
}

/** /usage → the stats dashboard (Overview / Models · All / 30d / 7d). */
export default function UsageModal() {
  const open = useApp((s) => s.usageOpen)
  const setOpen = useApp((s) => s.setUsageOpen)
  const [tab, setTab] = useState<'overview' | 'models'>('overview')
  const [range, setRange] = useState<UsageRange>('all')
  const [stats, setStats] = useState<UsageStats | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    void window.codezy.usage.stats(range).then((st) => {
      if (alive) setStats(st)
    })
    return () => {
      alive = false
    }
  }, [open, range])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  // the panel grows when the numbers arrive — keep it fully in view
  useEffect(() => {
    if (open && stats) rootRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, stats])

  if (!open) return null

  return (
    <div ref={rootRef} className="usage-panel" role="region" aria-label="Usage stats">
      <div className="usage-body">
        <div className="usage-head">
          <div className="usage-tabs">
            {(['overview', 'models'] as const).map((t) => (
              <button key={t} className={`usage-tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                {t === 'overview' ? 'Overview' : 'Models'}
              </button>
            ))}
          </div>

          <div className="segmented">
            {RANGES.map((r) => (
              <button key={r.id} className={range === r.id ? 'on' : ''} onClick={() => setRange(r.id)}>
                {r.label}
              </button>
            ))}
            <button className="x" onClick={() => setOpen(false)} title="Close (Esc)">
              ✕
            </button>
          </div>
        </div>

        {!stats ? (
          <div className="usage-loading">crunching numbers…</div>
        ) : tab === 'overview' ? (
          <Overview stats={stats} />
        ) : (
          <Models stats={stats} />
        )}
      </div>
    </div>
  )
}

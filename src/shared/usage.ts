// ---------------------------------------------------------------------------
// usage.ts — shapes and helpers for the /usage stats dashboard.
// Computation happens in the main process (it owns the session files); the
// renderer only formats and draws. Shared so both sides agree on the shape.
// ---------------------------------------------------------------------------

export type UsageRange = 'all' | '30d' | '7d'

export interface UsageModelStat {
  id: string
  messages: number
  tokens: number
  lastUsed: number
}

export interface UsageDay {
  day: string // YYYY-MM-DD (local)
  count: number // messages that day
  tokens: number
}

export interface UsageStats {
  range: UsageRange
  // cards (range-filtered)
  sessions: number
  messages: number
  tokens: number // estimated from text length (~4 chars/token)
  activeDays: number
  // cards (all-time)
  currentStreak: number
  longestStreak: number
  peakHour: number | null // 0–23 across the range
  favoriteModel: string | null
  // heatmap: every day in the window (oldest → today)
  heatmap: UsageDay[]
  // Models tab
  models: UsageModelStat[]
  activeModel: string
  provider: string
  effort: string
  contextWindow: number
  lastUsage: { prompt: number; completion: number; ctx: number; ts: number } | null
}

export function fmtNum(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`
  if (n >= 10_000) return Math.round(n).toLocaleString('en-US')
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export function fmtHour(h: number | null): string {
  if (h === null) return '—'
  if (h === 0) return '12 AM'
  if (h < 12) return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

/** Short model name for a card ("qwen2.5-coder:7b" → "qwen2.5-coder"). */
export function shortModel(id: string | null): string {
  if (!id) return '—'
  const noTag = id.split(':')[0]
  return noTag.length > 18 ? noTag.slice(0, 17) + '…' : noTag
}

// The classic comparison from the reference design: HP1 ≈ 76,944 words
// ≈ ~100k tokens. A small table gives the line variety as totals grow.
const COMPARISONS: { tokens: number; label: string }[] = [
  { tokens: 280, label: 'a tweet' },
  { tokens: 1200, label: 'an email' },
  { tokens: 100_000, label: 'Harry Potter and the Philosopher\'s Stone' },
  { tokens: 1_300_000, label: 'The Lord of the Rings' },
  { tokens: 180_000_000, label: 'the entire Harry Potter series' }
]

/** One fun, human line for the bottom of the dashboard. */
export function funFact(tokens: number): string {
  if (tokens < 1) return 'No tokens yet — your first message will light this up.'
  const c = [...COMPARISONS].sort((a, b) => b.tokens - a.tokens).find((x) => tokens >= x.tokens * 1.5)
  const ref = c ?? COMPARISONS[1]
  const ratio = tokens / ref.tokens
  if (ratio >= 1.05) {
    return `You've used ~${ratio < 10 ? +ratio.toFixed(1) : Math.round(ratio)}× more tokens than ${ref.label}.`
  }
  return `You've used ~${Math.max(1, Math.round(ratio * 100))}% of ${ref.label} — in tokens.`
}

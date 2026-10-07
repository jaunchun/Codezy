// ---------------------------------------------------------------------------
// main/usage.ts — aggregates every session file into the /usage dashboard:
// session & message counts, token estimates, streaks, peak hour, favourite
// model, a contribution-style heatmap and a per-model breakdown.
// ---------------------------------------------------------------------------

import type { UsageDay, UsageModelStat, UsageRange, UsageStats } from '../shared/usage'
import { getSettings, listSessions } from './store'

const DAY = 86_400_000
const HEAT_DAYS = 84 // 12 weeks × 7 days, the classic contribution grid

/** ~4 chars per token — the same estimate the rest of CODEZY uses. */
const est = (content: string): number => Math.max(1, Math.round(content.length / 4))

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Consecutive days with ≥1 message, ending today (or yesterday). */
function currentStreak(days: Set<string>): number {
  const d = new Date()
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1) // today still quiet
  let n = 0
  while (days.has(dayKey(d.getTime()))) {
    n++
    d.setDate(d.getDate() - 1)
  }
  return n
}

function longestStreak(days: Set<string>): number {
  const nums = [...days]
    .map((k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)))
    .sort((a, b) => a - b)
  let best = nums.length ? 1 : 0
  let run = 0
  let prev = 0
  for (const n of nums) {
    run = prev && n - prev === DAY ? run + 1 : 1
    best = Math.max(best, run)
    prev = n
  }
  return best
}

export function collectUsage(range: UsageRange): UsageStats {
  const settings = getSettings()
  const sessions = listSessions()
  const now = Date.now()
  const span = range === 'all' ? 0 : range === '30d' ? 30 : 7
  const cutoff = span ? now - span * DAY : -Infinity

  let sessionsInRange = 0
  let messages = 0
  let tokens = 0
  const hours = new Array<number>(24).fill(0)
  const allDays = new Set<string>()
  const rangeDays = new Set<string>()
  const dayTotals = new Map<string, UsageDay>()
  const modelMap = new Map<string, UsageModelStat>()
  let lastUsage: UsageStats['lastUsage'] = null
  let lastUsageTs = 0
  let favoriteModel: string | null = null

  for (const s of sessions) {
    let touched = false
    for (const m of s.messages) {
      const key = dayKey(m.ts)
      const t = est(m.content)
      allDays.add(key)

      const bucket = dayTotals.get(key) ?? { day: key, count: 0, tokens: 0 }
      bucket.count++
      bucket.tokens += t
      dayTotals.set(key, bucket)

      if (m.ts >= cutoff) {
        touched = true
        messages++
        tokens += t
        rangeDays.add(key)
        hours[new Date(m.ts).getHours()]++
        if (m.role === 'assistant') {
          const id = m.model ?? settings.activeModel
          const e = modelMap.get(id) ?? { id, messages: 0, tokens: 0, lastUsed: 0 }
          e.messages++
          e.tokens += t
          e.lastUsed = Math.max(e.lastUsed, m.ts)
          modelMap.set(id, e)
        }
      }
    }
    if (touched) sessionsInRange++
    if (s.lastUsage && s.lastUsage.ts > lastUsageTs) {
      lastUsage = s.lastUsage
      lastUsageTs = s.lastUsage.ts
    }
  }

  const peak = messages > 0 ? hours.indexOf(Math.max(...hours)) : null
  const models = [...modelMap.values()].sort((a, b) => b.messages - a.messages)
  if (models.length) favoriteModel = models[0].id

  // heatmap: the last 12 weeks regardless of range (dimmed outside the range)
  const heatmap: UsageDay[] = []
  const today = new Date()
  today.setHours(12, 0, 0, 0) // midday avoids DST edge cases at ±24h
  for (let i = HEAT_DAYS - 1; i >= 0; i--) {
    const key = dayKey(today.getTime() - i * DAY)
    heatmap.push(dayTotals.get(key) ?? { day: key, count: 0, tokens: 0 })
  }

  return {
    range,
    sessions: sessionsInRange,
    messages,
    tokens,
    activeDays: rangeDays.size,
    currentStreak: currentStreak(allDays),
    longestStreak: longestStreak(allDays),
    peakHour: peak,
    favoriteModel,
    heatmap,
    models,
    activeModel: settings.activeModel,
    provider: settings.activeProvider,
    effort: settings.effort,
    contextWindow: { light: 4096, medium: 8192, deep: 16384 }[settings.effort],
    lastUsage
  }
}

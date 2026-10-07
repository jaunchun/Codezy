// ---------------------------------------------------------------------------
// usage.mjs — aggregates message arrays into the /usage stats card:
// counts, token estimates, streaks, peak hour, per-model breakdown and a
// 12-week contribution heatmap (the app dashboard, in text). Port of
// src/main/usage.ts — but it takes plain arrays so the CLI can merge app
// sessions, terminal saves and the live session.
// ---------------------------------------------------------------------------

const DAY = 86_400_000
const HEAT_DAYS = 84 // 12 weeks × 7 days

/** ~4 chars per token — the same estimate the rest of CODEZY uses. */
const est = (content) => Math.max(1, Math.round(String(content).length / 4))

function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Consecutive days with ≥1 message, ending today (or yesterday). */
function currentStreak(days) {
  const d = new Date()
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1)
  let n = 0
  while (days.has(dayKey(d.getTime()))) {
    n++
    d.setDate(d.getDate() - 1)
  }
  return n
}

function longestStreak(days) {
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

/**
 * @param chats {{messages: {role:string, content:string, ts?:number, model?:string}[], lastUsage?:object}[]}
 * @param defaultModel {string} — model assumed for assistant replies without one
 */
export function collectUsage(chats, defaultModel) {
  let sessions = 0
  let messages = 0
  let tokens = 0
  let today = 0
  const todayKey = dayKey(Date.now())
  const hours = new Array(24).fill(0)
  const allDays = new Set()
  const modelMap = new Map()
  const dayTotals = new Map()
  let lastUsage = null
  let lastUsageTs = 0

  for (const chat of chats) {
    let touched = false
    for (const m of chat.messages ?? []) {
      const ts = m.ts ?? 0
      const key = dayKey(ts || Date.now())
      const t = est(m.content)
      allDays.add(key)

      const bucket = dayTotals.get(key) ?? { day: key, count: 0, tokens: 0 }
      bucket.count++
      bucket.tokens += t
      dayTotals.set(key, bucket)

      touched = true
      messages++
      tokens += t
      if (key === todayKey) today++
      if (ts) hours[new Date(ts).getHours()]++
      if (m.role === 'assistant') {
        const id = m.model || defaultModel
        const e = modelMap.get(id) ?? { id, messages: 0, tokens: 0, lastUsed: 0 }
        e.messages++
        e.tokens += t
        e.lastUsed = Math.max(e.lastUsed, ts)
        modelMap.set(id, e)
      }
    }
    if (touched) sessions++
    if (chat.lastUsage && (chat.lastUsage.ts ?? 0) > lastUsageTs) {
      lastUsage = chat.lastUsage
      lastUsageTs = chat.lastUsage.ts ?? 0
    }
  }

  const peak = messages > 0 ? hours.indexOf(Math.max(...hours)) : null
  const models = [...modelMap.values()].sort((a, b) => b.messages - a.messages)

  // 12-week heatmap (rows = weekday, cols = week)
  const heat = []
  const anchor = new Date()
  anchor.setHours(12, 0, 0, 0)
  for (let i = HEAT_DAYS - 1; i >= 0; i--) {
    const key = dayKey(anchor.getTime() - i * DAY)
    heat.push(dayTotals.get(key) ?? { day: key, count: 0, tokens: 0 })
  }

  return {
    chats: sessions,
    messages,
    tokens,
    today,
    currentStreak: currentStreak(allDays),
    longestStreak: longestStreak(allDays),
    peakHour: peak,
    favoriteModel: models[0]?.id ?? null,
    models,
    heat,
    lastUsage
  }
}

/**
 * Renders the heatmap as 7 rows × 12 week-columns of double-wide cells.
 * @returns {string[]} terminal lines (already colored)
 */
export function heatLines(heat, dim, accent, reset) {
  const rows = Array.from({ length: 7 }, () => [])
  heat.forEach((d, i) => {
    const col = Math.floor(i / 7)
    const row = new Date(`${d.day}T12:00:00`).getDay() // 0=Sun
    rows[row].push({ col, count: d.count })
  })
  const label = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const shade = (n) => (n === 0 ? `${dim}·${reset}` : n < 3 ? `${dim}░${reset}` : n < 6 ? `${accent}▒${reset}` : `${accent}█${reset}`)
  const out = []
  rows.forEach((cells, r) => {
    const byCol = new Map(cells.map((c) => [c.col, c.count]))
    let line = `${dim}${label[r]}${reset} `
    for (let c = 0; c < 12; c++) line += shade(byCol.get(c) ?? 0) + ' '
    out.push(line.replace(/\s+$/, ''))
  })
  return out
}

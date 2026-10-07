// ---------------------------------------------------------------------------
// search.mjs — /search: DuckDuckGo lite (no key, no account). Port of
// src/main/search.ts to plain JS for the terminal. All parsing is tolerant:
// anything that doesn't match is skipped, never thrown.
// ---------------------------------------------------------------------------

const ENDPOINT = 'https://lite.duckduckgo.com/lite/'
export const MAX_RESULTS = 8

/** &amp; &#x27; … → real characters, tags stripped, whitespace collapsed. */
function text(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Resolves DDG redirect links (/l/?uddg=…) and drops relative/internal ones. */
function cleanUrl(href) {
  try {
    const abs = new URL(href, ENDPOINT)
    const uddg = abs.searchParams.get('uddg')
    const url = uddg ?? abs.toString()
    if (!/^https?:\/\//.test(url)) return null
    if (/(^|\.)(duckduckgo\.com)$/i.test(new URL(url).hostname)) return null
    return url
  } catch {
    return null
  }
}

/** Pulls titles/links and snippets out of the lite results table. */
function parseLite(html) {
  const hits = []
  const seen = new Set()

  const linkRe = /<a[^>]*href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = linkRe.exec(html)) !== null) {
    const url = cleanUrl(m[2])
    const title = text(m[3])
    if (!url || !title || seen.has(url)) continue
    seen.add(url)
    hits.push({ title, url, snippet: '' })
    if (hits.length >= MAX_RESULTS) break
  }

  const snipRe = /<td[^>]*class=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi
  const snippets = []
  while ((m = snipRe.exec(html)) !== null) {
    const s = text(m[1])
    if (s) snippets.push(s)
  }
  hits.forEach((h, i) => {
    if (snippets[i]) h.snippet = snippets[i]
  })
  return hits
}

/** Runs a web search. Throws on network/HTTP failure — the caller notices. */
export async function webSearch(query) {
  const q = query.trim().slice(0, 300)
  if (!q) return []
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CODEZY/1.0'
    },
    body: new URLSearchParams({ q }).toString(),
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) throw new Error(`DuckDuckGo responded ${res.status}`)
  return parseLite(await res.text())
}

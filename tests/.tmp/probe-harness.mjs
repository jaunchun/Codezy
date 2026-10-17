// Probe: parallel prefix, retry, usage totals, abort → stopped (headless DI).
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const PROJ = path.resolve(import.meta.dirname, '..', '..')
const H = await import(pathToFileURL(path.join(PROJ, 'cli', 'lib', 'harness.mjs')).href)
const { runAgent, isTransient } = H

let fail = 0
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`)
  if (!ok) fail++
}

// -- 1. parallel read prefix --------------------------------------------------
{
  const log = []
  const reg = {
    r1: { run: async () => { log.push(['r1-start', Date.now()]); await new Promise((r) => setTimeout(r, 250)); log.push(['r1-end', Date.now()]); return 'one' } },
    r2: { run: async () => { log.push(['r2-start', Date.now()]); await new Promise((r) => setTimeout(r, 120)); log.push(['r2-end', Date.now()]); return 'two' } },
    w1: { run: async () => { log.push(['w1-start', Date.now()]); await new Promise((r) => setTimeout(r, 30)); log.push(['w1-end', Date.now()]); return 'wrote' } },
    r3: { run: async () => { log.push(['r3-start', Date.now()]); return 'three' } }
  }
  const names = { r1: 'read_file', r2: 'read_file', w1: 'write_file', r3: 'read_file' }
  // fake registry keys must be TOOLS names? — run1 looks up by call name, so map via aliases:
  const registry = {
    read_file: {
      run: async (a) => {
        const tag = a.path
        log.push([`${tag}-start`, Date.now()])
        await new Promise((r) => setTimeout(r, tag === 'slow' ? 250 : tag === 'mid' ? 120 : 30))
        log.push([`${tag}-end`, Date.now()])
        return `content of ${tag}`
      }
    },
    write_file: {
      run: async () => {
        log.push(['w-start', Date.now()])
        await new Promise((r) => setTimeout(r, 30))
        log.push(['w-end', Date.now()])
        return 'wrote x'
      }
    }
  }
  void reg; void names
  const calls = [
    { id: 'c1', function: { name: 'read_file', arguments: { path: 'slow' } } }, // 250ms
    { id: 'c2', function: { name: 'read_file', arguments: { path: 'mid' } } },  // 120ms
    { id: 'c3', function: { name: 'write_file', arguments: { path: 'x' } } },   // serial
    { id: 'c4', function: { name: 'read_file', arguments: { path: 'fast' } } }  // after write → tail
  ]
  const t0 = Date.now()
  const res = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry,
    needsApproval: (n) => n === 'write_file', // read prefix ungated
    approve: async () => true,
    callModel: async ({ messages }) => {
      const toolMsgs = messages.filter((m) => m.role === 'tool').length
      if (toolMsgs >= 4) return { content: 'DONE', stats: { promptTokens: 11, completionTokens: 7 } }
      return { content: '', tool_calls: calls }
    },
    onEvent: () => {}
  })
  const wall = Date.now() - t0
  // parallel head (250,120) ≈ 250 + serial tail (30+~0) + one extra model roundtrip
  check('parallel: wall time under serial cost', wall < 900, `${wall}ms (serial would be ~1400+ incl. roundtrips)`)
  const toolMsgs = res.messages.filter((m) => m.role === 'tool')
  check('parallel: 4 tool messages, original order', toolMsgs.length === 4 && toolMsgs.map((m) => m.tool_call_id).join(',') === 'c1,c2,c3,c4', toolMsgs.map((m) => m.tool_call_id).join(','))
  const iSlow = log.findIndex((l) => l[0] === 'slow-start')
  const iMid = log.findIndex((l) => l[0] === 'mid-start')
  const iSlowEnd = log.findIndex((l) => l[0] === 'slow-end')
  check('parallel: mid read STARTED before slow read ENDED', iMid !== -1 && iSlowEnd !== -1 && iMid < iSlowEnd, `mid@${iMid} slowEnd@${iSlowEnd}`)
  const iW = log.findIndex((l) => l[0] === 'w-start')
  const iFast = log.findIndex((l) => l[0] === 'fast-start')
  check('sequential tail: write runs before the post-write read', iW !== -1 && iFast !== -1 && iW < iFast, `w@${iW} fast@${iFast}`)
  check('usage: summed from stats', res.usage.promptTokens === 11 && res.usage.completionTokens === 7 && res.usage.calls === 2, JSON.stringify(res.usage))
}

// -- 2. transient retry -------------------------------------------------------
{
  let attempts = 0
  const retries = []
  const res = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: {},
    retries: 2,
    retryDelayMs: 0,
    callModel: async () => {
      attempts++
      if (attempts === 1) throw new Error('Ollama error 503: server busy')
      if (attempts === 2) throw new Error('fetch failed')
      return { content: 'ok-after-retry' }
    },
    onEvent: (e) => { if (e.type === 'retry') retries.push(e) }
  })
  check('retry: two transient failures then success', res.status === 'text' && res.text === 'ok-after-retry' && attempts === 3, `attempts=${attempts}`)
  check('retry: onEvent got retry notices', retries.length === 2 && retries[0].attempt === 1, JSON.stringify(retries.map((r) => r.attempt)))

  // permanent error must NOT retry
  let perma = 0
  let threw = null
  try {
    await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      registry: {},
      retries: 2,
      retryDelayMs: 0,
      callModel: async () => { perma++; throw new Error('model "nope" not found') },
      onEvent: () => {}
    })
  } catch (e) { threw = e }
  check('retry: permanent error fails fast (1 attempt)', perma === 1 && /not found/.test(String(threw?.message)), `attempts=${perma}`)

  check('isTransient: classifier shapes', isTransient(new Error('API error 429')) && isTransient(new Error('Ollama error 500')) && !isTransient(new Error('API error 400')) && !isTransient(new Error('model "x" not found')))
}

// -- 3. abort → clean stop ----------------------------------------------------
{
  const abortCtl = new AbortController()
  const p = runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: {},
    signal: abortCtl.signal,
    callModel: async () => {
      abortCtl.abort() // simulate Ctrl+C mid-flight
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      throw e
    },
    onEvent: () => {}
  })
  const res = await p
  check('abort: returns stopped with chain intact', res.status === 'stopped' && res.messages.length === 1, `${res.status}/${res.messages.length}`)
  check('abort: no dangling assistant message', res.messages.every((m) => m.role !== 'assistant'))
}

console.log(fail ? `\n${fail} FAIL(S)` : '\nALL PASS')
process.exit(fail ? 1 : 0)

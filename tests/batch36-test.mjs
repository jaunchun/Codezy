// Batch 36 — the v1 TUI's LIVE composer during a streaming reply
// (needs a live local model, like batch2/3):
//  A. plain message typed mid-stream → progress row shows `· 1 queued`
//     (nothing dropped), and after Esc stops the reply the queued line
//     AUTO-SENDS — a second stream starts.
//  B. bare Esc still stops the stream (the pinned `esc to stop` meaning).
//  C. a slash-command typed mid-stream RUNS: the `/usage` palette path
//     (open palette → Enter) aborts the reply and prints the usage card —
//     the regression guard for "commands are dead while the model writes".
//  D. source pins: the streaming router, the queued counter, the live-composer
//     comment — the strings that must never regress.
// Kills every spawn; writes nothing outside the session (no saves fire).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TUI = path.join(PROJ, 'cli', 'codezy.mjs')
const MSG = 'Explain in detail how binary search works, at least 120 words.\r'

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

function spawnTui() {
  const p = spawn(process.execPath, [TUI], {
    cwd: PROJ,
    env: { ...process.env, CODEZY_TTY: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  p.out = ''
  p.stdout.on('data', (d) => (p.out += d))
  p.stderr.on('data', (d) => (p.out += d))
  return p
}

function kill(p) {
  try {
    p.kill()
  } catch {}
}

/** poll p.out until pred(out) or timeout */
function waitFor(p, pred, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (pred(p.out)) {
        clearInterval(iv)
        resolve(true)
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv)
        resolve(false)
      }
    }, 150)
  })
}

// --- A+B: queue a plain message mid-stream, Esc stops, queue auto-sends ------
const p1 = spawnTui()
{
  const ready = await waitFor(p1, (o) => o.includes('Ask anything'), 15000)
  check('A splash composer ready', ready)
  p1.stdin.write(MSG)
  const streaming = await waitFor(p1, (o) => o.includes('esc to stop'), 90000)
  check('A reply is streaming (progress row up)', streaming)

  let cp = p1.out.length
  p1.stdin.write('queue me later\r')
  const queued = await waitFor(p1, (o) => o.slice(cp).includes('1 queued'), 10000)
  check('A plain text mid-stream queues — `· 1 queued` in the row', queued, `${p1.out.slice(cp).match(/· \d+ queued/)?.[0] ?? 'no counter'}`)

  cp = p1.out.length
  p1.stdin.write('\x1b') // bare Esc
  const stopped = await waitFor(p1, (o) => o.slice(cp).includes('stopped'), 10000)
  check('B bare Esc still stops the stream', stopped)

  cp = p1.out.length
  const resent = await waitFor(p1, (o) => o.slice(cp).includes('esc to stop'), 60000)
  check('A queued message auto-sends after the reply (2nd stream up)', resent)
  kill(p1)
}

// --- C: a slash-command RUNS while the model is talking ----------------------
const p2 = spawnTui()
{
  const ready = await waitFor(p2, (o) => o.includes('Ask anything'), 15000)
  check('C splash composer ready', ready)
  p2.stdin.write(MSG)
  const streaming = await waitFor(p2, (o) => o.includes('esc to stop'), 90000)
  check('C reply is streaming (progress row up)', streaming)

  const cp = p2.out.length
  p2.stdin.write('/usage') // opens the command palette mid-stream…
  await new Promise((r) => setTimeout(r, 300))
  p2.stdin.write('\r') // …Enter runs the typed command
  const card = await waitFor(p2, (o) => o.slice(cp).includes('est. tokens'), 30000)
  check('C slash-command RUNS mid-stream (usage card prints)', card, card ? '' : p2.out.slice(cp).slice(-200).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''))
  const cut = p2.out.slice(cp).includes('stopped')
  check('C the running reply was aborted for it', cut)
  kill(p2)
}

// --- D: source pins ----------------------------------------------------------
{
  const src = fs.readFileSync(TUI, 'utf8')
  check('D router never eats input (composer fallback)', src.includes('else keyInput(s)') && src.includes('if (waiters.length || overlay) keyInput(s)'))
  check('D bare/glued Esc stops (glued-esc regex pin)', src.includes('/^(\\x1b)+$/.test(s) && streaming) stopStream()'))
  check('D queued counter in the progress row', src.includes('lineQueue.length ? ` · ${lineQueue.length} queued`'))
  check('D paste also flows mid-stream', src.includes('waiters.length || overlay || streaming) applyPaste(s)'))
  check('D shift+enter newline works mid-stream', src.includes('waiters.length || thinking || !!abortCtl'))
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} FAIL(S)`)
  process.exit(1)
}
console.log('ALL PASS')
process.exit(0)

// debug2: batch36 timing — write the message the INSTANT 'Ask anything' shows
import { spawn } from 'node:child_process'
const TUI = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy/cli/codezy.mjs'
const p = spawn(process.execPath, [TUI], {
  cwd: 'C:/Users/kajtg/Documents/Projekt domyślny/codezy',
  env: { ...process.env, CODEZY_TTY: '1' },
  stdio: ['pipe', 'pipe', 'pipe']
})
let out = ''
p.stdout.on('data', (d) => (out += d))
p.stderr.on('data', (d) => (out += d))
const strip = (s) => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '\n')

// immediate write as soon as the splash placeholder shows (batch36 timing)
const iv = setInterval(() => {
  if (out.includes('Ask anything')) {
    clearInterval(iv)
    p.stdin.write('Write a six line poem about the sea with vivid imagery\r')
    console.log('[t=0] poem written')
  }
}, 20)

setTimeout(() => {
  console.log('has esc to stop:', out.includes('esc to stop'))
  console.log('has thinking:', out.includes('thinking'))
  console.log('has 1 queued-capable row:', /queued/.test(out))
  console.log('has meta 1.0s-ish line:', /· \d+\.\d+s ·/.test(out))
  const lines = strip(out).split('\n').filter((l) => l.trim())
  console.log('=== tail ===')
  console.log(lines.slice(-22).join('\n'))
  try { p.kill() } catch {}
  process.exit(0)
}, 20000)

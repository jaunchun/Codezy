// debug: what does the TUI emit for a first message with CODEZY_TTY=1?
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
setTimeout(() => {
  p.stdin.write('Write a six line poem about the sea with vivid imagery\r')
}, 1500)
setTimeout(() => {
  const t = strip(out)
  const lines = t.split('\n').filter((l) => l.trim())
  console.log('=== markers ===')
  console.log('has esc to stop:', out.includes('esc to stop'))
  console.log('has thinking:', out.includes('thinking'))
  console.log('has chars row:', /chars ·/.test(out))
  console.log('has stopped:', out.includes('stopped'))
  console.log('has error/✗:', out.includes('✗') || out.includes('error'))
  console.log('=== tail ===')
  console.log(lines.slice(-25).join('\n'))
  try { p.kill() } catch {}
  process.exit(0)
}, 25000)

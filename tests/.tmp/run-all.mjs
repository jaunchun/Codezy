/* Sequential runner for every tests/batchN-test.mjs — reports per-suite status
   and aggregates failures. Scratch helper (lives under .tmp). */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const files = fs
  .readdirSync(path.join(PROJ, 'tests'))
  .filter((f) => /^batch\d+-test\.mjs$/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))

const bad = []
for (const f of files) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [path.join(PROJ, 'tests', f)], {
    cwd: PROJ,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const out = (r.stdout || '') + (r.stderr || '')
  const failLines = (out.match(/^FAIL\b/gm) || []).length
  const ok = r.status === 0 && failLines === 0
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f.padEnd(20)} exit=${r.status} failLines=${failLines} ${secs}s`)
  if (!ok) {
    bad.push(f)
    console.log('---- tail ----')
    console.log(out.trim().split('\n').slice(-30).join('\n'))
    console.log('--------------')
  }
}
console.log(bad.length ? `\n${bad.length} SUITE(S) FAILED: ${bad.join(', ')}` : '\nALL SUITES PASS')
process.exit(bad.length ? 1 : 0)

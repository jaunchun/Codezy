// Batch 34 — the CLI as its own npm package + the v2 REPL upgrade wave
// (all model-free: no live model calls anywhere in this batch):
//  A. cli/package.json: name/bin/type/files/engines, version === root version,
//     root package.json is private (only cli/ may ever be published), every
//     file in `files` exists on disk.
//  B. getVersion() prefers cli/package.json; `--version` prints it; `--help`
//     keeps the pinned flag, documents `doctor` + agent commands, exits 0,
//     and stays ANSI-free when piped.
//  C. `codezy doctor`: exit 0 with the node/package/endpoint rows, ANSI-free
//     when piped; a bogus flag under doctor → exit 2.
//  D. web_fetch (new agent tool): schema in TOOLS, registry entry, rejects
//     non-http / missing url, fetches a LOCAL http server, strips HTML to
//     prose (no tags, no script bodies), honors maxChars.
//  E. v2 REPL over a pipe: /help lists the new commands, /auto flips, /tools
//     lists web_fetch, exit 0 — plus source pins: TAB completer, TTY-gated
//     spinner, SYSTEM prompt names web_fetch.
//  F. batch29/9 regression pins: the exact strings that must never break.
//  Restores nothing: no settings, no network beyond 127.0.0.1.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const CLI_DIR = path.join(PROJ, 'cli')
const CLI = path.join(CLI_DIR, 'index.mjs')
const V2 = path.join(CLI_DIR, 'codezy-v2.mjs')

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}
const readJson = (f, fb) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fb
  }
}
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

function run(cmd, args, inputLines, gap = 250) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: PROJ, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    const kill = setTimeout(() => {
      try {
        p.kill()
      } catch {}
    }, 60000)
    let t = 800
    for (const l of inputLines ?? []) {
      setTimeout(() => p.stdin.write(l + '\r'), t)
      t += gap
    }
    setTimeout(() => p.stdin.end(), t + 400)
    p.on('close', (code) => {
      clearTimeout(kill)
      resolve({ code, out })
    })
  })
}

// -- A. the npm package --------------------------------------------------------
const pkg = readJson(path.join(CLI_DIR, 'package.json'), null)
const rootPkg = readJson(path.join(PROJ, 'package.json'), null)
check('A cli/package.json parses', !!pkg)
if (pkg) {
  check('A name is codezy', pkg.name === 'codezy', String(pkg.name))
  check('A bin maps codezy → ./index.mjs', pkg.bin?.codezy === './index.mjs', String(pkg.bin?.codezy))
  check('A type module', pkg.type === 'module', String(pkg.type))
  check('A engines node >= 18', parseInt(String(pkg.engines?.node ?? '').replace(/\D+/g, ''), 10) >= 18, String(pkg.engines?.node))
  const files = Array.isArray(pkg.files) ? pkg.files : []
  const must = ['index.mjs', 'print.mjs', 'codezy.mjs', 'codezy-v2.mjs', 'doctor.mjs', 'lib']
  for (const m of must) check(`A files covers ${m}`, files.includes(m), JSON.stringify(files))
  const missing = files.filter((f) => !fs.existsSync(path.join(CLI_DIR, f)))
  check('A every files entry exists on disk', missing.length === 0, missing.join(','))
  check('A version matches root package.json', !!rootPkg && pkg.version === rootPkg.version, `${pkg.version} vs ${rootPkg?.version}`)
  check('A root package.json is private (never publish the app)', rootPkg?.private === true, String(rootPkg?.private))
}

// -- B. version + help ---------------------------------------------------------
const { getVersion } = await import(pathToFileURL(path.join(CLI_DIR, 'lib', 'cli.mjs')).href)
check('B getVersion reads the cli package', getVersion() === pkg?.version, getVersion())

const ver = await run(process.execPath, [CLI, '--version'])
check('B --version exit 0', ver.code === 0, `code=${ver.code}`)
check('B --version prints codezy <cli version>', ver.out.trim() === `codezy ${pkg?.version}`, ver.out.trim())

const help = await run(process.execPath, [CLI, '--help'])
check('B --help exit 0', help.code === 0, `code=${help.code}`)
check('B help keeps --output-format', help.out.includes('--output-format'))
check('B help documents doctor', help.out.includes('codezy doctor'))
check('B help documents the agent commands', help.out.includes('AGENT COMMANDS') && help.out.includes('/export'))
check('B help is plain when piped', !help.out.includes('\x1b['))

// -- C. doctor -----------------------------------------------------------------
const doc = await run(process.execPath, [CLI, 'doctor'])
check('C doctor exit 0', doc.code === 0, `code=${doc.code} out=${doc.out.slice(0, 160)}`)
const dOut = stripAnsi(doc.out)
check('C doctor header', dOut.includes('codezy doctor'), dOut.split('\n')[0] ?? '')
check('C doctor has node row', /\bnode\b.*v\d+/.test(dOut), dOut.split('\n')[2] ?? '')
check('C doctor has endpoint row', dOut.includes('endpoint'), '')
check('C doctor is plain when piped', !doc.out.includes('\x1b['))
const docBad = await run(process.execPath, [CLI, 'doctor', '--nope'])
check('C doctor with a bogus flag → exit 2', docBad.code === 2, `code=${docBad.code}`)

// -- D. web_fetch tool ---------------------------------------------------------
const { TOOLS, makeRegistry } = await import(pathToFileURL(path.join(CLI_DIR, 'lib', 'harness.mjs')).href)
check('D schema registered in TOOLS', TOOLS.some((t) => t.function?.name === 'web_fetch'))
check('D no dependency smuggled into the schema', TOOLS.every((t) => t.type === 'function'))
const reg = makeRegistry({ roots: [os.tmpdir()] })
check('D registry entry present', typeof reg.web_fetch?.run === 'function')
check('D check requires url', typeof reg.web_fetch.check({}) === 'string')
check('D check rejects non-http', typeof reg.web_fetch.check({ url: 'file:///C:/Windows/win.ini' }) === 'string')
check('D check accepts http', reg.web_fetch.check({ url: 'http://example.com/x' }) === null)

const HTML = `<html><head><style>.h{color:red}</style><script>window.junk = 'SHOULD_NOT_APPEAR'</scr` + `ipt></head><body><h1>Hello CODEZY fetch</h1><p>Readable body text.</p></body></html>`
const BIG = `<p>${'lorem ipsum dolor sit amet '.repeat(400)}</p>`
const srv = http.createServer((req, res) => {
  if (req.url === '/plain') {
    res.setHeader('content-type', 'text/plain')
    res.end('raw text line\nsecond line')
    return
  }
  if (req.url === '/404') {
    res.statusCode = 404
    res.end('nope')
    return
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(req.url === '/big' ? BIG : HTML)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port
try {
  const page = await reg.web_fetch.run({ url: `http://127.0.0.1:${port}/` })
  check('D fetch returns the text', page.includes('Hello CODEZY fetch'), page.slice(0, 80))
  check('D HTML tags stripped', !page.includes('<h1>') && !page.includes('<p>'))
  check('D script bodies dropped', !page.includes('SHOULD_NOT_APPEAR'))
  check('D styles dropped', !page.includes('color:red'))

  const plain = await reg.web_fetch.run({ url: `http://127.0.0.1:${port}/plain` })
  check('D non-HTML passes through', plain.includes('raw text line') && plain.includes('second line'), plain.slice(0, 60))

  const capped = await reg.web_fetch.run({ url: `http://127.0.0.1:${port}/big`, maxChars: 1000 })
  check('D maxChars caps the output', capped.endsWith('…[truncated]') && capped.length < 1100, `${capped.length} chars`)

  const missing = await reg.web_fetch.run({ url: `http://127.0.0.1:${port}/404` })
  check('D HTTP errors reported, not thrown', String(missing).startsWith('fetch failed: HTTP 404'), String(missing).slice(0, 60))
} finally {
  srv.closeAllConnections?.()
  srv.close()
}

// -- E. v2 REPL commands over a pipe -------------------------------------------
const e = await run(process.execPath, [V2], ['/help', '/auto', '/auto on', '/tools', '/exit'])
check('E REPL exits 0', e.code === 0, `code=${e.code}`)
check('E /help lists /model', e.out.includes('/model [id]'))
check('E /help lists /export', e.out.includes('/export [f]'))
check('E /help keeps the pinned checklist row', e.out.includes("show the agent's current checklist"))
check('E /help keeps the pinned mcp row', e.out.includes('MCP servers: status + the tools they offer'))
check('E /auto off then on', e.out.includes('auto-approve off') && e.out.includes('auto-approve on'), e.out.slice(0, 120))
check('E /tools lists web_fetch', /tools · \d+ built in[\s\S]*web_fetch/.test(stripAnsi(e.out)))

const v2src = fs.readFileSync(V2, 'utf8')
check('E TAB completer wired into readline', v2src.includes('completer') && /readline\.createInterface\(\{[\s\S]*completer/.test(v2src))
check('E completer knows every slash command', v2src.includes("'/export'") && v2src.includes("'/model'"))
check('E spinner is TTY-gated', v2src.includes('TTY && !PRINT && !!process.stderr.isTTY'))
check('E spinner only draws between writes', v2src.includes('function spinClear'))
check('E SYSTEM prompt names web_fetch', v2src.includes('web_fetch opens one URL and returns its text'))
check('E SYSTEM prompt names edit_file', v2src.includes('write_file, edit_file and run_command always ask'))
check('E doctor routed from index', fs.readFileSync(CLI, 'utf8').includes("'./doctor.mjs'"))

// -- F. pins that must never break ---------------------------------------------
const pins = [
  ["case '/mcp'", true],
  ['MCP servers: status + the tools they offer', true],
  ["show the agent's current checklist", true],
  ['await mcpRegistryTools(servers)', true],
  ['Object.assign(registry, mcp.entries)', true],
  ['ev.ms < 1000', true],
  ['let mcpCache = null', true],
  ['type /help · /mcp', true]
]
for (const [pin] of pins) check(`F pin: ${pin}`, v2src.includes(pin))
const ternary = 'tools: mcp?.schemas?.length ? [...TOOLS, ...mcp.schemas] : undefined'
const count = v2src.split(ternary).length - 1
check('F tools ternary appears exactly twice', count === 2, `count=${count}`)

// -- G. it really packs: npm pack --dry-run ------------------------------------
{
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8', shell: true })
  if (npm.status !== 0) {
    console.log('SKIP  G npm pack (npm not on PATH)')
  } else {
    const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: CLI_DIR,
      encoding: 'utf8',
      shell: true,
      timeout: 120000
    })
    let meta = null
    try {
      meta = JSON.parse(r.stdout)[0]
    } catch {
      meta = null
    }
    check('G npm pack --dry-run exit 0', r.status === 0, `status=${r.status} ${(r.stderr ?? '').slice(0, 120)}`)
    check('G pack metadata parses', !!meta)
    if (meta) {
      const paths = (meta.files ?? []).map((f) => f.path)
      check('G pack ships index.mjs', paths.includes('index.mjs'), paths.join(', '))
      check('G pack ships lib/harness.mjs', paths.includes('lib/harness.mjs'))
      check('G pack ships the REPL shells', paths.includes('codezy-v2.mjs') && paths.includes('codezy.mjs'))
      check('G pack name + version', meta.name === 'codezy' && meta.version === pkg?.version, `${meta.name}@${meta.version}`)
      check('G pack stays dependency-free', !(meta.dependencies && Object.keys(meta.dependencies).length), JSON.stringify(meta.dependencies ?? {}))
      check('G pack has no node_modules noise', !paths.some((p) => p.startsWith('node_modules')), '')
    }
  }
}

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

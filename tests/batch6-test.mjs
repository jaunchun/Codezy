// Batch 6 headless check — desktop mirror + design layer:
//  1. shared/commands: 7-theme union, themeBase/themePalette, /copy + /diff
//     registered, helpText lists them (bundled with esbuild, then imported).
//  2. main/git.ts: gitDiff against a real temp repo + a non-repo folder.
//  3. global.css: the design-layer block exists, is last, carries palettes.
//  4. TUI: /theme dark gives the "app theme" hint instead of a usage error.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const require = createRequire(path.join(PROJ, 'package.json'))
const { build } = require('esbuild')

const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '\n')

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

const OUT = path.join(os.tmpdir(), `codezy-batch6-${Date.now()}`)
const REPO = path.join(OUT, 'repo')
const NOT_REPO = path.join(OUT, 'plain')
const cleanup = () => fs.rmSync(OUT, { recursive: true, force: true })
process.on('exit', cleanup)

// --- 1. bundle shared/commands + main/git (one entry each → flat outputs) -----
fs.mkdirSync(OUT, { recursive: true })
for (const entry of ['src/shared/commands.ts', 'src/main/git.ts']) {
  await build({
    entryPoints: [path.join(PROJ, entry)],
    outfile: path.join(OUT, path.basename(entry).replace(/\.ts$/, '.mjs')),
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
}
const commands = await import(pathToFileURL(path.join(OUT, 'commands.mjs')).href)
const gitmod = await import(pathToFileURL(path.join(OUT, 'git.mjs')).href)

const { isTheme, themeBase, themePalette, parseInput, helpText, THEME_NAMES } = commands
const PALETTES = ['midnight', 'ember', 'mint', 'slate']

check('theme union has 7', THEME_NAMES.length === 7, THEME_NAMES.join(','))
check('isTheme accepts surfaces', ['dark', 'light', 'acrylic'].every(isTheme))
check('isTheme accepts palettes', PALETTES.every(isTheme))
check('isTheme rejects junk', !isTheme('foo') && !isTheme('master') && !isTheme(''))
check(
  'themeBase mapping',
  themeBase('dark') === 'dark' &&
    themeBase('light') === 'light' &&
    themeBase('acrylic') === 'acrylic' &&
    PALETTES.every((t) => themeBase(t) === 'dark'),
  PALETTES.map((t) => `${t}→${themeBase(t)}`).join(' ')
)
check(
  'themePalette mapping',
  themePalette('ember') === 'ember' &&
    themePalette('mint') === 'mint' &&
    themePalette('slate') === 'slate' &&
    themePalette('midnight') === 'midnight' &&
    themePalette('dark') === 'midnight' &&
    themePalette('light') === 'midnight' &&
    themePalette('acrylic') === 'midnight'
)

const pc = parseInput('/copy last reply')
check('parseInput /copy', pc.kind === 'command' && pc.name === '/copy' && pc.args === 'last reply')
const pd = parseInput('/diff src/app.ts')
check('parseInput /diff', pd.kind === 'command' && pd.name === '/diff' && pd.args === 'src/app.ts')
check('parseInput unknown stays chat', parseInput('/nope here').kind === 'chat')
const help = helpText()
check('help lists /copy', help.includes('/copy'))
check('help lists /diff', help.includes('/diff'))
check('help /theme has palettes', help.includes('midnight|ember|mint|slate'))

// --- 2. gitDiff against a real repo + a plain folder --------------------------
const git = (...argv) =>
  spawnSync('git', ['-C', REPO, ...argv], { encoding: 'utf8', timeout: 10000, windowsHide: true })

fs.mkdirSync(REPO, { recursive: true })
fs.mkdirSync(NOT_REPO, { recursive: true })
git('init')
fs.writeFileSync(path.join(REPO, 'file.txt'), 'line1\nline2\n')
git('add', '.')
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init')
fs.writeFileSync(path.join(REPO, 'file.txt'), 'line1\nline2 changed\nline3')
fs.writeFileSync(path.join(REPO, 'untracked.txt'), 'new\n')

const { gitDiff } = gitmod
const d = gitDiff(REPO)
check('gitDiff ok', d.ok === true)
check('gitDiff branch', typeof d.branch === 'string' && d.branch.length > 0, `branch=${d.branch}`)
check('gitDiff files', d.files.some((f) => f.includes('file.txt')) && d.files.some((f) => f.includes('untracked.txt')), JSON.stringify(d.files))
check('gitDiff stat', d.stat.includes('file.txt') && d.stat.includes('|'), d.stat.split('\n')[0] ?? '')
check('gitDiff body additions', d.body.includes('+line3'))
check('gitDiff body deletions', d.body.includes('-line2'))
const narrow = gitDiff(REPO, 'file.txt')
check(
  'gitDiff pathspec',
  narrow.ok &&
    narrow.body.includes('+line3') &&
    narrow.stat.includes('file.txt') &&
    !narrow.stat.includes('untracked.txt') &&
    !narrow.files.some((f) => f.includes('untracked.txt')),
  narrow.stat.split('\n')[0] ?? ''
)
const nr = gitDiff(NOT_REPO)
check('gitDiff non-repo', nr.ok === false && /not a git repository/.test(nr.error ?? ''), nr.error ?? '')

// --- 3. global.css design layer ----------------------------------------------
const css = fs.readFileSync(path.join(PROJ, 'src/renderer/src/styles/global.css'), 'utf8')
const MARK = 'CODEZY v2 · DESIGN LAYER'
check('design layer marker present', css.includes(MARK))
check('design layer is last', css.indexOf(MARK) > css.indexOf('.dump-list {'), `mark=${css.indexOf(MARK)} dump=${css.indexOf('.dump-list {')}`)
check(
  'all 4 palettes in CSS',
  PALETTES.every((p) => css.includes(`html[data-palette='${p}']`))
)
check('design layer keeps --accent', /html\[data-palette='ember'\] \{[^}]*--accent: #ff8a3d/.test(css))
check('composer accent edge', css.includes('inset 2.5px 0 0 var(--accent)'))

// --- 4. TUI /theme with a desktop surface name -------------------------------
const TUI = path.join(PROJ, 'cli/codezy.mjs')
await new Promise((resolve) => {
  const p = spawn(process.execPath, [TUI], { cwd: PROJ, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (out += d))
  setTimeout(() => p.stdin.write('/theme dark\r'), 700)
  setTimeout(() => {
    p.stdin.end('/quit\r')
  }, 1500)
  p.on('close', (code) => {
    const s = strip(out)
    check('TUI /theme dark exit 0', code === 0, `code=${code}`)
    check('TUI /theme dark hint', s.includes('is an app theme'), s.split('\n').find((l) => l.includes('theme')) ?? '')
    check('TUI /theme dark keeps palettes listed', s.includes('midnight|ember|mint|slate'))
    resolve()
  })
  setTimeout(() => {
    try {
      p.kill()
    } catch {}
    resolve()
  }, 8000)
})

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

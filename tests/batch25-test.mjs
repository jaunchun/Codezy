// Batch 25 — v3 full makeover (presentation-only pass):
//  A. CSS static: block 29 appended after 28, design layer still last, the
//     typography rhythm (text-wrap/tracking), layered picker classes, unified
//     button/field focus states, modal entrance, accent selection, bubble
//     depth — and the reduce-motion kill still guards every new transition.
//  B. theme picker (jsdom): 7 swatches in the pinned order (ember at 4),
//     layered preview + accent dot + name, hover previews / restores, click
//     commits through the bridge, active ring follows the committed theme.
//  C. pin regression: the section labels, 8 accent swatches, export/import +
//     update controls and density buttons the older suites rely on.
// Deterministic: no network, scripted bridge, single-act interactions.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const require = createRequire(path.join(PROJ, 'package.json'))
const { build } = require('esbuild')

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

// OUT inside the project so esbuild resolves node_modules.
const OUT = path.join(PROJ, 'tests', '.tmp', `b25-${Date.now() % 100000}`)
fs.mkdirSync(OUT, { recursive: true })
const rd = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8')

// --- A. CSS static ---------------------------------------------------------------
{
  const css = rd('src/renderer/src/styles/global.css')
  const MARK = 'CODEZY v2 · DESIGN LAYER'
  check('A design layer marker present', css.includes(MARK))
  check('A design layer still last', css.indexOf(MARK) > css.indexOf('.dump-list {'), `mark=${css.indexOf(MARK)} dump=${css.indexOf('.dump-list {')}`)
  const order = ['26b — v2.6', '27 — v3 review-first', '28 — v3 connections', '29 — v3 full makeover'].map((m) => css.indexOf(m))
  check('A blocks in order 26b < 27 < 28 < 29', order.every((i) => i > 0) && order.every((i, n) => n === 0 || i > order[n - 1]), JSON.stringify(order))

  // typography rhythm
  check('A text-wrap rhythm', css.includes('text-wrap: balance') && css.includes('text-wrap: pretty'))
  check('A heading tracking', /\.modal h2[\s\S]{0,120}letter-spacing: -0\.014em/.test(css))
  check('A section label tracking', /\.settings-section \{\s*letter-spacing: 0\.06em/.test(css))
  check('A chips get tabular numbers', /\.chip,\s*\n\.settings-section ~ \.field \.row \.chip \{\s*font-variant-numeric: tabular-nums/.test(css))

  // layered picker
  for (const sel of ['.theme-preview {', '.theme-accent {', '.theme-name {', '.theme-swatch.active {', '.theme-swatch:focus-visible {'])
    check(`A picker style ${sel.slice(0, -2)}`, css.includes(sel))
  check('A active swatch glows with the accent', /theme-swatch\.active \{[^}]*box-shadow: 0 0 0 3px color-mix\(in srgb, var\(--accent\) 22%/.test(css))

  // micro-motion + focus
  check('A buttons transition', /\.btn \{\s*transition:[\s\S]*?border-color 0\.12s ease/.test(css))
  check('A keyboard focus rings', css.includes('.btn:focus-visible') && css.includes('.btn.danger:focus-visible'))
  check('A field accent focus ring', /\.field input:focus,\s*\.field textarea:focus,\s*\.field select:focus \{/.test(css))

  // entrance + selection + depth
  check('A modal entrance animation', css.includes('@keyframes modalIn') && /\.overlay \.modal,\s*\.overlay \.setup-card \{/.test(css))
  check('A selection follows the accent', /::selection \{\s*background: color-mix\(in srgb, var\(--accent\) 30%/.test(css))
  check('A bubble elevation', css.includes('.msg-row.user .bubble') && /\.bubble \{\s*box-shadow: 0 1px 2px/.test(css))

  // reduce-motion still guards everything new
  check('A reduce-motion kill intact', css.includes("html[data-motion='off'] *"))
  check('A prefers-reduced-motion blocks intact', css.includes('@media (prefers-reduced-motion: reduce)'))
}

// --- jsdom (batch21/24 pattern) ----------------------------------------------------
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
})
const defineGlobal = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
defineGlobal('window', dom.window)
defineGlobal('document', dom.window.document)
defineGlobal('navigator', dom.window.navigator)
defineGlobal('HTMLElement', dom.window.HTMLElement)
defineGlobal('HTMLInputElement', dom.window.HTMLInputElement)
defineGlobal('Event', dom.window.Event)
defineGlobal('MouseEvent', dom.window.MouseEvent)
defineGlobal('KeyboardEvent', dom.window.KeyboardEvent)
defineGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
defineGlobal('localStorage', dom.window.localStorage)
defineGlobal(
  'requestAnimationFrame',
  typeof dom.window.requestAnimationFrame === 'function'
    ? dom.window.requestAnimationFrame.bind(dom.window)
    : (cb) => setTimeout(cb, 0)
)
dom.window.matchMedia =
  dom.window.matchMedia ||
  (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// scripted bridge
const setCalls = []
const SETTINGS = {
  theme: 'dark',
  accent: '#3d9bff',
  dataDir: path.join(OUT, 'data'),
  driveFolder: null,
  ollamaUrl: 'http://127.0.0.1:11434',
  providers: [],
  activeProvider: 'ollama',
  activeModel: 'm',
  effort: 'medium',
  userName: 'dev',
  learn: true,
  fontSize: 14,
  mode: 'build',
  v2: false,
  setupDone: true,
  reduceMotion: false,
  density: 'cozy',
  autoUpdate: true,
  notifyDone: false,
  enterSends: true,
  mcpServers: []
}
const mock = {
  settings: {
    get: async () => SETTINGS,
    set: async (patch) => {
      setCalls.push(patch)
      return { ...SETTINGS, ...patch }
    }
  },
  models: { list: async () => [] },
  memory: { read: async () => '' },
  health: { drive: async () => 'off' },
  mcp: { list: async () => [], probe: async () => ({ ok: false, tools: [], error: 'not probed' }), save: async () => {} },
  dialog: { saveText: async () => null, pickFiles: async () => [] }
}
dom.window.codezy = mock
defineGlobal('codezy', mock)

const entry = path.join(OUT, 'entry.tsx')
fs.writeFileSync(
  entry,
  [
    `export { default as SettingsModal } from '${PROJ}/src/renderer/src/components/SettingsModal'`,
    `export { useApp } from '${PROJ}/src/renderer/src/store/app'`,
    `export { createRoot } from 'react-dom/client'`,
    `export { act } from 'react'`,
    `export { createElement } from 'react'`
  ].join('\n')
)
await build({
  entryPoints: [entry],
  outfile: path.join(OUT, 'ui.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  define: { __APP_VERSION__: JSON.stringify('0.0.0-test') },
  logLevel: 'silent'
})
const ui = await import(pathToFileURL(path.join(OUT, 'ui.mjs')).href)
const st = () => ui.useApp.getState()
const { createElement: h } = ui

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
const root = ui.createRoot(document.getElementById('root'))
const render = async (el) => {
  await ui.act(async () => {
    root.render(el)
    await settle()
  })
}
const fire = async (el, type) => {
  await ui.act(async () => {
    if (type === 'click') el.click()
    else el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, relatedTarget: document.body }))
    await settle()
  })
}

await ui.act(async () => {
  ui.useApp.setState({ settings: SETTINGS, settingsOpen: true })
})
await render(h(ui.SettingsModal))

// --- B. theme picker ------------------------------------------------------------------
{
  const swatches = [...document.querySelectorAll('.theme-swatch')]
  const labels = ['Dark', 'Light', 'Acrylic', 'Singularity', 'Midnight', 'Ember', 'Mint', 'Slate']
  check('B eight swatches in the pinned order', swatches.length === 8 && swatches.map((s) => s.querySelector('.theme-name')?.textContent).join(',') === labels.join(','), swatches.map((s) => s.querySelector('.theme-name')?.textContent).join(','))
  check('B ember stays at index 5', swatches[5]?.querySelector('.theme-name')?.textContent === 'Ember')
  check('B hover hint kept', swatches[0]?.title?.includes('Hover to preview'))
  check(
    'B layered preview structure',
    swatches.every((s) => !!s.querySelector('.theme-preview') && !!s.querySelector('.theme-accent')),
    String(swatches.filter((s) => !s.querySelector('.theme-preview')).length) + ' missing'
  )
  check('B accent dot carries the accent', swatches[0].querySelector('.theme-accent')?.style.background === 'rgb(61, 155, 255)', swatches[0].querySelector('.theme-accent')?.style.background)
  check('B committed theme marked active', swatches[0].classList.contains('active') && swatches.filter((s) => s.classList.contains('active')).length === 1)

  // hover previews, leave restores
  await fire(swatches[5], 'mouseover')
  check('B hovering previews ember', document.documentElement.dataset.palette === 'ember', document.documentElement.dataset.palette)
  await fire(swatches[5], 'mouseout')
  check('B leaving restores the committed theme', document.documentElement.dataset.palette !== 'ember', document.documentElement.dataset.palette)

  // click commits through the bridge
  await fire(swatches[6], 'click')
  check('B click commits the theme', setCalls.some((p) => p.theme === 'mint'), JSON.stringify(setCalls))
  check('B store reflects the commit', st().settings.theme === 'mint', st().settings.theme)
  const after = [...document.querySelectorAll('.theme-swatch')]
  check('B active ring follows the commit', after[6].classList.contains('active') && !after[0].classList.contains('active'))

  // previews use the inline gradient values (midnight's owns an accent half)
  check('B preview keeps its gradient', after[4].querySelector('.theme-preview')?.style.background.includes('linear-gradient'), after[4].querySelector('.theme-preview')?.style.background)
}

// --- C. pins the older suites rely on ---------------------------------------------------
{
  const labels = [...document.querySelectorAll('.settings-section')].map((n) => n.textContent.trim())
  const SECTIONS = ['profile', 'appearance', 'models & providers', 'behavior', 'storage', 'learning & memory', 'about', 'MCP servers']
  check('C every known section renders', SECTIONS.every((s) => labels.includes(s)), labels.join('|'))

  const accents = [...document.querySelectorAll('.accent-swatch')]
  check('C 8 accent swatches, one active', accents.length === 8 && accents.filter((s) => s.classList.contains('active')).length === 1, String(accents.length))

  const texts = [...document.querySelectorAll('button')].map((b) => b.textContent.trim())
  check('C export + import offered', texts.some((t) => t.startsWith('export settings')) && texts.some((t) => t.startsWith('import settings')))
  check('C update controls offered', texts.includes('check now') && texts.includes('check on launch') && texts.includes('never'), JSON.stringify(texts.filter((t) => t.includes('check') || t === 'never')))
  check('C density buttons offered', texts.includes('cozy') && texts.includes('compact'))
  check('C effort + mode buttons offered', ['plan', 'build', 'auto'].every((m) => texts.includes(m)) && ['light', 'medium', 'deep'].every((e) => texts.includes(e)))

  await ui.act(async () => {
    ui.useApp.setState({ settingsOpen: false })
  })
  await render(h(ui.SettingsModal))
  check('C dialog unmounts on close', !document.querySelector('.modal'))
}

// --- cleanup + summary ----------------------------------------------------------------------
try {
  fs.rmSync(OUT, { recursive: true, force: true })
} catch { /* best effort */ }

console.log('')
console.log(fails.length ? `${fails.length} FAIL:\n  ${fails.join('\n  ')}` : 'ALL PASS')
process.exit(fails.length ? 1 : 0)

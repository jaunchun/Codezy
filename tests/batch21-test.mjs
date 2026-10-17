// Batch 21 — the v2.6 in-app GitHub updater (jaunchun/Codezy):
//  1. static: the whole wiring — update.ts, the four IPC handlers, the preload
//     bridge, the api types, the store actions, the /update command, the
//     Settings → about controls and the block-26b pill CSS.
//  2. unit: the pure helpers with an INJECTED fetch (GitHub is never touched):
//     asset-name version parsing, numeric compare, release evaluation
//     (drafts/prereleases skipped, never a downgrade pill), check/download
//     failure paths, byte-count verification and the silent installer spawn.
//  3. jsdom: the title-bar pill — idle → downloading (percent) → ready →
//     installing, failure lands back at idle, dismissal persists per version
//     and only a NEWER version re-opens the pill.
// Scratch lives under tests/.tmp and USERPROFILE is faked into it.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const require = createRequire(path.join(PROJ, 'package.json'))
const { build } = require('esbuild')

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  - ' + detail : ''}`)
  if (!ok) fails.push(label)
}

const OUT = path.join(PROJ, 'tests', '.tmp', `b21-${Date.now()}`)
const FAKE_HOME = path.join(OUT, 'fake-home')
fs.mkdirSync(FAKE_HOME, { recursive: true })
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME
process.on('exit', () => {
  try {
    fs.rmSync(OUT, { recursive: true, force: true })
  } catch {}
})

const read = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8')

// --- 1. static: the wiring ----------------------------------------------------
{
  const upd = read('src/main/update.ts')
  check('update: points at jaunchun/Codezy', upd.includes(`UPDATE_REPO = 'jaunchun/Codezy'`))
  check('update: hits the GitHub releases API', upd.includes('https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10'))
  check('update: the check has a short timeout', upd.includes('AbortSignal.timeout(8000)'))
  check('update: the download gets ten slow-line minutes', upd.includes('AbortSignal.timeout(600_000)'))
  check('update: sends a user agent', /'user-agent': `CODEZY\//.test(upd))
  check('update: never throws — failures resolve to ok:false', /error: e instanceof Error \? e\.message : String\(e\)/.test(upd))
  check('update: streams to .part, then renames', upd.includes('fs.createWriteStream(tmp)') && upd.includes('fs.renameSync(tmp, dest)'))
  check('update: verifies every byte against content-length', /received !== total/.test(upd))
  check(
    'update: the installer runs silently with the electron-updater flags',
    /spawn\(setupPath, \['--updated', '\/S', '--force-run'\]/.test(upd)
  )
  check('update: detached + hidden window + unref', /detached: true/.test(upd) && /windowsHide: true/.test(upd) && /child\.unref\(\)/.test(upd))
  check('update: resolves on the real spawn/error outcome', /child\.once\('spawn'/.test(upd) && /child\.once\('error'/.test(upd))
  check('update: a missing file is an error, not a crash', upd.includes(`error: 'update file is gone'`))
  check('update: NO second window (no BrowserWindow in the updater)', !/new BrowserWindow/.test(upd))

  const main = read('src/main/index.ts')
  for (const ch of ['update:check', 'update:download', 'update:apply', 'update:openRelease']) {
    check(`main: ${ch} handler registered`, main.includes(`ipcMain.handle('${ch}'`))
  }
  check('main: compares against the running app version', /checkForUpdates\(app\.getVersion\(\)\)/.test(main))
  check('main: progress is pushed to the renderer', main.includes(`win?.webContents.send('update:progress', p)`))
  check('main: the download lands in the app temp dir', /app\.getPath\('temp'\), 'codezy-update'/.test(main))
  check('main: a successful spawn quits 300ms later so NSIS owns the files', /setTimeout\(\(\) => app\.quit\(\), 300\)/.test(main))
  check('main: external links are restricted to github.com', main.includes(`url.startsWith('https://github.com/')`))
  check('main: nothing newer drops the stale file', /if \(!updateCheck\.available\) updateFile = null/.test(main))

  const pre = read('src/preload/index.ts')
  check('preload: update bridge block present', /update: \{/.test(pre))
  check('preload: check/download/apply/openRelease invoked', /check: \(\) => ipcRenderer\.invoke\('update:check'\)/.test(pre) && /download: \(\) => ipcRenderer\.invoke\('update:download'\)/.test(pre) && /apply: \(\) => ipcRenderer\.invoke\('update:apply'\)/.test(pre) && /openRelease: \(url: string\)/.test(pre))
  check('preload: onProgress subscribes and returns an unsubscribe', /update:progress'/.test(pre) && /removeListener\('update:progress'/.test(pre))

  const api = read('src/shared/api.ts')
  check('api: update section declared', /update: \{/.test(api))
  for (const t of ['UpdateRelease', 'UpdateCheck', 'UpdateProgress']) {
    check(`api: ${t} type exported`, new RegExp(`interface ${t} \\{`).test(api))
  }
  check('api: check() never rejects', /check\(\): Promise<UpdateCheck>/.test(api))

  check('types: autoUpdate setting', /autoUpdate\?: boolean/.test(read('src/shared/types.ts')))
  check('main store: autoUpdate defaults on', /autoUpdate: true/.test(read('src/main/store.ts')))

  const store = read('src/renderer/src/store/app.ts')
  check('store: dismissal is remembered per version', store.includes(`const UPDATE_DISMISS_KEY = 'codezy.update.dismissed'`))
  check('store: launch check is gated by autoUpdate', /if \(settings\.autoUpdate !== false\)/.test(store))
  check('store: the launch check is silent and failure-proof', /checkForUpdates\(true\)/.test(store) && /\.catch\(\(\) => undefined\)/.test(store))
  check('store: checkForUpdates(silent?) action', /async checkForUpdates\(silent = false\)/.test(store))
  check('store: downloadUpdate action', /async downloadUpdate\(\)/.test(store))
  check('store: applyUpdate action', /async applyUpdate\(\)/.test(store))
  check('store: dismissUpdate action', /dismissUpdate\(\)/.test(store))
  check('store: a failed download falls back to idle', /Update download failed/.test(store) && /updatePhase: 'idle', updatePercent: 0/.test(store))
  check('store: a failed installer start falls back to ready', /Couldn't start the update/.test(store) && /updatePhase: 'ready'/.test(store))
  check('store: /update runs a non-silent check', /case '\/update':/.test(store) && /checkForUpdates\(false\)/.test(store))

  const bar = read('src/renderer/src/components/TitleBar.tsx')
  check('titlebar: the pill renders only for a newer, undismissed version', /const showPill = !!release && release\.version !== updateDismissed/.test(bar))
  check('titlebar: phase is on the element as data-phase', /className="upd-pill" data-phase=\{updatePhase\}/.test(bar))
  check('titlebar: three aria labels (download / downloading / restart)', bar.includes("'Restart to install update'") && bar.includes("'Update downloading'") && bar.includes("'Download update'"))
  check('titlebar: shows the percent while downloading', /`\$\{updatePercent\}%`/.test(bar))
  check('titlebar: idle clicks download, ready clicks install', /if \(updatePhase === 'idle'\) void downloadUpdate\(\)/.test(bar) && /else if \(updatePhase === 'ready'\) void applyUpdate\(\)/.test(bar))
  check('titlebar: no dismiss while it is working', /updatePhase === 'idle' \|\| updatePhase === 'ready'/.test(bar))

  const set = read('src/renderer/src/components/SettingsModal.tsx')
  check('settings: check on launch / never / check now', set.includes('check on launch') && set.includes('check now') && /className=\{`btn \$\{settings\.autoUpdate === false \? 'primary' : ''\}`\}/.test(set))
  check('settings: the hint promises a top-bar pill', set.includes('small pill in the top bar'))

  check('commands: /update registered', read('src/shared/commands.ts').includes(`name: '/update'`))

  const css = read('src/renderer/src/styles/global.css')
  const has = (re, label) => check(label, re.test(css))
  has(/26b — v2\.6 GitHub updater/, 'css: the pill lives in the last (26b) design block')
  has(/\.titlebar \.upd-pill \{/, 'css: pill inside the title bar')
  has(/\.upd-main \{/, 'css: pill main button')
  has(/\.upd-bar \{/, 'css: bottom progress bar')
  has(/\.upd-pill\[data-phase='downloading'\] \.upd-bar \{/, 'css: bar fills while downloading')
  has(/\.upd-pill\[data-phase='ready'\] \.upd-main[\s\S]{0,120}animation: updPulse/, 'css: ready state pulses')
  has(/\.upd-pill\[data-phase='installing'\] \.upd-main \{/, 'css: installing state')
  has(/@keyframes updPulse \{/, 'css: updPulse keyframes')
  has(/\.upd-x \{/, 'css: dismiss button')
}

// --- 2. unit: the pure helpers with an injected fetch -------------------------
{
  fs.writeFileSync(
    path.join(OUT, 'update-entry.ts'),
    `export {
      parseVersion, compareVersions, isNewerVersion, pickAsset, evaluateReleases,
      checkForUpdates, downloadUpdate, applyUpdate, UPDATE_REPO
    } from '${PROJ}/src/main/update'`
  )
  await build({
    entryPoints: [path.join(OUT, 'update-entry.ts')],
    outfile: path.join(OUT, 'update.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const u = await import(pathToFileURL(path.join(OUT, 'update.mjs')).href)

  check('update: UPDATE_REPO is the shipped repo', u.UPDATE_REPO === 'jaunchun/Codezy', String(u.UPDATE_REPO))

  // version parsing comes from the asset name (the tag is prose)
  check('version: CODEZY-Setup-2.6.0.exe → 2.6.0', u.parseVersion('CODEZY-Setup-2.6.0.exe') === '2.6.0', String(u.parseVersion('CODEZY-Setup-2.6.0.exe')))
  check('version: two-part names normalise to x.y.0', u.parseVersion('CODEZY-Setup-2.6.exe') === '2.6.0', String(u.parseVersion('CODEZY-Setup-2.6.exe')))
  check('version: a prose tag carries no version', u.parseVersion('Release') === null, String(u.parseVersion('Release')))
  check('version: an installer without a number is skipped', u.parseVersion('setup.exe') === null)

  check('compare: numeric, never lexical (2.10.0 > 2.9.0)', u.compareVersions('2.10.0', '2.9.0') === 1, String(u.compareVersions('2.10.0', '2.9.0')))
  check('compare: equal versions are 0', u.compareVersions('2.5.0', '2.5.0') === 0)
  check('compare: older is -1', u.compareVersions('1.9.9', '2.0.0') === -1)
  check('newer: strictly newer only', u.isNewerVersion('2.6.0', '2.5.0') && !u.isNewerVersion('2.5.0', '2.5.0') && !u.isNewerVersion('2.4.0', '2.5.0'))

  const asset = (name, url = `https://github.com/jaunchun/Codezy/releases/download/x/${name}`, size = 1) => ({ name, browser_download_url: url, size })
  check('asset: picks the newest setup exe', u.pickAsset([asset('CODEZY-Setup-2.5.0.exe'), asset('CODEZY-Setup-2.6.0.exe')])?.version === '2.6.0')
  check('asset: ignores anything that is not an exe', u.pickAsset([asset('notes.md'), asset('src.zip')]) === null)
  check('asset: ignores an exe with no version', u.pickAsset([asset('CODEZY-setup.exe')]) === null)
  check('asset: ignores an exe with no download url', u.pickAsset([{ name: 'CODEZY-Setup-9.9.9.exe' }]) === null)
  check('asset: a non-array payload is not a release', u.pickAsset('nonsense') === null)

  const release = (version, extra = {}) => ({
    draft: false,
    prerelease: false,
    html_url: `https://github.com/jaunchun/Codezy/releases/tag/Release`,
    body: `CODEZY ${version}`,
    assets: [asset(`CODEZY-Setup-${version}.exe`)],
    ...extra
  })

  const newer = u.evaluateReleases([release('2.6.0')], '2.5.0')
  check('evaluate: a newer release is offered', newer.ok === true && newer.available === true && newer.release?.version === '2.6.0')
  check('evaluate: notes and page come along', newer.release.notes === 'CODEZY 2.6.0' && newer.release.page.includes('github.com'))

  const behind = u.evaluateReleases([release('2.3.0')], '2.5.0')
  check('evaluate: GitHub behind local → no downgrade pill', behind.ok === true && behind.available === false && behind.release === null)

  const same = u.evaluateReleases([release('2.5.0')], '2.5.0')
  check('evaluate: the same version is not an update', same.available === false && same.release === null)

  const drafts = u.evaluateReleases([release('9.9.9', { draft: true }), release('8.8.8', { prerelease: true })], '2.5.0')
  check('evaluate: drafts and prereleases are skipped', drafts.available === false && drafts.release === null)

  const mixed = u.evaluateReleases([release('2.4.0'), release('2.6.0'), release('2.5.5')], '2.5.0')
  check('evaluate: the highest of several releases wins', mixed.release?.version === '2.6.0', String(mixed.release?.version))

  check('evaluate: a payload that is not an array is harmless', u.evaluateReleases({ message: 'API rate limit' }, '2.5.0').available === false)
  const long = u.evaluateReleases([{ ...release('2.6.0'), body: 'x'.repeat(900) }], '2.5.0')
  check('evaluate: release notes are capped', long.release.notes.length === 400, String(long.release.notes.length))

  // --- checkForUpdates: injected fetch, never the network ---
  const calls = []
  const okFetch = (payload, opts = {}) => async (url, init) => {
    calls.push({ url, init })
    if (opts.throw) throw new Error('network down')
    return { ok: !opts.status, status: opts.status ?? 200, json: async () => payload }
  }

  const ok = await u.checkForUpdates('2.5.0', okFetch([release('2.6.0')]))
  check('check: an available release comes back ok+available', ok.ok && ok.available && ok.release.version === '2.6.0')
  check('check: asks jaunchun/Codezy for releases', calls[0].url === 'https://api.github.com/repos/jaunchun/Codezy/releases?per_page=10', calls[0].url)
  check('check: carries a user agent and the api accept header', /CODEZY\/2\.5\.0/.test(calls[0].init.headers['user-agent']) && calls[0].init.headers.accept === 'application/vnd.github+json')
  check('check: has an abort signal attached', !!calls[0].init.signal)

  const behind2 = await u.checkForUpdates('2.5.0', okFetch([release('2.3.0')]))
  check('check: local newer than GitHub → available:false', behind2.ok && !behind2.available && behind2.release === null)

  const http = await u.checkForUpdates('2.5.0', okFetch([], { status: 503 }))
  check('check: an HTTP error resolves to ok:false', http.ok === false && !http.available && /503/.test(http.error), http.error)

  const offline = await u.checkForUpdates('2.5.0', okFetch(null, { throw: true }))
  check('check: a dead network resolves, never throws', offline.ok === false && offline.error === 'network down', JSON.stringify(offline))

  // --- downloadUpdate: a fake byte stream into the scratch dir ---
  const dl = path.join(OUT, 'dl')
  const chunkFetch = (chunks, { status = 200, length = null } = {}) => async () => ({
    ok: status === 200,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? length : null) },
    body: {
      getReader() {
        let i = 0
        return {
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined })
        }
      }
    }
  })
  const bytes = (s) => new Uint8Array(Buffer.from(s))
  const progress = []

  const got = await u.downloadUpdate('https://example.invalid/setup.exe', dl, (p) => progress.push(p), chunkFetch([bytes('hello '), bytes('world')], { length: '11' }))
  check('download: lands as CODEZY-update.exe', typeof got.path === 'string' && got.path.endsWith('CODEZY-update.exe'), JSON.stringify(got))
  check('download: every streamed byte is on disk', fs.existsSync(got.path) && fs.readFileSync(got.path, 'utf8') === 'hello world')
  check('download: no .part left behind', !fs.existsSync(`${got.path}.part`))
  check('download: progress reports received/total/percent', progress.length >= 2 && progress.at(-1).received === 11 && progress.at(-1).total === 11 && progress.at(-1).percent === 100, JSON.stringify(progress.at(-1)))

  const noLen = []
  const got2 = await u.downloadUpdate('https://example.invalid/setup.exe', dl, (p) => noLen.push(p), chunkFetch([bytes('abc')], { length: null }))
  check('download: unknown size reports percent -1 (never fake 100)', !!got2.path && noLen.at(-1).percent === -1, JSON.stringify(noLen.at(-1)))

  const short = await u.downloadUpdate('https://example.invalid/setup.exe', dl, () => {}, chunkFetch([bytes('tiny')], { length: '999' }))
  check('download: a short body is rejected, not installed', 'error' in short && /incomplete download \(4\/999 bytes\)/.test(short.error), JSON.stringify(short))
  check('download: the partial file is removed', !fs.existsSync(path.join(dl, 'CODEZY-update.exe.part')))

  const http404 = await u.downloadUpdate('https://example.invalid/gone.exe', dl, () => {}, chunkFetch([], { status: 404 }))
  check('download: HTTP failure is an error string', 'error' in http404 && /HTTP 404/.test(http404.error), JSON.stringify(http404))

  // --- applyUpdate: never spawns a file that is not there ---
  const gone = await u.applyUpdate(path.join(OUT, 'no-such-setup.exe'))
  check('apply: a vanished setup refuses cleanly (no spawn)', gone.ok === false && gone.error === 'update file is gone', JSON.stringify(gone))
}

// --- 3. jsdom: the title-bar pill ---------------------------------------------
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let diskState = {
  theme: 'dark',
  accent: '#3d9bff',
  dataDir: 'tests/.tmp/batch21',
  driveFolder: null,
  ollamaUrl: 'http://127.0.0.1:11434',
  providers: [],
  activeProvider: 'ollama',
  activeModel: 'qwen.2.5-coder:7b',
  effort: 'medium',
  userName: 'dev',
  learn: true,
  fontSize: 14,
  mode: 'build',
  v2: false,
  notifyDone: false,
  enterSends: true,
  setupDone: true,
  reduceMotion: false,
  autoContinue: true,
  autoUpdate: false // no launch timer while the suite runs — the gate itself is grepped above
}
let eventHandler = null
const chatSends = []
let healthStatus = 'online'

// the updater bridge: controllable so every phase can be held and observed
let progressCb = null
let checkCalls = 0
let checkResult = null
let downloadImpl = async () => ({ path: path.join(OUT, 'dl', 'CODEZY-update.exe') })
let applyImpl = async () => ({ ok: true })
const update = {
  check: async () => {
    checkCalls++
    return typeof checkResult === 'function' ? checkResult() : { ...checkResult }
  },
  download: () => downloadImpl(),
  apply: () => applyImpl(),
  onProgress: (cb) => {
    progressCb = cb
    return () => {
      progressCb = null
    }
  },
  openRelease: async () => {}
}
const AVAILABLE = (v) => ({
  ok: true,
  current: '2.5.0',
  available: true,
  release: {
    version: v,
    name: `CODEZY-Setup-${v}.exe`,
    url: `https://github.com/jaunchun/Codezy/releases/download/rel/CODEZY-Setup-${v}.exe`,
    size: 113000000,
    notes: 'Fixes the cowork tree.',
    page: 'https://github.com/jaunchun/Codezy/releases'
  }
})

const mock = {
  settings: {
    get: async () => ({ ...diskState }),
    set: async (patch) => {
      diskState = { ...diskState, ...patch }
      return { ...diskState }
    }
  },
  projects: { list: async () => [] },
  sessions: {
    list: async () => [
      { id: 's1', title: 'one', messages: [{ id: 'm1', role: 'assistant', content: 'hi', ts: 1 }], createdAt: 1, updatedAt: 1, linkedFolders: [] }
    ],
    create: async () => ({ id: 'new', title: 'New chat', messages: [], createdAt: 1, updatedAt: 1 }),
    save: async (s) => s,
    delete: async () => {}
  },
  chat: {
    onEvent: (cb) => {
      eventHandler = cb
    },
    send: async (id) => {
      chatSends.push(id)
    },
    abort: async () => {}
  },
  health: { ollama: async () => healthStatus, drive: async () => 'ok' },
  models: { list: async () => [{ id: 'qwen.2.5-coder:7b', provider: 'ollama', providerName: 'Ollama', parameter: '7B', quant: 'Q4', size: 1, family: 'qwen' }] },
  memory: { read: async () => '', write: async () => true },
  skills: { list: async () => [] },
  edits: { apply: async () => ({ applied: [], errors: [] }), list: async () => [], undo: async () => ({ message: 'ok' }), restore: async () => ({ restored: 0, message: 'no' }) },
  dialog: { pickFolder: async () => null, pickFiles: async () => [], saveText: async (name) => path.join(OUT, name) },
  images: { dataUrl: async () => 'data:image/gif;base64,', paste: async () => null },
  files: { list: async () => [], read: async () => null },
  ide: { tree: async () => [], read: async () => null, write: async (_id, p) => p, create: async (_id, p) => p, rename: async (_id, f, t) => t, delete: async () => true },
  git: { status: async () => ({ ok: false, folder: '', files: [] }), diff: async () => ({ ok: false, error: 'no repo', folder: '', branch: '', files: [], stat: '', body: '' }) },
  win: { minimize: () => {}, maximize: () => {}, close: () => {} },
  update
}
dom.window.codezy = mock

const entry = path.join(OUT, 'entry.tsx')
fs.writeFileSync(
  entry,
  [
    `export { default as TitleBar } from '${PROJ}/src/renderer/src/components/TitleBar'`,
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

await st().init()
check('init: starts with nothing checked', st().updateInfo === null && st().updatePhase === 'idle', JSON.stringify({ i: st().updateInfo, p: st().updatePhase }))
check('init: no stray launch timer when autoUpdate is off', diskState.autoUpdate === false)

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}
const root = ui.createRoot(document.getElementById('root'))
const render = async (el) => {
  await ui.act(async () => {
    root.render(el)
  })
}
const pill = () => document.querySelector('.upd-pill')
const btn = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label)
const click = async (el) => {
  await ui.act(async () => {
    el.click()
  })
  await flush(4)
}

// --- idle pill ----------------------------------------------------------------
ui.useApp.setState({ updateInfo: AVAILABLE('2.6.0'), updatePhase: 'idle', updatePercent: 0, updateDismissed: null })
await render(ui.createElement(ui.TitleBar, { title: 'one' }))
check('pill: shows for a newer version', !!pill(), pill() ? pill().className : 'missing')
check('pill: starts idle with the version label', pill()?.dataset.phase === 'idle' && pill()?.querySelector('.upd-label')?.textContent === 'v2.6.0', pill() ? pill().dataset.phase + '/' + pill().textContent : '')
check('pill: aria label says what a click does', pill()?.querySelector('.upd-main')?.getAttribute('aria-label') === 'Download update')
check('pill: idle has a dismiss button', !!pill()?.querySelector('.upd-x'))

await ui.act(async () => {
  ui.useApp.setState({ updateInfo: { ok: true, current: '2.5.0', available: false, release: null } })
})
await flush()
check('pill: hidden when the check says nothing is newer', !pill(), pill() ? pill().textContent : 'hidden')

await ui.act(async () => {
  ui.useApp.setState({ updateInfo: AVAILABLE('2.6.0'), updatePhase: 'idle' })
})
await flush()
check('pill: back as soon as GitHub is ahead', !!pill() && pill()?.dataset.phase === 'idle', pill() ? pill().textContent : 'missing')

// --- download: hold it mid-flight ---------------------------------------------
let resolveDownload = null
downloadImpl = () => new Promise((r) => (resolveDownload = r))
await click(pill().querySelector('.upd-main'))
check('download: click flips the pill to downloading', st().updatePhase === 'downloading', st().updatePhase)
check('download: the pill shows a percentage', pill()?.querySelector('.upd-pct')?.textContent === '0%', pill()?.textContent)
check('download: aria label reflects the state', pill()?.querySelector('.upd-main')?.getAttribute('aria-label') === 'Update downloading')
check('download: no dismiss while it runs', !pill()?.querySelector('.upd-x'))

await ui.act(async () => {
  progressCb && progressCb({ received: 47300000, total: 113000000, percent: 42 })
})
check('download: progress moves the label and the bar', pill()?.querySelector('.upd-pct')?.textContent === '42%' && pill()?.querySelector('.upd-bar')?.style.width === '42%', pill()?.querySelector('.upd-bar')?.style.width)

await ui.act(async () => {
  resolveDownload && resolveDownload({ path: path.join(OUT, 'dl', 'CODEZY-update.exe') })
  resolveDownload = null
  await flush(4)
})
check('download: finished → ready to install', st().updatePhase === 'ready', st().updatePhase)
check('pill: ready asks for a restart', pill()?.querySelector('.upd-label')?.textContent === 'restart to update' && pill()?.querySelector('.upd-main')?.getAttribute('aria-label') === 'Restart to install update', pill()?.textContent)

// --- apply --------------------------------------------------------------------
let applied = 0
applyImpl = async () => {
  applied++
  return { ok: true }
}
await click(pill().querySelector('.upd-main'))
check('apply: clicking starts the installer', applied === 1 && st().updatePhase === 'installing', `${applied}/${st().updatePhase}`)
check('pill: installing state is on the element', pill()?.dataset.phase === 'installing')

applyImpl = async () => ({ ok: false, error: 'nope' })
await ui.act(async () => {
  ui.useApp.setState({ updatePhase: 'ready' }) // a click only applies from here
})
await flush()
await click(pill().querySelector('.upd-main'))
check('apply: a failed start falls back to ready with a notice', st().updatePhase === 'ready' && st().notices.some((n) => /Couldn't start the update: nope/.test(n.text)), JSON.stringify(st().notices.map((n) => n.text)))

// --- a failed download never wedges the pill ----------------------------------
downloadImpl = async () => ({ error: 'network died' })
await ui.act(async () => {
  ui.useApp.setState({ updatePhase: 'idle', updatePercent: 0 })
})
await flush()
await click(pill().querySelector('.upd-main'))
check('download: a failure returns to idle with a notice', st().updatePhase === 'idle' && st().updatePercent === 0 && st().notices.some((n) => /Update download failed: network died/.test(n.text)), JSON.stringify(st().notices.map((n) => n.text)))

// --- dismissal is per version -------------------------------------------------
downloadImpl = async () => ({ path: path.join(OUT, 'dl', 'CODEZY-update.exe') })
await ui.act(async () => {
  ui.useApp.setState({ updateInfo: AVAILABLE('2.6.0'), updatePhase: 'idle', updatePercent: 0, updateDismissed: null })
})
await flush()
await click(pill().querySelector('.upd-x'))
check('dismiss: the pill goes away', st().updateInfo === null && !pill())
check('dismiss: remembered in localStorage per version', localStorage.getItem('codezy.update.dismissed') === '2.6.0', String(localStorage.getItem('codezy.update.dismissed')))
check('dismiss: the store remembers it too', st().updateDismissed === '2.6.0', String(st().updateDismissed))

await ui.act(async () => {
  ui.useApp.setState({ updateInfo: AVAILABLE('2.6.0') })
})
await flush()
check('dismiss: the same version stays hidden', !pill(), pill() ? pill().textContent : 'hidden')

await ui.act(async () => {
  ui.useApp.setState({ updateInfo: AVAILABLE('2.6.1') })
})
await flush()
check('dismiss: a NEWER version opens the pill again', !!pill() && pill()?.querySelector('.upd-label')?.textContent === 'v2.6.1', pill() ? pill().textContent : 'missing')

// --- the check action: notices, silent mode, failures -------------------------
checkResult = AVAILABLE('2.6.1')
await st().checkForUpdates(false)
check('check: available → notice points at the top bar', st().notices.some((n) => /pill in the top bar installs it/.test(n.text)), JSON.stringify(st().notices.map((n) => n.text)))

const quiet = st().notices.length
await st().checkForUpdates(true)
check('check: the launch check is silent (no notice)', st().notices.length === quiet && st().updateInfo.available === true, String(st().notices.length - quiet))

checkResult = { ok: true, current: '2.5.0', available: false, release: null }
await st().checkForUpdates(false)
check('check: up to date says so', st().notices.some((n) => /You're on the latest version \(2\.5\.0\)/.test(n.text)), JSON.stringify(st().notices.map((n) => n.text)))

checkResult = { ok: false, current: '2.5.0', available: false, release: null, error: 'offline' }
await st().checkForUpdates(false)
check('check: an offline check reports without throwing', st().notices.some((n) => /Update check failed: offline/.test(n.text)), JSON.stringify(st().notices.map((n) => n.text)))

// --- /update command ----------------------------------------------------------
checkResult = AVAILABLE('2.6.1')
const before = checkCalls
const sendsBefore = chatSends.length
await st().send('/update')
check('cmd /update runs a check', checkCalls === before + 1, String(checkCalls - before))
check('cmd /update never reaches the model', chatSends.length === sendsBefore, String(chatSends.length - sendsBefore))

// --- settings: the auto-update toggle ----------------------------------------
await st().updateSettings({ autoUpdate: false })
check('settings: autoUpdate persists through the bridge', diskState.autoUpdate === false, String(diskState.autoUpdate))

ui.useApp.setState({ settingsOpen: true, settings: { ...st().settings, autoUpdate: false } })
await render(ui.createElement(ui.SettingsModal))
check('settings: update controls offered', !!btn('check on launch') && !!btn('never') && !!btn('check now'), [...document.querySelectorAll('.settings-section')].map((s) => s.textContent).join('|'))
await click(btn('check now'))
check('settings: check now runs a check', checkCalls === before + 2, String(checkCalls - before))
await click(btn('check on launch'))
check('settings: check on launch turns the gate back on', st().settings.autoUpdate === true && diskState.autoUpdate === true, String(diskState.autoUpdate))
await click(btn('never'))
check('settings: never turns the gate off', st().settings.autoUpdate === false && diskState.autoUpdate === false, String(diskState.autoUpdate))

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

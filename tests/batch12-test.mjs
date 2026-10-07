// Batch 12 — "models don't show up" root-cause fixes:
//  1. main store patchSettings (esbuild): a patch merges over the file ON
//     DISK — an external writer's keys (a provider the TUI connected) survive
//     a settings update. Old behavior rewrote the whole object and wiped them.
//  2. renderer store (esbuild, mocked bridge): updateSettings sends ONLY the
//     changed keys (patch, not full state); a rejecting health.drive() can no
//     longer skip the model refresh; resync() pulls settings + models written
//     by another holder.
//  3. pickerRows (esbuild): group heads + model rows, and a connected provider
//     with nothing loaded gets an explicit "(no models loaded …)" note instead
//     of a silent gap.
//  4. TUI clobber survival (USERPROFILE-isolated): desktop writes providers
//     while the TUI is running → TUI's next save (/effort) must NOT wipe them.
//     Old code spread its startup snapshot over the file → wiped.
//  5. TUI external visibility: a provider written by the desktop shows up in
//     the TUI's /provider card without a restart (syncSettings on each input).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
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

const OUT = path.join(os.tmpdir(), `codezy-batch12-${Date.now()}`)
fs.mkdirSync(OUT, { recursive: true })
const ISO_ROOTS = []
process.on('exit', () => {
  for (const d of ISO_ROOTS) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {}
  }
  try {
    fs.rmSync(OUT, { recursive: true, force: true })
  } catch {}
})

const NEBIUS = { id: 'nebius', name: 'Nebius Token Factory', baseUrl: 'https://api.tokenfactory.nebius.com/v1', apiKey: 'nk-b12' }

// --- 1. main store: patchSettings merges over disk ---------------------------
fs.writeFileSync(
  path.join(OUT, 'electron-stub.mjs'),
  'export const app = { getPath: () => "" }\nexport default { app }\n'
)
await build({
  entryPoints: [path.join(PROJ, 'src/main/store.ts')],
  outfile: path.join(OUT, 'store.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { electron: path.join(OUT, 'electron-stub.mjs') },
  logLevel: 'silent'
})
{
  const store = await import(pathToFileURL(path.join(OUT, 'store.mjs')).href)
  const TDIR = path.join(OUT, 'data')
  store.initStore(TDIR)
  store.saveSettings({
    theme: 'dark',
    accent: '#3d9bff',
    dataDir: TDIR,
    driveFolder: null,
    ollamaUrl: 'http://127.0.0.1:11434',
    providers: [NEBIUS],
    activeProvider: 'nebius',
    activeModel: 'nvidia/Nemotron-3_5-Lightning',
    effort: 'medium',
    userName: '',
    learn: true,
    fontSize: 14,
    mode: 'build',
    v2: false,
    notifyDone: false,
    enterSends: true
  })

  const { prev, saved } = store.patchSettings({ effort: 'deep' })
  const file1 = JSON.parse(fs.readFileSync(path.join(TDIR, 'settings.json'), 'utf8'))
  check('store: patch applied', saved.effort === 'deep' && file1.effort === 'deep', `effort=${file1.effort}`)
  check(
    'store: patch preserves providers',
    Array.isArray(file1.providers) && file1.providers[0]?.id === 'nebius' && file1.providers[0]?.apiKey === 'nk-b12',
    JSON.stringify(file1.providers)
  )
  check('store: prev is the pre-patch disk state', prev.effort === 'medium', `prev.effort=${prev.effort}`)

  // an external writer (the TUI) changes a key after the desktop read it
  const disk = JSON.parse(fs.readFileSync(path.join(TDIR, 'settings.json'), 'utf8'))
  disk.activeModel = 'external-model'
  fs.writeFileSync(path.join(TDIR, 'settings.json'), JSON.stringify(disk, null, 2))
  store.patchSettings({ fontSize: 15 })
  const file2 = JSON.parse(fs.readFileSync(path.join(TDIR, 'settings.json'), 'utf8'))
  check(
    'store: external change survives a patch',
    file2.activeModel === 'external-model' && file2.fontSize === 15 && file2.providers[0]?.id === 'nebius',
    JSON.stringify({ m: file2.activeModel, fs: file2.fontSize, p: file2.providers?.length })
  )
}

// --- 2. renderer store: patch payload + refresh order + resync ----------------
{
  let setCalls = []
  let modelsListCalls = 0
  let diskState = {
    theme: 'dark',
    accent: '#3d9bff',
    dataDir: 'C:/tmp/batch12',
    driveFolder: null,
    ollamaUrl: 'http://127.0.0.1:11434',
    providers: [],
    activeProvider: 'ollama',
    activeModel: 'qwen2.5-coder:7b',
    effort: 'medium',
    userName: 'dev',
    learn: true,
    fontSize: 14,
    mode: 'build'
  }
  const mock = {
    settings: {
      get: async () => ({ ...diskState }),
      set: async (patch) => {
        setCalls.push(patch)
        diskState = { ...diskState, ...patch } // main merges the same way
        return { ...diskState }
      }
    },
    health: {
      ollama: async () => 'online',
      drive: async () => {
        throw new Error('drive down') // must not skip the model refresh
      }
    },
    memory: { read: async () => '', write: async () => true },
    skills: { list: async () => [] },
    sessions: { save: async (s) => s },
    models: {
      list: async () => {
        modelsListCalls++
        return diskState.providers.map((p) => ({ id: 'nvidia/Nemotron-3_5-Lightning', provider: p.id, providerName: p.name }))
      }
    }
  }
  globalThis.window = { codezy: mock }

  await build({
    entryPoints: [path.join(PROJ, 'src/renderer/src/store/app.ts')],
    outfile: path.join(OUT, 'app.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent'
  })
  const { useApp } = await import(pathToFileURL(path.join(OUT, 'app.mjs')).href)

  useApp.setState({
    settings: { ...diskState },
    sessions: [],
    activeId: null,
    notices: [],
    ready: true
  })
  const st = () => useApp.getState()

  await st().updateSettings({ providers: [NEBIUS] })
  check(
    'store(update): settings.set receives a PATCH only',
    setCalls.length === 1 && Object.keys(setCalls[0]).length === 1 && 'providers' in setCalls[0],
    JSON.stringify(setCalls[0])
  )
  check(
    'store(update): drive failure does not skip the model refresh',
    modelsListCalls === 1 && st().models.length === 1 && st().models[0].provider === 'nebius',
    `modelsListCalls=${modelsListCalls} models=${JSON.stringify(st().models)}`
  )

  // another holder wrote to disk behind the renderer's back
  diskState = { ...diskState, providers: [{ id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiKey: '' }] }
  modelsListCalls = 0
  await st().resync()
  check(
    'store(resync): pulls external settings + models',
    st().settings.providers[0]?.id === 'lmstudio' && modelsListCalls === 1 && st().models[0]?.provider === 'lmstudio',
    JSON.stringify({ s: st().settings.providers?.[0]?.id, m: st().models })
  )
}

// --- 3. pickerRows ------------------------------------------------------------
{
  await build({
    entryPoints: [path.join(PROJ, 'src/renderer/src/components/pickerRows.ts')],
    outfile: path.join(OUT, 'pickerRows.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const { buildPickerRows } = await import(pathToFileURL(path.join(OUT, 'pickerRows.mjs')).href)

  const oll = { id: 'qwen2.5-coder:7b', provider: 'ollama', providerName: 'Ollama (local)' }
  const neb = { id: 'nvidia/Nemotron-3_5-Lightning', provider: 'nebius', providerName: 'Nebius Token Factory' }

  const rows = buildPickerRows([oll, neb], [NEBIUS], true)
  const heads = rows.filter((r) => r.type === 'head').map((r) => r.label)
  const models = rows.filter((r) => r.type === 'model')
  check('picker: group heads', heads.length === 2 && heads[0] === 'Ollama (local)' && heads[1] === 'Nebius Token Factory', JSON.stringify(heads))
  check('picker: model rows keep keyboard idx', models.length === 2 && models[0].idx === 0 && models[1].idx === 1, JSON.stringify(models.map((m) => m.idx)))

  const empty = buildPickerRows([oll], [NEBIUS], true)
  const emptyHeads = empty.filter((r) => r.type === 'head').map((r) => r.label)
  const notes = empty.filter((r) => r.type === 'empty')
  check(
    'picker: unloaded provider gets a note, not a gap',
    emptyHeads.includes('Nebius Token Factory') && notes.length === 1 && /no models loaded/.test(notes[0].label),
    JSON.stringify({ emptyHeads, notes })
  )
  check('picker: note suppressed while searching', buildPickerRows([oll], [NEBIUS], false).every((r) => r.type !== 'empty'), '')

  const withOllamaGuard = buildPickerRows([], [{ id: 'ollama', name: 'Ollama' }, NEBIUS], true)
  check(
    'picker: ollama never gets an "api key" note',
    withOllamaGuard.filter((r) => r.type === 'empty').length === 1,
    JSON.stringify(withOllamaGuard)
  )
}

// --- shared TUI helpers (isolated USERPROFILE) --------------------------------
const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '\n')

function tuiRun({ label, seed, externalAt, keys }) {
  const home = path.join(os.tmpdir(), `codezy-b12-${label}-${Date.now()}`)
  ISO_ROOTS.push(home)
  fs.mkdirSync(path.join(home, '.codezy'), { recursive: true })
  const settingsFile = path.join(home, '.codezy', 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify(seed, null, 2))

  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(PROJ, 'cli/codezy.mjs')], {
      cwd: home,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, USERPROFILE: home }
    })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    const kill = setTimeout(() => {
      try {
        p.kill()
      } catch {}
    }, 60000)
    if (externalAt) setTimeout(() => fs.writeFileSync(settingsFile, JSON.stringify(externalAt(seed), null, 2)), 900)
    for (const [ms, buf] of keys) setTimeout(() => p.stdin.write(buf), ms)
    setTimeout(() => p.stdin.end(), Math.max(...keys.map(([ms]) => ms)) + 900)
    p.on('close', (code) => {
      clearTimeout(kill)
      let after = null
      try {
        after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      } catch {}
      resolve({ out, code, after })
    })
  })
}

// --- 4. TUI save must not wipe a provider the desktop just connected ----------
{
  const seed = { ollamaUrl: 'http://127.0.0.1:11434', activeProvider: 'ollama', activeModel: 'qwen2.5-coder:7b', effort: 'medium', providers: [], dataDir: '', theme: 'light' }
  const r = await tuiRun({
    label: 'clobber',
    seed,
    // the desktop connects Nebius while the TUI is already running …
    externalAt: (s) => ({ ...s, providers: [NEBIUS], activeProvider: 'nebius', activeModel: 'nvidia/Nemotron-3_5-Lightning' }),
    // … then the user types /effort (a settings save) in the TUI
    keys: [
      [1800, '/effort deep\r'],
      [2700, '/quit\r']
    ]
  })
  const out = strip(r.out)
  check('tui-clobber: exit 0', r.code === 0, `code=${r.code}`)
  check('tui-clobber: /effort worked', /effort → deep/.test(out), (out.match(/effort[^\n]*/) ?? [''])[0])
  check(
    'tui-clobber: provider survives the TUI save',
    r.after?.effort === 'deep' && r.after?.providers?.[0]?.id === 'nebius' && r.after?.providers?.[0]?.apiKey === 'nk-b12',
    JSON.stringify({ effort: r.after?.effort, providers: r.after?.providers?.map((p) => p.id) })
  )
}

// --- 5. TUI sees what the desktop connected (no restart) ----------------------
{
  const seed = { ollamaUrl: 'http://127.0.0.1:11434', activeProvider: 'ollama', activeModel: 'qwen2.5-coder:7b', effort: 'medium', providers: [], dataDir: '', theme: 'light' }
  const r = await tuiRun({
    label: 'sync',
    seed,
    externalAt: (s) => ({ ...s, providers: [NEBIUS] }),
    keys: [
      [1800, '/provider\r'],
      [2700, '/quit\r']
    ]
  })
  const out = strip(r.out)
  check('tui-sync: exit 0', r.code === 0, `code=${r.code}`)
  check('tui-sync: /provider card lists the externally connected provider', out.includes('nebius   Nebius Token Factory'), (out.match(/nebius {1,4}Nebius[^\n]*/) ?? [''])[0])
}

console.log(fails.length ? `\n${fails.length} FAIL(S)` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

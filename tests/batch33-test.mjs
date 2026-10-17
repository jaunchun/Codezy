/* batch33 — REAL-BROWSER E2E for the singularity theme (animated black hole).
   Boots the actual built renderer (out/renderer) in headless Chrome with a
   stubbed preload bridge, settings.theme = 'singularity', then proves:
     - App mounts <canvas class="singularity-bg"> for the theme
     - the canvas is a full-window, pointer-transparent fixed layer at z 0
     - the surfaces really are translucent frosted glass (alpha < 1 + blur)
     - the canvas actually PAINTS a scene (bright disk/ring + dark space)
     - consecutive frames DIFFER (it is animated)
     - setting data-motion='off' freezes it to one static frame
   and writes a couple of full-page screenshots so a human can eyeball it.
   Requires a current build first:  npm run build
   Scratch lives under tests/.tmp. */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const OUT = path.join(PROJ, 'tests', '.tmp', 'singtest')
fs.mkdirSync(OUT, { recursive: true })
const SHOTS = path.join(PROJ, 'tests', '.tmp', 'singularity-shots')
fs.mkdirSync(SHOTS, { recursive: true })
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = 9359
const HTTP_PORT = 8333
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

const MOCK = `(function () {
  var settings = {
    theme: 'singularity', accent: '#3d9bff', dataDir: 'C:/tmp/codezy-test', driveFolder: null,
    ollamaUrl: 'http://127.0.0.1:11434', providers: [], activeProvider: 'ollama',
    activeModel: 'qwen2.5-coder:7b', effort: 'medium', userName: 'dev', learn: false,
    fontSize: 14, mode: 'build', v2: true, setupDone: true, reduceMotion: false,
    autoUpdate: false, enterSends: true, mcpServers: []
  }
  var session = { id: 's1', title: 'one', messages: [], createdAt: 1, updatedAt: 1, linkedFolders: [] }
  var special = {
    settings: { get: function () { return Promise.resolve(JSON.parse(JSON.stringify(settings))) },
                set: function (p) { Object.assign(settings, p); return Promise.resolve(JSON.parse(JSON.stringify(settings))) } },
    projects: { list: function () { return Promise.resolve([]) } },
    sessions: {
      list: function () { return Promise.resolve([JSON.parse(JSON.stringify(session))]) },
      get: function () { return Promise.resolve(null) },
      save: function (s) { return Promise.resolve(s) },
      create: function () { return Promise.resolve(JSON.parse(JSON.stringify(session))) },
      delete: function () { return Promise.resolve() },
      search: function () { return Promise.resolve([]) }
    },
    models: { list: function () { return Promise.resolve([]) } },
    health: {
      ollama: function () { return Promise.resolve('online') },
      drive: function () { return Promise.resolve({ enabled: false, folder: null, healthy: false }) }
    },
    chat: { onEvent: function () { return function () {} },
            send: function () { return Promise.resolve() },
            abort: function () { return Promise.resolve() },
            v2Decision: function () { return Promise.resolve() } },
    app: { version: function () { return Promise.resolve('3.1.2-test') },
           openExternal: function () { return Promise.resolve() },
           openTerminal: function () { return Promise.resolve(null) } },
    win: { minimize: function () {}, maximize: function () {}, close: function () {},
           isMaximized: function () { return Promise.resolve(false) } },
    update: { check: function () { return Promise.resolve({ ok: false }) } },
    memory: { read: function () { return Promise.resolve('') }, write: function () { return Promise.resolve(true) } },
    skills: { list: function () { return Promise.resolve([]) } },
    tasks: { list: function () { return Promise.resolve([]) }, stop: function () { return Promise.resolve(false) } },
    mcp: { list: function () { return Promise.resolve([]) },
           probe: function () { return Promise.resolve({ ok: false, tools: [], error: 'test stub' }) },
           save: function () { return Promise.resolve() } },
    files: { list: function () { return Promise.resolve([]) }, read: function () { return Promise.resolve(null) },
             ingest: function () { return Promise.resolve({ files: [], dirs: [], skipped: 0 }) } },
    ide: { tree: function () { return Promise.resolve([]) },
           read: function () { return Promise.resolve({ content: '', truncated: false }) },
           write: function () { return Promise.resolve() } },
    edits: { apply: function (id, e) { return Promise.resolve({ applied: (e || []).map(function (x) { return { path: x.path } }), errors: [] }) } },
    dialog: { pickFolder: function () { return Promise.resolve(null) }, pickFiles: function () { return Promise.resolve([]) },
              saveText: function () { return Promise.resolve(null) } },
    images: { dataUrl: function () { return Promise.resolve('data:image/gif;base64,') } },
    notify: { send: function () { return Promise.resolve() } },
    git: { diff: function () { return Promise.resolve({ ok: false, files: [] }) } },
    usage: { stats: function () { return Promise.resolve(null) } },
    drive: { status: function () { return Promise.resolve({ enabled: false, folder: null, healthy: false }) } }
  }
  window.codezy = new Proxy(special, {
    get: function (t, k) {
      if (k in t) return t[k]
      return function () { return Promise.resolve(undefined) }
    }
  })
})()`

const PAINT = `(function () {
  var c = document.querySelector('.singularity-bg')
  if (!c) return null
  var ctx = c.getContext('2d')
  var W = c.width, H = c.height
  var d = ctx.getImageData(0, 0, W, H).data
  var bright = 0, dark = 0, max = 0, n = 0, colored = 0
  for (var y = 0; y < H; y += 4) {
    for (var x = 0; x < W; x += 4) {
      var i = (y * W + x) * 4
      var r = d[i], g = d[i + 1], b = d[i + 2]
      var lum = r * 0.299 + g * 0.587 + b * 0.114
      if (lum > max) max = lum
      if (lum > 150) bright++
      if (lum < 20) dark++
      if (Math.max(r, g, b) - Math.min(r, g, b) > 12) colored++
      n++
    }
  }
  return { w: W, h: H, bright: bright, dark: dark, max: Math.round(max), n: n, colored: colored }
})()`

const COMPOSE = `(function () {
  var c = document.querySelector('.singularity-bg')
  if (!c) return null
  var ctx = c.getContext('2d')
  var W = c.width, H = c.height
  function lumAt(fx, fy, half) {
    var x0 = Math.max(0, Math.round(fx * W - half)), y0 = Math.max(0, Math.round(fy * H - half))
    var d = ctx.getImageData(x0, y0, half * 2, half * 2).data
    var s = 0
    for (var i = 0; i < d.length; i += 4) s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
    return +(s / (d.length / 4)).toFixed(1)
  }
  return { shadow: lumAt(0.5, 0.5, 14), left: lumAt(0.16, 0.62, 40), right: lumAt(0.88, 0.76, 40) }
})()`

const FRAME = `(function () {
  var c = document.querySelector('.singularity-bg')
  return c ? c.toDataURL('image/png').length + ':' + c.toDataURL('image/png').slice(0, 400) : null
})()`

async function main() {
  if (!fs.existsSync(path.join(PROJ, 'out', 'renderer', 'index.html'))) {
    console.log('FAIL  out/renderer missing — run `npm run build` first')
    process.exit(1)
  }
  let server, chrome, ws
  try {
    server = spawn(process.execPath, [path.join(PROJ, 'tests', '.tmp', 'serve-site.mjs'), path.join(PROJ, 'out', 'renderer'), String(HTTP_PORT)], { stdio: 'ignore' })
    await sleep(700)

    const profile = path.join(OUT, 'prof-' + Date.now())
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--window-size=1400,950', '--user-data-dir=' + profile, '--remote-debugging-port=' + CDP_PORT,
      '--no-first-run', '--disable-extensions', 'about:blank'
    ], { stdio: 'ignore' })

    let target = null
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(250)
      try {
        const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
        target = list.find((t) => t.type === 'page') || null
      } catch { /* devtools not up yet */ }
    }
    if (!target) throw new Error('no devtools target')
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')) })

    let id = 0
    const pending = new Map()
    const pageErrors = []
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? rej(new Error(m.error.message)) : res(m.result)
      } else if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(String(m.params.exceptionDetails?.exception?.description || 'exception').slice(0, 400))
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        pageErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400))
      }
    }
    const send = (method, params = {}) =>
      new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true })
      if (r.exceptionDetails) return { error: String(r.exceptionDetails.exception?.description || 'eval error') }
      return r.result.value
    }
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(SHOTS, name)
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
      return r.data
    }

    await send('Runtime.enable')
    await send('Page.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK })
    await send('Page.navigate', { url: 'http://127.0.0.1:' + HTTP_PORT + '/' })

    let booted = false
    for (let i = 0; i < 60 && !booted; i++) {
      await sleep(250)
      booted = (await ev("!!document.querySelector('.composer')")) === true
    }
    check('boot: the app renders the composer', booted)
    if (!booted) throw new Error('boot failed')

    // let a few frames paint
    await send('Runtime.evaluate', {
      expression: 'Promise.race([document.fonts.ready, new Promise(function(r){setTimeout(r,2000)})])',
      awaitPromise: true, returnByValue: true
    })
    await sleep(900)

    check('theme: <html> carries data-theme=singularity', (await ev('document.documentElement.dataset.theme')) === 'singularity')
    check('theme: the black-hole canvas is mounted', (await ev("!!document.querySelector('canvas.singularity-bg')")) === true)

    const geo = await ev(`(function(){
      var c = document.querySelector('.singularity-bg')
      var cs = getComputedStyle(c), r = c.getBoundingClientRect()
      var mp = getComputedStyle(document.querySelector('.main-pane'))
      return { pos: cs.position, z: cs.zIndex, pe: cs.pointerEvents,
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        vw: innerWidth, vh: innerHeight,
        paneBg: mp.backgroundColor, paneBlur: mp.backdropFilter || mp.webkitBackdropFilter }
    })()`)
    check('canvas: full-window fixed layer, click-through, behind the UI',
      geo.pos === 'fixed' && geo.z === '0' && geo.pe === 'none' &&
        geo.x === 0 && geo.y === 0 && geo.w === geo.vw && geo.h === geo.vh,
      JSON.stringify(geo))
    check('surface: the pane is translucent frosted glass',
      /rgba\([^)]*,\s*0?\.\d+\)/.test(String(geo.paneBg)) && String(geo.paneBlur).includes('blur'),
      `bg=${geo.paneBg} blur=${geo.paneBlur}`)

    const paint = await ev(PAINT)
    check('canvas: it actually paints a scene (bright disk + dark space)',
      paint && paint.bright > 50 && paint.dark / paint.n > 0.5 && paint.max > 200,
      JSON.stringify(paint))
    check('canvas: the whole scene is monochrome (no coloured pixels)',
      paint && paint.colored === 0, `colored=${paint && paint.colored}`)

    const comp = await ev(COMPOSE)
    check('composition: a pitch-black shadow hangs dead-centre',
      comp && comp.shadow < 90, JSON.stringify(comp))
    check('composition: light cascades down the left, the right stays dark',
      comp && comp.left > comp.right, JSON.stringify(comp))

    check('accent: singularity forces the accent to white (monochrome chrome)',
      (await ev("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")) === '#ffffff')

    // animation: two full-page captures a beat apart must differ
    const a = await shot('frame-A.png')
    await sleep(700)
    const b = await shot('frame-B.png')
    check('animation: consecutive frames differ (the hole is alive)', a !== b,
      `bytesA=${a.length} bytesB=${b.length} same=${a === b}`)
    // and the canvas bitmap itself moved
    const f1 = await ev(FRAME)
    await sleep(600)
    const f2 = await ev(FRAME)
    check('animation: the canvas bitmap changes frame to frame', !!f1 && !!f2 && f1 !== f2)

    // save the raw canvas (the hole unobstructed by the frosted UI) so a human
    // can eyeball the actual effect, two frames apart
    const rawA = await ev("document.querySelector('.singularity-bg').toDataURL('image/png')")
    await sleep(650)
    const rawB = await ev("document.querySelector('.singularity-bg').toDataURL('image/png')")
    const write = (name, dataUrl) => {
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
        fs.writeFileSync(path.join(SHOTS, name), Buffer.from(dataUrl.split(',')[1], 'base64'))
      }
    }
    write('canvas-A.png', rawA)
    write('canvas-B.png', rawB)

    // reduced motion → frozen single frame
    await ev("document.documentElement.dataset.motion = 'off'")
    await sleep(400)
    const r1 = await ev(FRAME)
    await sleep(500)
    const r2 = await ev(FRAME)
    check('reduced motion: the canvas settles to one static frame',
      !!r1 && !!r2 && r1 === r2, `same=${r1 === r2}`)
    await shot('frame-static-reduced-motion.png')

    if (pageErrors.length) {
      console.log('\npage errors (' + pageErrors.length + '):')
      for (const e of pageErrors.slice(0, 8)) console.log('  ' + e)
    }
    check('no uncaught page errors', pageErrors.length === 0, pageErrors[0] || '')
  } catch (err) {
    check('driver ran to completion', false, String((err && err.message) || err))
  } finally {
    try { ws && ws.close() } catch {}
    try { server && server.kill() } catch {}
    try { if (chrome) spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  }
  console.log('\nscreenshots → ' + SHOTS)
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS')
  process.exit(fails.length ? 1 : 0)
}

main()

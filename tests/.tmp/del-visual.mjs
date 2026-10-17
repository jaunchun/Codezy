/* del-visual — visual probe for the chat-delete confirm menu.
   Boots the built renderer (out/renderer) in headless Chrome with the batch32
   stubbed bridge, opens the confirm menu, then cycles every theme state and
   captures computed colors + a clipped screenshot per state:
     dark / light / acrylic / MISSING (data-theme removed — the index.html
     pre-init state, when applyTheme never ran).
   Scratch: tests/.tmp/del-visual.  Requires: npm run build. */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const OUT = path.join(PROJ, 'tests', '.tmp', 'del-visual')
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = 9360
const HTTP_PORT = 8340
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MOCK = `(function () {
  var settings = {
    theme: 'dark', accent: '#3d9bff', dataDir: 'C:/tmp/codezy-test', driveFolder: null,
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
    app: { version: function () { return Promise.resolve('3.0.0-test') },
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
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? rej(new Error(m.error.message)) : res(m.result)
      }
    }
    const send = (method, params = {}) =>
      new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true })
      if (r.exceptionDetails) return { error: String(r.exceptionDetails.exception?.description || 'eval error') }
      return r.result.value
    }

    await send('Runtime.enable')
    await send('Page.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK })
    await send('Page.navigate', { url: 'http://127.0.0.1:' + HTTP_PORT + '/' })

    let booted = false
    for (let i = 0; i < 60 && !booted; i++) {
      await sleep(250)
      booted = (await ev("document.querySelectorAll('[aria-label=\"Delete chat\"]').length")) === 1
    }
    if (!booted) throw new Error('boot failed: no row trash')

    const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', Object.assign({ type, x, y }, extra))
    const click = async (x, y) => {
      await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
      await mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 })
    }
    const trash = await ev(`(function(){var t=document.querySelector('[aria-label="Delete chat"]');var r=t.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    await mouse('mouseMoved', trash.x, trash.y); await sleep(120)
    await click(trash.x, trash.y); await sleep(400)
    const open = await ev("!!document.querySelector('.ctx-menu')")
    console.log('confirm menu open after trash click:', open)
    if (!open) throw new Error('menu did not open')

    const PROBE = `(function(){
      var m=document.querySelector('.ctx-menu')
      if(!m) return null
      var cs=getComputedStyle(m)
      var h=m.querySelector('.ctx-head'), s=m.querySelector('.ctx-sub')
      var bs=[].map.call(m.querySelectorAll('button'),function(b){return b.textContent.trim()})
      var anims=(m.getAnimations?m.getAnimations():[]).map(function(a){return a.playState+'@'+Math.round(a.currentTime||0)})
      return {
        theme: document.documentElement.dataset.theme || null,
        menuBg: cs.backgroundColor, menuOpacity: cs.opacity, menuFilter: cs.backdropFilter, menuAnim: cs.animationName,
        menuAnimState: anims,
        head: h ? getComputedStyle(h).color : null,
        sub: s ? getComputedStyle(s).color : null,
        buttons: bs,
        btnColors: [].map.call(m.querySelectorAll('button'),function(b){return getComputedStyle(b).color}),
        rect: (function(){var q=m.getBoundingClientRect();return {x:Math.round(q.left),y:Math.round(q.top),w:Math.round(q.width),h:Math.round(q.height)}})()
      }
    })()`
    const probe = () => ev(PROBE)

    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: 620, height: 460, scale: 1.5 }
      })
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
    }

    const states = ['dark', 'light', 'acrylic', 'MISSING']
    for (const st of states) {
      if (st === 'MISSING') await ev("document.documentElement.removeAttribute('data-theme')")
      else await ev(`document.documentElement.dataset.theme='${st}'`)
      await sleep(350)
      const info = await probe()
      console.log('\n== ' + st + ' ==')
      console.log(JSON.stringify(info, null, 2))
      await shot('del-' + st.toLowerCase())
    }
  } catch (err) {
    console.log('FAIL  ' + (err && err.message || err))
  } finally {
    try { ws && ws.close() } catch {}
    try { server && server.kill() } catch {}
    try { if (chrome) spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    console.log('\nshots in ' + OUT)
    process.exit(0)
  }
}

main()

/* Probe: why does the invisible-triangle fan die mid-gap in a real browser?
   Wraps window event listeners before the app loads, then replays the
   hover->gap travel and dumps every pointerleave/pointermove the fan's
   window listeners actually saw, plus the intent-class timeline. */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const OUT = path.join(PROJ, 'tests', '.tmp', 'segtest')
fs.mkdirSync(OUT, { recursive: true })
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = 9348
const HTTP_PORT = 8323
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PRE = `(function () {
  window.__lis = []
  var origAdd = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (type, fn, opt) {
    if (this === window && (type === 'pointermove' || type === 'pointerdown' || type === 'blur')) {
      window.__lis.push({ hook: 'add:' + type })
      var wrapped = function (e) {
        window.__lis.push({ hook: 'call:' + type, x: e.clientX, y: e.clientY,
          tgt: String((e.target && (e.target.className || e.target.nodeName)) || '?').slice(0, 26) })
        return fn.apply(this, arguments)
      }
      return origAdd.call(this, type, wrapped, opt)
    }
    return origAdd.apply(this, arguments)
  }
  origAdd.call(window, 'pointerleave', function (e) {
    window.__lis.push({ hook: 'native-leave', x: e.clientX, y: e.clientY,
      tgt: String((e.target && (e.target.className || e.target.nodeName)) || '?').slice(0, 26) })
  }, true)
  origAdd.call(window, 'pointermove', function (e) {
    window.__lis.push({ hook: 'native-move', x: e.clientX, y: e.clientY,
      tgt: String((e.target && (e.target.className || e.target.nodeName)) || '?').slice(0, 26) })
  }, true)
  var iv = setInterval(function () {
    var fabs = document.querySelectorAll('.seg-fab')
    if (fabs.length === 2) {
      clearInterval(iv)
      fabs.forEach(function (f) {
        f.addEventListener('pointerleave', function (e) {
          window.__lis.push({ hook: 'fab-leave', x: e.clientX, y: e.clientY, fab: String(f.className) })
        }, true)
      })
    }
  }, 50)
  var origRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    var r = origRect.call(this)
    if (this.classList && this.classList.contains('segmented')) {
      var host = this.closest('.seg-fab')
      window.__rects.push({ fab: host ? String(host.className).slice(0, 24) : '?', t: Math.round(performance.now()),
        l: Math.round(r.left), top: Math.round(r.top), b: Math.round(r.bottom), rr: Math.round(r.right),
        h: Math.round(r.height) })
    }
    return r
  }
  window.__rects = []
})()`

const MOCK = `(function () {
  var settings = { theme: 'dark', accent: '#3d9bff', dataDir: 'C:/t', driveFolder: null,
    ollamaUrl: 'http://127.0.0.1:11434', providers: [], activeProvider: 'ollama',
    activeModel: 'm', effort: 'medium', userName: 'dev', learn: false, fontSize: 14,
    mode: 'build', v2: true, setupDone: true, reduceMotion: false, autoUpdate: false,
    enterSends: true, mcpServers: [] }
  var session = { id: 's1', title: 'one', messages: [], createdAt: 1, updatedAt: 1, linkedFolders: [] }
  var special = {
    settings: { get: function () { return Promise.resolve(JSON.parse(JSON.stringify(settings))) },
                set: function (p) { Object.assign(settings, p); return Promise.resolve(JSON.parse(JSON.stringify(settings))) } },
    projects: { list: function () { return Promise.resolve([]) } },
    sessions: { list: function () { return Promise.resolve([JSON.parse(JSON.stringify(session))]) },
      get: function () { return Promise.resolve(null) }, save: function (s) { return Promise.resolve(s) },
      create: function () { return Promise.resolve(JSON.parse(JSON.stringify(session))) },
      delete: function () { return Promise.resolve() }, search: function () { return Promise.resolve([]) } },
    models: { list: function () { return Promise.resolve([]) } },
    health: { ollama: function () { return Promise.resolve('online') },
      drive: function () { return Promise.resolve({ enabled: false, folder: null, healthy: false }) } },
    chat: { onEvent: function () { return function () {} }, send: function () { return Promise.resolve() },
      abort: function () { return Promise.resolve() }, v2Decision: function () { return Promise.resolve() } },
    app: { version: function () { return Promise.resolve('t') }, openExternal: function () { return Promise.resolve() },
      openTerminal: function () { return Promise.resolve(null) } },
    win: { minimize: function () {}, maximize: function () {}, close: function () {},
      isMaximized: function () { return Promise.resolve(false) } },
    update: { check: function () { return Promise.resolve({ ok: false }) } },
    memory: { read: function () { return Promise.resolve('') }, write: function () { return Promise.resolve(true) } },
    skills: { list: function () { return Promise.resolve([]) } },
    tasks: { list: function () { return Promise.resolve([]) }, stop: function () { return Promise.resolve(false) } },
    mcp: { list: function () { return Promise.resolve([]) }, probe: function () { return Promise.resolve({ ok: false, tools: [], error: 'x' }) },
      save: function () { return Promise.resolve() } },
    files: { list: function () { return Promise.resolve([]) }, read: function () { return Promise.resolve(null) },
      ingest: function () { return Promise.resolve({ files: [], dirs: [], skipped: 0 }) } },
    ide: { tree: function () { return Promise.resolve([]) }, read: function () { return Promise.resolve({ content: '', truncated: false }) },
      write: function () { return Promise.resolve() } },
    edits: { apply: function (id, e) { return Promise.resolve({ applied: [], errors: [] }) } },
    dialog: { pickFolder: function () { return Promise.resolve(null) }, pickFiles: function () { return Promise.resolve([]) },
      saveText: function () { return Promise.resolve(null) } },
    images: { dataUrl: function () { return Promise.resolve('data:image/gif;base64,') } },
    notify: { send: function () { return Promise.resolve() } },
    git: { diff: function () { return Promise.resolve({ ok: false, files: [] }) } },
    usage: { stats: function () { return Promise.resolve(null) } }
  }
  window.codezy = new Proxy(special, { get: function (t, k) { return k in t ? t[k] : function () { return Promise.resolve(undefined) } } })
})()`

async function main() {
  let server, chrome, ws
  const log = (...a) => console.log(...a)
  try {
    server = spawn(process.execPath, [path.join(PROJ, 'tests', '.tmp', 'serve-site.mjs'), path.join(PROJ, 'out', 'renderer'), String(HTTP_PORT)], { stdio: 'ignore' })
    await sleep(700)
    chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--window-size=1400,950', '--user-data-dir=' + path.join(OUT, 'probe-' + Date.now()),
      '--remote-debugging-port=' + CDP_PORT, '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
    let target = null
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(250)
      try { const l = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json(); target = l.find((t) => t.type === 'page') || null } catch {}
    }
    if (!target) throw new Error('no devtools')
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')) })
    let id = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) }
    }
    const pageErrors = []
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = ((orig) => (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push(String(m.params.exceptionDetails?.exception?.description || 'exception').slice(0, 500))
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500))
      orig(ev)
    })(ws.onmessage)
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.exceptionDetails ? { error: 'eval' } : r.result.value }

    await send('Runtime.enable'); await send('Page.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PRE + '\n;\n' + MOCK })
    await send('Page.navigate', { url: 'http://127.0.0.1:' + HTTP_PORT + '/' })
    let booted = false
    for (let i = 0; i < 60 && !booted; i++) { await sleep(250); booted = (await ev("document.querySelectorAll('.seg-fab').length")) === 2 }
    if (!booted) {
      log('boot failed. root HTML:', await ev("document.getElementById('root') ? document.getElementById('root').innerHTML.slice(0, 600) : 'no root'"))
      log('page errors:', JSON.stringify(pageErrors.slice(0, 6), null, 1))
      throw new Error('boot failed')
    }
    log('booted')

    const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', Object.assign({ type, x, y }, extra))
    const cls = () => ev("document.querySelector('.seg-fab-right').className")
    const op = () => ev("(function(){var p=document.querySelector('.seg-fab-right .segmented');return getComputedStyle(p).opacity})()")

    // native listener log reset after boot (boot may log a few)
    await ev('window.__lis.length = 0; window.__rects.length = 0')

    const mb = await ev("(function(){var f=document.querySelector('.seg-fab-right');var b=f.querySelector('.seg-badge');var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()")
    log('badge center:', JSON.stringify(mb))

    await mouse('mouseMoved', mb.x, mb.y); await sleep(400)
    log('after hover: cls=', await cls(), 'opacity=', await op(), 'hover=', await ev("document.querySelector('.seg-fab-right').matches(':hover')"))
    await ev('window.__lis.length = 0; window.__rects.length = 0')

    const gap = await ev("(function(){var f=document.querySelector('.seg-fab-right');var p=f.querySelector('.segmented');var fr=f.getBoundingClientRect();var pr=p.getBoundingClientRect();return {x:(fr.left+fr.right)/2,y:(pr.bottom+fr.top)/2, popBottom:pr.bottom, fabTop:fr.top}})()")
    log('gap point:', JSON.stringify(gap))

    await mouse('mouseMoved', gap.x, gap.y)
    await sleep(60)
    log('t+60ms:  cls=', await cls(), ' opacity=', await op())
    await sleep(150)
    log('t+210ms: cls=', await cls(), ' opacity=', await op())
    await sleep(300)
    log('t+510ms: cls=', await cls(), ' opacity=', await op())

    const lis = await ev('JSON.stringify(window.__lis, null, 1)')
    log('--- listener log (from hover-clear to now) ---')
    log(lis)
    log('--- pop rect reads during the same window ---')
    log(await ev('JSON.stringify(window.__rects, null, 1)'))
  } catch (e) {
    log('ERROR', e.message)
  } finally {
    try { ws && ws.close() } catch {}
    try { server && server.kill() } catch {}
    try { if (chrome) spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    process.exit(0)
  }
}
main()

/* batch32 — REAL-BROWSER E2E for the chat-delete confirm menu (Sidebar).
   Boots the actual built renderer (out/renderer) in headless Chrome with a
   stubbed preload bridge, then replays the user journey with real mouse
   events and key presses:
     trash click -> confirm menu opens WITHOUT deleting -> Cancel / Escape /
     outside click all dismiss WITHOUT deleting -> second trash click toggles
     -> "Delete chat" really deletes -> the row's context menu still works.
   Regressions this pins down:
   - the chat row's trash icon used to call sessions.delete on a SINGLE click
     (one misclick and the chat was gone — removeSession is a hard delete)
   - the confirm menu's outside-click dismissal must not eat the very click
     that opens it (mousedown precedes click — the trash stops propagation)
   Requires a current build first:  npm run build
   Scratch lives under tests/.tmp. */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const OUT = path.join(PROJ, 'tests', '.tmp', 'deltest')
fs.mkdirSync(OUT, { recursive: true })
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = 9358
const HTTP_PORT = 8332
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

// ---- preload bridge stub (same shape as batch31 — one session 'one') --------
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
  const trace = []
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

    await send('Runtime.enable')
    await send('Page.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK })
    await send('Page.navigate', { url: 'http://127.0.0.1:' + HTTP_PORT + '/' })

    // wait for the sidebar row with its trash button
    let booted = false
    for (let i = 0; i < 60 && !booted; i++) {
      await sleep(250)
      booted = (await ev("document.querySelectorAll('[aria-label=\"Delete chat\"]').length")) === 1
    }
    check('boot: the chat row renders with its trash button', booted)
    if (!booted) throw new Error('boot failed: no row trash')

    const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', Object.assign({ type, x, y }, extra))
    const move = (x, y) => mouse('mouseMoved', x, y)
    const click = async (x, y) => {
      await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
      await mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 })
    }
    const rclick = async (x, y) => {
      await mouse('mousePressed', x, y, { button: 'right', buttons: 2, clickCount: 1 })
      await mouse('mouseReleased', x, y, { button: 'right', buttons: 0, clickCount: 1 })
    }
    const key = async (k) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 })
    }
    const nTrash = () => ev('document.querySelectorAll(\'[aria-label="Delete chat"]\').length')
    const menuState = () =>
      ev(`(function(){
        var m=document.querySelector('.ctx-menu')
        if(!m) return {open:false}
        var bs=[].map.call(m.querySelectorAll('button'),function(b){return b.textContent.trim()})
        var h=m.querySelector('.ctx-head'), s=m.querySelector('.ctx-sub')
        return {open:true, head:h?h.textContent:'', sub:s?s.textContent:'', buttons:bs}
      })()`)
    const btnAt = async (labelRe) => {
      const r = await ev(`(function(){
        var bs=document.querySelectorAll('.ctx-menu button')
        for(var i=0;i<bs.length;i++){
          if(${labelRe}.test(bs[i].textContent)){var q=bs[i].getBoundingClientRect();return {x:q.left+q.width/2,y:q.top+q.height/2}}
        } return null
      })()`)
      return r
    }
    const trashAt = async () => ev(`(function(){var t=document.querySelector('[aria-label="Delete chat"]');if(!t)return null;var r=t.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)

    // ---- 1. one click on the trash must NOT delete --------------------------
    const t1 = await trashAt()
    trace.push('trash rect: ' + JSON.stringify(t1))
    await move(t1.x, t1.y); await sleep(120)
    const hit1 = await ev(`(function(){var e=document.elementFromPoint(${Math.round(t1.x)},${Math.round(t1.y)});return e?e.tagName+'#'+(e.getAttribute('aria-label')||e.getAttribute('class')||''):'none'})()`)
    check('the trash is hit-testable at its centre', /SVG|svg/.test(String(hit1)), 'elementFromPoint=' + hit1)
    await click(t1.x, t1.y); await sleep(300)
    const m1 = await menuState()
    check('one click opens the confirm menu instead of deleting', m1.open === true, JSON.stringify(m1))
    check('the menu asks first and names the chat',
      m1.open && /Delete this chat/.test(m1.head) && /one/.test(m1.sub) &&
      m1.buttons.some((b) => /Delete chat/.test(b)) && m1.buttons.some((b) => /Cancel/.test(b)),
      JSON.stringify(m1 && m1.buttons))
    const still1 = await nTrash()
    check('nothing was deleted by that click', still1 === 1, 'trashes=' + still1)

    // ---- 2. Cancel dismisses, the chat survives -----------------------------
    const cancel = await btnAt('/Cancel/')
    await move(cancel.x, cancel.y); await sleep(80)
    await click(cancel.x, cancel.y); await sleep(250)
    const m2 = await menuState()
    const still2 = await nTrash()
    check('Cancel closes the menu', !m2.open, JSON.stringify(m2))
    check('the chat survived Cancel', still2 === 1, 'trashes=' + still2)

    // ---- 3. Escape dismisses, the chat survives ----------------------------
    const t3 = await trashAt()
    await click(t3.x, t3.y); await sleep(250)
    await key('Escape'); await sleep(200)
    const m3 = await menuState()
    const still3 = await nTrash()
    check('Escape closes the menu', !m3.open, JSON.stringify(m3))
    check('the chat survived Escape', still3 === 1, 'trashes=' + still3)

    // ---- 4. outside click dismisses, the chat survives ---------------------
    const t4 = await trashAt()
    await click(t4.x, t4.y); await sleep(250)
    await click(600, 300); await sleep(250)
    const m4 = await menuState()
    const still4 = await nTrash()
    check('an outside click closes the menu', !m4.open, JSON.stringify(m4))
    check('the chat survived the outside click', still4 === 1, 'trashes=' + still4)

    // ---- 5. clicking the trash again toggles the menu closed ---------------
    const t5 = await trashAt()
    await click(t5.x, t5.y); await sleep(250)
    const m5a = await menuState()
    await click(t5.x, t5.y); await sleep(250)
    const m5b = await menuState()
    check('the trash toggles: open, then closed on a second click',
      m5a.open === true && m5b.open === false, 'open=' + m5a.open + ' -> ' + m5b.open)

    // ---- 6. the row context menu still opens (right-click) -----------------
    const row = await ev(`(function(){var t=document.querySelector('[aria-label="Delete chat"]');var r=t?t.closest('.side-item'):null;if(!r)return null;var q=r.getBoundingClientRect();return {x:q.left+40,y:q.top+q.height/2}})()`)
    await rclick(row.x, row.y); await sleep(300)
    const m6 = await menuState()
    check('right-click still opens the row context menu with Delete',
      m6.open === true && m6.buttons.some((b) => /Rename/.test(b)) && m6.buttons.some((b) => /^Delete/.test(b)),
      JSON.stringify(m6))
    await key('Escape'); await sleep(200)
    const still6 = await nTrash()
    check('Escape closed the context menu without deleting', still6 === 1, 'trashes=' + still6)

    // ---- 7. the confirm really deletes -------------------------------------
    const t7 = await trashAt()
    await click(t7.x, t7.y); await sleep(250)
    const del = await btnAt('/Delete chat/')
    if (!del) throw new Error('confirm Delete button not found')
    await move(del.x, del.y); await sleep(80)
    await click(del.x, del.y); await sleep(400)
    const m7 = await menuState()
    const still7 = await nTrash()
    check('confirming DELETES the chat and closes the menu', still7 === 0 && !m7.open,
      'trashes=' + still7 + ' menuOpen=' + m7.open)

    if (pageErrors.length) {
      console.log('\npage errors (' + pageErrors.length + '):')
      for (const e of pageErrors.slice(0, 8)) console.log('  ' + e)
    }
  } catch (err) {
    check('driver ran to completion', false, String(err && err.message || err))
  } finally {
    console.log('\n--- trace ---')
    for (const t of trace) console.log(t)
    try { ws && ws.close() } catch {}
    try { server && server.kill() } catch {}
    try { if (chrome) spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS')
  process.exit(fails.length ? 1 : 0)
}

main()

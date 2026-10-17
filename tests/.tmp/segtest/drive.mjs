/* Real-browser interaction test for the effort/mode popovers.
   Boots the ACTUAL built renderer (out/renderer) in headless Chrome with a
   stubbed preload bridge, then replays the user flow with real mouse events:
   hover -> click to pin -> travel -> hit-test -> click an option -> close.
   Logs a full trace so a failure shows exactly which step breaks. */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const OUT = path.join(PROJ, 'tests', '.tmp', 'segtest')
fs.mkdirSync(OUT, { recursive: true })
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = 9347
const HTTP_PORT = 8322
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

// ---- preload bridge stub: explicit shapes for everything the app boots with,
// plus a proxy fallback so an unforeseen call never crashes the page. --------
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

const SNAP = `(function () {
  var fab = document.querySelector('.seg-fab:not(.seg-fab-right)')
  var pop = fab && fab.querySelector('.segmented')
  if (!fab || !pop) return { fab: !!fab, pop: !!pop }
  var cs = getComputedStyle(pop)
  var on = pop.querySelector('button.on')
  var r = pop.getBoundingClientRect()
  return { cls: fab.className, opacity: cs.opacity, pe: cs.pointerEvents,
           rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
           on: on ? on.textContent : null }
})()`
const SNAP_MODE = SNAP.replace(".seg-fab:not(.seg-fab-right)", '.seg-fab-right')

async function main() {
  const trace = []
  let server, chrome, ws
  try {
    // static server over the REAL build output
    server = spawn(process.execPath, [path.join(PROJ, 'tests', '.tmp', 'serve-site.mjs'), path.join(PROJ, 'out', 'renderer'), String(HTTP_PORT)], { stdio: 'ignore' })
    await sleep(700)

    // headless Chrome with DevTools
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

    // wait for the composer with both fabs
    let booted = false
    for (let i = 0; i < 60 && !booted; i++) {
      await sleep(250)
      booted = (await ev("document.querySelectorAll('.seg-fab').length")) === 2
    }
    const where = await ev("document.querySelector('#root') && document.querySelector('#root').firstElementChild ? document.querySelector('#root').firstElementChild.className + ' | kids=' + document.querySelector('#root').firstElementChild.children.length : 'no root'")
    check('boot: composer rendered with both fabs', booted, String(where))
    if (!booted) throw new Error('boot failed: ' + JSON.stringify(where))

    const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', Object.assign({ type, x, y }, extra))
    const move = async (x, y) => { await mouse('mouseMoved', x, y); }
    const click = async (x, y) => {
      await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
      await mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 })
    }
    const snap = async (step, mode = false) => {
      const s = await ev(mode ? SNAP_MODE : SNAP)
      trace.push(step + ': ' + JSON.stringify(s))
      return s
    }
    const rectOf = (sel, last = false) =>
      ev(`(function(){var b=document.querySelectorAll(${JSON.stringify(sel)});var t=b[b.length-${last ? 1 : 1}];if(!t)return null;var r=t.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    const badgeRect = (sel) =>
      ev(`(function(){var f=document.querySelector(${JSON.stringify(sel)});if(!f)return null;var b=f.querySelector('.seg-badge');var r=(b||f).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    const hitAt = (x, y) => ev(`(function(){var e=document.elementFromPoint(${x},${y});return e?e.tagName+'#'+(e.className||''):'none'})()`)

    // ---- EFFORT: hover -> click-pin -> travel away -> approach -> pick -------
    const E = ".seg-fab:not(.seg-fab-right)"
    const eb = await badgeRect(E)
    await move(eb.x, eb.y); await sleep(400)
    const s1 = await snap('effort/hover')
    check('1 hover opens the effort popover', parseFloat(s1.opacity) > 0.9, 'opacity=' + s1.opacity)

    await click(eb.x, eb.y); await sleep(300)
    const s2 = await snap('effort/click-pin')
    check('2 clicking the badge pins it', (s2.cls || '').includes('pinned'), 'cls=' + s2.cls)

    await move(600, 120); await sleep(450)
    const s3 = await snap('effort/travel-away')
    check('3 popover STAYS open after travelling away', parseFloat(s3.opacity) > 0.9 && (s3.cls || '').includes('pinned'),
      'opacity=' + s3.opacity + ' cls=' + s3.cls)

    const opt = await rectOf(E + ' .segmented button', true)
    await move(opt.x, opt.y); await sleep(350)
    const s4 = await snap('effort/approach')
    const hit = await hitAt(Math.round(opt.x), Math.round(opt.y))
    check('4 popover open on approach with pointer-events live', parseFloat(s4.opacity) > 0.9 && s4.pe !== 'none',
      'opacity=' + s4.opacity + ' pe=' + s4.pe)
    check('5 the option is HIT-TESTABLE at the cursor', /^BUTTON/.test(String(hit)), 'elementFromPoint=' + hit)

    await click(opt.x, opt.y); await sleep(500)
    const s5 = await snap('effort/option-click')
    check('6 clicking the option CHANGES the effort', s5.on != null && s5.on !== s1.on, 'on: ' + s1.on + ' -> ' + s5.on)

    await move(600, 120); await sleep(550)
    const s6 = await snap('effort/closed')
    check('7 popover closes after the pick + pin released', parseFloat(s6.opacity) < 0.1 && !(s6.cls || '').includes('pinned'),
      'opacity=' + s6.opacity + ' cls=' + s6.cls)

    // ---- MODE: pure hover path (the original triangle flow) ------------------
    const M = '.seg-fab-right'
    const mb = await badgeRect(M)
    await move(mb.x, mb.y); await sleep(400)
    const m1 = await snap('mode/hover', true)
    check('8 hover opens the mode popover', parseFloat(m1.opacity) > 0.9, 'opacity=' + m1.opacity)

    // midpoint of the 8px gap — the fan must hold it open mid-travel
    const gap = await ev(`(function(){var f=document.querySelector('${M}');var p=f.querySelector('.segmented');var fr=f.getBoundingClientRect();var pr=p.getBoundingClientRect();return {x:(fr.left+fr.right)/2,y:(pr.bottom+fr.top)/2}})()`)
    await move(gap.x, gap.y); await sleep(300)
    const m2 = await snap('mode/mid-gap', true)
    check('9 the invisible triangle holds it open in the gap', parseFloat(m2.opacity) > 0.9, 'opacity=' + m2.opacity)

    const mopt = await rectOf(M + ' .segmented button', true)
    await move(mopt.x, mopt.y); await sleep(350)
    const m3 = await snap('mode/approach', true)
    const mhit = await hitAt(Math.round(mopt.x), Math.round(mopt.y))
    check('10 mode option hit-testable on approach', parseFloat(m3.opacity) > 0.9 && /^BUTTON/.test(String(mhit)),
      'opacity=' + m3.opacity + ' hit=' + mhit)

    await click(mopt.x, mopt.y); await sleep(500)
    const m4 = await snap('mode/option-click', true)
    check('11 clicking the option CHANGES the mode', m4.on != null && m4.on !== m1.on, 'on: ' + m1.on + ' -> ' + m4.on)

    await move(600, 120); await sleep(550)
    const m5 = await snap('mode/closed', true)
    check('12 mode popover closes after the pick', parseFloat(m5.opacity) < 0.1, 'opacity=' + m5.opacity)

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

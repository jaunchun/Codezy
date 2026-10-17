/* batch31 — REAL-BROWSER E2E for the effort/mode popovers (Composer seg-fabs).
   Boots the actual built renderer (out/renderer) in headless Chrome with a
   stubbed preload bridge, then replays the user journey with real mouse
   events: hover -> click-pin -> travel -> hit-test -> pick -> close, for both
   the pinned flow and the pure-hover invisible-triangle flow.
   Requires a current build first:  npm run build
   Regressions this pins down (all invisible to jsdom-only tests):
   - the .intent class was dropped from the fabs during the pin refactor,
     silently killing the hover corridor (hover travel could never work)
   - a corridor built from the leave event's coordinates degenerated to zero
     area (pointerleave carries the JUMP DESTINATION) and got stuck open —
     the corridor is now static quad geometry between the two boxes' near
     edges, plus a 260ms grace when the pointer slips out
   - a picked option kept focus, and :focus-within trapped the popover open
   - the popovers opened TOWARD each other (each is wider than the gap between
     the badges): the effort trip crossed the mode badge, mode popped up over
     the effort options and the pick "hopped to mode" — they now fan OUTWARD */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const OUT = path.join(PROJ, 'tests', '.tmp', 'segtest')
fs.mkdirSync(OUT, { recursive: true })
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = 9357
const HTTP_PORT = 8331
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
  if (!fs.existsSync(path.join(PROJ, 'out', 'renderer', 'index.html'))) {
    console.log('FAIL  out/renderer missing — run `npm run build` first')
    process.exit(1)
  }
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
    const M = '.seg-fab-right'
    // baseline badge geometry — step 18 re-measures this at the very end
    await send('Runtime.evaluate', {
      expression: 'Promise.race([document.fonts.ready, new Promise(function(r){setTimeout(r,2000)})])',
      awaitPromise: true, returnByValue: true
    })
    const bootRects = { e: await badgeRect(E), m: await badgeRect(M) }
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
    const mb = await badgeRect(M)
    await move(mb.x, mb.y); await sleep(400)
    const m1 = await snap('mode/hover', true)
    check('8 hover opens the mode popover', parseFloat(m1.opacity) > 0.9, 'opacity=' + m1.opacity)

    // midpoint of the 8px gap — the fan must hold it open mid-travel
    const gap = await ev(`(function(){var f=document.querySelector('${M}');var p=f.querySelector('.segmented');var fr=f.getBoundingClientRect();var pr=p.getBoundingClientRect();return {x:(fr.left+fr.right)/2,y:(pr.bottom+fr.top)/2}})()`)
    await move(gap.x, gap.y); await sleep(300)
    const m2 = await snap('mode/mid-gap', true)
    check('9 the invisible triangle holds it open in the gap', parseFloat(m2.opacity) > 0.9, 'opacity=' + m2.opacity)

    // 9b. a sideways sweep inside the corridor — well off the badge's line.
    // Hull bounds are computed parametrically so the point stays valid
    // whichever side the popover opens on.
    const side9 = await ev(`(function(){var f=document.querySelector('${M}');var p=f.querySelector('.segmented');var fr=f.getBoundingClientRect();var pr=p.getBoundingClientRect();var y=pr.bottom+3;var t=(fr.top-y)/(fr.top-pr.bottom);var l=fr.left+(pr.left-fr.left)*t;var r=fr.right+(pr.right-fr.right)*t;return {x:l+(r-l)*0.7, y:y}})()`)
    await move(side9.x, side9.y); await sleep(300)
    const m2b = await snap('mode/sideways', true)
    check('9b sideways sweep inside the corridor keeps it open', parseFloat(m2b.opacity) > 0.9,
      'opacity=' + m2b.opacity + ' at (' + Math.round(side9.x) + ',' + Math.round(side9.y) + ')')

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

    // ---- GRACE: slip out of the corridor and come back <260ms later -------
    // Real pointer hovers the effort badge, then leaves for real (tracker +
    // grace fire → closed). The in/out pair is then replayed SYNTHETICALLY so
    // both moves land deterministically inside the grace window.
    const eb2 = await badgeRect(E)
    await move(eb2.x, eb2.y); await sleep(400) // real hover → open
    await move(600, 120); await sleep(600) // real leave → grace → closed
    const g0 = await snap('grace/closed-before')
    check('13 it is closed before the grace replay', parseFloat(g0.opacity) < 0.1, 'opacity=' + g0.opacity)
    const gseq = await ev(`new Promise(function(res){
      var fab = document.querySelector('${E}')
      var pop = fab.querySelector('.segmented')
      var pr = pop.getBoundingClientRect(), fr = fab.getBoundingClientRect()
      var cx = (fr.left+fr.right)/2, cy = (pr.bottom+fr.top)/2
      var fire = function(type, el, x, y){
        el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true,
          pointerId: 1, pointerType: 'mouse', relatedTarget: document.body }))
      }
      fire('pointerout', fab, cx, cy)                        // start a tracker
      setTimeout(function () {
        fire('pointermove', document.body, 600, 120)         // slip OUT → grace starts
        setTimeout(function () {
          fire('pointermove', document.body, cx, cy)         // back INSIDE within grace
          setTimeout(function () { res('done') }, 60)
        }, 80)
      }, 40)
    })`)
    await sleep(350) // let the CSS transition finish before judging opacity
    const g1 = await snap('grace/re-entered')
    check('14 slipping out and back within the grace keeps it open',
      parseFloat(g1.opacity) > 0.9 && (g1.cls || '').includes('intent'),
      'opacity=' + g1.opacity + ' cls=' + g1.cls + ' seq=' + JSON.stringify(gseq))
    await move(640, 150); await sleep(600) // a DIFFERENT far point (same-coord moves are coalesced)
    const g2 = await snap('grace/released')
    check('15 leaving for real closes it after the grace',
      parseFloat(g2.opacity) < 0.1 && !(g2.cls || '').includes('intent'),
      'opacity=' + g2.opacity + ' cls=' + g2.cls)

    // ---- 16. the effort trip, pure hover: it must never wake the mode -------
    // popover (the "effort doesn't work, it hops to mode" complaint — with the
    // old anchors the effort popover sat ON the mode badge, so the diagonal to
    // an option lit mode up mid-trip and the pick hopped over).
    const eb3 = await badgeRect(E)
    await move(eb3.x, eb3.y); await sleep(400)
    const h1 = await snap('effort/hover-only')
    check('16a hover (without a click) opens the effort popover', parseFloat(h1.opacity) > 0.9, 'opacity=' + h1.opacity)

    const egap = await ev(`(function(){var f=document.querySelector('${E}');var p=f.querySelector('.segmented');var fr=f.getBoundingClientRect();var pr=p.getBoundingClientRect();return {x:(fr.left+fr.right)/2,y:(pr.bottom+fr.top)/2}})()`)
    await move(egap.x, egap.y); await sleep(300)
    const h2 = await snap('effort/hover-gap')
    check('16b the corridor holds the effort popover open in the gap', parseFloat(h2.opacity) > 0.9, 'opacity=' + h2.opacity)

    // a real option that is not the active one (middle button, fallback first alt)
    const pick = await ev(`(function(){var f=document.querySelector('${E}');var pop=f.querySelector('.segmented');var on=pop.querySelector('button.on');var bs=pop.querySelectorAll('button');var b=bs[Math.floor(bs.length/2)];if(b===on){for(var i=0;i<bs.length;i++){if(bs[i]!==on){b=bs[i];break}}}var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    // walk there like a hand would — five real mouseMoved events on the
    // diagonal — watching the MODE popover after every waypoint
    const seenM = []
    for (let i = 1; i <= 5; i++) {
      const t = i / 5
      await move(eb3.x + (pick.x - eb3.x) * t, eb3.y + (pick.y - eb3.y) * t)
      await sleep(70)
      seenM.push(parseFloat((await snap('travel/t' + i + '-mode', true)).opacity))
    }
    await sleep(150)
    const h3 = await snap('effort/at-option')
    const h3m = await snap('effort/at-option-mode', true)
    const maxM = Math.max(...seenM, parseFloat(h3m.opacity))
    check('16c the whole trip never wakes the MODE popover (no hop to mode)', maxM < 0.1,
      'max mode opacity=' + maxM.toFixed(2) + ' waypoints=' + seenM.map((v) => v.toFixed(2)).join(','))
    const eh = await hitAt(Math.round(pick.x), Math.round(pick.y))
    check('16d the effort option is hit-testable under the cursor', parseFloat(h3.opacity) > 0.9 && /^BUTTON/.test(String(eh)),
      'opacity=' + h3.opacity + ' hit=' + eh)
    const before16 = h3.on
    const modeBefore16 = h3m.on
    await click(pick.x, pick.y); await sleep(500)
    const h4 = await snap('effort/picked')
    const h4m = await snap('effort/picked-mode', true)
    check('16e the pick lands on EFFORT and leaves mode untouched',
      h4.on != null && h4.on !== before16 && h4m.on === modeBefore16,
      'effort: ' + before16 + ' -> ' + h4.on + ' | mode: ' + modeBefore16 + ' -> ' + h4m.on)
    await move(600, 120); await sleep(550)
    const h5 = await snap('effort/closed-after-hover-pick')
    check('16f the popover closes after the hover pick', parseFloat(h5.opacity) < 0.1, 'opacity=' + h5.opacity)

    // ---- 17. both popovers open AT ONCE: separate boxes, separate badges ----
    const mb2 = await badgeRect(M)
    await move(mb2.x, mb2.y); await sleep(350)
    await click(mb2.x, mb2.y); await sleep(300) // pin mode
    const eb4 = await badgeRect(E)
    await move(eb4.x, eb4.y); await sleep(450) // hover effort → both open
    const bE = await snap('both/effort')
    const bM = await snap('both/mode', true)
    const geo = await ev(`(function(){
      var E=document.querySelector('${E}'), M=document.querySelector('${M}');
      var ep=E.querySelector('.segmented').getBoundingClientRect();
      var mp=M.querySelector('.segmented').getBoundingClientRect();
      var eb=E.querySelector('.seg-badge').getBoundingClientRect();
      var mb=M.querySelector('.seg-badge').getBoundingClientRect();
      var rail=document.querySelector('.composer').getBoundingClientRect();
      function inter(a,b){return !(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top)}
      return { ep:{l:Math.round(ep.left),r:Math.round(ep.right)}, mp:{l:Math.round(mp.left),r:Math.round(mp.right)},
        rail:{l:Math.round(rail.left),r:Math.round(rail.right)},
        popsIntersect: inter(ep,mp), eOverM: inter(ep,mb), mOverE: inter(mp,eb),
        eInRail: ep.left>=rail.left-0.5 && ep.right<=rail.right+0.5,
        mInRail: mp.left>=rail.left-0.5 && mp.right<=rail.right+0.5, vw: innerWidth }
    })()`)
    check('17a both popovers are open at the same time', parseFloat(bE.opacity) > 0.9 && parseFloat(bM.opacity) > 0.9,
      'e=' + bE.opacity + ' m=' + bM.opacity)
    check('17b the two popover boxes never intersect', geo && !geo.popsIntersect, JSON.stringify(geo))
    check('17c no popover sits over the sibling badge', geo && !geo.eOverM && !geo.mOverE, JSON.stringify(geo))
    check('17d both popovers stay inside the composer rail', geo && geo.eInRail && geo.mInRail, JSON.stringify(geo))
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await move(600, 120); await sleep(600)
    const b1 = await snap('both/closed-effort')
    const b2 = await snap('both/closed-mode', true)
    check('17e Esc releases the pin and both popovers close',
      parseFloat(b1.opacity) < 0.1 && parseFloat(b2.opacity) < 0.1 && !(b2.cls || '').includes('pinned'),
      'e=' + b1.opacity + ' m=' + b2.opacity + ' cls=' + b2.cls)

    // ---- 18. the badges must not slide around under the cursor ---------------
    const endRects = { e: await badgeRect(E), m: await badgeRect(M) }
    const drift = Math.max(
      bootRects.e && endRects.e ? Math.abs(endRects.e.x - bootRects.e.x) : 999,
      bootRects.m && endRects.m ? Math.abs(endRects.m.x - bootRects.m.x) : 999)
    check('18 the badges never shift mid-session (no hopping layout)', drift <= 3,
      'drift=' + drift.toFixed(1) + 'px boot e=' + JSON.stringify(bootRects.e) + ' m=' + JSON.stringify(bootRects.m) +
      ' end e=' + JSON.stringify(endRects.e) + ' m=' + JSON.stringify(endRects.m))

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

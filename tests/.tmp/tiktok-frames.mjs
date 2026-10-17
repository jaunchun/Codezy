/* Download-by-CDP: play the TikTok embed in headless Chrome, seek to each
   timestamp (awaiting the real 'seeked' event), capture a frame per stamp.
   Output: tests/.tmp/tiktok-frames/f-<stamp>.png */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const OUT = path.join(PROJ, 'tests', '.tmp', 'tiktok-frames')
fs.mkdirSync(OUT, { recursive: true })
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = 9361
const PROFILE = path.join(PROJ, 'tests', '.tmp', 'tiktok-prof-' + Date.now())
const EMBED = 'https://www.tiktok.com/embed/v2/7693200273614916884'
const STAMPS = [2, 6, 10, 14, 18, 22, 26, 30, 34, 38.5]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let chrome, ws
  try {
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--window-size=640,800', '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT, '--no-first-run', '--disable-extensions', 'about:blank'
    ], { stdio: 'ignore' })
    let target = null
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(250)
      try {
        const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
        target = list.find((t) => t.type === 'page') || null
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error('no devtools target')
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')) })
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
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) return { error: String(r.exceptionDetails.exception?.description || 'eval error') }
      return r.result.value
    }

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Page.navigate', { url: EMBED })

    // wait for a healthy, seekable video
    let state = null
    for (let i = 0; i < 80; i++) {
      await sleep(500)
      state = await ev(`(function(){
        var vids = [].slice.call(document.querySelectorAll('video'))
        return { n: vids.length, rs: vids.map(function(v){return v.readyState}), dur: vids.map(function(v){return v.duration})[1] || null,
                 err: vids.map(function(v){return v.error ? v.error.code : null}) }
      })()`)
      if (state && state.n >= 2 && state.rs[1] >= 2) break
    }
    console.log('video state:', JSON.stringify(state))
    if (!state || state.n < 2 || state.rs[1] < 2) throw new Error('video never became ready')

    for (const t of STAMPS) {
      const seek = await ev(`new Promise(function(res){
        var vids = [].slice.call(document.querySelectorAll('video')).filter(function(v){ return v.readyState >= 2 && getComputedStyle(v).visibility === 'visible' })
        if (!vids.length) return res('no visible video')
        var pending = vids.length
        var to = setTimeout(function(){ res('seek timeout') }, 4000)
        vids.forEach(function(v){
          v.pause()
          var done = function(){ if (--pending === 0) { clearTimeout(to); res('seeked') } }
          v.addEventListener('seeked', done, { once: true })
          try { v.currentTime = ${t} } catch (e) { done() }
        })
      })`)
      await sleep(150) // let the decoded frame paint
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(OUT, 'f-' + String(t).replace('.', '_') + '.png')
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      console.log('t=' + t + 's  ' + seek + '  -> ' + path.basename(file) + '  ' + fs.statSync(file).size + ' bytes')
    }
    console.log('DONE ->', OUT)
  } catch (e) {
    console.log('ERROR', e.message)
  } finally {
    try { ws && ws.close() } catch {}
    try { if (chrome) spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    process.exit(0)
  }
}
main()

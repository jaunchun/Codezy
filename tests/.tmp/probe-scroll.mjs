/* Discriminator: is captureScreenshot reflecting scrollY? */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9446;
const BASE = 'http://localhost:8321/';
const OUT = 'C:\\Users\\kajtg\\Documents\\Projekt domyślny\\codezy\\tests\\.tmp\\shots\\zz-verify.png';
const USER_DATA = 'C:\\Users\\kajtg\\Documents\\Projekt domyślny\\codezy\\tests\\.tmp\\chrome\\probe2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

try {
  let page;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch { /* retry */ }
    await sleep(200);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJS = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  await send('Page.navigate', { url: BASE });
  for (let i = 0; i < 60; i++) {
    const ok = await evalJS(`document.readyState === 'complete' && performance.timeOrigin > ${t0} && performance.now() > 400`);
    if (ok) break;
    await sleep(150);
  }
  const target = await evalJS(`(function () {
    const el = document.querySelector('#features');
    let y = el.getBoundingClientRect().top + window.scrollY - 78;
    y = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight));
    window.scrollTo(0, y);
    return y;
  })()`);
  await sleep(1500);
  const state = await evalJS(`JSON.stringify({ y: scrollY, vvTop: Math.round(visualViewport.pageTop), vvOff: Math.round(visualViewport.offsetTop), scale: visualViewport.scale })`);
  console.log('target', Math.round(target), 'state', state);

  const cap = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(cap.data, 'base64'));
  console.log('wrote zz-verify.png');
  ws.close();
} catch (e) {
  console.error(e);
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
}

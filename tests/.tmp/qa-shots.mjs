/* Deterministic screenshot QA for the CODEZY site via raw CDP (no deps).
   Usage: node qa-shots.mjs            → runs the full shot list. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROJ = 'C:\\Users\\kajtg\\Documents\\Projekt domyślny\\codezy';
const OUT = path.join(PROJ, 'tests', '.tmp', 'shots');
const PORT = 9444;
const BASE = 'http://localhost:8321/';
const USER_DATA = path.join(PROJ, 'tests', '.tmp', 'chrome', 'cdp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(USER_DATA, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

let ws;
const failures = [];

async function pollTargets() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('no CDP target appeared');
}

try {
  const page = await pollTargets();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(m.error.message)); else res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.text || 'exception');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJS = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  async function ready(since) {
    for (let i = 0; i < 120; i++) {
      // timeOrigin guard: never accept the *previous* document as ready
      const ok = await evalJS(`document.readyState === 'complete' && performance.timeOrigin > ${since} && performance.now() > 400`);
      if (ok) return;
      await sleep(150);
    }
    throw new Error('page never became ready');
  }

  async function navigate() {
    const since = Date.now();
    await send('Page.navigate', { url: BASE });
    await ready(since);
  }

  await navigate();

  async function ensureTheme(next) {
    const v = await evalJS(`JSON.stringify({t: document.documentElement.dataset.theme || '', s: localStorage.getItem('codezy-site-theme') || ''})`);
    const { t, s } = JSON.parse(v);
    if (t === next && s === next) return;
    await evalJS(`localStorage.setItem('codezy-site-theme', '${next}')`);
    await navigate();
  }

  async function waitVisibleImgs(maxMs = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const ok = await evalJS(`Array.from(document.images).every((i) => {
        const r = i.getBoundingClientRect();
        return r.bottom <= 0 || r.top >= innerHeight || i.complete;
      })`);
      if (ok) return;
      await sleep(200);
    }
  }

  async function shot(name, opts = {}) {
    const {
      w = 1400, h = 950, y = null, sel = null, theme = 'dark',
      wait = 900, fullpage = false, heroWait = false,
    } = opts;
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: w < 600,
    });
    await ensureTheme(theme);
    const scrollExpr = sel
      ? `(function () {
          const el = document.querySelector('${sel}');
          if (!el) return null;
          let y = el.getBoundingClientRect().top + window.scrollY - 78;
          y = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight));
          window.scrollTo(0, y);
          return y;
        })()`
      : `(function () {
          const y = Math.max(0, Math.min(${y ?? 0}, document.documentElement.scrollHeight - innerHeight));
          window.scrollTo(0, y);
          return y;
        })()`;
    const target = await evalJS(scrollExpr);
    if (target === null) throw new Error('missing selector ' + sel);
    await waitVisibleImgs();
    await sleep(wait);
    if (heroWait) await sleep(4700); // hero timeline (3.5s) + typewriter (~1.3s)
    if (!fullpage) {
      // a late navigation can reset scroll after the jump — verify and repair
      const cur = await evalJS(`window.scrollY`);
      if (Math.abs(cur - target) > 4) {
        await evalJS(`window.scrollTo(0, ${target})`);
        await waitVisibleImgs();
        await sleep(700);
      }
    }
    if (fullpage) {
      await evalJS(`window.scrollTo(0, document.body.scrollHeight)`);
      await sleep(1200);
      await waitVisibleImgs(8000);
      await evalJS(`window.scrollTo(0, 0)`);
      await sleep(900);
    }
    let preCap = fullpage ? 0 : await evalJS(`window.scrollY`);
    let repaired2 = false;
    if (!fullpage && Math.abs(preCap - target) > 4) {
      await evalJS(`window.scrollTo(0, ${target})`);
      await sleep(750);
      preCap = await evalJS(`window.scrollY`);
      repaired2 = true;
    }
    const themeNow = await evalJS(`document.documentElement.dataset.theme || 'dark'`);
    console.log(`dbg ${name}: target=${Math.round(target)} preCap=${Math.round(preCap)} repaired2=${repaired2} theme=${themeNow}/${theme}`);
    const cap = await send('Page.captureScreenshot', fullpage
      ? { format: 'png', captureBeyondViewport: true }
      : { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(cap.data, 'base64'));
    console.log('ok ' + name);
  }

  /* ---- desktop, dark ---- */
  await shot('q-hero', { y: 0, heroWait: true, wait: 300 });
  await shot('q-features', { sel: '#features' });
  await shot('q-modes', { sel: '#modes' });
  await shot('q-terminal', { sel: '#terminal' });
  await shot('q-motion', { sel: '#motion', wait: 1500 });
  await shot('q-engines', { sel: '#engines' });
  await shot('q-install', { sel: '#install', wait: 1100 });
  await shot('q-footer', { y: 99999, wait: 1000 });
  await shot('q-full', { fullpage: true, wait: 600 });

  /* ---- desktop, light ---- */
  await shot('ql-hero', { theme: 'light', y: 0, heroWait: true, wait: 300 });
  await shot('ql-features', { theme: 'light', sel: '#features' });
  await shot('ql-motion', { theme: 'light', sel: '#motion', wait: 1500 });

  /* ---- mobile, dark ---- */
  await shot('qm-hero', { w: 390, h: 844, y: 0, heroWait: true, wait: 300 });
  await shot('qm-features', { w: 390, h: 844, sel: '#features' });
  await shot('qm-modes', { w: 390, h: 844, sel: '#modes' });
  await shot('qm-motion', { w: 390, h: 844, sel: '#motion', wait: 1500 });
  await shot('qm-install', { w: 390, h: 844, sel: '#install', wait: 1100 });

  /* ---- reduced motion: nothing may stay hidden ---- */
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
  await ensureTheme('dark');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await navigate();
  await evalJS(`window.scrollTo(0, 0)`);
  await sleep(700);
  {
    const cap = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'q-reduced-hero.png'), Buffer.from(cap.data, 'base64'));
    console.log('ok q-reduced-hero');
    const hidden = await evalJS(`Array.from(document.querySelectorAll('.reveal')).filter((el) => getComputedStyle(el).opacity !== '1').length`);
    console.log('reduced: hidden .reveal elements = ' + hidden);
    if (hidden > 0) failures.push('reduced-motion leaves ' + hidden + ' .reveal elements hidden');
  }
  await send('Emulation.setEmulatedMedia', { features: [] });

  console.log(errors.length ? 'console errors: ' + JSON.stringify(errors) : 'console: clean');
  if (errors.length) failures.push('console errors: ' + errors.join(' | '));
} catch (e) {
  failures.push(String(e && e.stack || e));
} finally {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
}

if (failures.length) {
  console.error('FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}
console.log('all shots captured');

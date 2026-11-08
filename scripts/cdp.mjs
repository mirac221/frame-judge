// Zero-install capture: a small Playwright-compatible subset driven over the Chrome DevTools Protocol,
// using a Chrome, Edge, Chromium or Brave that's already installed. capture-page.mjs falls back to this
// when Playwright isn't installed. Needs Node 22+ (built-in WebSocket).
//
// Covered: chromium.launch, browser.newContext({ viewport, deviceScaleFactor, isMobile, hasTouch,
// colorScheme, reducedMotion }), context.newPage/close, page.on(console|pageerror|requestfailed|response),
// goto, reload, waitForLoadState('networkidle'), evaluate(fn, arg), waitForTimeout, screenshot({ path,
// clip, animations, caret }), locator(sel).first() hover/click/focus/fill/press/scrollIntoViewIfNeeded/
// boundingBox/screenshot, keyboard.press, and page.clock (install/pauseAt/runFor) as a fake clock for
// Date, performance.now, timers and requestAnimationFrame.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The first installed Chromium-family browser, or null. FRAME_JUDGE_BROWSER (or --browser) wins. */
export function findBrowser(preferred) {
  const pick = [preferred, process.env.FRAME_JUDGE_BROWSER].filter(Boolean);
  for (const p of pick) if (fs.existsSync(p)) return p;
  const env = (k) => process.env[k] || '';
  const candidates = process.platform === 'win32' ? [
    path.join(env('PROGRAMFILES'), 'Google/Chrome/Application/chrome.exe'),
    path.join(env('PROGRAMFILES(X86)'), 'Google/Chrome/Application/chrome.exe'),
    path.join(env('LOCALAPPDATA'), 'Google/Chrome/Application/chrome.exe'),
    path.join(env('PROGRAMFILES(X86)'), 'Microsoft/Edge/Application/msedge.exe'),
    path.join(env('PROGRAMFILES'), 'Microsoft/Edge/Application/msedge.exe'),
    path.join(env('PROGRAMFILES'), 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    path.join(env('LOCALAPPDATA'), 'Chromium/Application/chrome.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ] : [];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  if (process.platform !== 'win32') {
    for (const b of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
      const r = spawnSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    }
  }
  return null;
}

class Conn {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (m) => {
      let d;
      try { d = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8')); } catch { return; }
      if (d.id && this.pending.has(d.id)) {
        const { res, rej, method } = this.pending.get(d.id);
        this.pending.delete(d.id);
        if (d.error) rej(new Error(`${method}: ${d.error.message}`)); else res(d.result || {});
      } else if (d.method) {
        for (const f of this.listeners.get(`${d.sessionId || ''}|${d.method}`) || []) f(d.params || {});
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, method });
      this.ws.send(JSON.stringify(msg));
    });
  }
  on(sessionId, method, f) {
    const k = `${sessionId || ''}|${method}`;
    if (!this.listeners.has(k)) this.listeners.set(k, []);
    this.listeners.get(k).push(f);
    return () => this.listeners.set(k, (this.listeners.get(k) || []).filter((x) => x !== f));
  }
}

// Fake clock injected before any page script runs. Mirrors what capture-page uses from Playwright's
// page.clock: time only moves when runFor() is called, so JS-driven motion is captured frame-exact.
const CLOCK_SRC = (start, now) => `(() => {
  if (window.__fjClock) return;
  const START = ${start}; let now = ${now};
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(now); else super(...a); }
    static now() { return now; }
  }
  window.Date = FakeDate;
  try { performance.now = () => now - START; } catch (e) {}
  const timers = new Map(); const rafs = new Map(); let nextId = 1;
  window.setTimeout = (fn, ms = 0, ...args) => { const id = nextId++; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, every: 0 }); return id; };
  window.setInterval = (fn, ms = 0, ...args) => { const e = Math.max(1, Number(ms) || 0); const id = nextId++; timers.set(id, { at: now + e, fn, args, every: e }); return id; };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.requestAnimationFrame = (fn) => { const id = nextId++; rafs.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => { rafs.delete(id); };
  const call = (f, a) => { try { typeof f === 'function' ? f(...a) : null; } catch (e) { console.error(e && e.stack || String(e)); } };
  const fireDue = (until) => {
    for (let guard = 0; guard < 10000; guard++) {
      let best = null;
      for (const [id, t] of timers) if (t.at <= until && (!best || t.at < best[1].at)) best = [id, t];
      if (!best) return;
      const [id, t] = best;
      now = Math.max(now, t.at);
      if (t.every) t.at += t.every; else timers.delete(id);
      call(t.fn, t.args);
    }
  };
  window.__fjClock = {
    runFor(ms) {
      const end = now + Math.max(0, ms);
      fireDue(now);
      while (now < end) {
        const target = Math.min(end, now + 1000 / 60);
        fireDue(target);
        now = target;
        const cbs = [...rafs.values()]; rafs.clear();
        for (const f of cbs) call(f, [now - START]);
      }
      fireDue(now);
      return now;
    },
  };
})();`;

const KEYS = {
  Enter: [13, '\r'], Tab: [9, ''], Escape: [27, ''], Backspace: [8, ''], Delete: [46, ''], Space: [32, ' '], ' ': [32, ' '],
  ArrowUp: [38, ''], ArrowDown: [40, ''], ArrowLeft: [37, ''], ArrowRight: [39, ''], Home: [36, ''], End: [35, ''], PageDown: [34, ''], PageUp: [33, ''],
};

class Locator {
  constructor(page, selector) { this.page = page; this.selector = selector; }
  first() { return this; }
  async _box(scroll = true) {
    const box = await this.page.evaluate(([s, scroll]) => {
      const el = document.querySelector(s);
      if (!el) return null;
      if (scroll) {
        // Like Playwright: scroll only when the element isn't fully visible; a tall one aligns to the top.
        const b = el.getBoundingClientRect();
        const visible = b.top >= 0 && b.left >= 0 && b.bottom <= innerHeight && b.right <= innerWidth;
        if (!visible) el.scrollIntoView({ block: b.height > innerHeight ? 'start' : 'center', inline: 'nearest', behavior: 'instant' });
      }
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, [this.selector, scroll]);
    if (!box) throw new Error(`no element matches ${this.selector}`);
    return box;
  }
  async boundingBox() {
    try { const b = await this._box(false); return b.width && b.height ? b : null; } catch { return null; }
  }
  async scrollIntoViewIfNeeded() { await this._box(true); }
  async hover() {
    const b = await this._box();
    await this.page._mouse('mouseMoved', b.x + b.width / 2, b.y + b.height / 2);
  }
  async click() {
    const b = await this._box();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await this.page._mouse('mouseMoved', x, y);
    await this.page._mouse('mousePressed', x, y, { button: 'left', clickCount: 1 });
    await this.page._mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
  }
  async focus() {
    const ok = await this.page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.focus(); return true; }, this.selector);
    if (!ok) throw new Error(`no element matches ${this.selector}`);
  }
  async fill(text) {
    const ok = await this.page.evaluate(([s, t]) => {
      const el = document.querySelector(s);
      if (!el) return false;
      el.focus();
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, t); else if (el.isContentEditable) el.textContent = t; else el.value = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, [this.selector, text]);
    if (!ok) throw new Error(`no element matches ${this.selector}`);
  }
  async press(key) { await this.focus(); await this.page.keyboard.press(key); }
  async screenshot(opts = {}) {
    const b = await this._box(true);
    await sleep(50);
    await this.page.screenshot({ ...opts, clip: b });
  }
}

class Page {
  constructor(conn, sessionId, ctx) {
    this.conn = conn;
    this.sid = sessionId;
    this.ctx = ctx;
    this.timeout = 30000;
    this.handlers = { console: [], pageerror: [], requestfailed: [], response: [] };
    this.inflight = new Set();
    this.urls = new Map();
    this.lastNet = Date.now();
    this._clock = null;
    const self = this;
    this.keyboard = { press: (k) => self._key(k) };
    this.clock = {
      install: async ({ time }) => { self._clock = { start: time, now: time, injected: false }; },
      pauseAt: async (t) => { if (self._clock) self._clock.now = t; },
      runFor: async (ms) => { await self.evaluate((n) => window.__fjClock && window.__fjClock.runFor(n), ms); },
    };
  }
  s(method, params) { return this.conn.send(method, params, this.sid); }
  emit(ev, arg) { for (const f of this.handlers[ev] || []) { try { f(arg); } catch {} } }
  on(ev, f) { (this.handlers[ev] ||= []).push(f); return this; }
  setDefaultTimeout(ms) { this.timeout = ms; }

  async _init() {
    const c = this.ctx.opts;
    const on = (m, f) => this.conn.on(this.sid, m, f);
    on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      const text = (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
      this.emit('console', { type: () => 'error', text: () => text });
    });
    on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      this.emit('pageerror', { message: (d.exception && d.exception.description) || d.text || 'uncaught exception' });
    });
    on('Network.requestWillBeSent', (p) => { this.inflight.add(p.requestId); this.urls.set(p.requestId, p.request && p.request.url); this.lastNet = Date.now(); });
    on('Network.loadingFinished', (p) => { this.inflight.delete(p.requestId); this.lastNet = Date.now(); });
    on('Network.loadingFailed', (p) => {
      this.inflight.delete(p.requestId); this.lastNet = Date.now();
      if (p.canceled) return;
      const url = this.urls.get(p.requestId) || '';
      this.emit('requestfailed', { url: () => url, failure: () => ({ errorText: p.errorText }) });
    });
    on('Network.responseReceived', (p) => {
      const r = p.response || {};
      this.emit('response', { status: () => r.status, url: () => r.url });
    });
    await this.s('Page.enable');
    await this.s('Runtime.enable');
    await this.s('Network.enable');
    const vp = c.viewport || { width: 1280, height: 800 };
    await this.s('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: c.deviceScaleFactor || 1, mobile: !!c.isMobile });
    if (c.hasTouch) await this.s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const features = [];
    if (c.colorScheme) features.push({ name: 'prefers-color-scheme', value: c.colorScheme === 'no-preference' ? '' : c.colorScheme });
    if (c.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: c.reducedMotion === 'reduce' ? 'reduce' : '' });
    if (features.length) await this.s('Emulation.setEmulatedMedia', { features });
    await this.s('Page.addScriptToEvaluateOnNewDocument', { source: 'try{const s=document.createElement("style");s.textContent="*{caret-color:transparent!important}";(document.head||document.documentElement).appendChild(s)}catch(e){}', runImmediately: false }).catch(() => {});
  }

  _event(method, timeout) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { off(); rej(new Error(`timed out after ${timeout} ms waiting for ${method}`)); }, timeout);
      const off = this.conn.on(this.sid, method, (p) => { clearTimeout(t); off(); res(p); });
    });
  }

  async goto(url, { timeout } = {}) {
    if (this._clock && !this._clock.injected) {
      await this.s('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SRC(this._clock.start, this._clock.now) });
      this._clock.injected = true;
    }
    const loaded = this._event('Page.loadEventFired', timeout || this.timeout);
    const r = await this.s('Page.navigate', { url });
    if (r.errorText) { loaded.catch(() => {}); throw new Error(`navigation to ${url} failed: ${r.errorText}`); }
    await loaded;
  }
  async reload() {
    const loaded = this._event('Page.loadEventFired', this.timeout);
    await this.s('Page.reload', {});
    await loaded;
  }
  async waitForLoadState(state, { timeout } = {}) {
    const end = Date.now() + (timeout || this.timeout);
    while (Date.now() < end) {
      if (this.inflight.size === 0 && Date.now() - this.lastNet >= 500) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${state}`);
  }
  waitForTimeout(ms) { return sleep(ms); }

  async evaluate(fn, arg) {
    const expression = typeof fn === 'function' ? `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})` : String(fn);
    const r = await this.s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || 'evaluation failed');
    }
    return r.result ? r.result.value : undefined;
  }

  async _mouse(type, x, y, extra = {}) { await this.s('Input.dispatchMouseEvent', { type, x, y, ...extra }); }
  async _key(key) {
    const [code, text] = KEYS[key] || [key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, key.length === 1 ? key : ''];
    await this.s('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, windowsVirtualKeyCode: code, text: text || undefined });
    await this.s('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code });
  }

  async screenshot({ path: file, clip, animations } = {}) {
    // animations: 'disabled' = finite animations jump to their end, infinite ones show their first frame
    // for the shot and resume after it (what Playwright does).
    if (animations === 'disabled') {
      await this.evaluate(() => {
        window.__fjResume = [];
        for (const a of document.getAnimations()) {
          try {
            const end = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().endTime : Infinity;
            if (Number.isFinite(end)) a.finish();
            else if (a.playState === 'running') { window.__fjResume.push(a); a.pause(); a.currentTime = 0; }
          } catch (e) {}
        }
      }).catch(() => {});
    }
    const params = { format: 'png', fromSurface: true, captureBeyondViewport: false };
    if (clip) {
      const off = await this.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      params.clip = { x: clip.x + off.x, y: clip.y + off.y, width: Math.max(1, clip.width), height: Math.max(1, clip.height), scale: 1 };
    }
    const { data } = await this.s('Page.captureScreenshot', params);
    if (file) fs.writeFileSync(file, Buffer.from(data, 'base64'));
    if (animations === 'disabled') await this.evaluate(() => { for (const a of window.__fjResume || []) { try { a.play(); } catch (e) {} } window.__fjResume = []; }).catch(() => {});
    return Buffer.from(data, 'base64');
  }
  locator(selector) { return new Locator(this, selector); }
}

class Context {
  constructor(conn, id, opts) { this.conn = conn; this.id = id; this.opts = opts || {}; }
  async newPage() {
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank', browserContextId: this.id });
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.conn, sessionId, this);
    await page._init();
    return page;
  }
  async close() { await this.conn.send('Target.disposeBrowserContext', { browserContextId: this.id }).catch(() => {}); }
}

async function launch(executablePath) {
  if (typeof WebSocket !== 'function') throw new Error(`capturing without Playwright needs Node 22 or newer (this is Node ${process.versions.node})`);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-judge-cdp-'));
  const proc = spawn(executablePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--allow-file-access-from-files',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  const wsUrl = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`the browser didn't open a DevTools port in 30 s: ${stderr.trim().split('\n').pop() || ''}`)), 30000);
    proc.stderr.on('data', (d) => {
      stderr += d;
      const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); res(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(t); rej(new Error(`the browser exited (code ${code}) before DevTools was ready: ${stderr.trim().split('\n').pop() || ''}`)); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('could not connect to the browser over DevTools')), { once: true }); });
  const conn = new Conn(ws);
  return {
    executablePath,
    async newContext(opts) {
      const { browserContextId } = await conn.send('Target.createBrowserContext', {});
      return new Context(conn, browserContextId, opts);
    },
    async close() {
      try { await Promise.race([conn.send('Browser.close'), sleep(3000)]); } catch {}
      try { ws.close(); } catch {}
      try { proc.kill(); } catch {}
      await sleep(300);
      try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
    },
  };
}

/** A stand-in for require('playwright') that capture-page.mjs can use unchanged. */
export function playwrightLike(executablePath) {
  return { cdp: true, chromium: { launch: () => launch(executablePath) } };
}

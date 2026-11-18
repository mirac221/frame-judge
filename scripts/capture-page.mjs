import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';

const HELP = `capture-page.mjs <url|file.html> --out <dir> [options]

Screenshots
  --viewports desktop,tablet,mobile   presets: desktop 1440x900, laptop 1280x800, tablet 768x1024,
                                      mobile 390x844@2, or WIDTHxHEIGHT[@DPR]
  --slices 6                          max screens captured per viewport
  --actions states.json               interaction states to capture (see references/capture.md)
  --color-scheme light|dark|no-preference   (--dark is shorthand)
  --reduced-motion                    emulate prefers-reduced-motion: reduce
  --wait 500                          extra settle time after load, in ms
  --live-animations                   keep CSS animations running in screenshots
  --dpr N                             device pixel ratio for every viewport
  --channel chrome|msedge             use an installed browser instead of Playwright's
  --cdp                               skip Playwright: drive an installed Chrome/Edge/Chromium over DevTools
                                      (automatic when Playwright isn't installed; needs Node 22+)
  --browser <path>                    which browser --cdp uses (default: the first one found)
  --no-audit                          skip the automatic checks (contrast, touch targets, cut-off text,
                                      elements past the viewport edge) and their overlay images

Close-ups (instead of the normal screens)
  --zoom "VIEWPORT@SCROLLY:x,y,w,h"   re-render that region at --zoom-dpr (default 3); box in fractions
                                      of the screen. Repeatable. "judge.mjs requests" writes these for you.

Animation (first viewport only)
  --animate <ms> --fps 30             frame-exact capture, encoded to <out>/animation.mp4
  --selector <css> --pad 32           clip to one element (box measured at t=0)
  --track auto|none|<css,css>         measure moving elements every frame and draw their paths and speed
                                      curves (default auto: the up-to-4 elements that move the most)
  --encode <file.mp4>                 write the MP4 somewhere else
  --no-clock                          skip the fake clock if the page breaks under it`;

const PRESETS = {
  desktop: { width: 1440, height: 900, dpr: 1, mobile: false, touch: false },
  laptop: { width: 1280, height: 800, dpr: 1, mobile: false, touch: false },
  tablet: { width: 768, height: 1024, dpr: 1, mobile: false, touch: true },
  mobile: { width: 390, height: 844, dpr: 2, mobile: true, touch: true },
};
const BOOLEAN_FLAGS = new Set(['dark', 'reduced-motion', 'live-animations', 'no-clock', 'help', 'cdp', 'no-audit']);
const AUDIT_OVERLAYS_PER_VIEWPORT = 3;
const MAX_TRACKS = 4;
const TRACK_COLORS = ['#ff1744', '#00b0ff', '#ffab00', '#00c853'];
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const die = (msg) => { console.error(`capture-page: ${msg}`); process.exit(1); };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'state';
const push = (list, s) => { const t = String(s).slice(0, 300); if (list.length < 50 && !list.includes(t)) list.push(t); };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      let key = a.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq > -1) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else if (BOOLEAN_FLAGS.has(key)) val = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i];
      else val = true;
      out[key] = key in out ? [].concat(out[key], val) : val;
    } else out._.push(a);
  }
  return out;
}

function loadPlaywright() {
  const names = ['playwright', 'playwright-core', '@playwright/test'];
  const fromEnv = process.env.FRAME_JUDGE_PLAYWRIGHT;
  if (fromEnv) {
    try { return createRequire(fileURLToPath(import.meta.url))(path.resolve(fromEnv)); }
    catch (e) { die(`FRAME_JUDGE_PLAYWRIGHT=${fromEnv} could not be loaded: ${e.message}`); }
  }
  const tryFrom = (base) => {
    const req = createRequire(base);
    for (const n of names) {
      try { const pw = req(n); if (pw && pw.chromium) return pw; } catch {}
    }
    return null;
  };
  const local = tryFrom(path.join(process.cwd(), 'noop.js')) || tryFrom(fileURLToPath(import.meta.url));
  if (local) return local;
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return tryFrom(path.join(root, 'noop.js'));
  } catch { return null; }
}

async function launch(pw, channel) {
  const attempts = channel ? [channel] : [undefined, 'chrome', 'msedge'];
  let lastError;
  for (const ch of attempts) {
    try { return await pw.chromium.launch(ch ? { channel: ch } : {}); } catch (e) { lastError = e; }
  }
  die(`could not launch a browser (${String(lastError && lastError.message).split('\n')[0]}). Run "npx playwright install chromium", or pass --channel chrome / --channel msedge.`);
}

function resolveTarget(t) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (exists(path.resolve(t))) return pathToFileURL(path.resolve(t)).href;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(t)) return `http://${t}`;
  die(`can't find "${t}". Pass a URL or an existing file.`);
}

function parseViewports(spec) {
  return String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    if (PRESETS[s]) return { name: s, ...PRESETS[s] };
    const m = s.match(/^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/i);
    if (!m) die(`bad viewport "${s}". Use desktop, laptop, tablet, mobile or WIDTHxHEIGHT[@DPR].`);
    const width = Number(m[1]);
    const height = Number(m[2]);
    return { name: `${width}x${height}`, width, height, dpr: m[3] ? Number(m[3]) : 1, mobile: width < 600, touch: width < 1024 };
  });
}

const contextFor = (vp, o) => ({
  viewport: { width: vp.width, height: vp.height },
  deviceScaleFactor: o.dpr || vp.dpr,
  isMobile: vp.mobile,
  hasTouch: vp.touch,
  colorScheme: o.colorScheme,
  reducedMotion: o.reducedMotion,
});

function describe(vp, o) {
  const dpr = o.dpr || vp.dpr;
  const size = `${vp.width}×${vp.height}`;
  let s = `${vp.name === `${vp.width}x${vp.height}` ? size : `${vp.name} ${size}`}${dpr > 1 ? ` @${dpr}x` : ''}`;
  if (o.colorScheme !== 'light') s += `, ${o.colorScheme} colour scheme`;
  if (o.reducedMotion === 'reduce') s += ', reduced motion';
  return s;
}

function watch(page, sink) {
  page.on('console', (m) => { if (m.type() === 'error') push(sink.console_errors, m.text()); });
  page.on('pageerror', (e) => push(sink.page_errors, e.message));
  page.on('requestfailed', (r) => push(sink.failed_requests, `${(r.failure() && r.failure().errorText) || 'failed'} ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) push(sink.failed_requests, `HTTP ${r.status()} ${r.url()}`); });
}

async function settle(page, ms) {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const running = document.getAnimations().filter((a) => {
      const end = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().endTime : Infinity;
      return a.playState === 'running' && Number.isFinite(end);
    });
    await Promise.race([
      Promise.all(running.map((a) => a.finished.catch(() => {}))),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  }).catch(() => {});
  if (ms) await page.waitForTimeout(ms);
}

const scrollTo = (page, top) => page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), top);

async function captureViewport(browser, vp, o, cap) {
  const context = await browser.newContext(contextFor(vp, o));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  watch(page, cap.builder_only);
  await page.goto(o.url, { waitUntil: 'load', timeout: 60000 });
  await settle(page, o.wait);
  const m = await page.evaluate(() => ({
    height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    layoutW: window.innerWidth,
    sw: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
    broken: [...document.images].filter((img) => img.complete && img.naturalWidth === 0 && img.currentSrc).length,
  }));
  // Slice by the emulated screen, not innerWidth/innerHeight: on a mobile viewport, content wider than the
  // screen makes Chrome widen (and lengthen) the layout viewport, which used to hide the overflow and the
  // lower screens.
  m.vw = vp.width;
  m.vh = vp.height;
  const screens = Math.max(1, Math.ceil(m.height / m.vh));
  const n = Math.min(screens, o.slices);
  const label = describe(vp, o);
  const found = new Map();
  let overlays = 0;
  let captured = 0;
  let lastSy = -1;
  for (let i = 0; i < n; i++) {
    const y = i === n - 1 && n === screens && screens > 1 ? m.height - m.vh : i * m.vh;
    await scrollTo(page, y);
    await page.waitForTimeout(350);
    await settle(page, 0);
    const sy = Math.round(await page.evaluate(() => window.scrollY).catch(() => y));
    if (i > 0 && sy <= lastSy) {
      push(cap.builder_only.action_errors, `${vp.name}: the page won't scroll past y=${sy}px, so ${screens - i} lower screen(s) couldn't be captured${m.layoutW > m.vw + 1 ? ` (content ${m.sw - m.vw}px wider than the screen made the browser widen the layout to ${m.layoutW}px; fix the overflow)` : ''}`);
      break;
    }
    lastSy = sy;
    captured++;
    const id = `${vp.name}-${i + 1}`;
    const shot = { animations: o.liveAnimations ? 'allow' : 'disabled', caret: 'hide' };
    await page.screenshot({ path: path.join(o.out, `${id}.png`), ...shot });
    cap.artifacts.push({ id, file: `${id}.png`, type: 'viewport', viewport: vp.name, scroll_y: sy, shows: `${label}, screen ${i + 1} of ${screens} (scrolled to y=${sy}px)` });
    if (!o.audit) continue;
    const items = await page.evaluate(auditScreen, { touch: vp.touch, vw: m.vw, vh: m.vh }).catch((e) => { push(cap.builder_only.action_errors, `audit ${id}: ${String(e.message).split('\n')[0]}`); return []; });
    for (const it of items) {
      const k = `${it.kind}|${it.sel}`;
      if (!found.has(k)) found.set(k, { viewport: vp.name, screen: i + 1, kind: it.kind, value: it.label, selector: it.sel });
    }
    if (!items.length || overlays >= AUDIT_OVERLAYS_PER_VIEWPORT) continue;
    overlays++;
    try {
      await page.evaluate(drawAudit, { items, vw: m.vw, vh: m.vh });
      await page.screenshot({ path: path.join(o.out, `audit-${id}.png`), ...shot });
      const kinds = AUDIT_KINDS.filter(([k]) => items.some((it) => it.kind === k)).map(([k, what]) => `${items.filter((it) => it.kind === k).length} ${what}`);
      cap.artifacts.push({ id: `audit-${id}`, file: `audit-${id}.png`, type: 'audit_overlay', viewport: vp.name, scroll_y: sy, shows: `the same screen as ${id} with automatic checks boxed on it (numbered): ${kinds.join(', ')}. Red = text contrast below WCAG AA (ratio shown), orange = touch target under 44×44 px (size shown), magenta = text cut off by its container, blue = element past the viewport edge. Measured from the page; whether each one matters is your call.` });
    } finally {
      await page.evaluate(() => { const el = document.getElementById('__fj_audit'); if (el) el.remove(); }).catch(() => {});
    }
  }
  cap.measurements[vp.name] = {
    viewport: label,
    page_height_px: m.height,
    screens,
    captured_screens: captured,
    horizontal_overflow_px: Math.max(0, m.sw - m.vw),
    broken_images: m.broken,
  };
  if (captured < n) cap.measurements[vp.name].unreachable_screens = n - captured;
  if (o.audit) {
    const all = [...found.values()];
    const count = (k) => all.filter((x) => x.kind === k).length;
    cap.measurements[vp.name].audit = { low_contrast_text: count('contrast'), small_touch_targets: count('target'), cut_off_text: count('clipped'), past_viewport_edge: count('edge'), screens_checked: n };
    for (const x of all) if (cap.builder_only.audit.length < 80) cap.builder_only.audit.push(x);
  }
  if (o.actions) await runActions(page, vp, o, cap, label);
  await context.close();
}

const AUDIT_KINDS = [['contrast', 'low-contrast text'], ['target', 'small touch target(s)'], ['clipped', 'cut-off text'], ['edge', 'element(s) past the edge']];

// Runs in the page. Checks what's on the current screen and returns boxes in viewport coordinates.
// Contrast is measured against what is actually painted behind the text (elementsFromPoint), and text
// over images, gradients, video or canvas is skipped rather than guessed.
function auditScreen({ touch, vw, vh }) {
  const out = [];
  const seen = new Set();
  const sel = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 5; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(`${p}#${e.id}`); break; }
      const cls = [...e.classList].slice(0, 2).join('.');
      if (cls) p += `.${cls}`;
      const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(e) + 1})`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  const onScreen = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  const add = (kind, el, r, label) => {
    const k = `${kind}|${sel(el)}`;
    if (seen.has(k) || out.length >= 40) return;
    seen.add(k);
    out.push({ kind, box: box(r), label, sel: sel(el) });
  };
  const visible = (el) => {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || (e === el && s.visibility === 'hidden')) return false;
      o *= Number(s.opacity);
      if (o < 0.1) return false;
    }
    return true;
  };
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (t, b) => [t[0] * t[3] + b[0] * (1 - t[3]), t[1] * t[3] + b[1] * (1 - t[3]), t[2] * t[3] + b[2] * (1 - t[3]), 1];
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const rootDark = /dark/.test(getComputedStyle(document.documentElement).colorScheme || '');
  const MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'PICTURE', 'IFRAME', 'OBJECT', 'EMBED']);
  const bgAt = (el, x, y) => {
    const stack = document.elementsFromPoint(x, y);
    let i = stack.indexOf(el);
    if (i < 0) i = 0;
    const layers = [];
    for (const e of stack.slice(i)) {
      if (e !== el && MEDIA.has(e.tagName.toUpperCase())) return null;
      const s = getComputedStyle(e);
      if (s.backgroundImage !== 'none' || (s.backdropFilter && s.backdropFilter !== 'none') || s.mixBlendMode !== 'normal') return null;
      const c = rgba(s.backgroundColor);
      if (c[3] > 0) { layers.push(c); if (c[3] >= 0.99) break; }
    }
    let base;
    if (layers.length && layers[layers.length - 1][3] >= 0.99) base = layers.pop();
    else if (rootDark) return null;
    else base = [255, 255, 255, 1];
    for (let k = layers.length - 1; k >= 0; k--) base = over(layers[k], base);
    return base;
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'OPTION', 'TITLE']);
  const tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim() ? 1 : 2) });
  const range = document.createRange();
  const checked = new Set();
  let n = 0;
  for (let t = tw.nextNode(); t && n < 4000; t = tw.nextNode()) {
    n++;
    const el = t.parentElement;
    if (!el || SKIP.has(el.tagName)) continue;
    range.selectNodeContents(t);
    const r = range.getBoundingClientRect();
    if (!onScreen(r) || !visible(el)) continue;
    // cut off: the text runs past the edge of an ancestor that clips its overflow
    for (let a = el, depth = 0; a && a !== document.body && depth < 8; a = a.parentElement, depth++) {
      const s = getComputedStyle(a);
      const cx = /hidden|clip/.test(s.overflowX), cy = /hidden|clip/.test(s.overflowY);
      if (!cx && !cy) continue;
      const cr = a.getBoundingClientRect();
      const past = (cx && (r.right > cr.right + 1.5 || r.left < cr.left - 1.5)) || (cy && (r.bottom > cr.bottom + 1.5 || r.top < cr.top - 1.5));
      const ellipsis = a === el && s.textOverflow === 'ellipsis' && a.scrollWidth > a.clientWidth + 1;
      if (past || ellipsis) { add('clipped', a, cr, ellipsis ? 'truncated' : 'cut off'); break; }
    }
    if (checked.has(el)) continue;
    checked.add(el);
    const s = getComputedStyle(el);
    const fg = rgba(s.webkitTextFillColor && s.webkitTextFillColor !== s.color && rgba(s.webkitTextFillColor)[3] > 0 ? s.webkitTextFillColor : s.color);
    if (fg[3] === 0) continue;
    const px = Math.min(vw - 1, Math.max(0, (Math.max(r.left, 0) + Math.min(r.right, vw)) / 2));
    const py = Math.min(vh - 1, Math.max(0, (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2));
    const bg = bgAt(el, px, py);
    if (!bg) continue;
    const text = over(fg, bg);
    const l1 = lum(text), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(s.fontSize) || 16;
    const weight = parseInt(s.fontWeight, 10) || 400;
    const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    if (ratio < need) add('contrast', el, r, `${ratio.toFixed(1)}:1`);
  }
  if (touch) {
    const targets = document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem]');
    for (const el of targets) {
      const r = el.getBoundingClientRect();
      if (!onScreen(r) || !visible(el) || (r.width >= 44 && r.height >= 44)) continue;
      // WCAG 2.5.8 exempts a link inside a sentence
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.parentElement && el.parentElement.textContent.trim().length > el.textContent.trim().length + 15) continue;
      const lab = (el.type === 'checkbox' || el.type === 'radio') && (el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)));
      if (lab) { const lr = lab.getBoundingClientRect(); if (lr.width >= 44 && lr.height >= 44) continue; }
      add('target', el, r, `${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  }
  if (document.documentElement.scrollWidth > vw + 1) {
    let k = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (++k > 5000) break;
      const r = el.getBoundingClientRect();
      if (!(r.right > vw + 1) || !r.width || !r.height || r.bottom < 0 || r.top > vh) continue;
      const p = el.parentElement;
      if (p && p !== document.body && p.getBoundingClientRect().right > vw + 1) continue;
      let inside = false;
      for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        if (getComputedStyle(a).overflowX !== 'visible') { inside = true; break; }
      }
      if (!inside && getComputedStyle(el).position !== 'fixed') add('edge', el, r, `+${Math.round(r.right - vw)}px`);
    }
  }
  return out;
}

// Runs in the page: draws the audit boxes as a fixed overlay (removed right after the screenshot).
function drawAudit({ items, vw, vh }) {
  const COLORS = { contrast: '#ff1744', target: '#ff9100', clipped: '#d500f9', edge: '#2979ff' };
  const root = document.createElement('div');
  root.id = '__fj_audit';
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  items.forEach((it, i) => {
    const c = COLORS[it.kind] || '#ff1744';
    const x = Math.max(1, it.box.x), y = Math.max(1, it.box.y);
    const w = Math.max(4, Math.min(vw - 1, it.box.x + it.box.w) - x), h = Math.max(4, Math.min(vh - 1, it.box.y + it.box.h) - y);
    const b = document.createElement('div');
    b.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;box-sizing:border-box;border:2px solid ${c};background:${c}1f;`;
    const t = document.createElement('div');
    t.textContent = `${i + 1} ${it.label}`;
    t.style.cssText = `position:absolute;left:-2px;${y < 18 ? 'top:100%' : 'bottom:100%'};font:700 11px/15px system-ui,Arial,sans-serif;color:#fff;background:${c};padding:0 4px;white-space:nowrap;border-radius:2px;`;
    b.appendChild(t);
    root.appendChild(b);
  });
  const legend = document.createElement('div');
  legend.textContent = 'frame-judge audit overlay (not part of the page)';
  legend.style.cssText = 'position:fixed;right:6px;bottom:6px;font:600 11px/16px system-ui,Arial,sans-serif;color:#fff;background:rgba(0,0,0,.75);padding:2px 6px;border-radius:3px;';
  root.appendChild(legend);
  document.documentElement.appendChild(root);
}

async function captureZooms(browser, o, cap) {
  for (const [i, z] of o.zooms.entries()) {
    const vp = z.vp;
    const zo = { ...o, dpr: o.zoomDpr };
    const context = await browser.newContext(contextFor(vp, zo));
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    watch(page, cap.builder_only);
    await page.goto(o.url, { waitUntil: 'load', timeout: 60000 });
    await settle(page, o.wait);
    await scrollTo(page, z.y);
    await page.waitForTimeout(350);
    await settle(page, 0);
    const sy = Math.round(await page.evaluate(() => window.scrollY).catch(() => z.y));
    const [bx, by, bw, bh] = z.box;
    const x0 = Math.max(0, bx - bw * 0.15), y0 = Math.max(0, by - bh * 0.15);
    const x1 = Math.min(1, bx + bw * 1.15), y1 = Math.min(1, by + bh * 1.15);
    const clip = { x: Math.floor(x0 * vp.width), y: Math.floor(y0 * vp.height), width: Math.max(8, Math.ceil((x1 - x0) * vp.width)), height: Math.max(8, Math.ceil((y1 - y0) * vp.height)) };
    const id = `zoom-${i + 1}`;
    await page.screenshot({ path: path.join(o.out, `${id}.png`), clip, animations: o.liveAnimations ? 'allow' : 'disabled', caret: 'hide' });
    const pct = (a, b) => `${Math.round(a * 100)}–${Math.round(b * 100)}%`;
    cap.artifacts.push({ id, file: `${id}.png`, type: 'zoom', viewport: vp.name, scroll_y: sy, shows: `${describe(vp, zo)}, close-up re-rendered at ${o.zoomDpr}x of the region x ${pct(x0, x1)}, y ${pct(y0, y1)} of the screen scrolled to y=${sy}px` });
    if (sy !== z.y) push(cap.builder_only.action_errors, `${id}: asked for scroll y=${z.y}, the page stopped at ${sy}`);
    await context.close();
  }
}

async function runActions(page, vp, o, cap, label) {
  await scrollTo(page, 0);
  for (const [i, step] of o.actions.entries()) {
    if (Array.isArray(step.only) && !step.only.includes(vp.name)) continue;
    const where = `${vp.name} step ${i + 1} (${step.do}${step.selector ? ` ${step.selector}` : ''})`;
    const target = step.selector ? page.locator(step.selector).first() : null;
    const need = () => { if (!target) throw new Error('needs a selector'); return target; };
    try {
      switch (step.do) {
        case 'hover': await need().hover(); break;
        case 'click': await need().click(); break;
        case 'focus': await need().focus(); break;
        case 'fill': await need().fill(String(step.text ?? '')); break;
        case 'press': if (target) await target.press(step.key); else await page.keyboard.press(step.key); break;
        case 'scroll': if (target) await target.scrollIntoViewIfNeeded(); else await scrollTo(page, Number(step.y) || 0); break;
        case 'wait': await page.waitForTimeout(Number(step.ms) || 500); break;
        case 'reload': await page.reload({ waitUntil: 'load' }); await settle(page, o.wait); break;
        case 'shot': break;
        default: throw new Error(`unknown action "${step.do}"`);
      }
      if (step.wait && step.do !== 'wait') await page.waitForTimeout(Number(step.wait));
    } catch (e) {
      push(cap.builder_only.action_errors, `${where}: ${String(e.message).split('\n')[0]}`);
      continue;
    }
    const name = step.shot || (step.do === 'shot' ? `step-${i + 1}` : null);
    if (!name) continue;
    const id = `${vp.name}-${slug(name)}`;
    const clip = step.clip || (step.do === 'shot' ? step.selector : null);
    const shot = { path: path.join(o.out, `${id}.png`), animations: o.liveAnimations ? 'allow' : 'disabled', caret: 'hide' };
    try {
      if (clip) await page.locator(clip).first().screenshot(shot); else await page.screenshot(shot);
      cap.artifacts.push({ id, file: `${id}.png`, type: 'state', viewport: vp.name, shows: `${label}, state: ${step.label || name}${clip ? ' (cropped to one element)' : ''}` });
    } catch (e) {
      push(cap.builder_only.action_errors, `${where} screenshot: ${String(e.message).split('\n')[0]}`);
    }
  }
}

async function seek(t) {
  if (typeof window.frameJudgeSeek === 'function') { await window.frameJudgeSeek(t); return true; }
  const starts = window.__frameJudgeStarts || (window.__frameJudgeStarts = new WeakMap());
  for (const a of document.getAnimations()) {
    if (!starts.has(a)) starts.set(a, t);
    try { a.pause(); a.currentTime = Math.max(0, t - starts.get(a)); } catch {}
  }
  return false;
}

// ---- motion tracking: measure elements every frame, keep the ones that really move ----
function setupTrack({ root, selectors }) {
  let els;
  if (selectors) els = selectors.map((s) => document.querySelector(s)).filter(Boolean);
  else {
    const r = (root && document.querySelector(root)) || document.body;
    els = [...r.querySelectorAll('*')].filter((e) => !['SCRIPT', 'STYLE', 'LINK', 'META', 'BR', 'TITLE'].includes(e.tagName)).slice(0, 400);
  }
  window.__fjTrack = els;
  return els.length;
}
function sampleTrack() {
  return (window.__fjTrack || []).map((e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    const shown = s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    return [Math.round((r.left + r.width / 2) * 10) / 10, Math.round((r.top + r.height / 2) * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10, Math.round(Number(s.opacity) * 1000) / 1000, shown ? 1 : 0];
  });
}
function trackSelectors(idx) {
  const sel = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 5; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(`${p}#${e.id}`); break; }
      const cls = [...e.classList].slice(0, 2).join('.');
      if (cls) p += `.${cls}`;
      const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(e) + 1})`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  return idx.map((i) => (window.__fjTrack && window.__fjTrack[i] ? sel(window.__fjTrack[i]) : null));
}

const r1 = (n) => Math.round(n * 10) / 10;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function pickTracks(samples, times, clip) {
  if (samples.length < 2 || !samples[0].length) return [];
  const F = samples.length;
  const n = samples[0].length;
  const cand = [];
  for (let k = 0; k < n; k++) {
    let pathLen = 0, dOp = 0, dSize = 0, area = 0, shownAny = false;
    for (let f = 0; f < F; f++) {
      const b = samples[f][k];
      if (!b) continue;
      if (b[5]) { shownAny = true; area = Math.max(area, b[2] * b[3]); }
      if (!f) continue;
      const a = samples[f - 1][k];
      if (!a || !(a[5] && b[5])) continue;
      pathLen += Math.hypot(b[0] - a[0], b[1] - a[1]);
      dOp += Math.abs(b[4] - a[4]);
      dSize += Math.abs(b[2] - a[2]) + Math.abs(b[3] - a[3]);
    }
    const score = pathLen + 100 * dOp + dSize / 2;
    if (shownAny && area >= 16 && score > 3) cand.push({ k, score, area });
  }
  cand.sort((a, b) => b.score - a.score || b.area - a.area);
  // Children that ride along with a moving parent repeat its motion: keep only the largest of each group.
  const same = (a, b) => samples.every((s) => {
    const p = s[a], q = s[b], p0 = samples[0][a], q0 = samples[0][b];
    return Math.abs((p[0] - p0[0]) - (q[0] - q0[0])) < 1.5 && Math.abs((p[1] - p0[1]) - (q[1] - q0[1])) < 1.5 && Math.abs(p[4] - q[4]) < 0.02;
  });
  const chosen = [];
  for (const c of cand) {
    const dup = chosen.findIndex((d) => same(c.k, d.k));
    if (dup > -1) { if (c.area > chosen[dup].area) chosen[dup] = c; continue; }
    if (chosen.length < MAX_TRACKS) chosen.push(c);
  }
  const ox = clip ? clip.x : 0, oy = clip ? clip.y : 0;
  return chosen.map((c, i) => {
    const label = String.fromCharCode(65 + i);
    const pts = samples.map((s, f) => { const b = s[c.k]; return { t: times[f], x: r1(b[0] - ox), y: r1(b[1] - oy), w: b[2], h: b[3], o: b[4], shown: b[5] }; });
    const steps = [];
    let dist = 0;
    pts.forEach((p, f) => {
      if (f) { const q = pts[f - 1]; const d = Math.hypot(p.x - q.x, p.y - q.y); dist += d; steps.push({ t: p.t, d, v: d / ((p.t - q.t) / 1000 || 1) }); }
      p.dist = r1(dist);
      p.v = f ? r1(steps[f - 1].v) : 0;
    });
    const moving = steps.filter((s) => s.d > 0.5);
    const med = median(moving.map((s) => s.d));
    const maxStep = steps.reduce((m, s) => (s.d > m.d ? s : m), { d: 0, t: 0 });
    const jumps = steps.filter((s) => s.d > Math.max(8, 4 * med)).map((s) => s.t);
    const w0 = pts[0].w || 1, h0 = pts[0].h || 1;
    const scales = pts.map((p) => p.w / w0);
    const ops = pts.map((p) => p.o);
    const first = pts.find((p) => p.shown) || pts[0];
    return {
      k: c.k, label, pts,
      metrics: {
        label,
        start: `${Math.round(first.w)}×${Math.round(first.h)} px, centred at x=${Math.round(first.x)}, y=${Math.round(first.y)} in the frame at t=${first.t}ms`,
        path_px: r1(dist),
        net_px: r1(Math.hypot(pts[F - 1].x - pts[0].x, pts[F - 1].y - pts[0].y)),
        peak_speed_px_s: Math.round(Math.max(0, ...steps.map((s) => s.v))),
        moving_frames: moving.length,
        median_step_px: r1(med),
        max_step_px: r1(maxStep.d),
        max_step_at_ms: maxStep.t,
        constant_speed_share: moving.length >= 4 ? Math.round((moving.filter((s) => Math.abs(s.d - med) <= 0.15 * med).length / moving.length) * 100) / 100 : null,
        jumps_at_ms: jumps.slice(0, 8),
        opacity_range: [Math.min(...ops), Math.max(...ops)],
        scale_range: [Math.round(Math.min(...scales) * 100) / 100, Math.round(Math.max(...scales) * 100) / 100],
        squash: Math.round((Math.max(...pts.map((p) => (p.w / w0) / ((p.h / h0) || 1))) || 1) * 100) / 100,
      },
    };
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const niceStep = (span, target) => {
  const raw = span / Math.max(1, target);
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
};

function pathsSvg({ tracks, fps, frameSize, scale }) {
  const W = Math.round(frameSize.w * scale), H = Math.round(frameSize.h * scale);
  const every = Math.max(1, Math.round(fps / 2));
  let g = '';
  tracks.forEach((tr, i) => {
    const c = TRACK_COLORS[i % TRACK_COLORS.length];
    const pts = tr.pts.filter((p) => p.shown);
    if (!pts.length) return;
    const xy = pts.map((p) => `${r1(p.x * scale)},${r1(p.y * scale)}`).join(' ');
    g += `<polyline points="${xy}" fill="none" stroke="${c}" stroke-width="1.5" stroke-opacity="0.7"/>`;
    pts.forEach((p, f) => {
      g += `<circle cx="${r1(p.x * scale)}" cy="${r1(p.y * scale)}" r="3" fill="${c}" stroke="#000" stroke-width="0.6"/>`;
      if (f && f % every === 0) g += `<circle cx="${r1(p.x * scale)}" cy="${r1(p.y * scale)}" r="7" fill="none" stroke="${c}" stroke-width="1.5"/>`;
    });
    const inFrame = (p) => p.x >= 0 && p.y >= 0 && p.x <= frameSize.w && p.y <= frameSize.h;
    const s = pts.find(inFrame) || pts[0], e = pts[pts.length - 1];
    g += `<rect x="${r1(e.x * scale) - 6}" y="${r1(e.y * scale) - 6}" width="12" height="12" fill="none" stroke="${c}" stroke-width="2.5"/>`;
    g += `<circle cx="${r1(s.x * scale)}" cy="${r1(s.y * scale)}" r="11" fill="${c}" stroke="#000" stroke-width="1"/><text x="${r1(s.x * scale)}" y="${r1(s.y * scale) + 5}" text-anchor="middle" font-family="Arial" font-weight="700" font-size="14" fill="#000">${tr.label}</text>`;
  });
  return { W, H, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="position:absolute;left:0;top:0">${g}</svg>` };
}

function curvesSvg({ tracks, times }) {
  const W = 1500, ROW = 210, TOP = 34, padL = 64, gap = 40;
  const panels = 3;
  const pw = Math.floor((W - padL - gap * (panels - 1) - 24) / panels);
  const tMax = times[times.length - 1] || 1;
  const xt = niceStep(tMax, 6);
  const H = TOP + tracks.length * ROW + 10;
  let g = `<rect width="${W}" height="${H}" fill="#fff"/><text x="12" y="22" font-family="Arial" font-size="15" font-weight="700" fill="#111">Measured every frame · columns: distance travelled from start (px) · speed (px/s) · opacity (solid) and scale (dashed)</text>`;
  tracks.forEach((tr, i) => {
    const c = TRACK_COLORS[i % TRACK_COLORS.length];
    const y0 = TOP + i * ROW;
    g += `<circle cx="22" cy="${y0 + 26}" r="12" fill="${c}"/><text x="22" y="${y0 + 31}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="700" fill="#000">${tr.label}</text>`;
    const series = [
      { vals: tr.pts.map((p) => p.dist), unit: 'px' },
      { vals: tr.pts.map((p) => p.v), unit: 'px/s' },
      { vals: tr.pts.map((p) => p.o), vals2: tr.pts.map((p) => r1(p.w / (tr.pts[0].w || 1) * 100) / 100), unit: '' },
    ];
    series.forEach((s, j) => {
      const x0 = padL + j * (pw + gap), top = y0 + 12, ph = ROW - 50;
      const all = s.vals.concat(s.vals2 || []);
      let lo = Math.min(0, ...all), hi = Math.max(...all);
      if (j === 2) { lo = Math.min(0, ...all); hi = Math.max(1, ...all); }
      if (hi - lo < 1e-6) hi = lo + 1;
      const X = (t) => x0 + (t / tMax) * pw;
      const Y = (v) => top + ph - ((v - lo) / (hi - lo)) * ph;
      g += `<rect x="${x0}" y="${top}" width="${pw}" height="${ph}" fill="#fafafa" stroke="#ccc"/>`;
      const ys = niceStep(hi - lo, 4);
      for (let v = Math.ceil(lo / ys) * ys; v <= hi + 1e-9; v += ys) g += `<line x1="${x0}" x2="${x0 + pw}" y1="${r1(Y(v))}" y2="${r1(Y(v))}" stroke="#e6e6e6"/><text x="${x0 - 6}" y="${r1(Y(v)) + 4}" text-anchor="end" font-family="Arial" font-size="11" fill="#555">${Math.round(v * 100) / 100}</text>`;
      for (let t = 0; t <= tMax + 1e-9; t += xt) g += `<line x1="${r1(X(t))}" x2="${r1(X(t))}" y1="${top}" y2="${top + ph}" stroke="#eee"/><text x="${r1(X(t))}" y="${top + ph + 15}" text-anchor="middle" font-family="Arial" font-size="11" fill="#555">${Math.round(t)}ms</text>`;
      const line = (vals, dash) => `<polyline points="${vals.map((v, f) => `${r1(X(times[f]))},${r1(Y(v))}`).join(' ')}" fill="none" stroke="${c}" stroke-width="2"${dash ? ' stroke-dasharray="6 4"' : ''}/>`;
      g += line(s.vals, false);
      if (s.vals2) g += line(s.vals2, true);
      if (j < 2) for (const [f, v] of s.vals.entries()) g += `<circle cx="${r1(X(times[f]))}" cy="${r1(Y(v))}" r="1.8" fill="${c}"/>`;
      if (s.unit) g += `<text x="${x0 + pw - 4}" y="${top + 14}" text-anchor="end" font-family="Arial" font-size="11" fill="#777">${esc(s.unit)}</text>`;
    });
  });
  return { W, H, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}</svg>` };
}

async function renderHtml(browser, w, h, html, file) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: 'light' });
  const page = await context.newPage();
  await page.evaluate(async (markup) => {
    document.documentElement.style.background = '#fff';
    document.body.style.margin = '0';
    document.body.innerHTML = markup;
    await Promise.all([...document.images].map((i) => (i.decode ? i.decode().catch(() => {}) : null)));
    await new Promise((r) => setTimeout(r, 50));
  }, html);
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  await context.close();
}

async function renderMotionViews(browser, out, { tracks, times, fps, frameSize, dpr, bg }) {
  const long = Math.max(frameSize.w, frameSize.h);
  const scale = Math.min(1568 / long, Math.max(1, dpr));
  const p = pathsSvg({ tracks, fps, frameSize, scale });
  const img = exists(bg) ? `<img src="data:image/png;base64,${fs.readFileSync(bg).toString('base64')}" style="position:absolute;left:0;top:0;width:${p.W}px;height:${p.H}px;opacity:.45">` : '';
  const LEG = 28;
  const legend = `<div style="position:absolute;left:0;top:${p.H}px;width:${p.W}px;height:${LEG}px;background:#111;color:#fff;font:600 13px/28px Arial,sans-serif;padding:0 8px;box-sizing:border-box;white-space:nowrap;overflow:hidden">frame-judge motion paths · 1 dot per frame (${fps} fps) · ring every 500 ms · letter = first visible point, square = end</div>`;
  await renderHtml(browser, p.W, p.H + LEG, `<div style="position:relative;width:${p.W}px;height:${p.H + LEG}px;background:#fff">${img}${p.svg}${legend}</div>`, path.join(out, 'motion-paths.png'));
  const c = curvesSvg({ tracks, times });
  await renderHtml(browser, c.W, c.H, c.svg, path.join(out, 'motion-curves.png'));
}

function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

async function captureAnimation(browser, vp, o, cap) {
  const ms = Number(o.animate);
  const fps = Number(o.fps);
  if (!(ms > 0)) die('--animate needs a duration in milliseconds');
  if (!(fps > 0 && fps <= 120)) die('--fps must be between 1 and 120');
  const context = await browser.newContext(contextFor(vp, o));
  const page = await context.newPage();
  watch(page, cap.builder_only);
  const useClock = !o.noClock && Boolean(page.clock);
  if (!o.noClock && !page.clock) console.warn('capture-page: this Playwright has no page.clock (needs 1.45+), so JS-driven motion runs in real time');
  if (useClock) {
    const start = Date.UTC(2026, 0, 1);
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start + 60000);
  }
  await page.goto(o.url, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  if (useClock) await page.clock.runFor(0);

  let clip = null;
  if (o.selector) {
    const el = page.locator(o.selector).first();
    await el.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => die(`--selector "${o.selector}" not found`));
    const box = await el.boundingBox();
    if (!box) die(`--selector "${o.selector}" isn't visible`);
    const pad = Number(o.pad);
    const x = Math.max(0, Math.floor(box.x - pad));
    const y = Math.max(0, Math.floor(box.y - pad));
    clip = { x, y, width: Math.min(vp.width - x, Math.ceil(box.width + pad * 2)), height: Math.min(vp.height - y, Math.ceil(box.height + pad * 2)) };
  }

  const framesDir = path.join(o.out, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const total = Math.max(1, Math.round((ms / 1000) * fps));
  let tracking = o.track !== 'none';
  if (tracking) {
    const selectors = o.track === 'auto' ? null : o.track.split(',').map((s) => s.trim()).filter(Boolean);
    const count = await page.evaluate(setupTrack, { root: o.selector, selectors }).catch(() => 0);
    if (!count) { tracking = false; if (selectors) push(cap.builder_only.action_errors, `--track: no element matches ${o.track}`); }
  }
  const samples = [];
  const times = [];
  let prev = 0;
  let hooked = false;
  for (let i = 0; i < total; i++) {
    const t = Math.round((i * 1000) / fps);
    if (useClock && t > prev) await page.clock.runFor(t - prev);
    hooked = (await page.evaluate(seek, t)) || hooked;
    prev = t;
    await page.screenshot({ path: path.join(framesDir, `frame-${String(i).padStart(5, '0')}.png`), animations: 'allow', caret: 'hide', ...(clip ? { clip } : {}) });
    if (tracking) { samples.push(await page.evaluate(sampleTrack).catch(() => [])); times.push(t); }
    if ((i + 1) % 30 === 0 || i === total - 1) process.stdout.write(`\rcapture-page: frame ${i + 1}/${total}`);
  }
  process.stdout.write('\n');
  const tracks = tracking ? pickTracks(samples, times, clip) : [];
  if (tracks.length) {
    const sels = await page.evaluate(trackSelectors, tracks.map((tr) => tr.k)).catch(() => []);
    tracks.forEach((tr, i) => { if (cap.builder_only.tracks.length < MAX_TRACKS) cap.builder_only.tracks.push({ label: tr.label, selector: sels[i] || null }); });
  }
  await context.close();

  const area = clip ? `one element (${clip.width}×${clip.height} crop)` : describe(vp, o);
  cap.measurements.animation = {
    duration_ms: ms,
    fps,
    frames: total,
    area,
    capture_timing: useClock || hooked ? 'exact' : 'approximate (CSS exact, JS real time)',
  };
  if (tracking) {
    cap.measurements.animation.tracks = tracks.map((tr) => tr.metrics);
    if (!tracks.length) cap.measurements.animation.tracking = 'no page element moved, faded or resized (canvas or WebGL motion is not tracked)';
    else {
      const dpr = o.dpr || vp.dpr;
      const frameSize = { w: clip ? clip.width : vp.width, h: clip ? clip.height : vp.height };
      const bg = path.join(framesDir, `frame-${String(total - 1).padStart(5, '0')}.png`);
      try {
        await renderMotionViews(browser, o.out, { tracks, times, fps, frameSize, dpr, bg });
        cap.artifacts.push({ id: 'paths', file: 'motion-paths.png', type: 'motion_paths', shows: `the last frame (faded) with the path of each moving element drawn over it: one dot per captured frame at ${fps} fps, so dot spacing shows timing (even = constant speed, bunched = slowing). Letters ${tracks.map((tr) => tr.label).join(', ')} mark the first visible point of each path; a square marks the end. Ring every 500 ms.` });
        cap.artifacts.push({ id: 'curves', file: 'motion-curves.png', type: 'motion_graph', shows: `per moving element (${tracks.map((tr) => tr.label).join(', ')}): distance travelled from its start (px) over time, speed (px/s) over time, and opacity and scale over time, measured every frame. Flat speed = linear motion; spikes = pops.` });
      } catch (e) {
        push(cap.builder_only.action_errors, `motion views: ${String(e.message).split('\n')[0]}`);
      }
    }
  }

  const mp4 = path.resolve(o.encode ? String(o.encode) : path.join(o.out, 'animation.mp4'));
  let encoded = false;
  if (hasFfmpeg()) {
    fs.mkdirSync(path.dirname(mp4), { recursive: true });
    const r = spawnSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps),
      '-i', path.join(framesDir, 'frame-%05d.png'),
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'medium', '-movflags', '+faststart', mp4,
    ], { encoding: 'utf8' });
    encoded = r.status === 0;
    if (!encoded) console.warn(`capture-page: ffmpeg encode failed: ${String(r.stderr).trim().split('\n').pop()}`);
  } else {
    console.warn('capture-page: ffmpeg not found, so frames are kept but there is no MP4');
  }

  if (encoded) {
    cap.artifacts.push({ id: 'animation', file: path.relative(o.out, mp4), type: 'video', shows: `the captured animation: ${ms} ms at ${fps} fps, ${area}` });
    console.log(`capture-page: wrote ${mp4}`);
    console.log(`next: node "${path.join(SCRIPT_DIR, 'video-frames.mjs')}" "${mp4}" --out "${path.join(o.out, 'views')}" --as motion`);
  } else {
    const picks = [...new Set([0, Math.floor((total - 1) / 2), total - 1])];
    for (const i of picks) {
      const t = Math.round((i * 1000) / fps);
      cap.artifacts.push({ id: `frame-${i}`, file: `frames/frame-${String(i).padStart(5, '0')}.png`, type: 'frame', t: t / 1000, shows: `single animation frame at t=${t / 1000}s, ${area}` });
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args._[0]) { console.log(HELP); process.exit(args.help ? 0 : 1); }

const colorScheme = args.dark ? 'dark' : String(one(args['color-scheme']) || 'light');
if (!['light', 'dark', 'no-preference'].includes(colorScheme)) die('--color-scheme must be light, dark or no-preference');
const o = {
  url: resolveTarget(String(args._[0])),
  out: path.resolve(String(one(args.out) || die('--out <dir> is required'))),
  viewports: parseViewports(one(args.viewports) || 'desktop,tablet,mobile'),
  slices: args.slices !== undefined ? Math.max(1, parseInt(one(args.slices), 10) || 1) : 6,
  wait: args.wait !== undefined ? Math.max(0, Number(one(args.wait)) || 0) : 500,
  dpr: args.dpr !== undefined ? Number(one(args.dpr)) : null,
  colorScheme,
  reducedMotion: args['reduced-motion'] ? 'reduce' : 'no-preference',
  liveAnimations: Boolean(args['live-animations']),
  animate: args.animate !== undefined ? one(args.animate) : null,
  fps: args.fps !== undefined ? one(args.fps) : 30,
  selector: args.selector ? String(one(args.selector)) : null,
  pad: args.pad !== undefined ? one(args.pad) : 32,
  encode: args.encode && args.encode !== true ? String(one(args.encode)) : null,
  noClock: Boolean(args['no-clock']),
  audit: !args['no-audit'],
  track: args.track !== undefined && args.track !== true ? String(one(args.track)) : 'auto',
  zooms: [].concat(args.zoom ?? []).filter((z) => z !== true).map((z) => {
    const m = String(z).match(/^\s*([^@]+)@(\d+(?:\.\d+)?):\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*$/);
    if (!m) die(`bad --zoom "${z}". Use VIEWPORT@SCROLLY:x,y,w,h with the box in fractions, e.g. mobile@844:0.6,0,0.4,0.1`);
    const box = m.slice(3).map(Number);
    if (box.some((n) => n < 0 || n > 1) || !(box[2] > 0 && box[3] > 0)) die(`--zoom "${z}": the box must be fractions from 0 to 1`);
    return { vp: parseViewports(m[1].trim())[0], y: Math.round(Number(m[2])), box };
  }),
  zoomDpr: args['zoom-dpr'] !== undefined ? Math.min(4, Math.max(1, Number(one(args['zoom-dpr'])) || 3)) : 3,
  actions: null,
};
if (args.actions) {
  const file = path.resolve(String(one(args.actions)));
  if (!exists(file)) die(`actions file not found: ${file}`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { die(`actions file isn't valid JSON: ${e.message}`); }
  o.actions = Array.isArray(parsed) ? parsed : parsed && parsed.steps;
  if (!Array.isArray(o.actions)) die('the actions file must be a JSON array of steps');
}
fs.mkdirSync(o.out, { recursive: true });

let pw = args.cdp ? null : loadPlaywright();
if (!pw) {
  // No Playwright: drive an installed Chrome / Edge / Chromium / Brave over DevTools instead (scripts/cdp.mjs).
  const cdp = await import(pathToFileURL(path.join(SCRIPT_DIR, 'cdp.mjs')).href);
  const exe = cdp.findBrowser(args.browser ? String(one(args.browser)) : null);
  if (exe && typeof WebSocket === 'function') {
    pw = cdp.playwrightLike(exe);
    console.log(`capture-page: ${args.cdp ? '--cdp' : 'Playwright not found'}, so using your installed browser over DevTools: ${exe}`);
  } else {
    die(exe
      ? `Playwright not found, and capturing with your installed browser needs Node 22+ (this is ${process.versions.node}). Upgrade Node, or install Playwright: npm i -D playwright && npx playwright install chromium`
      : 'no browser to capture with. Install Chrome, Edge or Chromium (or pass --browser /path/to/chrome), or install Playwright: npm i -D playwright && npx playwright install chromium');
  }
}

const cap = {
  tool: 'capture-page',
  version: 1,
  source: String(args._[0]),
  url: o.url,
  kind_hint: o.animate ? 'motion' : 'frontend',
  created_at: new Date().toISOString(),
  measurements: {},
  artifacts: [],
  builder_only: { console_errors: [], page_errors: [], failed_requests: [], action_errors: [], audit: [], tracks: [] },
};

const browser = await launch(pw, args.channel ? String(one(args.channel)) : null);
try {
  if (o.zooms.length) await captureZooms(browser, o, cap);
  else if (o.animate) await captureAnimation(browser, o.viewports[0], o, cap);
  else for (const vp of o.viewports) await captureViewport(browser, vp, o, cap);
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(o.out, 'capture.json'), JSON.stringify(cap, null, 2) + '\n');

console.log(`capture-page: ${cap.artifacts.length} artifact(s) in ${o.out}`);
for (const [name, m] of Object.entries(cap.measurements)) {
  if (name === 'animation') {
    console.log(`  animation: ${m.frames} frames, ${m.capture_timing}`);
    if (m.tracks) console.log(`  tracked: ${m.tracks.length ? m.tracks.map((t) => `${t.label} (path ${t.path_px}px, peak ${t.peak_speed_px_s}px/s${t.jumps_at_ms.length ? `, jumps at ${t.jumps_at_ms.join('/')}ms` : ''})`).join(' · ') : m.tracking}`);
  } else {
    const a = m.audit;
    console.log(`  ${name}: ${m.captured_screens}/${m.screens} screens · overflow ${m.horizontal_overflow_px}px · broken images ${m.broken_images}${a ? ` · audit: ${a.low_contrast_text} low contrast, ${a.small_touch_targets} small targets, ${a.cut_off_text} cut off, ${a.past_viewport_edge} past edge` : ''}`);
  }
}
if (cap.builder_only.audit.length) {
  console.log('  audit details (builder-only, with selectors):');
  for (const x of cap.builder_only.audit.slice(0, 10)) console.log(`    - ${x.viewport} screen ${x.screen}: ${x.kind} ${x.value}  ${x.selector}`);
  if (cap.builder_only.audit.length > 10) console.log(`    … ${cap.builder_only.audit.length - 10} more in capture.json`);
}
if (cap.builder_only.tracks.length) console.log(`  tracks (builder-only): ${cap.builder_only.tracks.map((t) => `${t.label} = ${t.selector}`).join(' · ')}`);
const b = cap.builder_only;
const problems = b.console_errors.length + b.page_errors.length + b.failed_requests.length + b.action_errors.length;
if (problems) {
  console.log(`  builder-only: ${b.console_errors.length} console error(s), ${b.page_errors.length} page error(s), ${b.failed_requests.length} failed request(s), ${b.action_errors.length} action error(s). Fix these before spending a critic round:`);
  for (const line of [...b.page_errors, ...b.console_errors, ...b.failed_requests, ...b.action_errors].slice(0, 8)) console.log(`    - ${line}`);
}

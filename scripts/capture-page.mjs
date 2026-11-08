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

Animation (first viewport only)
  --animate <ms> --fps 30             frame-exact capture, encoded to <out>/animation.mp4
  --selector <css> --pad 32           clip to one element (box measured at t=0)
  --encode <file.mp4>                 write the MP4 somewhere else
  --no-clock                          skip the fake clock if the page breaks under it`;

const PRESETS = {
  desktop: { width: 1440, height: 900, dpr: 1, mobile: false, touch: false },
  laptop: { width: 1280, height: 800, dpr: 1, mobile: false, touch: false },
  tablet: { width: 768, height: 1024, dpr: 1, mobile: false, touch: true },
  mobile: { width: 390, height: 844, dpr: 2, mobile: true, touch: true },
};
const BOOLEAN_FLAGS = new Set(['dark', 'reduced-motion', 'live-animations', 'no-clock', 'help', 'cdp']);
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
  let s = `${vp.name} ${vp.width}×${vp.height}${dpr > 1 ? ` @${dpr}x` : ''}`;
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
    vh: window.innerHeight,
    vw: window.innerWidth,
    sw: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
    broken: [...document.images].filter((img) => img.complete && img.naturalWidth === 0 && img.currentSrc).length,
  }));
  const screens = Math.max(1, Math.ceil(m.height / m.vh));
  const n = Math.min(screens, o.slices);
  const label = describe(vp, o);
  for (let i = 0; i < n; i++) {
    const y = i === n - 1 && n === screens && screens > 1 ? m.height - m.vh : i * m.vh;
    await scrollTo(page, y);
    await page.waitForTimeout(350);
    await settle(page, 0);
    const id = `${vp.name}-${i + 1}`;
    await page.screenshot({ path: path.join(o.out, `${id}.png`), animations: o.liveAnimations ? 'allow' : 'disabled', caret: 'hide' });
    cap.artifacts.push({ id, file: `${id}.png`, type: 'viewport', viewport: vp.name, shows: `${label}, screen ${i + 1} of ${screens} (scrolled to y=${Math.round(y)}px)` });
  }
  cap.measurements[vp.name] = {
    viewport: label,
    page_height_px: m.height,
    screens,
    captured_screens: n,
    horizontal_overflow_px: Math.max(0, m.sw - m.vw),
    broken_images: m.broken,
  };
  if (o.actions) await runActions(page, vp, o, cap, label);
  await context.close();
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
  let prev = 0;
  let hooked = false;
  for (let i = 0; i < total; i++) {
    const t = Math.round((i * 1000) / fps);
    if (useClock && t > prev) await page.clock.runFor(t - prev);
    hooked = (await page.evaluate(seek, t)) || hooked;
    prev = t;
    await page.screenshot({ path: path.join(framesDir, `frame-${String(i).padStart(5, '0')}.png`), animations: 'allow', caret: 'hide', ...(clip ? { clip } : {}) });
    if ((i + 1) % 30 === 0 || i === total - 1) process.stdout.write(`\rcapture-page: frame ${i + 1}/${total}`);
  }
  process.stdout.write('\n');
  await context.close();

  const area = clip ? `one element (${clip.width}×${clip.height} crop)` : describe(vp, o);
  cap.measurements.animation = {
    duration_ms: ms,
    fps,
    frames: total,
    area,
    capture_timing: useClock || hooked ? 'exact' : 'approximate (CSS exact, JS real time)',
  };

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
  kind_hint: o.animate ? 'motion' : 'frontend',
  created_at: new Date().toISOString(),
  measurements: {},
  artifacts: [],
  builder_only: { console_errors: [], page_errors: [], failed_requests: [], action_errors: [] },
};

const browser = await launch(pw, args.channel ? String(one(args.channel)) : null);
try {
  if (o.animate) await captureAnimation(browser, o.viewports[0], o, cap);
  else for (const vp of o.viewports) await captureViewport(browser, vp, o, cap);
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(o.out, 'capture.json'), JSON.stringify(cap, null, 2) + '\n');

console.log(`capture-page: ${cap.artifacts.length} artifact(s) in ${o.out}`);
for (const [name, m] of Object.entries(cap.measurements)) {
  if (name === 'animation') console.log(`  animation: ${m.frames} frames, ${m.capture_timing}`);
  else console.log(`  ${name}: ${m.captured_screens}/${m.screens} screens · overflow ${m.horizontal_overflow_px}px · broken images ${m.broken_images}`);
}
const b = cap.builder_only;
const problems = b.console_errors.length + b.page_errors.length + b.failed_requests.length + b.action_errors.length;
if (problems) {
  console.log(`  builder-only: ${b.console_errors.length} console error(s), ${b.page_errors.length} page error(s), ${b.failed_requests.length} failed request(s), ${b.action_errors.length} action error(s). Fix these before spending a critic round:`);
  for (const line of [...b.page_errors, ...b.console_errors, ...b.failed_requests, ...b.action_errors].slice(0, 8)) console.log(`    - ${line}`);
}

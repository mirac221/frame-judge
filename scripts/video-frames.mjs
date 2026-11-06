import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HELP = `video-frames.mjs <video> --out <dir> [options]

  --as video|motion     rubric hint (motion also defaults to 2 keyframes instead of 4)
  --overview 16         tiles in the contact sheet (0 skips it)
  --keyframes N         full-detail single frames, long edge capped at 1568px
  --motion a-b          seconds to cut into filmstrips + a motion trail; repeatable
                        (default: the whole clip when it is 6 s or shorter)
  --motion-fps 12       filmstrip sample rate, or "source" for every frame (capped at the source fps)
  --events 2            auto-detect up to N sudden jumps/stalls and add full-rate strips around them (0 = off)
  --cols 4 --rows 3     filmstrip grid
  --width 1536          sheet width in px
  --diffs               also write frame-difference strips
  --no-detect           skip black / freeze / scene-change detection
  --no-labels           don't burn timestamps into tiles`;

const BOOLEAN_FLAGS = new Set(['diffs', 'no-detect', 'no-labels', 'help']);
const LONG_EDGE = 1568;
const PAD = 6;
const FONTS = [
  'C:/Windows/Fonts/consola.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/System/Library/Fonts/Menlo.ttc',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/TTF/DejaVuSansMono.ttf',
  '/usr/share/fonts/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
  '/usr/share/fonts/liberation-mono/LiberationMono-Regular.ttf',
  '/usr/share/fonts/noto/NotoSansMono-Regular.ttf',
];

const die = (msg) => { console.error(`video-frames: ${msg}`); process.exit(1); };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
const fx = (n, d = 3) => Number(Number(n).toFixed(d));
const tail = (s) => String(s || '').trim().split('\n').slice(-3).join(' | ');
const vf = (...parts) => parts.filter(Boolean).join(',');
const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 28 });

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

function must(bin, args, what) {
  const r = run(bin, args);
  if (r.error) die(`${bin} not found on PATH`);
  if (r.status !== 0) die(`${what} failed: ${tail(r.stderr)}`);
  return r;
}

const font = (() => {
  const env = process.env.FRAME_JUDGE_FONT;
  if (env && exists(env)) return env;
  return FONTS.find(exists) || null;
})();
let labels = false;

const fontPath = () => font.replace(/\\/g, '/').replace(/:/g, '\\:');
const label = (text, size) => {
  const band = size + 12;
  return `pad=iw:ih+${band}:0:${band}:color=0x101010,drawtext=fontfile='${fontPath()}':text='${text}':x=8:y=(${band}-th)/2:fontsize=${size}:fontcolor=white`;
};

function ff(build, what) {
  let r = run('ffmpeg', build(labels));
  if (r.error) die('ffmpeg not found on PATH');
  if (r.status !== 0 && labels && /drawtext|font/i.test(r.stderr)) {
    console.warn(`video-frames: drawtext failed (${tail(r.stderr)}), continuing without burned-in labels`);
    labels = false;
    r = run('ffmpeg', build(false));
  }
  if (r.status !== 0) die(`${what} failed: ${tail(r.stderr)}`);
  return r;
}

function decodedDuration(file) {
  const r = run('ffmpeg', ['-hide_banner', '-i', file, '-map', '0:v:0', '-f', 'null', '-']);
  const times = [...String(r.stderr).matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (!times.length) return 0;
  const [, h, m, s] = times[times.length - 1];
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function probe(file) {
  const j = JSON.parse(must('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 'ffprobe').stdout);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v) die('no video stream in the input');
  const a = streams.find((s) => s.codec_type === 'audio');
  const rate = (s) => { const [n, d] = String(s || '0/1').split('/').map(Number); return d ? n / d : n || 0; };
  let fps = rate(v.avg_frame_rate);
  if (!(fps > 0 && fps <= 240)) fps = rate(v.r_frame_rate);
  if (!(fps > 0 && fps <= 240)) fps = 30;
  let duration = Number(v.duration || (j.format && j.format.duration) || 0);
  if (!(duration > 0)) duration = decodedDuration(file);
  let width = v.width;
  let height = v.height;
  const rotation = Math.abs(Number((v.tags && v.tags.rotate) || ((v.side_data_list || []).find((d) => d.rotation !== undefined) || {}).rotation || 0));
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  return {
    duration,
    fps,
    width,
    height,
    frames: Number(v.nb_frames) || Math.round(duration * fps),
    codec: v.codec_name,
    pix_fmt: v.pix_fmt,
    audio: a ? { codec: a.codec_name, channels: a.channels, sample_rate: Number(a.sample_rate) } : null,
  };
}

function spread(n, meta) {
  const last = Math.max(0, meta.duration - 1 / meta.fps);
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => fx((i * last) / (n - 1)));
}

function tileWidth(width, cols) {
  const w = Math.floor((width - PAD * 2 - PAD * (cols - 1)) / cols);
  return w - (w % 2);
}

function grab(input, t, dest, filters, meta) {
  const attempt = (time) => ff((L) => {
    const chain = filters(L);
    return ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', input, '-frames:v', '1', '-update', '1', ...(chain ? ['-vf', chain] : []), dest];
  }, 'frame grab');
  attempt(t);
  if (!exists(dest)) attempt(Math.max(0, t - 2 / meta.fps));
  if (!exists(dest)) die(`could not grab a frame at t=${t}s`);
}

function clearPrefix(dir, prefix) {
  for (const f of fs.readdirSync(dir)) if (f.startsWith(prefix) && f.endsWith('.png')) fs.rmSync(path.join(dir, f));
}

function overview(input, meta, o, cap) {
  const n = Math.min(o.overview, Math.max(1, meta.frames));
  const times = spread(n, meta);
  const tw = tileWidth(o.width, o.cols);
  const size = Math.max(14, Math.round(tw / 16));
  const tmp = path.join(o.out, '.overview-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  times.forEach((t, i) => grab(input, t, path.join(tmp, `ov-${String(i).padStart(3, '0')}.png`), (L) => vf(`scale=${tw}:-2`, L && label(`t=${t.toFixed(2)}s`, size)), meta));
  must('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-framerate', '1', '-start_number', '0', '-i', path.join(tmp, 'ov-%03d.png'),
    '-vf', `tile=${o.cols}x${Math.ceil(n / o.cols)}:padding=${PAD}:margin=${PAD}:color=white`, '-frames:v', '1', path.join(o.out, 'sheet-overview.png'),
  ], 'contact sheet');
  fs.rmSync(tmp, { recursive: true, force: true });
  cap.artifacts.push({
    id: 'overview',
    file: 'sheet-overview.png',
    type: 'contact_sheet',
    shows: `${n} frames evenly spaced across the whole clip (t=0 to ${times[times.length - 1]}s), read left to right, top to bottom${labels ? '; each tile is stamped with its time' : '; tile times are in tiles[]'}`,
    tiles: times.map((t, i) => ({ tile: i + 1, t })),
  });
}

function keyframes(input, meta, o, cap) {
  const scale = meta.width >= meta.height ? `scale=${Math.min(LONG_EDGE, meta.width)}:-2` : `scale=-2:${Math.min(LONG_EDGE, meta.height)}`;
  spread(o.keyframes, meta).forEach((t, i) => {
    const id = `key-${i + 1}`;
    grab(input, t, path.join(o.out, `${id}.png`), (L) => vf(scale, L && label(`t=${t.toFixed(3)}s`, 24)), meta);
    cap.artifacts.push({ id, file: `${id}.png`, type: 'frame', t, shows: `single frame at t=${t}s, full detail (long edge up to ${LONG_EDGE}px)` });
  });
}

const sampling = (mf, meta) => {
  const step = meta.fps / mf;
  return step <= 1.05 ? `every frame of the ${fx(meta.fps, 2)} fps source` : `sampled at ${fx(mf, 2)} fps from a ${fx(meta.fps, 2)} fps source (about 1 frame in ${fx(step, 1)}, so very short events can fall between tiles)`;
};

function motionEvents(input, meta, limit) {
  const r = run('ffmpeg', ['-hide_banner', '-nostats', '-i', input, '-map', '0:v:0', '-vf', 'format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']);
  const points = [];
  let t = null;
  for (const line of String(r.stderr || '').split('\n')) {
    const pt = line.match(/pts_time:\s*([\d.]+)/);
    if (pt) { t = Number(pt[1]); continue; }
    const v = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (v && t !== null) { points.push({ t, v: Number(v[1]) }); t = null; }
  }
  if (points.length < 8) return [];
  const sorted = points.map((p) => p.v).sort((x, y) => x - y);
  const floor = Math.max(0.3, sorted[Math.floor(sorted.length / 2)] * 0.5);
  const found = [];
  points.forEach((p, i) => {
    const near = points.slice(Math.max(0, i - 4), i + 5).filter((_, j) => j !== Math.min(i, 4));
    const local = near.reduce((s, x) => s + x.v, 0) / near.length;
    if (p.v > floor && p.v > 2.5 * local) found.push({ t: fx(p.t), kind: 'jump', strength: fx(p.v / Math.max(local, 0.01), 1) });
    else if (local > floor && p.v < 0.15 * local) found.push({ t: fx(p.t), kind: 'stall', strength: fx(local / Math.max(p.v, 0.01), 1) });
  });
  const picked = [];
  for (const e of found.sort((x, y) => y.strength - x.strength)) {
    if (picked.length >= limit) break;
    if (picked.every((q) => Math.abs(q.t - e.t) > 0.5)) picked.push(e);
  }
  return picked.sort((x, y) => x.t - y.t);
}

function strips(input, meta, o, cap, [a, b], prefix, filters, type, describe, shift = 0, rate = null) {
  const d = fx(b - a);
  const mf = rate || Math.min(o.motionFps, meta.fps);
  const tw = tileWidth(o.width, o.cols);
  const size = Math.max(14, Math.round(tw / 16));
  const per = o.cols * o.rows;
  clearPrefix(o.out, `${prefix}-`);
  ff((L) => [
    '-y', '-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(d), '-i', input,
    '-vf', vf(`fps=${mf}`, ...filters, `scale=${tw}:-2`, L && label(`%{eif\\:(t+${a})*1000\\:d}ms`, size), `tile=${o.cols}x${o.rows}:padding=${PAD}:margin=${PAD}:color=white`),
    '-start_number', '1', path.join(o.out, `${prefix}-%02d.png`),
  ], type);
  const count = Math.max(1, Math.round(d * mf) - shift);
  const files = fs.readdirSync(o.out).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.png')).sort();
  files.forEach((file, s) => {
    const tiles = [];
    for (let k = 0; k < per; k++) {
      const j = s * per + k;
      if (j >= count) break;
      tiles.push({ tile: k + 1, t: fx(a + (j + shift) / mf) });
    }
    if (!tiles.length) { fs.rmSync(path.join(o.out, file)); return; }
    cap.artifacts.push({
      id: path.basename(file, '.png'),
      file,
      type,
      window: [a, b],
      shows: `${describe(sampling(mf, meta))}, t=${tiles[0].t}s to ${tiles[tiles.length - 1].t}s (${tiles.length} tiles), read left to right, top to bottom${labels ? '; tiles stamped in ms' : ''}`,
      tiles,
    });
  });
}

function trail(input, meta, o, cap, [a, b], n) {
  const d = fx(b - a);
  const frames = Math.min(8, Math.max(2, Math.round(d * Math.min(o.motionFps, meta.fps))));
  const width = Math.min(o.width, meta.width);
  const file = `trail-${n}.png`;
  ff((L) => [
    '-y', '-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(d), '-i', input,
    '-vf', vf(`fps=${fx(frames / d, 4)}`, `scale=${width - (width % 2)}:-2`, `tmix=frames=${frames}`, L && label(`trail ${a.toFixed(2)}-${b.toFixed(2)}s (${frames} frames)`, 20)),
    '-update', '1', path.join(o.out, file),
  ], 'motion trail');
  cap.artifacts.push({
    id: `trail-${n}`,
    file,
    type: 'motion_trail',
    window: [a, b],
    shows: `${frames} frames from t=${a}s to ${b}s averaged into one image: anything still stays sharp, anything moving leaves faint ghosts along its path`,
  });
}

function detect(input, meta) {
  const r = run('ffmpeg', ['-hide_banner', '-nostats', '-i', input, '-map', '0:v:0', '-vf', "blackdetect=d=0.1:pix_th=0.10,freezedetect=n=-60dB:d=0.5,select='gt(scene,0.30)',showinfo", '-f', 'null', '-']);
  const err = String(r.stderr || '');
  const starts = [...err.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...err.matchAll(/freeze_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  return {
    black_segments: [...err.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)].map((m) => [fx(m[1]), fx(m[2])]),
    freeze_segments: starts.map((s, i) => [fx(s), fx(ends[i] ?? meta.duration)]),
    scene_changes_s: [...err.matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*([\d.]+)/g)].map((m) => fx(m[1])),
  };
}

function audio(input, meta) {
  if (!meta.audio) return { present: false };
  const r = run('ffmpeg', ['-hide_banner', '-nostats', '-i', input, '-map', '0:a:0', '-af', 'silencedetect=n=-50dB:d=0.5,ebur128=framelog=quiet', '-f', 'null', '-']);
  const err = String(r.stderr || '');
  const starts = [...err.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Math.max(0, Number(m[1])));
  const ends = [...err.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const lufs = [...err.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
  return {
    present: true,
    ...meta.audio,
    integrated_lufs: lufs ? Number(lufs[1]) : null,
    silences: starts.map((s, i) => [fx(s), fx(ends[i] ?? meta.duration)]),
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args._[0]) { console.log(HELP); process.exit(args.help ? 0 : 1); }

const input = path.resolve(String(args._[0]));
if (!exists(input)) die(`not found: ${args._[0]}`);
const as = String(one(args.as) || 'video');
if (!['video', 'motion'].includes(as)) die('--as must be video or motion');
const int = (v, fallback, min) => {
  if (v === undefined || v === true) return fallback;
  const n = parseInt(one(v), 10);
  if (!Number.isFinite(n) || n < min) die(`expected a whole number ≥ ${min}, got "${one(v)}"`);
  return n;
};
const o = {
  out: path.resolve(String(one(args.out) || die('--out <dir> is required'))),
  overview: int(args.overview, 16, 0),
  keyframes: int(args.keyframes, as === 'motion' ? 2 : 4, 0),
  cols: int(args.cols, 4, 1),
  rows: int(args.rows, 3, 1),
  width: int(args.width, 1536, 320),
  motionFps: Number(one(args['motion-fps'])) > 0 ? Number(one(args['motion-fps'])) : 12,
  events: int(args.events, 2, 0),
};
fs.mkdirSync(o.out, { recursive: true });
labels = !args['no-labels'] && Boolean(font);

const meta = probe(input);
if (!(meta.duration > 0)) die('could not work out the clip duration');
if (/^(source|full)$/i.test(String(one(args['motion-fps']) ?? ''))) o.motionFps = meta.fps;

const windows = [];
for (const w of [].concat(args.motion ?? []).filter((x) => x !== true)) {
  const m = String(w).match(/^\s*(\d+(?:\.\d+)?)\s*[-:]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) die(`bad --motion "${w}". Use start-end in seconds, e.g. 0.5-2`);
  const a = Number(m[1]);
  const b = Math.min(Number(m[2]), meta.duration);
  if (!(b > a)) die(`--motion ${w} is empty or outside the clip (duration ${fx(meta.duration, 2)}s)`);
  windows.push([a, fx(b)]);
}
if (!windows.length && meta.duration <= 6.0001) windows.push([0, fx(meta.duration)]);

const cap = {
  tool: 'video-frames',
  version: 1,
  source: input,
  kind_hint: as,
  created_at: new Date().toISOString(),
  measurements: {},
  artifacts: [],
};

if (o.overview > 0) overview(input, meta, o, cap);
if (o.keyframes > 0) keyframes(input, meta, o, cap);
windows.forEach((w, i) => {
  strips(input, meta, o, cap, w, `strip-${i + 1}`, [], 'filmstrip', (s) => `frames ${s}`);
  trail(input, meta, o, cap, w, i + 1);
  if (args.diffs) {
    strips(input, meta, o, cap, w, `diff-${i + 1}`, ['format=gray', 'tblend=all_mode=difference', "lut=c0='min(val*4,255)'"], 'diff_strip',
      (s) => `frame-to-frame differences, ${s} (bright = changed since the previous frame, black = unchanged)`, 1);
  }
});

const events = o.events > 0 ? motionEvents(input, meta, o.events) : [];
events.forEach((e, i) => {
  const half = 6 / meta.fps;
  const a = fx(Math.max(0, e.t - half));
  const b = fx(Math.min(meta.duration, e.t + half));
  strips(input, meta, o, cap, [a, b], `dense-${i + 1}`, [], 'filmstrip',
    (s) => `${s}, centred on a sudden motion ${e.kind === 'jump' ? 'jump (possible pop or teleport)' : 'stall (possible dropped or repeated frame)'} detected at t=${e.t}s; may be intentional`, 0, meta.fps);
});

cap.measurements = {
  duration_s: fx(meta.duration),
  fps: fx(meta.fps),
  width: meta.width,
  height: meta.height,
  frames: meta.frames,
  codec: meta.codec,
  pix_fmt: meta.pix_fmt,
  audio: audio(input, meta),
  ...(args['no-detect'] ? {} : detect(input, meta)),
  motion_events: events,
};
cap.artifacts.push({
  id: 'video',
  file: input,
  type: 'video',
  shows: `the full clip (${meta.codec}, ${meta.width}×${meta.height}, ${fx(meta.fps, 2)} fps, ${fx(meta.duration, 2)}s, ${meta.audio ? 'with audio' : 'no audio'}). Open it only if you can actually watch video.`,
});
fs.writeFileSync(path.join(o.out, 'capture.json'), JSON.stringify(cap, null, 2) + '\n');

const images = cap.artifacts.filter((x) => x.type !== 'video').length;
const m = cap.measurements;
console.log(`video-frames: ${images} image(s) in ${o.out} (${labels ? 'timestamps burned in' : 'no burned-in labels'})`);
console.log(`  ${m.width}×${m.height} · ${m.fps} fps · ${m.duration_s}s · ${m.frames} frames · audio: ${m.audio.present ? `${m.audio.codec}${m.audio.integrated_lufs !== null ? `, ${m.audio.integrated_lufs} LUFS` : ''}` : 'none'}`);
if (m.black_segments) console.log(`  black: ${m.black_segments.length} · frozen: ${m.freeze_segments.length} · scene changes: ${m.scene_changes_s.length}`);
if (!windows.length) console.log('  clip is longer than 6s: add --motion a-b windows to get frame-by-frame filmstrips where it matters');

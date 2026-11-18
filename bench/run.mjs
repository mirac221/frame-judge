// Seeded-defect benchmark: small pages and animations with known, planted problems (plus clean controls),
// run through the real pipeline: capture, bundle, a sandboxed critic, the gate. It reports which planted
// defects the gate turned into must-fix or verify items, and how many must-fix items the clean controls got.
//
//   node bench/run.mjs                       every case, critic-sandbox with the claude CLI, model sonnet
//   node bench/run.mjs --cases low-contrast,linear-easing --model haiku
//   node bench/run.mjs --runner agy --model claude-sonnet-4-6
//   node bench/run.mjs --dry                 capture and bundle only (no critic, no model usage)
//   node bench/run.mjs --score               re-score the last run without running anything
//
// The critic runs use your Claude plan (or agy's quota): about one critic review per case.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'scripts');
const CASES = path.join(HERE, 'cases');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const out = path.resolve(opt('out', path.join(HERE, '.out')));
const model = opt('model', 'sonnet');
const runner = opt('runner', 'claude');
const bar = opt('bar', '3');
const dry = flag('dry');
const scoreOnly = flag('score');
const only = opt('cases', '').split(',').map((s) => s.trim()).filter(Boolean);
const names = fs.readdirSync(CASES).filter((d) => fs.existsSync(path.join(CASES, d, 'case.json')) && (!only.length || only.includes(d)));
if (!names.length) { console.error(`bench: no cases${only.length ? ` matching ${only.join(', ')}` : ''}`); process.exit(1); }

const node = (script, args, cwd) => {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const must = (r, what) => { if (!r.ok) throw new Error(`${what} failed:\n${r.out.trim().split('\n').slice(-6).join('\n')}`); return r; };

function runCase(name) {
  const c = JSON.parse(fs.readFileSync(path.join(CASES, name, 'case.json'), 'utf8'));
  const dir = path.join(out, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const state = path.join(dir, '.frame-judge');
  const pagePath = path.join(CASES, name, 'page.html');
  must(node('judge.mjs', ['init', '--dir', state, '--brief', c.brief, '--kind', c.kind === 'motion' ? 'motion' : 'frontend', '--critic-model', model, '--bar', bar], dir), 'init');
  const sources = [];
  if (c.kind === 'motion') {
    const anim = path.join(dir, 'cap', 'anim');
    must(node('capture-page.mjs', [pagePath, '--out', anim, '--animate', String(c.animate || 2000), '--fps', '30', ...(c.selector ? ['--selector', c.selector] : []), ...(c.viewports ? ['--viewports', c.viewports] : [])], dir), 'animation capture');
    const views = path.join(dir, 'cap', 'views');
    must(node('video-frames.mjs', [path.join(anim, 'animation.mp4'), '--out', views, '--as', 'motion'], dir), 'video-frames');
    sources.push(anim, views);
  } else {
    const pg = path.join(dir, 'cap', 'page');
    must(node('capture-page.mjs', [pagePath, '--out', pg, '--slices', '3', ...(c.viewports ? ['--viewports', c.viewports] : [])], dir), 'page capture');
    sources.push(pg);
  }
  const b = must(node('judge.mjs', ['bundle', '--dir', state, ...sources], dir), 'bundle');
  const images = Number((b.out.match(/\((\d+) images\)/) || [])[1] || 0);
  if (dry) return { name, images, dry: true };
  const crit = node('critic-sandbox.mjs', ['--dir', state, '--runner', runner, '--model', model], dir);
  fs.writeFileSync(path.join(dir, 'critic.log'), crit.out);
  return { name, images };
}

const textOf = (f) => [f.criterion, f.kind, f.observation, f.problem, f.fix, f.brief_quote].filter(Boolean).join(' ');
function score(name) {
  const c = JSON.parse(fs.readFileSync(path.join(CASES, name, 'case.json'), 'utf8'));
  const dir = path.join(out, name, '.frame-judge');
  const ledgerPath = path.join(dir, 'ledger.json');
  if (!fs.existsSync(ledgerPath)) return { name, status: 'not run' };
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const last = ledger.rounds[ledger.rounds.length - 1];
  const gp = last && path.join(dir, `round-${last.round}`, 'gate.json');
  if (!gp || !fs.existsSync(gp)) return { name, status: last && last.gated_at ? last.decision : 'no review' };
  const g = JSON.parse(fs.readFileSync(gp, 'utf8'));
  if (!g.buckets) return { name, status: g.decision };
  const strong = [...g.buckets.must_fix, ...g.buckets.verify];
  const weak = [...g.buckets.polish, ...(g.elevate || []).map((e) => ({ criterion: e.criterion, observation: e.change, problem: e.why }))];
  const unmet = (g.asks || []).filter((a) => !['met', 'not_visual'].includes(a.status)).map((a) => ({ kind: 'missing', brief_quote: a.quote, observation: a.note }));
  const hit = (d, list) => list.some((f) => {
    const re = new RegExp(d.text, 'i');
    const kindOk = !d.kinds || d.kinds.includes(f.kind);
    return kindOk && re.test(textOf(f));
  });
  const defects = c.defects.map((d) => ({ id: d.id, result: hit(d, [...strong, ...unmet]) ? 'caught' : hit(d, weak) ? 'weak' : 'missed' }));
  return {
    name, status: g.decision, control: Boolean(c.control), defects,
    must_fix: g.buckets.must_fix.length, lifts: g.buckets.must_fix.filter((f) => f.from_lift).length,
    coverage: g.counts && g.counts.coverage, scores: (g.scores || []).map((s) => `${s.criterion} ${s.score}`).join(', '),
  };
}

if (!scoreOnly) {
  fs.mkdirSync(out, { recursive: true });
  console.log(`bench: ${names.length} case(s)${dry ? ', capture and bundle only' : `, critic ${runner}/${model}, bar ${bar}`} → ${out}`);
  for (const n of names) {
    const t0 = Date.now();
    try {
      const r = runCase(n);
      console.log(`  ${n}: ${r.dry ? `bundled, ${r.images} images` : 'reviewed'} (${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (e) {
      console.log(`  ${n}: ERROR ${String(e.message).split('\n').join('\n    ')}`);
    }
  }
  if (dry) process.exit(0);
}

const results = names.map(score);
const planted = results.flatMap((r) => (r.defects || []).map((d) => ({ case: r.name, ...d })));
const caught = planted.filter((d) => d.result === 'caught').length;
const weak = planted.filter((d) => d.result === 'weak').length;
const controls = results.filter((r) => r.control && r.defects);
console.log('\ncase                   decision          planted defects                  must-fix  coverage       scores');
for (const r of results) {
  const d = r.defects ? (r.control ? '(control)' : r.defects.map((x) => `${x.id}:${x.result}`).join(' ')) : '';
  console.log(`  ${r.name.padEnd(21)}${String(r.status).padEnd(18)}${d.padEnd(33)}${String(r.must_fix ?? '').padEnd(10)}${String(r.coverage ?? '').padEnd(15)}${r.scores || ''}`);
}
console.log(`\nplanted defects caught as must-fix/verify: ${caught}/${planted.length}${weak ? ` (+${weak} only as polish or elevate)` : ''}`);
if (controls.length) console.log(`clean controls: ${controls.filter((r) => r.status === 'PASS').length}/${controls.length} passed · must-fix items on controls: ${controls.reduce((s, r) => s + r.must_fix, 0)} (${controls.reduce((s, r) => s + r.lifts, 0)} of them quality-bar lifts)`);
const summary = { at: new Date().toISOString(), runner, model, bar: Number(bar), caught, weak, planted: planted.length, results };
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`details: ${path.join(out, 'results.json')}`);

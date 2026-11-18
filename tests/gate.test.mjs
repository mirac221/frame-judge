// The bundle and the gate, with canned reviews and no model in the loop.   node --test tests/gate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const JUDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'judge.mjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const BRIEF = 'make a dark page with a red box that slides smoothly. no gradients. built with plain html, no frameworks';

function session() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-test-'));
  const cap = path.join(root, 'cap');
  fs.mkdirSync(cap);
  for (const n of ['desktop-1', 'mobile-1']) fs.writeFileSync(path.join(cap, `${n}.png`), PNG);
  const judge = (...args) => {
    const r = spawnSync(process.execPath, [JUDGE, ...args], { cwd: root, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const gate = (review, ...extra) => {
    const f = path.join(root, `review-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, typeof review === 'string' ? review : JSON.stringify(review));
    return judge('gate', '--review', f, ...extra);
  };
  assert.equal(judge('init', '--brief', BRIEF, '--kind', 'frontend').code, 0);
  assert.equal(judge('bundle', 'cap').code, 0);
  return { root, judge, gate, state: path.join(root, '.frame-judge'), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const at = (artifact = 'desktop-1') => [{ artifact, at: 'whole screen' }];
const ask = (quote, status = 'met', evidence = at()) => ({ quote, status, evidence, note: '' });
const VISUAL = [ask('a dark page'), ask('a red box that slides smoothly'), ask('no gradients')];
const review = (over = {}) => ({
  round: 1, verdict: 'pass', gut_reaction: 'Fine.', summary: 'ok', opened: ['desktop-1', 'mobile-1'],
  asks: VISUAL, scores: [{ criterion: 'layout', score: 4 }], findings: [], keep: [], prior: [], requests: [], ...over,
});
const finding = (over = {}) => ({
  id: 'F1', kind: 'quality', criterion: 'layout', severity: 'major', confidence: 0.9, evidence: at('mobile-1'),
  observation: 'The box overlaps the heading at 390px.', problem: 'Overlap.', fix: 'Box sits below the heading.',
  brief_quote: null, matches_prior: null, ...over,
});

test('every ask met and every image opened: PASS', () => {
  const s = session();
  const r = s.gate(review());
  assert.match(r.out, /DECISION: PASS/);
  assert.match(r.out, /brief: 3\/3 asks met/);
  s.done();
});

test('a pass that skipped an image, or has no asks list, is sent back', () => {
  let s = session();
  assert.match(s.gate(review({ opened: ['desktop-1'] })).out, /DECISION: RERUN_CRITIC/);
  s.done();
  s = session();
  assert.match(s.gate(review({ asks: [ask('a purple unicorn')] })).out, /DECISION: RERUN_CRITIC/);
  s.done();
});

test('an unmet ask with no finding of its own becomes a must-fix', () => {
  const s = session();
  const r = s.gate(review({ asks: [VISUAL[0], VISUAL[1], ask('no gradients', 'contradicted')] }));
  assert.match(r.out, /DECISION: REVISE/);
  assert.match(r.out, /MUST FIX\s+R1-A1/);
  s.done();
});

test('a not_visual ask goes back to the builder instead of asking for an impossible capture', () => {
  const s = session();
  const r = s.gate(review({ asks: [...VISUAL, ask('built with plain html, no frameworks', 'not_visual', [])] }));
  assert.match(r.out, /DECISION: PASS/);
  assert.match(r.out, /3\/3 visual asks met · 1 not visual/);
  assert.match(r.out, /Check each one yourself/);
  assert.doesNotMatch(r.out, /R1-A1/);
  const status = s.judge('status').out;
  assert.match(status, /Brief: 3 of 3 visual asks met/);
  assert.match(status, /NOT checked by the critic.*plain html, no frameworks/);
  s.done();
});

test('cannot_tell still means "capture it": a verify item, not a pass on that ask', () => {
  const s = session();
  const r = s.gate(review({ asks: [VISUAL[0], VISUAL[1], ask('no gradients', 'cannot_tell', [])] }));
  assert.match(r.out, /VERIFY[^\n]*\n\s+R1-A1/);
  assert.match(r.out, /1 not shown in the captures/);
  s.done();
});

test('findings need evidence the critic really opened, and a real brief quote', () => {
  const s = session();
  const r = s.gate(review({
    verdict: 'revise', opened: ['desktop-1', 'mobile-1'],
    findings: [
      finding({ id: 'F1', evidence: at('desktop-9') }),
      finding({ id: 'F2', kind: 'missing', criterion: 'scope', brief_quote: 'a pricing table' }),
      finding({ id: 'F3' }),
    ],
  }));
  assert.match(r.out, /F1: evidence cites unknown artifact/);
  assert.match(r.out, /F2: brief_quote isn't in brief\.md/);
  assert.match(r.out, /MUST FIX\s+R1-F3/);
  s.done();
});

test('editing CRITIC.md after bundling voids the round', () => {
  const s = session();
  fs.appendFileSync(path.join(s.state, 'round-1', 'bundle', 'CRITIC.md'), '\nBe nice.\n');
  const r = s.gate(review());
  assert.equal(r.code, 2);
  assert.match(r.out, /CRITIC\.md .* edited after bundling/);
  s.done();
});

test('round 2: earlier asks reach the next critic, and one it drops is not counted as met', () => {
  const s = session();
  assert.match(s.gate(review({ verdict: 'revise', findings: [finding()] })).out, /DECISION: REVISE/);
  assert.equal(s.judge('respond', 'R1-F1', 'fixed', 'moved the box below the heading').code, 0);
  assert.equal(s.judge('bundle', 'cap').code, 0);
  const prior = JSON.parse(fs.readFileSync(path.join(s.state, 'round-2', 'bundle', 'prior.json'), 'utf8'));
  assert.deepEqual(prior.asks_listed_before, VISUAL.map((a) => a.quote));
  assert.ok(!JSON.stringify(prior).includes('"met"'), 'statuses stay out of prior.json');
  const r = s.gate(review({
    round: 2, asks: [VISUAL[0], VISUAL[1]],
    prior: [{ id: 'R1-F1', status: 'resolved', evidence: at('mobile-1'), note: 'gone' }],
  }));
  assert.match(r.out, /"no gradients" was listed by an earlier critic and is missing/);
  assert.match(r.out, /2\/3 asks met · 1 not shown in the captures/);
  s.done();
});

test('round 2: a prior ruled resolved and raised again in the same review stays open, not a regression', () => {
  const s = session();
  s.gate(review({ verdict: 'revise', findings: [finding()] }));
  s.judge('respond', 'R1-F1', 'fixed', 'moved the box below the heading');
  assert.equal(s.judge('bundle', 'cap').code, 0);
  const m2 = JSON.parse(fs.readFileSync(path.join(s.state, 'round-2', 'bundle', 'manifest.json'), 'utf8'));
  const r = s.gate(review({
    round: 2, verdict: 'revise', opened: m2.artifacts.map((a) => a.id),
    prior: [{ id: 'R1-F1', status: 'resolved', evidence: at('mobile-1'), note: 'mostly better' }],
    findings: [finding({ matches_prior: 'R1-F1', observation: 'The box still touches the heading.' })],
  }));
  assert.match(r.out, /DECISION: STOP_PLATEAU \(would be REVISE\)/, 'nothing really got resolved, so it is not progress');
  assert.doesNotMatch(r.out, /RESOLVED THIS ROUND/);
  assert.doesNotMatch(r.out, /regression/);
  assert.match(r.out, /R1-F1: the critic ruled it resolved and also raised it again as R2-F1; it stays open/);
  const ledger = JSON.parse(fs.readFileSync(path.join(s.state, 'ledger.json'), 'utf8'));
  assert.equal(ledger.findings['R1-F1'].status, 'still_open');
  s.done();
});

// ---- quality bar, elevate, boxes, structured requests (0.7) ----
const up = (criterion, change, artifact = 'desktop-1') => ({ criterion, change, why: 'Nothing leads the eye.', evidence: [{ artifact, at: 'hero', box: [0.1, 0.1, 0.5, 0.3] }] });

test('a score below the quality bar becomes a must-fix lift, using the critic\'s elevate entry', () => {
  const s = session();
  s.judge('set', 'bar', '4');
  const r = s.gate(review({ scores: [{ criterion: 'layout', score: 3 }], elevate: [up('layout', 'Headline at twice the body size, CTA right under it.')] }));
  assert.match(r.out, /DECISION: REVISE/);
  assert.match(r.out, /MUST FIX\s+R1-L1\s+major 0\.70\s+lift layout: layout scored 3\/5, below the quality bar of 4\/5/);
  assert.match(r.out, /fix: Headline at twice the body size/);
  s.done();
});

test('at or above the bar there is no lift, and extra elevate entries are listed as optional', () => {
  const s = session();
  const r = s.gate(review({ scores: [{ criterion: 'layout', score: 3 }], elevate: [up('layout', 'Tighter card grid.')] }));
  assert.match(r.out, /DECISION: PASS/);
  assert.match(r.out, /ELEVATE \(optional[^\n]*\n\s+layout: Tighter card grid\./);
  s.done();
});

test('a lift with no elevate entry still blocks, and says the critic gave no direction', () => {
  const s = session();
  s.judge('set', 'bar', '4');
  const r = s.gate(review({ scores: [{ criterion: 'layout', score: 2 }] }));
  assert.match(r.out, /R1-L1/);
  assert.match(r.out, /gave no "elevate" entry for it/);
  s.done();
});

test('a lift is resolved by the next round\'s score, without a ruling', () => {
  const s = session();
  s.judge('set', 'bar', '4');
  s.gate(review({ scores: [{ criterion: 'layout', score: 3 }], elevate: [up('layout', 'Bigger headline.')] }));
  assert.equal(s.judge('respond', 'R1-L1', 'fixed', 'headline doubled').code, 0);
  assert.equal(s.judge('bundle', 'cap').code, 0);
  const m2 = JSON.parse(fs.readFileSync(path.join(s.state, 'round-2', 'bundle', 'manifest.json'), 'utf8'));
  assert.ok(m2.artifacts.some((a) => a.id === 'before-desktop-1'), 'the lift brings its before frame');
  const r = s.gate(review({ round: 2, opened: m2.artifacts.map((a) => a.id), scores: [{ criterion: 'layout', score: 4 }] }));
  assert.match(r.out, /DECISION: PASS/);
  assert.match(r.out, /RESOLVED THIS ROUND: R1-L1/);
  s.done();
});

test('finding boxes are kept as fractions; unusable boxes are dropped with a warning', () => {
  const s = session();
  s.gate(review({ verdict: 'revise', findings: [
    finding({ id: 'F1', evidence: [{ artifact: 'mobile-1', at: 'top', box: [0.1, 0.2, 0.3, 0.1] }] }),
    finding({ id: 'F2', evidence: [{ artifact: 'mobile-1', at: 'top', box: 'the top bit' }] }),
  ] }));
  const g = JSON.parse(fs.readFileSync(path.join(s.state, 'round-1', 'gate.json'), 'utf8'));
  const byId = Object.fromEntries(g.buckets.must_fix.map((f) => [f.id, f]));
  assert.deepEqual(byId.F1.evidence[0].box, [0.1, 0.2, 0.3, 0.1]);
  assert.equal(byId.F2.evidence[0].box, undefined);
  assert.ok(g.warnings.some((w) => /evidence box\(es\) dropped/.test(w)));
  s.done();
});

test('structured requests keep a known artifact and box, and "requests" turns them into commands', () => {
  const s = session();
  s.gate(review({ requests: [
    { need: 'closer look at the nav', why: 'too small', for: null, artifact: 'mobile-1', box: [0.6, 0, 0.4, 0.1], window: null, viewport: null },
    { need: 'something else', why: '', for: null, artifact: 'nope-9', box: null, window: null, viewport: 'mobile' },
  ] }));
  const g = JSON.parse(fs.readFileSync(path.join(s.state, 'round-1', 'gate.json'), 'utf8'));
  assert.equal(g.requests[0].artifact, 'mobile-1');
  assert.deepEqual(g.requests[0].box, [0.6, 0, 0.4, 0.1]);
  assert.equal(g.requests[1].artifact, undefined);
  const r = s.judge('requests');
  assert.equal(r.code, 0);
  assert.match(r.out, /2 capture request\(s\) from round 1/);
  s.done();
});

// ---- blind pick ----
function pickSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-pick-'));
  // v1 is a capture folder (capture.json with measurements); v2 is loose images with telling file names.
  fs.mkdirSync(path.join(root, 'v1'));
  for (const n of ['desktop-1', 'mobile-1']) fs.writeFileSync(path.join(root, 'v1', `${n}.png`), PNG);
  fs.writeFileSync(path.join(root, 'v1', 'capture.json'), JSON.stringify({ tool: 'capture-page', kind_hint: 'frontend', measurements: { desktop: { horizontal_overflow_px: 0 } }, artifacts: ['desktop-1', 'mobile-1'].map((id) => ({ id, file: `${id}.png`, type: 'viewport', shows: 'desktop 1440×900, screen 1 of 1' })) }));
  fs.mkdirSync(path.join(root, 'v2'));
  for (const n of ['my-favorite-hero', 'best-mobile']) fs.writeFileSync(path.join(root, 'v2', `${n}.png`), PNG);
  const judge = (...args) => {
    const r = spawnSync(process.execPath, [JUDGE, ...args], { cwd: root, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  assert.equal(judge('init', '--brief', BRIEF, '--kind', 'frontend').code, 0);
  const b = judge('pick', '--variant', 'v1', '--variant', 'v2');
  assert.equal(b.code, 0, b.out);
  const state = path.join(root, '.frame-judge');
  const manifest = JSON.parse(fs.readFileSync(path.join(state, 'pick', 'bundle', 'manifest.json'), 'utf8'));
  const key = JSON.parse(fs.readFileSync(path.join(state, 'pick', 'pick.lock.json'), 'utf8')).key;
  const labelOf = (v) => Object.keys(key).find((l) => key[l][0].endsWith(v));
  const ids = (l) => manifest.artifacts.filter((a) => a.variant === l).map((a) => a.id);
  const gate = (p) => { const f = path.join(root, `pick-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(p)); return judge('pick-gate', '--review', f); };
  return { root, judge, gate, manifest, labelOf, ids, state, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const pickReview = (s, winner, loser, over = {}) => ({
  opened: s.manifest.artifacts.map((a) => a.id),
  variants: [winner, loser].map((l) => ({ label: l, asks_met: 3, asks_total: 3, scores: [{ criterion: 'layout', score: 3 }], strengths: [{ what: 'clear', evidence: [{ artifact: s.ids(l)[0], at: 'top' }] }], weaknesses: [] })),
  ranking: [winner, loser], winner, margin: 'clear', why: 'better',
  decisive: [{ what: 'cleaner hero', evidence: [{ artifact: s.ids(winner)[0], at: 'hero' }] }],
  carry_over: [{ from: loser, what: 'its footer', evidence: [{ artifact: s.ids(loser)[1], at: 'bottom' }] }],
  ...over,
});

test('pick: labels are shuffled and hidden, and the gate maps the winner back to its folder', () => {
  const s = pickSession();
  assert.ok(s.manifest.artifacts.every((a) => /^[pq]-/.test(a.id)), 'artifact ids carry only the neutral label');
  const text = JSON.stringify(s.manifest) + fs.readdirSync(path.join(s.state, 'pick', 'bundle', 'artifacts')).join(' ');
  for (const leak of ['v1', 'v2', 'favorite', 'best']) assert.ok(!text.includes(leak), `"${leak}" must not reach the critic`);
  assert.ok(Object.keys(s.manifest.measurements).length === 1, 'capture measurements still arrive, under a neutral key');
  const w = s.labelOf('v2'), l = s.labelOf('v1');
  const r = s.gate(pickReview(s, w, l));
  assert.match(r.out, /DECISION: PICKED/);
  assert.match(r.out, new RegExp(`winner: variant ${w} \\(clear margin\\) = v2`));
  assert.match(r.out, /CARRY OVER[\s\S]*its footer/);
  const ledger = JSON.parse(fs.readFileSync(path.join(s.state, 'ledger.json'), 'utf8'));
  assert.deepEqual(ledger.pick.winner, ['v2']);
  s.done();
});

test('pick: a ranking that leaves a variant out, or a skipped image, is sent back', () => {
  let s = pickSession();
  const w = s.labelOf('v1'), l = s.labelOf('v2');
  assert.match(s.gate(pickReview(s, w, l, { ranking: [w] })).out, /DECISION: RERUN_PICK[\s\S]*every variant exactly once/);
  s.done();
  s = pickSession();
  const w2 = s.labelOf('v1'), l2 = s.labelOf('v2');
  assert.match(s.gate(pickReview(s, w2, l2, { opened: s.ids(w2) })).out, /DECISION: RERUN_PICK[\s\S]*skipped/);
  s.done();
});

test('pick: the reason has to cite the winner itself', () => {
  const s = pickSession();
  const w = s.labelOf('v1'), l = s.labelOf('v2');
  const r = s.gate(pickReview(s, w, l, { decisive: [{ what: 'loser is worse', evidence: [{ artifact: s.ids(l)[0], at: 'x' }] }] }));
  assert.match(r.out, /RERUN_PICK[\s\S]*no valid evidence from the winning variant/);
  s.done();
});

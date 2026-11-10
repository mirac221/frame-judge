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

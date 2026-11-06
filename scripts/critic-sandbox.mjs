import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELP = `critic-sandbox.mjs [--model sonnet] [--max-turns 40] [--dir .frame-judge]

Runs the frame critic as a separate headless Claude Code process. It gets a private copy of the
review bundle outside your project, only the Read tool, no MCP servers, and a hook that blocks any
read outside that copy. Its real tool calls are recorded and the review is gated with
transcript-verified coverage. Needs the claude CLI and uses your Claude plan.`;

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const REGATE = new Set(['RERUN_CRITIC', 'STOP_CRITIC_UNRELIABLE']);
const die = (msg) => { console.error(`critic-sandbox: ${msg}`); process.exit(1); };

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
if (argv.includes('--help')) { console.log(HELP); process.exit(0); }

const dir = path.resolve(opt('dir', process.env.FRAME_JUDGE_DIR || '.frame-judge'));
const ledgerPath = path.join(dir, 'ledger.json');
if (!fs.existsSync(ledgerPath)) die(`no ${ledgerPath}. Run "judge.mjs init" and "judge.mjs bundle" first.`);
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const entry = ledger.rounds[ledger.rounds.length - 1];
if (!entry || (entry.gated_at && !REGATE.has(entry.decision))) die('no round is waiting for a review. Run "judge.mjs bundle" first.');

const roundDir = path.join(dir, `round-${entry.round}`);
const bundle = path.join(roundDir, 'bundle');
const model = String(opt('model', ledger.critic_model || 'sonnet'));
const maxTurns = String(opt('max-turns', '40'));

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-judge-critic-'));
const sandboxBundle = path.join(sandbox, 'bundle');
fs.cpSync(bundle, sandboxBundle, { recursive: true });
const settings = path.join(sandbox, 'settings.json');
fs.writeFileSync(settings, JSON.stringify({
  hooks: {
    PreToolUse: [{
      matcher: '*',
      hooks: [{ type: 'command', command: process.execPath, args: [path.join(SCRIPTS, 'critic-guard.mjs'), '--bundle', sandboxBundle] }],
    }],
  },
}));

const message = `You are the frame critic. Your bundle is ${sandboxBundle}. Read ${path.join(sandboxBundle, 'CRITIC.md')} and follow it exactly. Open nothing outside that folder. Reply with the review JSON only.`;
const cliArgs = [
  '-p',
  ...(model && model !== 'inherit' ? ['--model', model] : []),
  '--tools', 'Read',
  '--disallowedTools', 'mcp__*',
  '--strict-mcp-config',
  '--settings', settings,
  '--max-turns', maxTurns,
  '--no-session-persistence',
  '--output-format', 'stream-json',
  '--verbose',
  message,
];

console.log(`critic-sandbox: round ${entry.round}, model ${model}, private bundle copy in ${sandbox}`);
const run = spawnSync('claude', cliArgs, { cwd: sandboxBundle, encoding: 'utf8', maxBuffer: 1 << 30, timeout: 30 * 60 * 1000 });
if (run.error) {
  fs.rmSync(sandbox, { recursive: true, force: true });
  die(run.error.code === 'ENOENT' ? 'the claude CLI is not on PATH' : run.error.message);
}

const attempt = (entry.attempts || 0) + 1;
const transcript = path.join(roundDir, `critic-sandbox.attempt-${attempt}.jsonl`);
fs.writeFileSync(transcript, run.stdout || '');
let result = null;
for (const line of String(run.stdout || '').split('\n')) {
  try {
    const event = JSON.parse(line);
    if (event.type === 'result') result = event;
  } catch {}
}
fs.rmSync(sandbox, { recursive: true, force: true });
if (!result) die(`the critic produced no result (exit ${run.status}). ${String(run.stderr || '').trim().split('\n').pop() || ''}`);
console.log(`critic-sandbox: critic finished in ${result.num_turns ?? '?'} turns${typeof result.total_cost_usd === 'number' ? `, about $${result.total_cost_usd.toFixed(2)}` : ''}`);

const reviewPath = path.join(roundDir, 'review.json');
fs.writeFileSync(reviewPath, String(result.result ?? ''));
const gate = spawnSync(process.execPath, [
  path.join(SCRIPTS, 'judge.mjs'), 'gate',
  '--dir', dir,
  '--review', reviewPath,
  '--reviewer', 'headless',
  '--model', model,
  '--transcript', transcript,
  '--transcript-bundle', sandboxBundle,
], { stdio: 'inherit' });
process.exit(gate.status ?? 1);

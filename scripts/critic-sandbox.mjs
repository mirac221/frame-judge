import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELP = `critic-sandbox.mjs [--runner claude|agy] [--model sonnet] [--max-turns 40] [--dir .frame-judge]

Runs the frame critic as a separate headless process on a private copy of the review bundle,
outside your project. Its real tool calls are recorded, and the review is gated with
transcript-verified coverage: a critic that skipped images, or read anything outside its copy,
doesn't count.

  --runner claude  (default) the claude CLI: only the Read tool, no MCP servers, and a hook that
                   BLOCKS any read outside the copy. Enforced isolation. Uses your Claude plan.
  --runner agy     Antigravity's CLI in plan mode: its file reads are audited after the fact, so a
                   peek outside the copy voids the review. Verified, not enforced. Models: agy models.`;

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
const runner = String(opt('runner', 'claude'));
if (!['claude', 'agy'].includes(runner)) die('--runner must be claude or agy');
const model = String(opt('model', ledger.critic_model || (runner === 'agy' ? 'claude-sonnet-4-6' : 'sonnet')));
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
const attempt = (entry.attempts || 0) + 1;
const transcript = path.join(roundDir, `critic-sandbox.attempt-${attempt}.jsonl`);
const claudeBin = [process.env.FRAME_JUDGE_CLAUDE, process.env.CLAUDE_CODE_EXECPATH].filter(Boolean).find((p) => fs.existsSync(p)) || 'claude';

function gateNow(reviewText, label) {
  const reviewPath = path.join(roundDir, 'review.json');
  fs.writeFileSync(reviewPath, String(reviewText ?? ''));
  const gate = spawnSync(process.execPath, [
    path.join(SCRIPTS, 'judge.mjs'), 'gate',
    '--dir', dir,
    '--review', reviewPath,
    '--reviewer', 'headless',
    '--model', label,
    '--transcript', transcript,
    '--transcript-bundle', sandboxBundle,
  ], { stdio: 'inherit' });
  process.exit(gate.status ?? 1);
}

if (runner === 'agy') {
  // Headless agy denies shell commands, and a denied command can end the run with no output: say so up front.
  const agyMessage = `${message} Use only your file-viewing tool to open files (it shows images too). Never run a shell command: it would be denied and your review lost.`;
  const agyArgs = ['-p', agyMessage, ...(model && model !== 'inherit' ? ['--model', model] : []), '--mode', 'plan',
    '--output-format', 'stream-json', '--json-schema', path.join(SCRIPTS, '..', 'references', 'review.schema.json'), '--print-timeout', '900s'];
  console.log(`critic-sandbox: round ${entry.round}, agy model ${model}, private bundle copy in ${sandbox}`);
  const run = spawnSync(process.env.FRAME_JUDGE_AGY || 'agy', agyArgs, { cwd: sandboxBundle, encoding: 'utf8', maxBuffer: 1 << 30, timeout: 20 * 60 * 1000, windowsHide: true });
  if (run.error) { fs.rmSync(sandbox, { recursive: true, force: true }); die(run.error.code === 'ENOENT' ? 'the agy CLI is not on PATH' : run.error.message); }
  // Turn agy's tool steps into the tool_use records the gate audits: reads become Read with the path.
  const lines = [];
  const seen = new Set();
  let result = null;
  for (const line of String(run.stdout || '').split('\n')) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.event === 'result') result = ev.result;
    const st = ev.step_update;
    if (!st || st.step_type !== 'tool' || !st.tool_info || seen.has(st.step_index)) continue;
    seen.add(st.step_index);
    const name = String(st.tool_info.name || st.tool_name || '');
    const prm = st.tool_info.parameters || {};
    const file = prm.Path || prm.AbsolutePath || prm.FilePath || prm.TargetFile || '';
    const where = prm.DirectoryPath || prm.SearchPath || prm.SearchDirectory || file || prm.Url || prm.CommandLine || '';
    lines.push(JSON.stringify(/^(read_file|view_file|view_file_outline)$/.test(name)
      ? { type: 'tool_use', id: `agy-${st.step_index}`, name: 'Read', input: { file_path: file } }
      : { type: 'tool_use', id: `agy-${st.step_index}`, name, input: { path: where } }));
  }
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  fs.rmSync(sandbox, { recursive: true, force: true });
  const text = result && (result.structured_output ? JSON.stringify(result.structured_output) : result.response);
  if (!text) die(`the agy critic produced no review (exit ${run.status}): ${String(run.stderr || '').trim().split('\n').pop() || ''}`);
  console.log(`critic-sandbox: agy critic finished (${result.status}${result.finished_reason ? `, ${result.finished_reason}` : ''}), ${lines.length} tool call(s) recorded`);
  gateNow(text, model);
}

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
const run = spawnSync(claudeBin, cliArgs, { cwd: sandboxBundle, encoding: 'utf8', maxBuffer: 1 << 30, timeout: 30 * 60 * 1000 });
if (run.error) {
  fs.rmSync(sandbox, { recursive: true, force: true });
  die(run.error.code === 'ENOENT' ? 'the claude CLI is not on PATH' : run.error.message);
}

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

if (/authenticat|oauth|log ?in/i.test(String(result.result || '')) && result.is_error) die(`the claude CLI isn't logged in (${String(result.result).slice(0, 120)}). Run "claude auth login" in a terminal, or use --runner agy.`);
gateNow(result.result, model);

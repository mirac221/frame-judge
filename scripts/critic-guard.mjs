import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const bundleArg = args[0] === '--bundle' ? args[1] : null;

let event;
try { event = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }

const isCritic = Boolean(bundleArg) || /frame[-_]critic/i.test(String(event.agent_type || ''));
if (!isCritic) process.exit(0);

const deny = (why) => {
  process.stderr.write(`frame-judge guard: ${why}. The critic may only Read files inside its review bundle.\n`);
  process.exit(2);
};
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
const key = (p) => {
  const k = real(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? k.toLowerCase() : k;
};

const tool = String(event.tool_name || '');
if (tool !== 'Read') deny(`${tool || 'this tool'} is not allowed for the critic`);
const target = event.tool_input && event.tool_input.file_path;
if (!target) deny('Read without a file path');

const file = key(path.resolve(event.cwd || process.cwd(), String(target)));
if (bundleArg) {
  const root = key(path.resolve(bundleArg)).replace(/\/+$/, '');
  if (!file.startsWith(`${root}/`)) deny(`${target} is outside the bundle`);
} else if (!/\/\.frame-judge\/round-\d+\/bundle\//.test(file)) {
  deny(`${target} is outside a .frame-judge review bundle`);
}
process.exit(0);

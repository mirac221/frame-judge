import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HELP = `judge.mjs <command> [options]   (state lives in ./.frame-judge, or --dir / FRAME_JUDGE_DIR)

  init     --brief "..." | --brief-file <file|->  [--kind frontend,motion,video] [--ref image]...
           [--max-rounds 3] [--min-confidence 0.6] [--critic-model alias] [--force]
  brief    [--add "the user's exact words"]
  set      critic-model | max-rounds | min-confidence | kind  <value>
  bundle   <capture dir|file>... [--include-video] [--force]
  gate     --review <file|->  [--reviewer subagent|headless|human|self] [--model name]
  respond  <finding-id> fixed|disputed|wont-fix "<note>" [--evidence image] [--quote "brief words"]
  status   [--json]`;

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFS = path.join(SKILL_DIR, 'references');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v']);
const KINDS = ['frontend', 'motion', 'video'];
const SEVERITY = ['blocker', 'major', 'minor', 'nit'];
const FINDING_KIND = ['quality', 'missing', 'contradicts', 'unrequested'];
const PRIOR_STATUS = ['resolved', 'still_open', 'regressed', 'cannot_tell'];
const VERDICT = ['pass', 'revise', 'rethink'];
const REVIEWERS = ['subagent', 'headless', 'human', 'self'];
const OPEN = new Set(['open', 'still_open', 'regressed', 'cannot_tell']);
const REGATE = new Set(['RERUN_CRITIC', 'STOP_CRITIC_UNRELIABLE']);
const BUCKET_RANK = { must_fix: 0, verify: 1, polish: 2, ignored: 3 };
const WARN_IMAGES = 20;
const MAX_IMAGES = 40;
const BOOLEAN_FLAGS = new Set(['force', 'include-video', 'json', 'help']);

const die = (msg, code = 1) => { console.error(`frame-judge: ${msg}`); process.exit(code); };
const readText = (p) => fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
const readJson = (p) => JSON.parse(readText(p));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const now = () => new Date().toISOString();
const rel = (p) => path.relative(process.cwd(), p) || '.';
const trunc = (s, n = 140) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const norm = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[‘’‚‛]/g, "'")
  .replace(/[“”„‟]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

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
const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
const many = (v) => (v === undefined ? [] : [].concat(v).filter((x) => x !== true));
const csv = (v) => many(v).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);

function stateDir(args) {
  return path.resolve(one(args.dir) || process.env.FRAME_JUDGE_DIR || '.frame-judge');
}
function loadLedger(dir) {
  const p = path.join(dir, 'ledger.json');
  if (!exists(p)) die(`no ${rel(p)}. Run "judge.mjs init" first.`);
  return readJson(p);
}
const saveLedger = (dir, ledger) => writeJson(path.join(dir, 'ledger.json'), ledger);
const lastRound = (ledger) => ledger.rounds[ledger.rounds.length - 1];
const lastGated = (ledger) => [...ledger.rounds].reverse().find((r) => r.gated_at && !REGATE.has(r.decision));

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function quoteInBrief(quote, briefText) {
  const briefNorm = norm(briefText);
  const q = norm(quote).replace(/^["'\s]+|["'\s.,;:!?]+$/g, '');
  if (!q) return false;
  const parts = q.split(/\s*(?:\.\.\.|…)\s*/).filter(Boolean);
  return parts.length > 0 && parts.every((p) => briefNorm.includes(p));
}

function sanitizeBrief(md) {
  return md.replace(/(^|\n)(```|~~~)[^\n]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g,
    (_m, pre, _fence, body) => `${pre}[code block omitted by frame-judge: ${body.split('\n').length} lines]`);
}

function slugId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'artifact';
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out.sort();
}

function extractJson(raw) {
  const s = String(raw ?? '').replace(/^﻿/, '').trim();
  const tryParse = (t) => { try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : null; } catch { return null; } };
  const unwrap = (v, depth = 0) => {
    if (!v || depth > 3) return null;
    if (Array.isArray(v.findings)) return v;
    if (v.structured_output && typeof v.structured_output === 'object') return unwrap(v.structured_output, depth + 1);
    if (typeof v.result === 'string') return extractJson(v.result);
    return null;
  };
  let v = unwrap(tryParse(s));
  if (v) return v;
  for (const m of s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) { v = unwrap(tryParse(m[1].trim())); if (v) return v; }
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { v = unwrap(tryParse(s.slice(start, i + 1))); if (v) return v; break; }
    }
  }
  return null;
}

function cmdInit(args) {
  const dir = stateDir(args);
  if (exists(path.join(dir, 'ledger.json'))) {
    if (!args.force) die(`${rel(dir)} already exists. Run "judge.mjs status" to continue, or add --force to start over (the old folder is renamed, not deleted).`);
    const moved = `${dir}-old-${now().replace(/[:.]/g, '-')}`;
    fs.renameSync(dir, moved);
    console.log(`moved the previous session to ${rel(moved)}`);
  }
  let brief = null;
  if (args.brief !== undefined && args.brief !== true) brief = String(one(args.brief));
  else if (args['brief-file'] !== undefined) {
    const f = String(one(args['brief-file']));
    brief = f === '-' ? readStdin() : readText(path.resolve(f));
  }
  if (!brief || !brief.trim()) die('give the user\'s request verbatim: --brief "..." or --brief-file <file> (use - for stdin)');

  const kinds = csv(args.kind);
  for (const k of kinds) if (!KINDS.includes(k)) die(`unknown --kind "${k}" (use ${KINDS.join(', ')})`);
  const maxRounds = args['max-rounds'] !== undefined ? parseInt(one(args['max-rounds']), 10) : 3;
  if (!(maxRounds >= 1)) die('--max-rounds must be 1 or more');
  const minConf = args['min-confidence'] !== undefined ? Number(one(args['min-confidence'])) : 0.6;
  if (!(minConf > 0 && minConf <= 1)) die('--min-confidence must be between 0 and 1');

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  const briefMd = `## Original request\n\n${brief.trim()}\n`;
  fs.writeFileSync(path.join(dir, 'brief.md'), briefMd);

  const refs = [];
  for (const r of many(args.ref)) {
    const src = path.resolve(String(r));
    const ext = path.extname(src).toLowerCase();
    if (!exists(src)) die(`reference image not found: ${r}`);
    if (!IMAGE_EXT.has(ext)) die(`reference must be an image (${[...IMAGE_EXT].join(' ')}): ${r}`);
    fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
    const file = `refs/ref-${refs.length + 1}${ext}`;
    fs.copyFileSync(src, path.join(dir, file));
    refs.push({ file, original: path.basename(src) });
  }

  const ledger = {
    version: 1,
    created_at: now(),
    kinds,
    max_rounds: maxRounds,
    min_confidence: minConf,
    critic_model: args['critic-model'] ? String(one(args['critic-model'])) : null,
    refs,
    brief_sha256: sha256(briefMd),
    rounds: [],
    findings: {},
  };
  saveLedger(dir, ledger);
  console.log(`frame-judge: initialized ${rel(dir)}`);
  console.log(`  brief: ${trunc(brief, 100)}`);
  console.log(`  kinds: ${kinds.length ? kinds.join(', ') : 'auto (from captures)'} · max rounds: ${maxRounds} · critic model: ${ledger.critic_model || 'not chosen yet: ask the user before round 1'}`);
  if (refs.length) console.log(`  reference images: ${refs.length}`);
  console.log('next: build, capture (capture-page.mjs / video-frames.mjs), then "judge.mjs bundle <capture dirs>"');
}

function cmdBrief(args) {
  const dir = stateDir(args);
  const ledger = loadLedger(dir);
  const p = path.join(dir, 'brief.md');
  if (args.add === undefined) { process.stdout.write(readText(p)); return; }
  const text = String(one(args.add) === true ? readStdin() : one(args.add)).trim();
  if (!text) die('empty clarification. Pass the user\'s exact words.');
  const n = (readText(p).match(/^## Clarification /gm) || []).length + 1;
  fs.appendFileSync(p, `\n## Clarification ${n} (from the user)\n\n${text}\n`);
  ledger.brief_sha256 = sha256(readText(p));
  saveLedger(dir, ledger);
  console.log(`frame-judge: added clarification ${n} to brief.md`);
}

function cmdSet(args) {
  const dir = stateDir(args);
  const ledger = loadLedger(dir);
  const [key, value] = args._;
  if (!key || value === undefined) die('usage: judge.mjs set critic-model|max-rounds|min-confidence|kind <value>');
  if (key === 'critic-model') ledger.critic_model = String(value);
  else if (key === 'max-rounds') {
    const n = parseInt(value, 10);
    if (!(n >= 1)) die('max-rounds must be 1 or more');
    ledger.max_rounds = n;
  } else if (key === 'min-confidence') {
    const n = Number(value);
    if (!(n > 0 && n <= 1)) die('min-confidence must be between 0 and 1');
    ledger.min_confidence = n;
  } else if (key === 'kind' || key === 'kinds') {
    const kinds = csv(value);
    for (const k of kinds) if (!KINDS.includes(k)) die(`unknown kind "${k}"`);
    ledger.kinds = kinds;
  } else die(`unknown setting "${key}"`);
  saveLedger(dir, ledger);
  console.log(`frame-judge: ${key} = ${value}`);
}

function cmdBundle(args) {
  const dir = stateDir(args);
  const ledger = loadLedger(dir);
  const last = lastRound(ledger);
  const reuse = last && (!last.gated_at || REGATE.has(last.decision));
  const round = reuse ? last.round : (last ? last.round + 1 : 1);
  const force = !!args.force;

  if (!reuse && last) {
    if (['PASS', 'SELF_PASS'].includes(last.decision) && last.brief_sha256 === ledger.brief_sha256 && !force)
      die(`round ${last.round} already passed. If the user asked for more changes, add their words with "judge.mjs brief --add" first (or use --force).`);
    if (['STOP_PLATEAU', 'RETHINK'].includes(last.decision) && !force)
      die(`round ${last.round} ended with ${last.decision}. Report to the user first, and continue with --force only once they agree.`);
  }
  if (round > ledger.max_rounds && !force)
    die(`the round cap is ${ledger.max_rounds}. Report to the user and ask before going on. If they agree: judge.mjs set max-rounds ${round}`);

  if (round > 1 && !reuse) {
    const unanswered = Object.entries(ledger.findings)
      .filter(([, f]) => f.bucket === 'must_fix' && OPEN.has(f.status) && !(f.response && f.response.round >= f.last_open_round))
      .map(([id]) => id);
    if (unanswered.length && !force)
      die(`answer every must-fix finding before the next round (judge.mjs respond <id> fixed|disputed|wont-fix "..."): ${unanswered.join(', ')}`);
  }

  const sources = args._;
  if (!sources.length) die('usage: judge.mjs bundle <capture dir|file>... (the folders capture-page.mjs / video-frames.mjs wrote)');
  const includeVideo = !!args['include-video'];
  const roundDir = path.join(dir, `round-${round}`);
  const bundleDir = path.join(roundDir, 'bundle');
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(bundleDir, 'artifacts'), { recursive: true });

  const artifacts = [];
  const measurements = {};
  const skipped = [];
  const ids = new Set();
  const kindHints = new Set();
  const uniqueId = (base) => {
    const b = slugId(base);
    let id = b, n = 2;
    while (ids.has(id)) id = `${b}-${n++}`;
    ids.add(id);
    return id;
  };
  const addFile = (absFile, meta = {}) => {
    const ext = path.extname(absFile).toLowerCase();
    const isImg = IMAGE_EXT.has(ext);
    const isVid = VIDEO_EXT.has(ext);
    if (!isImg && !(isVid && includeVideo)) { skipped.push(rel(absFile)); return null; }
    if (!exists(absFile)) { skipped.push(`${rel(absFile)} (missing)`); return null; }
    const id = uniqueId(meta.id || path.basename(absFile, ext));
    const file = `artifacts/${id}${ext}`;
    fs.copyFileSync(absFile, path.join(bundleDir, file));
    const entry = { id, file, type: meta.type || (isVid ? 'video' : 'image'), shows: meta.shows || (isVid ? 'a video file' : 'an image (no description recorded)') };
    for (const k of ['viewport', 't', 'window', 'tiles']) if (meta[k] !== undefined) entry[k] = meta[k];
    artifacts.push(entry);
    return id;
  };

  for (const src of sources) {
    const abs = path.resolve(src);
    if (!exists(abs)) die(`not found: ${src}`);
    if (fs.statSync(abs).isDirectory()) {
      const capPath = path.join(abs, 'capture.json');
      if (exists(capPath)) {
        const cap = readJson(capPath);
        if (cap.kind_hint) kindHints.add(cap.kind_hint);
        const label = path.basename(abs);
        if (cap.measurements && Object.keys(cap.measurements).length) measurements[label] = cap.measurements;
        for (const a of cap.artifacts || []) {
          if (a.type === 'video' && !includeVideo) continue;
          addFile(path.resolve(abs, a.file), a);
        }
      } else {
        for (const f of walk(abs)) addFile(f);
      }
    } else addFile(abs);
  }

  for (const r of ledger.refs || []) {
    addFile(path.join(dir, r.file), {
      id: path.basename(r.file, path.extname(r.file)),
      type: 'reference',
      shows: `a reference image the user supplied (${r.original}). Compare the work against it.`,
    });
  }

  const disputeIds = {};
  for (const [fid, f] of Object.entries(ledger.findings)) {
    const resp = f.response;
    if (resp && resp.action === 'disputed' && resp.evidence_file && OPEN.has(f.status) && resp.round >= f.last_open_round) {
      const id = addFile(path.join(dir, resp.evidence_file), {
        id: `dispute-${fid}`,
        type: 'dispute_evidence',
        shows: `evidence the builder submitted to dispute prior finding ${fid}`,
      });
      if (id) disputeIds[fid] = id;
    }
  }

  const imageCount = artifacts.filter((a) => IMAGE_EXT.has(path.extname(a.file))).length;
  if (!artifacts.some((a) => a.type !== 'reference' && a.type !== 'dispute_evidence'))
    die('no visual artifacts found in the given sources (only png/jpg/webp/gif, plus video with --include-video)');
  if (imageCount > MAX_IMAGES && !force)
    die(`${imageCount} images is too many for one critic round (cap ${MAX_IMAGES}). Use fewer slices or viewports, lean on sheets, or pass --force.`);

  let kinds = ledger.kinds && ledger.kinds.length ? [...ledger.kinds] : [...kindHints].filter((k) => KINDS.includes(k));
  if (!kinds.length) kinds = artifacts.some((a) => VIDEO_EXT.has(path.extname(a.file))) ? ['video'] : ['frontend'];
  kinds = KINDS.filter((k) => kinds.includes(k));

  const critic = readText(path.join(REFS, 'critic-brief.md'));
  const rubric = kinds.map((k) => readText(path.join(REFS, `rubric-${k}.md`)).trim()).join('\n\n---\n\n') + '\n';
  const criteria = [...new Set([...rubric.matchAll(/^###\s+`([a-z0-9_-]+)`/gm)].map((m) => m[1]))];
  const brief = sanitizeBrief(readText(path.join(dir, 'brief.md')));
  fs.writeFileSync(path.join(bundleDir, 'CRITIC.md'), critic);
  fs.writeFileSync(path.join(bundleDir, 'rubric.md'), rubric);
  fs.writeFileSync(path.join(bundleDir, 'brief.md'), brief);

  let prior = null;
  if (round > 1) {
    prior = {
      note: 'Findings from earlier rounds. Judge each one only from this round\'s artifacts. The builder\'s claims of having fixed something are deliberately left out. Disputes and refusals are listed with the builder\'s evidence or brief quote, for you to rule on.',
      findings: [],
    };
    for (const [fid, f] of Object.entries(ledger.findings)) {
      const include = (f.bucket === 'must_fix' && f.status !== 'rejected') || (['verify', 'polish'].includes(f.bucket) && OPEN.has(f.status));
      if (!include) continue;
      const p = { id: fid, from_round: f.round, kind: f.kind, criterion: f.criterion, severity: f.severity, observation: f.observation, fix: f.fix, last_status: f.status };
      if (f.brief_quote) p.brief_quote = f.brief_quote;
      const resp = f.response;
      const fresh = resp && resp.round >= f.last_open_round && OPEN.has(f.status);
      if (fresh && resp.action === 'disputed' && disputeIds[fid]) p.dispute = { claim: trunc(resp.note, 300), evidence_artifact: disputeIds[fid] };
      if (fresh && resp.action === 'wont-fix') p.declined = { reason: trunc(resp.note, 300), brief_quote: resp.quote };
      prior.findings.push(p);
    }
    writeJson(path.join(bundleDir, 'prior.json'), prior);
  }

  const manifest = {
    round,
    kinds,
    criteria,
    note: 'Artifact labels are mechanical descriptions written by capture scripts. They are not claims about quality.',
    image_count: imageCount,
    artifacts,
    measurements,
  };
  writeJson(path.join(bundleDir, 'manifest.json'), manifest);
  writeJson(path.join(roundDir, 'bundle.lock.json'), {
    created_at: now(),
    critic_sha256: sha256(critic),
    rubric_sha256: sha256(rubric),
    brief_sha256: sha256(brief),
    kinds,
  });

  const textSection = (name, body) => `\n\n======== ${name} ========\n\n${body.trim()}\n`;
  let packet = `# frame-judge review packet, round ${round}\n\nFor a critic that can't open files: paste this whole file into a fresh chat with a vision-capable model, then attach every image listed in manifest.json (from the artifacts/ folder). Paste the JSON reply back to the builder.`;
  packet += textSection('CRITIC.md', critic);
  packet += textSection('brief.md', brief);
  packet += textSection('rubric.md', rubric);
  packet += textSection('manifest.json', JSON.stringify(manifest, null, 2));
  if (prior) packet += textSection('prior.json', JSON.stringify(prior, null, 2));
  fs.writeFileSync(path.join(bundleDir, 'packet.md'), packet);

  const abs = path.resolve(bundleDir);
  const spawn = `You are the frame critic. Your bundle is ${abs}. Read ${path.join(abs, 'CRITIC.md')} and follow it exactly. Open nothing outside that folder. Reply with the review JSON only.`;
  fs.writeFileSync(path.join(roundDir, 'spawn.txt'), spawn + '\n');

  const entry = { round, bundle: rel(bundleDir), created_at: now(), brief_sha256: ledger.brief_sha256, gated_at: null, attempts: reuse && last ? last.attempts || 0 : 0 };
  if (reuse) ledger.rounds[ledger.rounds.length - 1] = { ...last, ...entry, decision: REGATE.has(last.decision) ? last.decision : undefined };
  else ledger.rounds.push(entry);
  saveLedger(dir, ledger);

  console.log(`frame-judge: round ${round}/${ledger.max_rounds} bundle ready at ${rel(bundleDir)}`);
  console.log(`  ${artifacts.length} artifacts (${imageCount} images) · kinds: ${kinds.join(', ')}${prior ? ` · prior findings: ${prior.findings.length}` : ''}`);
  if (skipped.length) console.log(`  skipped ${skipped.length} non-visual or missing file(s): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}`);
  if (imageCount > WARN_IMAGES) console.log(`  warning: ${imageCount} images. Past ~20 per request, Claude tightens image limits and cost climbs. Prefer sheets, fewer slices, tighter crops.`);
  console.log(`  critic model: ${ledger.critic_model || 'NOT CHOSEN. Ask the user once, then: judge.mjs set critic-model <alias>'}`);
  console.log('\nSpawn a FRESH critic (no fork, no extra context) with exactly this message:\n');
  console.log(spawn);
  console.log(`\nSave its reply to ${rel(path.join(roundDir, 'review.json'))}, then: judge.mjs gate --review ${rel(path.join(roundDir, 'review.json'))} --reviewer subagent`);
}

function cmdGate(args) {
  const dir = stateDir(args);
  const ledger = loadLedger(dir);
  const entry = lastRound(ledger);
  if (!entry || (entry.gated_at && !REGATE.has(entry.decision))) die('no round is waiting for a review. Run "judge.mjs bundle" first.');
  const round = entry.round;
  const roundDir = path.join(dir, `round-${round}`);
  const bundleDir = path.join(roundDir, 'bundle');
  const manifest = readJson(path.join(bundleDir, 'manifest.json'));
  const lock = readJson(path.join(roundDir, 'bundle.lock.json'));

  const criticNow = readText(path.join(bundleDir, 'CRITIC.md'));
  const rubricNow = readText(path.join(bundleDir, 'rubric.md'));
  const skillCritic = readText(path.join(REFS, 'critic-brief.md'));
  const skillRubric = lock.kinds.map((k) => readText(path.join(REFS, `rubric-${k}.md`)).trim()).join('\n\n---\n\n') + '\n';
  const tampered = [];
  if (sha256(criticNow) !== lock.critic_sha256 || sha256(criticNow) !== sha256(skillCritic)) tampered.push('CRITIC.md');
  if (sha256(rubricNow) !== lock.rubric_sha256 || sha256(rubricNow) !== sha256(skillRubric)) tampered.push('rubric.md');
  if (tampered.length) die(`${tampered.join(' and ')} in the bundle ${tampered.length > 1 ? 'were' : 'was'} edited after bundling, so the critic may have been softened. Re-run "judge.mjs bundle" and a fresh critic.`, 2);

  const reviewer = String(one(args.reviewer) || 'subagent');
  if (!REVIEWERS.includes(reviewer)) die(`--reviewer must be one of ${REVIEWERS.join(', ')}`);
  const model = args.model ? String(one(args.model)) : ledger.critic_model || null;
  const reviewArg = one(args.review);
  if (!reviewArg) die('usage: judge.mjs gate --review <file|-> [--reviewer subagent|headless|human|self]');
  const raw = reviewArg === '-' ? readStdin() : readText(path.resolve(String(reviewArg)));
  const attempt = (entry.attempts || 0) + 1;
  fs.writeFileSync(path.join(roundDir, `review.attempt-${attempt}.txt`), raw);
  const minConf = ledger.min_confidence ?? 0.6;
  const warnings = [];
  const notes = [];

  const review = extractJson(raw);
  if (!review) {
    const decision = attempt >= 2 ? 'STOP_CRITIC_UNRELIABLE' : 'RERUN_CRITIC';
    Object.assign(entry, { gated_at: now(), reviewer, model, attempts: attempt, decision, counts: null });
    saveLedger(dir, ledger);
    writeJson(path.join(roundDir, 'gate.json'), { round, decision, reason: 'no JSON object with a findings array found in the review' });
    printDecision({ round, max: ledger.max_rounds, decision, reviewer, model, reason: 'The review contained no JSON object with a "findings" array.' });
    return;
  }

  const verdict = VERDICT.includes(norm(review.verdict)) ? norm(review.verdict) : null;
  if (!verdict) warnings.push(`critic verdict "${review.verdict}" isn't pass, revise or rethink`);

  const artifactIds = new Set(manifest.artifacts.map((a) => a.id));
  const byFile = new Map();
  for (const a of manifest.artifacts) {
    byFile.set(a.file, a.id);
    byFile.set(path.basename(a.file), a.id);
    byFile.set(path.basename(a.file, path.extname(a.file)), a.id);
  }
  const resolveArtifact = (ref) => {
    const r = String(ref ?? '').trim().replace(/\\/g, '/');
    if (artifactIds.has(r)) return r;
    if (byFile.has(r)) return byFile.get(r);
    const base = r.split('/').pop();
    if (byFile.has(base)) return byFile.get(base);
    return null;
  };

  const measurementKeys = new Set();
  const collectKeys = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) collectKeys(v); else measurementKeys.add(k.toLowerCase());
    }
  };
  collectKeys(manifest.measurements);
  const isMeasurementRef = (ref) => measurementKeys.size > 0 && /measurement/i.test(String(ref ?? ''));
  const namesMeasurement = (text) => [...measurementKeys].some((k) => String(text).toLowerCase().includes(k));

  const visual = manifest.artifacts.filter((a) => IMAGE_EXT.has(path.extname(a.file).toLowerCase())).map((a) => a.id);
  const openedRaw = Array.isArray(review.opened) ? review.opened.map(String) : null;
  const opened = openedRaw ? new Set(openedRaw.map(resolveArtifact).filter(Boolean)) : null;
  const skipped = opened ? visual.filter((id) => !opened.has(id)) : visual;
  if (!opened) warnings.push('the critic didn\'t list what it opened ("opened"), so coverage can\'t be checked');
  else {
    const unknownOpened = openedRaw.filter((r) => !resolveArtifact(r) && !isMeasurementRef(r));
    if (unknownOpened.length) warnings.push(`"opened" lists unknown artifact(s): ${unknownOpened.join(', ')}`);
    if (skipped.length) notes.push(`coverage: the critic opened ${visual.length - skipped.length} of ${visual.length} images and skipped ${skipped.join(', ')}`);
  }

  const checkEvidence = (ev) => {
    const list = Array.isArray(ev) ? ev : ev ? [ev] : [];
    const good = [], bad = [], unopened = [];
    for (const e of list) {
      const ref = typeof e === 'string' ? e : e && e.artifact;
      const at = typeof e === 'object' && e ? String(e.at ?? '') : '';
      if (isMeasurementRef(ref)) {
        if (namesMeasurement(at) || namesMeasurement(ref)) good.push({ artifact: 'measurements', at });
        else bad.push(`${ref} (names no real measurement)`);
        continue;
      }
      const id = resolveArtifact(ref);
      if (!id) bad.push(String(ref));
      else if (opened && !opened.has(id)) unopened.push(id);
      else good.push({ artifact: id, at });
    }
    return { good, bad, unopened, total: list.length };
  };
  const evidenceErrors = (ev) => [
    ev.bad.length ? `evidence cites unknown artifact(s): ${ev.bad.join(', ')}` : '',
    ev.unopened.length ? `evidence cites artifact(s) the critic never opened: ${ev.unopened.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  const briefText = readText(path.join(bundleDir, 'brief.md'));
  const criteria = new Set(manifest.criteria || []);

  const rawFindings = Array.isArray(review.findings) ? review.findings : [];
  const valid = [];
  const rejected = [];
  const seenIds = new Set();
  rawFindings.forEach((f, i) => {
    f = f && typeof f === 'object' ? f : {};
    let id = typeof f.id === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(f.id) ? f.id : `F${i + 1}`;
    while (seenIds.has(id)) id = `${id}x`;
    seenIds.add(id);
    const errs = [];
    const kind = f.kind == null ? 'quality' : norm(f.kind);
    if (!FINDING_KIND.includes(kind)) errs.push(`unknown kind "${f.kind}"`);
    const severity = norm(f.severity);
    if (!SEVERITY.includes(severity)) errs.push(`unknown severity "${f.severity}"`);
    let confidence = Number(f.confidence);
    if (Number.isFinite(confidence) && confidence > 1 && confidence <= 100) { confidence /= 100; notes.push(`${id}: confidence given as a percentage, read as ${confidence}`); }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) errs.push(`confidence must be 0 to 1 (got ${JSON.stringify(f.confidence)})`);
    const ev = checkEvidence(f.evidence);
    if (!ev.good.length) errs.push(ev.total ? evidenceErrors(ev) : 'no evidence');
    const observation = String(f.observation ?? '').trim();
    if (!observation) errs.push('no observation');
    const briefQuote = f.brief_quote == null ? null : String(f.brief_quote);
    if (['missing', 'contradicts'].includes(kind)) {
      if (!briefQuote || !briefQuote.trim()) errs.push(`a "${kind}" finding needs a brief_quote`);
      else if (!quoteInBrief(briefQuote, briefText)) errs.push(`brief_quote isn't in brief.md: "${trunc(briefQuote, 80)}"`);
    } else if (briefQuote && !quoteInBrief(briefQuote, briefText)) {
      warnings.push(`${id}: brief_quote isn't in brief.md (ignored, since a ${kind} finding doesn't need one)`);
    }
    const criterion = String(f.criterion ?? (kind === 'quality' ? '' : 'scope')) || (kind === 'quality' ? 'unspecified' : 'scope');
    if (errs.length) { rejected.push({ id, reasons: errs, observation: trunc(observation, 120) }); return; }
    if (kind === 'quality' && criteria.size && !criteria.has(criterion)) warnings.push(`${id}: criterion "${criterion}" isn't in the rubric`);
    if (ev.bad.length || ev.unopened.length) warnings.push(`${id}: dropped some evidence (${evidenceErrors(ev)})`);
    valid.push({
      id, kind, criterion, severity, confidence,
      evidence: ev.good,
      observation,
      problem: String(f.problem ?? '').trim(),
      fix: String(f.fix ?? '').trim(),
      brief_quote: briefQuote && quoteInBrief(briefQuote, briefText) ? briefQuote : null,
      matches_prior: typeof f.matches_prior === 'string' && f.matches_prior.trim() ? f.matches_prior.trim() : null,
    });
  });

  const bucketOf = (f) => {
    if (f.severity === 'blocker' || f.severity === 'major') return f.confidence >= minConf ? 'must_fix' : 'verify';
    if (f.severity === 'minor') return f.confidence >= 0.5 ? 'polish' : 'ignored';
    return 'ignored';
  };
  const buckets = { must_fix: [], verify: [], polish: [], ignored: [] };
  for (const f of valid) buckets[bucketOf(f)].push(f);
  for (const b of Object.values(buckets)) b.sort((a, c) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(c.severity) || c.confidence - a.confidence);

  const scores = Array.isArray(review.scores)
    ? review.scores.filter((s) => s && typeof s === 'object').map((s) => ({ criterion: String(s.criterion), score: Number(s.score) }))
    : review.scores && typeof review.scores === 'object'
      ? Object.entries(review.scores).map(([criterion, score]) => ({ criterion, score: Number(score) }))
      : [];
  for (const s of scores) if (!Number.isInteger(s.score) || s.score < 1 || s.score > 5) warnings.push(`score for "${s.criterion}" isn't an integer from 1 to 5`);
  const unexplained = scores.filter((s) => Number.isInteger(s.score) && s.score <= 2 && !valid.some((f) => f.criterion === s.criterion)).map((s) => `${s.criterion} (${s.score})`);
  if (unexplained.length) warnings.push(`low scores with no finding under the same criterion: ${unexplained.join(', ')}`);

  let expectedPrior = [];
  const priorPath = path.join(bundleDir, 'prior.json');
  if (exists(priorPath)) expectedPrior = (readJson(priorPath).findings || []).map((p) => p.id);
  const rulings = [];
  for (const p of Array.isArray(review.prior) ? review.prior : []) {
    if (!p || typeof p !== 'object') continue;
    const pid = String(p.id ?? '');
    if (!ledger.findings[pid]) { warnings.push(`prior ruling "${pid}" doesn't match any earlier finding`); continue; }
    let status = norm(p.status);
    if (!PRIOR_STATUS.includes(status)) { warnings.push(`prior ruling ${pid}: unknown status "${p.status}", treated as cannot_tell`); status = 'cannot_tell'; }
    const ev = checkEvidence(p.evidence);
    if (status !== 'cannot_tell' && !ev.good.length) { warnings.push(`prior ruling ${pid} (${status}) cites no valid artifact, so it's treated as cannot_tell`); status = 'cannot_tell'; }
    if (!rulings.some((r) => r.id === pid)) rulings.push({ id: pid, status, evidence: ev.good, note: String(p.note ?? '').trim() });
  }
  const unchecked = expectedPrior.filter((pid) => !rulings.some((r) => r.id === pid));
  if (unchecked.length) warnings.push(`critic didn't rule on prior finding(s) ${unchecked.join(', ')}, so they keep their last status`);

  const total = rawFindings.length;
  const unusable = total >= 2 && rejected.length / total >= 0.5;
  if (rejected.length && total) notes.push(`${rejected.length} of ${total} findings rejected for bad evidence or format${rejected.length / total >= 0.3 ? '. That rate suggests the critic is guessing, so consider a stronger critic model.' : ''}`);

  const statusAfter = (pid) => {
    const r = rulings.find((x) => x.id === pid);
    return r ? r.status : ledger.findings[pid].status;
  };
  const priorOpenMustFix = Object.entries(ledger.findings)
    .filter(([pid, f]) => f.bucket === 'must_fix' && f.status !== 'rejected' && OPEN.has(statusAfter(pid)))
    .map(([pid]) => pid);
  const blocking = new Set(priorOpenMustFix);
  for (const f of buckets.must_fix) if (!(f.matches_prior && blocking.has(f.matches_prior))) blocking.add(`R${round}-${f.id}`);
  const verifyBlockers = buckets.verify.filter((f) => f.severity === 'blocker').length;
  const blockingCount = blocking.size + verifyBlockers;
  const resolvedNow = rulings.filter((r) => r.status === 'resolved').length;

  const coverageGap = !opened || skipped.length > 0;
  let decision;
  if (unusable) decision = attempt >= 2 ? 'STOP_CRITIC_UNRELIABLE' : 'RERUN_CRITIC';
  else if (blockingCount === 0 && coverageGap) {
    decision = attempt >= 2 ? 'STOP_CRITIC_UNRELIABLE' : 'RERUN_CRITIC';
    notes.push('nothing blocking was found, but a pass needs every image looked at, and this critic skipped some or didn\'t say what it opened.');
  }
  else if (blockingCount === 0) decision = reviewer === 'self' ? 'SELF_PASS' : 'PASS';
  else if (verdict === 'rethink' && buckets.must_fix.some((f) => f.severity === 'blocker')) decision = 'RETHINK';
  else decision = 'REVISE';

  let wouldBe = null;
  if (decision === 'REVISE' || decision === 'RETHINK') {
    const prev = [...ledger.rounds].reverse().find((r) => r.round < round && r.counts);
    if (round >= ledger.max_rounds) { wouldBe = decision; decision = 'STOP_MAX_ROUNDS'; }
    else if (prev && blockingCount >= prev.counts.blocking && resolvedNow === 0) { wouldBe = decision; decision = 'STOP_PLATEAU'; }
  }
  const discard = REGATE.has(decision);
  if (!discard) {
    if (verdict === 'pass' && blockingCount > 0) notes.push('the critic said "pass", but its own findings or prior rulings include must-fix items. The gate overrides it.');
    if (verdict && verdict !== 'pass' && blockingCount === 0) notes.push(`the critic said "${verdict}", but nothing it reported clears the must-fix bar (blocker or major at confidence ≥ ${minConf}). The gate passes it; polish items are listed.`);
  }

  const coverage = opened ? `${visual.length - skipped.length}/${visual.length}` : 'unknown';
  const counts = { must_fix: buckets.must_fix.length, verify: buckets.verify.length, polish: buckets.polish.length, ignored: buckets.ignored.length, rejected: rejected.length, resolved: resolvedNow, blocking: blockingCount, coverage };
  if (!discard) {
    for (const r of rulings) {
      const pf = ledger.findings[r.id];
      pf.status = r.status;
      pf.history.push({ round, status: r.status, note: trunc(r.note, 200) });
      if (OPEN.has(r.status)) pf.last_open_round = round;
    }
    for (const [bucket, list] of Object.entries(buckets)) {
      for (const f of list) {
        const pf = f.matches_prior ? ledger.findings[f.matches_prior] : null;
        if (pf && pf.status !== 'rejected') {
          const wasResolved = pf.status === 'resolved';
          if (bucket !== 'ignored') {
            pf.status = wasResolved ? 'regressed' : 'still_open';
            pf.last_open_round = round;
          }
          if (BUCKET_RANK[bucket] < BUCKET_RANK[pf.bucket]) { pf.bucket = bucket; pf.severity = f.severity; pf.confidence = f.confidence; }
          pf.history.push({ round, status: wasResolved ? 'regressed' : 'raised_again', as: `R${round}-${f.id}`, observation: trunc(f.observation, 200) });
          if (wasResolved && bucket !== 'ignored') warnings.push(`${f.matches_prior} had been resolved and is back (raised again as R${round}-${f.id}): a regression`);
          f.ledger_id = f.matches_prior;
          continue;
        }
        if (f.matches_prior) warnings.push(`R${round}-${f.id}: matches_prior "${f.matches_prior}" isn't a known finding, so it's recorded as new`);
        const gid = `R${round}-${f.id}`;
        const { id: _drop, ...rest } = f;
        ledger.findings[gid] = {
          round, ...rest, bucket,
          status: bucket === 'ignored' ? 'ignored' : 'open',
          last_open_round: round,
          history: [{ round, status: 'raised' }],
        };
        f.ledger_id = gid;
      }
    }
  }
  Object.assign(entry, {
    gated_at: now(), reviewer, model, attempts: attempt, critic_verdict: verdict, decision, counts,
    gut_reaction: trunc(review.gut_reaction, 300), summary: trunc(review.summary, 600),
  });
  saveLedger(dir, ledger);
  const gate = { round, decision, would_be: wouldBe, reviewer, model, critic_verdict: verdict, min_confidence: minConf, counts, buckets, rejected, prior_rulings: rulings, still_open_from_earlier: priorOpenMustFix, keep: review.keep || [], requests: review.requests || [], scores, warnings, notes };
  writeJson(path.join(roundDir, 'gate.json'), gate);
  if (reviewArg === '-' || path.resolve(String(reviewArg)) !== path.resolve(path.join(roundDir, 'review.json'))) writeJson(path.join(roundDir, 'review.json'), review);

  printDecision({ round, max: ledger.max_rounds, decision, wouldBe, reviewer, model, verdict, coverage, gut: review.gut_reaction, buckets, rejected, rulings, priorOpenMustFix, requests: review.requests, warnings, notes, ledger });
}

function printDecision(o) {
  const L = (s = '') => console.log(s);
  L(`frame-judge · round ${o.round}/${o.max} · DECISION: ${o.decision}${o.wouldBe ? ` (would be ${o.wouldBe})` : ''}`);
  L(`critic: ${o.reviewer}${o.model ? ` (${o.model})` : ''}${o.verdict ? ` · critic verdict: ${o.verdict}` : ''}${o.coverage ? ` · images opened: ${o.coverage}` : ''}`);
  if (o.reason) L(`reason: ${o.reason}`);
  if (o.gut) L(`gut reaction: "${trunc(o.gut, 200)}"`);
  const show = (title, list) => {
    if (!list || !list.length) return;
    L(`\n${title}`);
    for (const f of list) {
      const lid = f.ledger_id || `R${o.round}-${f.id}`;
      const merged = f.ledger_id && f.ledger_id !== `R${o.round}-${f.id}` ? ` (critic's ${f.id}, same issue as ${f.ledger_id})` : '';
      L(`  ${lid}${merged}  ${f.severity} ${f.confidence.toFixed(2)}  ${f.kind === 'quality' ? f.criterion : f.kind}: ${trunc(f.observation, 110)}`);
      if (f.fix) L(`      fix: ${trunc(f.fix, 110)}`);
    }
  };
  if (o.buckets) {
    show('MUST FIX', o.buckets.must_fix);
    show('VERIFY (recapture closer before fixing, don\'t blind-fix)', o.buckets.verify);
    show('POLISH (fix if cheap)', o.buckets.polish);
  }
  if (o.priorOpenMustFix && o.priorOpenMustFix.length) {
    L('\nSTILL OPEN FROM EARLIER ROUNDS');
    for (const pid of o.priorOpenMustFix) { const f = o.ledger.findings[pid]; if (f) L(`  ${pid}  ${f.status}  ${trunc(f.observation, 110)}`); }
  }
  if (o.rulings && o.rulings.length) {
    const res = o.rulings.filter((r) => r.status === 'resolved').map((r) => r.id);
    if (res.length) L(`\nRESOLVED THIS ROUND: ${res.join(', ')}`);
  }
  if (o.rejected && o.rejected.length) {
    L('\nREJECTED (not counted)');
    for (const r of o.rejected) L(`  ${r.id}: ${r.reasons.join('; ')}`);
  }
  if (o.requests && o.requests.length) {
    L('\nCRITIC REQUESTS (capture these for the next round)');
    for (const r of o.requests) if (r && r.need) L(`  - ${trunc(r.need, 120)}${r.for ? ` (for ${r.for})` : ''}`);
  }
  if ((o.warnings && o.warnings.length) || (o.notes && o.notes.length)) {
    L('\nNOTES');
    for (const w of [...(o.notes || []), ...(o.warnings || [])]) L(`  - ${w}`);
  }
  const next = {
    PASS: 'Report to the user ("judge.mjs status" prints the block). Lead with the critic\'s verdict.',
    SELF_PASS: 'Report, and say plainly this was a self-review, not an independent critic.',
    REVISE: 'Fix every must-fix item, answer each with "judge.mjs respond <id> fixed|disputed|wont-fix ...", recapture EVERYTHING, then "judge.mjs bundle ...".',
    RETHINK: 'Stop patching. Tell the user the critic thinks the approach is wrong at the root (summary in gate.json), and agree on a direction before rebuilding.',
    STOP_MAX_ROUNDS: 'Round cap reached. Report what is still open ("judge.mjs status") and ask the user whether to continue (judge.mjs set max-rounds N).',
    STOP_PLATEAU: 'This round resolved nothing. You are going in circles. Report and ask the user how to proceed ("bundle --force" continues anyway).',
    RERUN_CRITIC: 'That review was unusable. Spawn a FRESH critic on the same bundle (same message) and gate again.',
    STOP_CRITIC_UNRELIABLE: 'Two unusable reviews. Suggest a stronger critic model or another fallback (references/platforms.md), then rerun.',
  }[o.decision];
  L(`\nNEXT: ${next}`);
}

function cmdRespond(args) {
  const dir = stateDir(args);
  const ledger = loadLedger(dir);
  const [fid, actionRaw, ...rest] = args._;
  if (!fid || !actionRaw) die('usage: judge.mjs respond <finding-id> fixed|disputed|wont-fix "<note>" [--evidence image] [--quote "brief words"]');
  const f = ledger.findings[fid];
  if (!f) {
    const open = Object.entries(ledger.findings).filter(([, x]) => OPEN.has(x.status) && x.bucket !== 'ignored').map(([id]) => id);
    die(`unknown finding "${fid}". Open findings: ${open.join(', ') || 'none'}`);
  }
  const action = { fixed: 'fixed', fix: 'fixed', disputed: 'disputed', dispute: 'disputed', 'wont-fix': 'wont-fix', wont_fix: 'wont-fix', wontfix: 'wont-fix' }[String(actionRaw).toLowerCase()];
  if (!action) die('action must be fixed, disputed or wont-fix');
  const note = (rest.join(' ') || (args.note && args.note !== true ? String(one(args.note)) : '')).trim();
  if (!note) die('add a short note saying what you did, or why');
  const gated = lastGated(ledger);
  const resp = { action, note: note.slice(0, 500), round: gated ? gated.round : f.round, at: now() };
  if (action === 'disputed') {
    const ev = one(args.evidence);
    if (!ev || ev === true) die('a dispute needs visual evidence: --evidence <image> (a crop, extra frames). Code is not evidence.');
    const src = path.resolve(String(ev));
    const ext = path.extname(src).toLowerCase();
    if (!exists(src) || !IMAGE_EXT.has(ext)) die('evidence must be an existing image file (png, jpg, webp, gif)');
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    resp.evidence_file = `evidence/${slugId(fid)}${ext}`;
    fs.copyFileSync(src, path.join(dir, resp.evidence_file));
  }
  if (action === 'wont-fix') {
    const q = one(args.quote);
    if (!q || q === true) die('wont-fix needs --quote "<the user\'s words the fix would violate>"');
    if (!quoteInBrief(String(q), readText(path.join(dir, 'brief.md')))) die('that quote is not in brief.md. A wont-fix has to rest on the user\'s actual words.');
    resp.quote = String(q);
  }
  f.response = resp;
  saveLedger(dir, ledger);
  const pending = Object.entries(ledger.findings)
    .filter(([, x]) => x.bucket === 'must_fix' && OPEN.has(x.status) && !(x.response && x.response.round >= x.last_open_round))
    .map(([id]) => id);
  console.log(`frame-judge: ${fid} → ${action}`);
  console.log(pending.length ? `still unanswered must-fix: ${pending.join(', ')}` : 'all must-fix findings answered. Recapture everything, then bundle.');
}

function cmdStatus(args) {
  const dir = stateDir(args);
  const ledger = loadLedger(dir);
  if (args.json) { console.log(JSON.stringify(ledger, null, 2)); return; }
  const L = (s = '') => console.log(s);
  const gated = ledger.rounds.filter((r) => r.gated_at && r.counts);
  const last = gated[gated.length - 1];
  const pending = lastRound(ledger);
  L(`frame-judge status · ${ledger.rounds.length} round(s) of max ${ledger.max_rounds} · critic model: ${ledger.critic_model || 'not chosen'}`);
  for (const r of ledger.rounds) {
    L(`  round ${r.round}: ${r.decision || (r.gated_at ? 'gated' : 'awaiting review')}${r.reviewer ? ` · ${r.reviewer}${r.model ? `/${r.model}` : ''}` : ''}${r.counts ? ` · must-fix ${r.counts.must_fix}, verify ${r.counts.verify}, polish ${r.counts.polish}, rejected ${r.counts.rejected}, resolved ${r.counts.resolved}` : ''}`);
  }
  if (pending && !pending.gated_at) L(`  → round ${pending.round} bundle is waiting for a critic: ${pending.bundle}`);
  if (!last) { L('\nNo gated round yet.'); return; }

  const F = Object.entries(ledger.findings);
  const label = (id, f) => `${id} ${trunc(f.observation, 70)}`;
  const fixed = F.filter(([, f]) => f.status === 'resolved' && f.bucket !== 'ignored');
  const open = F.filter(([, f]) => OPEN.has(f.status) && f.bucket !== 'ignored');
  const disputed = F.filter(([, f]) => f.response && f.response.action === 'disputed');
  const unanswered = open.filter(([, f]) => f.bucket === 'must_fix' && !(f.response && f.response.round >= f.last_open_round));
  const firstGut = gated.find((r) => r.gut_reaction);
  const independent = last.reviewer !== 'self';
  const passed = ['PASS', 'SELF_PASS'].includes(last.decision);

  L('\n--- report block (paste this, then add context) ---');
  L(`Critic: ${last.decision} on round ${last.round} of ${ledger.max_rounds} (${last.reviewer}${last.model ? `, model ${last.model}` : ''}, ${independent ? 'code-blind' : 'SELF-REVIEW, not independent'})`);
  if (firstGut) L(`Round ${firstGut.round} gut reaction: "${firstGut.gut_reaction}"`);
  if (!passed) L(`Not passed. ${open.filter(([, f]) => f.bucket === 'must_fix').length} must-fix item(s) still open.`);
  if (fixed.length) L(`Fixed: ${fixed.map(([id, f]) => label(id, f)).join(' · ')}`);
  if (open.length) L(`Open: ${open.map(([id, f]) => `${id} (${f.severity}, ${f.status}) ${trunc(f.observation, 60)}`).join(' · ')}`);
  if (disputed.length) L(`Disputed: ${disputed.map(([id, f]) => `${id} → ${f.status === 'resolved' ? 'critic accepted the dispute' : 'critic upheld it'}`).join(' · ')}`);
  if (unanswered.length) L(`Unanswered must-fix: ${unanswered.map(([id]) => id).join(', ')}`);
  L(`Captures: ${last.bundle}/artifacts`);
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const commands = { init: cmdInit, brief: cmdBrief, set: cmdSet, bundle: cmdBundle, gate: cmdGate, respond: cmdRespond, status: cmdStatus };
if (!cmd || cmd === 'help' || cmd === '--help' || !commands[cmd]) {
  console.log(HELP);
  process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
}
commands[cmd](args);

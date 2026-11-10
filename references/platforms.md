# Platforms: installing, spawning the critic, the model question, fallbacks

Checked against vendor docs in November 2026.

These tools change fast. If anything here disagrees with your installed version's `--help` or docs, trust those, and tell the user what was different.

## Contents
Running only on command · Cursor · The slop scout · Claude Code · Codex · Antigravity · Claude app · ChatGPT app · Chat apps: relay · Everything else: the fallback ladder

Read your own app's section, plus "The slop scout" when unslop mode is on. Skip the other apps.

Every platform has the same three non-negotiables:
- **A fresh critic each round.** Never a fork or anything else that inherits context.
- **The spawn message `bundle` printed, and nothing else.**
- **Ask about the model once, and only where the platform lets you choose it** (Claude Code and the Claude apps, Codex app and CLI). Record the answer with `judge.mjs set critic-model …` and reuse it.

## Running only on command

frame-judge is command-only. In ordinary chats, the only thing it costs is its one-paragraph description (about 100 tokens). The instructions load only when the user calls it.
- **Claude Code, Cursor, Antigravity, anything else:** the description itself says "command-only, never load it on your own". Tested on Claude Code (Sonnet, Haiku) and Antigravity (Gemini): a landing-page request didn't trigger it, and `/frame-judge` did.
- **Codex CLI, IDE and app:** in addition, `agents/openai.yaml` sets `allow_implicit_invocation: false`, a hard switch.
- **Don't add `disable-model-invocation: true`.** Claude Code and Cursor support it, but Antigravity then hides the skill completely, `/frame-judge` included (tested). The description gives the same behavior everywhere.

How to invoke it: `/frame-judge` in Claude Code, Cursor (IDE and CLI) and Antigravity (`/frame-judge:frame-judge` as a Claude Code plugin); `$frame-judge` in Codex and the ChatGPT desktop app's Codex mode; `@frame-judge` in ChatGPT Chat and Work; "use frame-judge" anywhere else.

## Cursor (IDE and Cursor CLI)

**Install:** `node scripts/install.mjs` (or by hand). Cursor reads skills from `~/.cursor/skills/`, `~/.agents/skills/`, `~/.claude/skills/` and `~/.codex/skills/`, plus the same folders in a project. If the skill is already installed for Claude Code or Codex, Cursor uses that copy.

**Critic agent:** `agents/cursor/frame-critic.md` goes to `~/.cursor/agents/` (or `<repo>/.cursor/agents/`). It sets `readonly: true`, so the critic can't edit files or run state-changing commands. Cursor also reads `.claude/agents/` and `.codex/agents/`; on a name clash `.cursor/` wins.

**Spawn:** ask Agent to run the `frame-critic` subagent with the spawn message, verbatim, or type `/frame-critic <spawn message>`. Subagents start with a fresh context, so the critic doesn't inherit the conversation. Cursor subagents can't be limited to the bundle folder, so coverage is self-reported. If the `claude` or `agy` CLI is installed, `critic-sandbox.mjs` gives you a separate process with recorded tool calls instead.

**Model question:** ask in chat. A subagent's model comes from `model:` in its agent file (`inherit` by default, or an id such as `claude-opus-5[effort=high]`). Changing it means editing that file, which is the user's config: ask first. Otherwise say the critic runs on the same model as you.

**Cursor CLI:** the same skills, agents and subagents load in `agent` (the Cursor CLI). Untested here, because Cursor isn't installed on the test machine.

## The slop scout (unslop mode)

The scout needs web search.
- **Claude Code:** a general-purpose subagent has WebSearch and WebFetch. Don't use the `frame-critic` agent; it can only read files.
- **Codex:** web search has to be enabled in the user's Codex setup.
- **Antigravity:** the agent can search and browse.

If the platform has no web access at all, tell the user unslop mode can't run, and build without it. Never write an avoid list from memory: `judge.mjs avoid` rejects lists without real sources, for that reason.

## Claude Code

**Install**
- **Plugin:** `/plugin marketplace add mirac221/frame-judge`, then `/plugin install frame-judge@frame-judge`. This brings in the skill and the critic agent, which is then named `frame-judge:frame-critic`.
- **Plain skill:** `~/.claude/skills/frame-judge/` for all projects, or `<repo>/.claude/skills/frame-judge/` for one repo.
- **Critic agent** (plain-skill installs; optional, recommended): copy `agents/claude-code/frame-critic.md` to `~/.claude/agents/` or `<repo>/.claude/agents/`.
  - It is restricted to the `Read` tool and skips CLAUDE.md files (`omitClaudeMd: true`).
  - Without it, a general-purpose subagent still loads CLAUDE.md and a git status snapshot.

**Model question:** use AskUserQuestion, once, before round 1.
- Question: "Which model should the frame critic run on? It looks at up to ~20 images per round, for up to 3 rounds."
- Options:
  - `Sonnet (Recommended)`: balanced cost and eye
  - `Opus`: strictest; best at subtle motion and typography problems; most quota
  - `Haiku`: cheapest; fine for obvious breakage, misses subtle issues
  - `Same as me`: no override
- Record the answer: `judge.mjs set critic-model sonnet`, or `inherit` for "same as me".

**Spawn** with the Agent tool, fresh every round:
- `subagent_type`: `"frame-critic"` if installed (plugin: `"frame-judge:frame-critic"`), otherwise `"general-purpose"`. Never a fork; forks inherit the whole conversation.
- `model`: the alias, `sonnet` | `opus` | `haiku` | `fable`. Leave it out for "same as me". Per-call `model` beats the agent file's `model:`, and `CLAUDE_CODE_SUBAGENT_MODEL` is the env-level default.
- `prompt`: the spawn message, verbatim.
- The subagent's final message is the review. Save it to `round-N/review.json` as-is.

**Enforcement:**
- **In-session subagent:** nothing hooks your regular sessions, so code-blindness rests on the agent's instructions. Gate with `--transcript auto`: the gate finds the critic's subagent transcript under `~/.claude/projects/`, counts the images it actually read, and voids the review if it touched anything outside the bundle.
- **Sandboxed critic:** this is enforced, and it's the default whenever the `claude` CLI is on PATH (see below).

**Sandboxed critic (default when the `claude` CLI is available):**
```bash
node <skill>/scripts/critic-sandbox.mjs --model sonnet
```
- It copies the bundle to a private temp folder outside the project.
- It runs `claude -p` there with only the `Read` tool, no MCP servers, and the guard hook pinned to that copy.
- It records the critic's tool calls, then gates the review with that transcript and deletes the copy.
- It uses your Claude plan. It doesn't work with `--bare`, which skips the login.

## Codex (CLI, IDE extension, app)

**Install**
- **Skill:** `~/.agents/skills/frame-judge/` or `<repo>/.agents/skills/frame-judge/`. Codex also scans parent folders up to the repo root.
- **Critic agent:** copy `agents/codex/frame-critic.toml` to `~/.codex/agents/` or `<repo>/.codex/agents/`.

**Delegation:** Codex only spawns subagents when asked. AGENTS.md or skill instructions count as asking, so be explicit: "Spawn the frame_critic agent with this message: …".

**Model question:** ask in chat, once. Codex has no question widget. "Which model should the critic run on? (list the models your Codex offers), or the same as this session?" Record it with `judge.mjs set critic-model <id>`.
- **Per-spawn choice:** ask for it in the spawn ("…using model X with high reasoning effort"). The resolution order is: spawn value, then the `[agents]` default, then the parent's model. A `model` set in the agent file overrides that whole chain.
- **Known problem:** with the multi-agent v2 spawn schema (reported mid-2026), some versions ignore per-spawn model and effort, and children inherit the parent's. If you can't confirm the child ran on the chosen model, use one of these:
  - pin `model = "…"` and `model_reasoning_effort` in the agent TOML (that's the user's config, so ask before editing it);
  - the headless fallback below, which takes `-m`.
- **Defaults for every subagent:** `[agents] default_subagent_model` in `config.toml`.

**Isolation:** there's no per-agent read-only sandbox; subagents inherit the parent's sandbox. The agent's instructions confine it to the bundle, but nothing enforces that, and coverage is the critic's own `opened` list. To tighten it:
- Set `features.shell_tool = false` in the TOML and paste `packet.md` into the spawn message, so the critic only needs `view_image`.
- If the Claude Code CLI is also installed, run the critic with `critic-sandbox.mjs` instead.

Either way, tell the user which one you used.

**Images:** the critic looks at images with the built-in `view_image` tool. It's on by default; the setting is `[tools] view_image` in `config.toml`.

**Headless fallback:**
```bash
cd .frame-judge/round-1/bundle
codex exec -m <model> -s read-only -o ../review.json \
  "You are the frame critic. Your bundle is the current directory. Read CRITIC.md and follow it exactly. Open nothing outside this folder. Reply with the review JSON only."
```
- `-o` / `--output-last-message` writes the final message.
- `--output-schema <file>` can enforce `review.schema.json`.
- Some versions take `-i` / `--image <file>` (repeatable) to attach images up front. Check `codex exec --help` before relying on it.

## Antigravity (App, IDE, CLI)

**Install**
- **Skill:** `<workspace>/.agents/skills/frame-judge/`, or global `~/.gemini/config/skills/frame-judge/`. The IDE also reads the legacy `~/.gemini/antigravity/skills/`. In the CLI, run `/skills reload` after adding it.
- **Critic agent:** copy `agents/antigravity/frame-critic.md` to `<workspace>/.agents/agents/frame-critic.md` or `~/.gemini/config/agents/frame-critic.md`.

**Sandboxed critic (recommended when the `agy` CLI is installed):**
```bash
node <skill>/scripts/critic-sandbox.mjs --runner agy --model claude-sonnet-4-6
```
- It copies the bundle to a private temp folder and runs `agy -p` there in plan mode, with output held to `review.schema.json`.
- It records every tool call from agy's event stream. The gate counts the images the critic really opened, and voids the review if it read anything outside the copy.
- Any id from `agy models` works. The model question is then a real choice: Claude Sonnet (recommended), Claude Opus, or a Gemini tier.
- Each run shows up as its own conversation in Antigravity's history.

**Model question for `invoke_subagent`: don't ask.** Antigravity has no per-spawn model choice. The critic runs on its agent file's setting, `model: inherit` (the parent's model), and that's what you tell the user. A user who wants a fixed tier can change that line to `flash` or `pro` themselves; those are Gemini tiers and draw from the Gemini quota pool, not the Claude/GPT one.

**Spawn:** call `invoke_subagent` with the `frame-critic` agent and the spawn message. Workspace mode `inherit` is fine, because the critic only reads. If the agent file isn't installed, `define_subagent` can create a transient critic; give it the body of `agents/antigravity/frame-critic.md`.

**Isolation:** the agent file grants only `view_file`, but nothing restricts which files it opens, and coverage is self-reported. If the Claude Code CLI is installed, `critic-sandbox.mjs` gives enforced isolation.

**Tools:** the agent file grants only `view_file`. Tool names must be exact; a misspelled one can hang the subagent. If the critic reports it can't see images through `view_file` on your version, switch to the human relay, or use a fresh Agent Manager conversation as the critic.

**Video:** Gemini models take video natively. Bundle with `--include-video` so a Gemini critic can watch the clip. It still has to cite sheet tiles and timestamps.

## Claude app (desktop and claude.ai)

- **Code tab of the Claude desktop app:** that's Claude Code; use the Claude Code section.
- **Cowork:** it installs Claude Code plugins (`/plugin marketplace add mirac221/frame-judge`), and Anthropic's docs say subagents run there. Spawn `frame-judge:frame-critic` as you would in Claude Code. Not tested in Cowork.
- **claude.ai chat:** upload the zip from `node scripts/install.mjs --zip` (Settings > Capabilities > code execution on, then Skills > Upload). The code-execution sandbox can install packages, so `npm i playwright && npx playwright install chromium` can make page capture work there. There are no subagents, so the critic runs as a **relay** (below).

## ChatGPT app

- **Codex mode in the ChatGPT desktop app** (the former Codex app): same skills folder (`~/.agents/skills/`), same `frame_critic` agent (`~/.codex/agents/`), same `$frame-judge`. Use the Codex section.
- **ChatGPT Work:** upload the zip and invoke it with `@frame-judge`. Work can run subagents in its hosted environment, so spawn a fresh one with the spawn message. If its environment can't run the capture scripts, capture locally and relay.
- **ChatGPT Chat:** upload the zip and use relay mode.

## Chat apps: relay

When the app can't start an independent agent:
1. Capture and bundle as usual, wherever the scripts can run.
2. Give the user `round-N/bundle/packet.md` and the `artifacts/` folder. They open a **fresh** chat with any vision model, paste the packet, attach every image, and paste the JSON reply back.
3. Run `gate --reviewer human`. The asks list, coverage and evidence rules apply as usual, and asks it marks `not_visual` come back to you to check.
4. If the user won't relay, use self-review (`gate --reviewer self`, at most `SELF_PASS`) and say so plainly.

## Everything else: the fallback ladder

For an app with no section above. Use the first option that works, and tell the user which one you used.

1. **`critic-sandbox.mjs`**, if the doctor found the `claude` or `agy` CLI. It gates the review itself.
2. **Native subagent, chosen model.** A fresh one, with the spawn message and nothing else.
3. **Native subagent, default model.** The platform can't choose per subagent; say so.
4. **Another headless critic in a separate process**, started inside the bundle folder (the `codex exec` command above, or any CLI agent that can read images). Run the gate with `--reviewer headless`.
5. **Human relay.** The steps are in "Chat apps: relay" above.
6. **Self-review**, last resort. You can't spawn anything and no human is available.
   1. Don't open any project file until the review is written.
   2. Read the bundle's `CRITIC.md` and follow it exactly, as if you'd never seen the project. Use only the bundle's files.
   3. Write the JSON and run `gate --reviewer self`. The best possible result is `SELF_PASS`, and your report must say the work was not independently reviewed.
7. **No vision.** If no available model can see images, you can't judge visuals. Say so, hand over the captures, and stop.

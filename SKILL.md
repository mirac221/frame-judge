---
name: frame-judge
description: Build frontends, UI animations, motion graphics and videos, then prove they are good instead of claiming it. Use whenever you create or change anything visual - web pages, components, landing pages, dashboards, CSS/JS/canvas/SVG animation, character or sprite animation, HTML-to-video, Remotion, ffmpeg edits, motion design. You render the work, capture screenshots and frame sheets, and a separate code-blind critic subagent judges only the pixels against the user's original words, with evidence, severity and confidence for every finding, inside a capped revise loop. You never grade your own visual work.
license: Apache-2.0
compatibility: Node 18+, ffmpeg and ffprobe on PATH, and Playwright (or playwright-core plus an installed Chrome/Edge) for page capture. Native critic subagents on Claude Code, Codex and Antigravity; other agents fall back to a headless, human-relayed or clearly labeled self review.
metadata:
  version: "0.3.0"
---

# frame-judge

You don't get to grade your own visual work.

You build it and render it. Then a separate critic judges what actually came out on screen against what the user actually asked for. The critic never sees your code, your reasoning or your opinion of the result. Until it passes the work, or the round cap hits, you don't call it done, polished, smooth or beautiful.

Why: the model that wrote the code reads its intent into the output. It "sees" the walk cycle it meant to write, not the one that renders. A critic that only gets pixels plus the user's words can't do that. It has to look.

`<skill>` below means the folder this file is in (in Claude Code: `${CLAUDE_SKILL_DIR}`). Scripts are plain Node 18+ with no install step. They keep state in `.frame-judge/` under your working directory.

## The loop

| Step | What | Who |
|---|---|---|
| 0 | Lock the user's request, verbatim | you |
| 0b | Ask "unsloppy?". If yes, a scout researches the AI defaults to avoid | you, the user, a scout |
| 1 | Build | you |
| 2 | Render and capture: screenshots, frame sheets, motion trails | scripts |
| 3 | Mechanical self-check: it renders, nothing blank, no runtime errors | you |
| 4 | Bundle a code-free review packet | script |
| 5 | Ask which model the critic runs on, if the platform allows it (once) | you, then the user |
| 6 | Critic reviews the bundle | fresh subagent |
| 7 | Gate validates the review and decides | script |
| 8 | Answer every must-fix finding, then back to step 2 | you |
| 9 | Report the critic's verdict, not your opinion | you |

Default cap: 3 critic rounds.

## 0. Lock the brief

```bash
node <skill>/scripts/judge.mjs init --brief-file request.txt --kind frontend,motion
```
Use `--brief "..."` for inline text, or `--brief-file -` to read stdin.

- **Verbatim.** Save the user's message as written: typos, caps, everything. Never paraphrase, summarize or "clarify" it. The critic judges against their words, not your reading of them.
- **Later clarifications** from the user go in with `judge.mjs brief --add "<their exact words>"`. Your own assumptions never go in.
- **Reference images** the user gave you: add `--ref mock.png` (repeatable) so the critic can compare against them.
- **`--kind`** picks the rubrics: `frontend` for pages and UI, `motion` for any animation, `video` for clips and edits. Leave it out to auto-detect from the captures.
- **`--critic-model`** if the user already named one.

This creates `.frame-judge/` (it git-ignores itself) with `brief.md` and `ledger.json`. The ledger survives context compaction. If you lose track, run `judge.mjs status`.

## 0b. Ask about unslop mode (before building)

Ask the user once, in these words:

> Do you want it unsloppy? (experimental: may decrease quality and will spend more tokens)

On Claude Code, ask with AskUserQuestion, in the same prompt as the critic-model question from step 5. Elsewhere, ask in chat. Skip it if the user already said.

- **No:** carry on. Unslop is off by default.
- **Yes:**
  1. Run `judge.mjs set unslop on`, then `judge.mjs scout`. It prints a message for a **slop scout**: a fresh subagent with web search that finds out how AIs typically get this kind of request wrong.
  2. Send the scout that message and nothing else. The same rules as for the critic apply: fresh agent, no fork, nothing added. Use the critic's model if one is set.
  3. Save its reply, then run `judge.mjs avoid --file <reply>`. That rejects lists without real sources.
- **No web search available:** tell the user unslop can't run here, and continue without it.

The avoid list lands in `.frame-judge/avoid.md`, and it's included in every review bundle, so the critic checks the work against it too.

"Experimental" because steering away from defaults can push a build toward odd choices, and the scout costs an extra agent run with web searches.

## 1. Build

If unslop is on, read `.frame-judge/avoid.md` first.
- Design around each pattern. Don't just invert it: the goal is work that fits the brief, not work that's merely different.
- Anything the user explicitly asked for beats the list.

Before building, read the section of [references/craft.md](references/craft.md) for your medium, once per session. It covers what critics flag most: spacing, type, AI-template tells, easing, walk cycles, video pacing.

For anything animated, make time an explicit input: a timeline you can seek, or a `window.frameJudgeSeek(ms)` hook. That makes capture frame-exact, and it turns HTML into video for free.

## 2. Render and capture

**Pages and UI** (needs Playwright; setup in [references/capture.md](references/capture.md)):
```bash
node <skill>/scripts/capture-page.mjs http://localhost:5173 --out .frame-judge/cap/page
```
Defaults are desktop 1440×900, tablet 768×1024 and mobile 390×844, captured screen by screen. Options:
- `--actions states.json` for hover, menu and error states
- `--color-scheme dark`
- `--reduced-motion`
- local files work as well as URLs

**Animation on a page.** This is frame-exact (fake clock plus Web Animations seeking) and encodes to MP4:
```bash
node <skill>/scripts/capture-page.mjs scene.html --out .frame-judge/cap/anim --animate 3000 --fps 30 --selector "#hero"
```

**Any video**, including that MP4:
```bash
node <skill>/scripts/video-frames.mjs .frame-judge/cap/anim/animation.mp4 --out .frame-judge/cap/anim-views --as motion
```

What you get:
- **Viewport slices** instead of one giant full-page image, which would get downscaled into mush.
- **State shots** from your actions file.
- **A timestamped contact sheet.**
- **Filmstrips**: frames sampled at 12 fps by default, plus full-rate strips around any sudden jump or stall the script detects (`--motion-fps source` gives every frame everywhere). Sampled means a one-frame glitch can fall between tiles, which is why the event detection exists.
- **Motion trails**: whatever should stay still stays sharp, and whatever slides smears.
- **Objective numbers**: duration, fps, black or frozen segments, horizontal overflow, broken images.

Capture what the user will experience: every viewport they'd use, the states that matter, the whole animation. The critic can't flag what you didn't show it. Leaving out the ugly parts is exactly the cheating this skill exists to stop.

## 3. Mechanical self-check

Before you spend a critic round, check and fix the binary stuff:
- it renders
- no blank or black frames
- nothing in `builder_only` in each `capture.json` (console errors, failed requests)
- the right duration and size
- `horizontal_overflow_px` and `broken_images` are zero

That's the whole list. You don't get to decide it looks good and skip the critic.

## 4. Bundle

```bash
node <skill>/scripts/judge.mjs bundle .frame-judge/cap/page .frame-judge/cap/anim-views
```

This writes `.frame-judge/round-N/bundle/`. It holds only visual files (png, jpg, webp, gif, plus video if you pass `--include-video`) and these text files:
- `brief.md`, with code blocks stripped
- the rubrics
- `CRITIC.md`, the critic's instructions
- `manifest.json`, with citable artifact IDs
- `prior.json`, from round 2 on: open findings *without* your "fixed" claims, so the critic checks for itself

The script won't open a new round while must-fix findings are unanswered, or past the round cap. It prints the exact message to send the critic.

**Image budget:** aim for 20 images or fewer per round. Claude tightens per-image limits past 20 images in one request. Every image costs about ⌈w/28⌉×⌈h/28⌉ tokens; a 1440×900 shot is around 1.7k. Contact sheets and filmstrips pack 12 to 16 frames into one image, so lean on them. `--slices 3` trims long pages.

## 5. Choose the critic's model (only where the platform supports it)

Ask only if your platform lets you pick a subagent's model, and only once, before round 1. Skip it if the user already named one. Save the answer with `judge.mjs set critic-model <alias>` and reuse it every round.

| Platform | Ask? | How |
|---|---|---|
| Claude Code, Claude apps | Yes | AskUserQuestion, in the same prompt as the unslop question: Sonnet (balanced, recommended), Opus (sharpest eye, most quota), Haiku (cheapest, misses subtle issues), Same as me |
| Codex app, Codex CLI | Yes | Ask in chat, then pass the choice when you spawn the critic |
| Antigravity | No | There's no per-spawn model choice. The critic runs on its agent file's setting; tell the user that. |
| Anything else | No | Unless it clearly supports per-subagent models. Use the default and tell the user which model reviewed the work. |

When you do ask, be straight about the trade-off. A weaker critic is cheaper, but it hallucinates more defects and misses subtle ones. The gate catches fake evidence; it can't catch bad taste.

Exact syntax per platform: [references/platforms.md](references/platforms.md).

## 6. Run the critic

Use a **fresh** critic every round, so it has no memory beyond `prior.json` and no stake in its earlier calls. Send it the message `bundle` printed, and nothing else:

> You are the frame critic. Your bundle is `<abs path>`. Read `<abs path>/CRITIC.md` and follow it exactly. Open nothing outside that folder. Reply with the review JSON only.

- **Add nothing.** No summary of what you built, no "focus on the header", no "I fixed the legs". Your opinion is the one input the critic must never get. If the user wants something checked, it's already in the brief, in their words.
- **No forks.** Never run the critic as a fork or anything else that inherits context. It would see your whole conversation, code included.
- **Prefer the installed agent.** Use `frame-critic` if it exists, because it's limited to reading files. Its name is `frame-judge:frame-critic` when the skill came in as a Claude Code plugin, and `frame_critic` in Codex. Otherwise use a general-purpose subagent with the same message.
- **Claude Code enforces code-blindness.** The plugin's hook blocks the `frame-critic` agent from reading anything outside a `.frame-judge/round-N/bundle/` folder. For the strongest isolation, run `node <skill>/scripts/critic-sandbox.mjs` instead of spawning a subagent: it runs the critic as a separate headless process on a private copy of the bundle, with only the Read tool, and gates the review itself. Codex and Antigravity have no per-agent file sandbox, so there it rests on the critic's instructions; say so in your report.

Save the reply, untouched, to `.frame-judge/round-N/review.json`.

## 7. Gate

```bash
node <skill>/scripts/judge.mjs gate --review .frame-judge/round-N/review.json --reviewer subagent --transcript auto
```
On Claude Code, `--transcript auto` finds the critic subagent's transcript, so the gate counts the images it really opened (not the ones it claims) and voids the review if it touched anything outside the bundle. Elsewhere, leave the flag off; coverage is then self-reported, and the report says so. (`critic-sandbox.mjs` passes its own transcript automatically.)

The gate decides, not the critic's mood and not you. It:
- **Rejects** findings that cite artifact IDs that don't exist or that the critic never opened, findings with no evidence, brief quotes that aren't in the brief, and bad severity or confidence values.
- **Checks coverage:** a pass only counts if the critic opened every image, verified from its transcript where one exists, otherwise from its own `opened` list.
- **Checks isolation:** with a transcript, any read outside the bundle voids the review (`RERUN_CRITIC`).
- **Sorts** the rest:
  - **must-fix**: blocker or major, confidence 0.6 or higher
  - **verify**: blocker or major below 0.6. Recapture closer; don't blind-fix.
  - **polish**: minor
  - **ignored**: nits
- **Checks** that `CRITIC.md` and the rubrics were not edited, so nobody softened the judge.
- **Updates** the ledger and prints one decision:

| Decision | Meaning | You |
|---|---|---|
| `PASS` | No must-fix left, nothing from the brief missing | Report (step 9) |
| `SELF_PASS` | Same, but from a self-review fallback | Report, and say it wasn't independent |
| `REVISE` | Must-fix items exist | Step 8, then a new round |
| `RETHINK` | Critic says the approach is wrong at the root | Tell the user before rebuilding |
| `STOP_MAX_ROUNDS` | Cap hit, still failing | Report what's open, ask whether to continue |
| `STOP_PLATEAU` | This round resolved nothing | Stop circling. Report, ask |
| `RERUN_CRITIC` | Review unusable (no JSON, mostly bogus evidence), a pass from a critic that skipped images, or a critic that read outside its bundle | Run a fresh critic on the same bundle |
| `STOP_CRITIC_UNRELIABLE` | Second unusable review | Suggest a stronger critic model or a fallback |

## 8. Revise

Work through the must-fix items by ID, blockers first. Answer every one before the next round:
```bash
node <skill>/scripts/judge.mjs respond R1-F2 fixed "contact foot planted for 4 frames"
node <skill>/scripts/judge.mjs respond R1-F4 disputed "gutters are equal on both sides" --evidence crop.png
node <skill>/scripts/judge.mjs respond R1-F6 wont-fix "user asked for this gradient" --quote "purple to blue gradient"
```
- **`disputed`** needs **visual** evidence, such as a crop or extra frames. It goes into the next bundle and the next critic rules on it. "The CSS says 16px" is not evidence; pixels are.
- **`wont-fix`** needs a verbatim quote from the brief that the fix would violate.
- **Fix causes, not captures.** Never change the capture to dodge a finding: no cropping out the broken footer, dropping the mobile viewport, or trimming the clip.
- **Verify items and critic `requests`:** capture that spot closer (an action with `clip`, a denser `--motion` window) so the next critic can confirm or kill them.
- **Don't regress** what the critic listed under `keep`.
- **Polish and nits:** fix polish if it's cheap. Ignore nits unless they're trivial.

Then recapture **everything**, not just the part you touched, because fixes break other things. Then bundle, critic, gate.

## 9. Report

Lead with the verdict. `judge.mjs status` prints the block for you:

```
Critic: PASS on round 2 of 3 (subagent, model sonnet, code-blind)
Round 1 gut reaction: "The legs scissor like a broken folding chair."
Fixed: R1-F1 foot sliding · R1-F2 hero text clipped at 390px · R1-F5 unrequested testimonials removed
Open: R2-F3 (minor) nav icon sits 2px low
Disputed: R1-F4, upheld by the critic, fixed in round 2
```

- If it didn't pass, say so first and list what's still open.
- Never describe your own output as great, smooth, polished, clean or pixel-perfect. Quote the critic.
- If the review wasn't independent (self-review), or ran on a different model than the user chose, say so.

## When the platform can't do it

Use the first option that works, and tell the user which one you used:

1. **Native subagent, chosen model.** Claude Code, Codex, Antigravity.
2. **Native subagent, default model.** The platform can't choose; say so.
3. **Headless critic process.** `critic-sandbox.mjs` on any machine with the Claude Code CLI (strongest isolation), or `codex exec` started inside the bundle folder. Commands are in platforms.md.
4. **Human relay.** `bundle` also writes `packet.md`. The user pastes it and the images into any fresh chat with a vision-capable model, then hands you the JSON. Run `gate --reviewer human`.
5. **Self-review**, last resort. Re-read nothing from the project and play the critic from the bundle alone. `gate --reviewer self` can only ever return `SELF_PASS`, and your report must say the work wasn't independently reviewed.
6. **No vision at all.** You can't judge visuals. Say so, hand over the captures, and let a human look.

## Files

| File | When |
|---|---|
| [references/craft.md](references/craft.md) | Before building (the section for your medium) |
| [references/capture.md](references/capture.md) | Capture setup, states files, frame-exact animation, HTML to video, ffmpeg recipes |
| [references/platforms.md](references/platforms.md) | Spawning the critic, the model question and fallbacks, per platform |
| `scripts/critic-sandbox.mjs`, `scripts/critic-guard.mjs`, `hooks/` | Claude Code isolation: the sandboxed critic runner, and the hook that blocks reads outside the bundle |
| [references/scout-brief.md](references/scout-brief.md) | The slop scout's instructions (unslop mode). The scout reads them itself. |
| [references/critic-brief.md](references/critic-brief.md) | Copied into every bundle as `CRITIC.md`. Don't edit it to go easier on yourself; the gate checks it. |
| `references/rubric-*.md` | What the critic scores. Copied into bundles automatically. |
| [references/review.schema.json](references/review.schema.json) | The critic's output format, usable with `--json-schema` / `--output-schema` |
| `agents/` | Optional critic agent definitions for Claude Code, Codex and Antigravity |

# frame-judge

**Your AI keeps calling its own websites, animations and videos "great". frame-judge makes it prove it.**

Your AI builds the work and renders it. Then a second AI, the critic, judges only what's actually on screen, against what you asked for. It never sees the code, and it never hears the builder's opinion. Every complaint has to point at a real frame. Nothing gets called done until the critic passes it.

![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![agent skills](https://img.shields.io/badge/Agent%20Skills-compatible-6b4fbb) ![node](https://img.shields.io/badge/node-18%2B-339933) ![deps](https://img.shields.io/badge/npm%20dependencies-0-brightgreen)

| Works in | Critic | Status |
|---|---|---|
| **Claude Code** (CLI, desktop app, VS Code / JetBrains) | A locked-down headless critic (reads outside its folder are blocked), or the `frame-critic` subagent with an audited transcript | Tested |
| **Antigravity** (app, IDE, `agy` CLI) | A headless `agy` critic whose every file read is audited, or `invoke_subagent` | Tested |
| **Cursor** (IDE and Cursor CLI) | A read-only `frame-critic` subagent | From the docs |
| **Codex** (CLI, IDE, ChatGPT desktop app in Codex mode) | The `frame_critic` agent | From the docs |
| **Claude Cowork**, **ChatGPT Work** | A fresh subagent | From the docs |
| **claude.ai**, **ChatGPT** chat | Relay: upload the zip; the critic runs in a fresh chat | From the docs |

No Playwright needed: page capture drives the Chrome, Edge or Chromium you already have.

## Install

**Send this link to your AI:**

> Install this skill: https://github.com/mirac221/frame-judge

That's it. Your AI reads the setup steps below and does the rest. Or do it yourself in one go: it installs into every agent app it finds on your machine.

```bash
git clone https://github.com/mirac221/frame-judge && node frame-judge/scripts/install.mjs
```

## What the critic sees

The critic doesn't read code. It gets frames: screenshots per device, timestamped filmstrips, and motion trails where anything that should stay still stays sharp.

![Filmstrip of a broken walk cycle, one frame every 83 ms](.github/media/filmstrip.png)
![Motion trail of the same walk: evenly spaced, no planted feet, no bounce](.github/media/trail.png)

That's from a real test. The request was a dark landing page with no gradients and a walking robot mascot. The AI's first attempt got this back from the critic:

> "This is the stock purple-to-blue gradient 'Unlock the power of AI' template. The brief banned gradients and asked for dark everywhere, and the 'robot' is a gliding stick figure with a mystery pink dot."

Each finding behind that verdict pointed at specific frames, and a script checked every one before it counted.

## What the critic checks now

**Every ask, one by one.** AI builders rarely fail by building something ugly. They fail by quietly dropping part of what you asked for. So the critic has to quote every explicit ask in your request, word for word, and mark each one met, partial, missing or contradicted, pointing at the frame that shows it. A script checks every quote against your actual words. An unmet ask becomes a must-fix even if the critic forgot to file it, and a "pass" without this list is sent back.

From a real run on a motion brief (Claude Haiku built it, a Sonnet critic judged it, 18 of 18 frames opened, verified from its transcript):

```
brief: 8/8 asks met
  "staggered by 150ms"          met  strip-1-01: successive peaks about 165ms apart
  "Each dot squashes when it lands."  met  dense-1-01: dot 3 flattening, tiles 1-3
  "the dots must not bounce; they gently fade in and out instead"
                                met  rm-strip-1-01: dots stay level and vary only in opacity
```

**Honest numbers from the November 2026 test.** Claude Haiku built three briefs: a landing page (8 asks), a settings page (8), and the motion brief above (8). A Sonnet critic judged each one, code-blind:
- The critic opened every frame in all three reviews, and the gate verified that from its transcripts (5/5, 2/2, 18/18).
- Haiku's first builds met 23 of the 24 asks. The one gap was a footer the capture had cut off, which is a capture problem, and the critic asked for that frame instead of guessing.
- Haiku revising its own work from screenshots didn't break anything either: the critic passed the revised motion build 9/9.

So on briefs this size, today's models mostly get it right, and frame-judge's job is to *prove* that with evidence, in about a minute, instead of you taking "looks great!" on faith. Where it earns its keep is where models still slip: long briefs, motion, and responsive details. The walking-robot test above is one of those.

**Before and after.** From round 2 on, the critic gets the previous round's frames next to the new ones for every open problem, so "fixed" is checked by comparing, not by taking the builder's word for it.

## Run it

frame-judge only runs when you call it. It stays out of your normal chats: the only thing it costs there is a one-paragraph description (about 100 tokens) telling your AI not to use it unless asked. Its instructions, scripts and critic load only on command. Type the command, then what you want built or fixed:

| App | Command |
|---|---|
| Claude Code (terminal, Claude desktop app, IDE) | `/frame-judge` (`/frame-judge:frame-judge` if installed as a plugin) |
| Codex (CLI, IDE, ChatGPT desktop app in Codex mode) | `$frame-judge` |
| ChatGPT (Chat and Work) | `@frame-judge` |
| Cursor (IDE and Cursor CLI) | `/frame-judge` |
| Antigravity | `/frame-judge` |
| Anything else | "use frame-judge" |

Example: `/frame-judge make me a dark landing page with a walking robot mascot`

## What changes for you

- **The model question:** your AI asks once which model the critic should use, on agents that support it (Claude Code, Codex). Cheaper or sharper, your call.
- **"Do you want it unsloppy?"** (experimental): before building, your AI asks whether to run unslop mode. If you say yes, a scout agent searches the web for how AIs usually get your kind of request wrong. The builder designs around that list, and the critic checks against it. It costs more tokens and can push the design toward odd choices, which is why it's opt-in.
- **Everything gets checked:** phone, tablet and desktop; hover and error states; the whole animation as timestamped frame strips. Strips are sampled (12 fps by default), with every frame shown around any sudden jump or stall it detects.
- **A verdict, not "looks great!":** you get the critic's verdict, what got fixed, and what's still open.
- **No endless loops:** at most 3 review rounds.

## Requirements

- Node.js 18 or newer
- ffmpeg
- For websites: Chrome, Edge or Chromium with Node 22+ (nothing to install), or Playwright
- `node scripts/judge.mjs doctor` tells you what's there
- An AI model that can see images

## Setup steps (for the AI doing the install)

You were sent this link to install frame-judge. Do this, then tell the user what you did.

**1. Clone this repo anywhere and run the installer.** It detects Claude Code, Codex (and the ChatGPT desktop app's Codex mode), Antigravity and Cursor on this machine, and copies the skill and the critic agent into each one's folders. It never overwrites a git clone or a different skill.

```bash
git clone https://github.com/mirac221/frame-judge
node frame-judge/scripts/install.mjs --dry-run   # show what it would do
node frame-judge/scripts/install.mjs             # do it
```

- `--apps claude-code,codex,antigravity,cursor` picks apps instead of auto-detecting.
- `--project <repo>` installs into one project instead of your user folders.
- `--zip` builds `dist/frame-judge.zip` for **claude.ai** (Settings > Capabilities > code execution, then Skills > Upload) and **ChatGPT** (Skills > Create > Upload).
- `--uninstall` removes what it installed.

**2. Claude Code, optional:** install it as a plugin instead, which brings the skill and the critic in one go: `claude plugin marketplace add mirac221/frame-judge`, then `claude plugin install frame-judge@frame-judge`. Claude Cowork takes the same plugin.

**3. Check the requirements:** `node frame-judge/scripts/judge.mjs doctor`. If ffmpeg or a browser is missing, tell the user how to get it. Don't install system software without asking.

**4. Reload:** in the Antigravity CLI, run `/skills reload`. Elsewhere, a new session picks the skill up.

**To update:** `git -C frame-judge pull`, then run the installer again.

<details>
<summary>Prefer to install it yourself? Copy-paste commands</summary>

**Claude Code (plugin):** in Claude Code, run
```
/plugin marketplace add mirac221/frame-judge
/plugin install frame-judge@frame-judge
```

**Claude Code (skill):**
```bash
git clone https://github.com/mirac221/frame-judge ~/.claude/skills/frame-judge
mkdir -p ~/.claude/agents && cp ~/.claude/skills/frame-judge/agents/claude-code/frame-critic.md ~/.claude/agents/
```

**Codex:**
```bash
git clone https://github.com/mirac221/frame-judge ~/.agents/skills/frame-judge
mkdir -p ~/.codex/agents && cp ~/.agents/skills/frame-judge/agents/codex/frame-critic.toml ~/.codex/agents/
```

**Antigravity:**
```bash
git clone https://github.com/mirac221/frame-judge ~/.gemini/config/skills/frame-judge
mkdir -p ~/.gemini/config/agents && cp ~/.gemini/config/skills/frame-judge/agents/antigravity/frame-critic.md ~/.gemini/config/agents/
```

**Windows PowerShell** (Claude Code shown; for other apps, `scripts/install.mjs` picks the right folders):
```powershell
git clone https://github.com/mirac221/frame-judge "$HOME\.claude\skills\frame-judge"
New-Item -ItemType Directory -Force "$HOME\.claude\agents" | Out-Null
Copy-Item "$HOME\.claude\skills\frame-judge\agents\claude-code\frame-critic.md" "$HOME\.claude\agents\"
```

</details>

## How the critic stays honest

| Problem | What frame-judge does |
|---|---|
| The builder grades its own work | The critic never gets the code, the builder's reasoning, or its "I fixed it" claims. A script checks the critic's instructions weren't edited to go easy. |
| The critic peeks at the code anyway | With the Claude Code CLI installed, the critic runs as a separate, locked-down process on a private copy of the review folder. A hook blocks any read outside that copy, so it's enforced, not just asked for. With Antigravity's `agy` CLI, the critic runs the same way, and every file it opened is checked afterwards. In-session critics on Claude Code are audited too: any review whose transcript shows it touched other files is thrown out. Cursor and Codex subagents have no per-agent file sandbox, so there it's instruction-only (Cursor's critic is at least read-only). |
| The critic skips half your request | It must list every explicit ask from your words, quoted verbatim, with a status and a frame. Made-up quotes are dropped; unmet asks become must-fix items; a pass without the list is sent back. |
| The critic only criticizes | Every criticism needs evidence. A pass is a legitimate verdict, and the critic must name what works so fixes don't break it. |
| "Good" is subjective | Written rubrics for websites, motion and video, with 1–5 scores and named red flags: foot sliding, linear easing, AI-template tells, and more. |
| The critic makes things up | A finding has to cite a frame it actually opened, or quote your request word for word. Otherwise it's thrown out. Unsure findings get a closer capture, not a blind fix. |
| The critic skims | A pass only counts if the critic opened every image. On Claude Code that's checked against the critic's actual file reads in its transcript, so claiming it looked doesn't work. Elsewhere it's the critic's own list. |
| Short glitches hide between sampled frames | The video tool scans every source frame for sudden jumps and stalls and adds full-rate strips around them. `--motion-fps source` shows every frame everywhere. |
| Builder and critic talk past each other | Findings have IDs. The builder answers each one: fixed, disputed (with screenshots, never code), or won't fix (quoting your request). The next critic sees before and after frames side by side. |
| It loops forever | At most 3 rounds, and it stops early if a round fixes nothing. |
| Agents differ | It uses a real subagent where the agent has one, a separate CLI critic where it doesn't, or a clearly labeled self-review as a last resort. |

<details>
<summary>What's in the repo</summary>

```
SKILL.md                 the workflow your AI follows
references/
  critic-brief.md        the critic's instructions, copied into every review
  scout-brief.md         the slop scout's instructions (unslop mode)
  rubric-frontend.md     layout, type, colour, responsive, states, AI-template tells
  rubric-motion.md       timing, easing, arcs, continuity, weight, walk cycles
  rubric-video.md        structure, pacing, composition, transitions, delivery
  review.schema.json     the critic's answer format
  platforms.md           running the critic on each agent, and the fallbacks
  capture.md             capture options, frame-exact animation, HTML to video
  craft.md               how to build it well the first time
scripts/
  capture-page.mjs       screenshots per device and state, frame-exact animation to MP4
  cdp.mjs                drives your installed Chrome/Edge over DevTools when Playwright isn't installed
  install.mjs            installs into every agent app on the machine; --zip for claude.ai and ChatGPT
  video-frames.mjs       contact sheets, filmstrips, motion trails, jump/stall detection, black/frozen-frame checks
  judge.mjs              doctor, locks the request, builds the review packet, checks the verdict, every ask, and the critic's transcript
  critic-guard.mjs       blocks the sandboxed critic from reading outside its review folder
  critic-sandbox.mjs     runs the critic as a separate process: locked-down claude, or audited agy
agents/                  the critic for Claude Code, Cursor, Codex and Antigravity, plus Codex's command-only setting
.claude-plugin/          Claude Code plugin files
```

</details>

**Also by me:** [assumption-judge](https://github.com/mirac221/assumption-judge), an independent judge that fact-checks every reply your AI agent writes and interrupts only on a hallucination.

## License

[Apache-2.0](LICENSE) © 2026 mirac221. Use it, change it, ship it. When you share it, keep the [LICENSE](LICENSE) and [NOTICE](NOTICE) files so the credit stays with the original work.

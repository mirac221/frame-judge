# Capture: getting pixels the critic can judge

## Setup

**ffmpeg and ffprobe** must be on PATH. They're used for every video view and for encoding animations.

**Playwright** is only for `capture-page.mjs`. The script looks for `playwright`, `playwright-core` or `@playwright/test` in three places: the project you run it from, the skill folder, and the global npm root. To point at a specific install, set `FRAME_JUDGE_PLAYWRIGHT=/path/to/node_modules/playwright`. If none is installed, ask the user before adding a dependency. Either option works:
- `npm i -D playwright`, then `npx playwright install chromium`.
- `npm i -D playwright-core`, then pass `--channel chrome` or `--channel msedge` to use a browser that's already installed. Nothing extra gets downloaded.

If launching the bundled Chromium fails, the script falls back to the installed Chrome, then Edge.

## Pages and UI: `capture-page.mjs`

```bash
node <skill>/scripts/capture-page.mjs <url|file.html> --out <dir> [options]
```

| Option | Default | What |
|---|---|---|
| `--viewports` | `desktop,tablet,mobile` | Presets (`desktop` 1440×900, `laptop` 1280×800, `tablet` 768×1024, `mobile` 390×844@2x) or `WIDTHxHEIGHT[@DPR]` |
| `--slices N` | `6` | Max screens captured per viewport, scrolling down the page. The manifest records the screens that weren't captured. |
| `--actions file.json` | none | Interaction states (see below) |
| `--color-scheme dark` | `light` | Also `no-preference`. `--dark` is shorthand. |
| `--reduced-motion` | off | Emulates `prefers-reduced-motion: reduce` |
| `--wait ms` | `500` | Extra settle time after load |
| `--live-animations` | off | By default, screenshots fast-forward finite CSS animations and transitions to their end state, so layout is judged settled. This flag keeps them running. |
| `--channel chrome\|msedge` | bundled | Use an installed browser |
| `--dpr N` | per preset | Override the device pixel ratio for every viewport |

The output dir gets one PNG per artifact plus `capture.json`. That file holds artifact ids, mechanical descriptions and measurements (`page_height_px`, `screens`, `horizontal_overflow_px`, `broken_images`). It also has a `builder_only` block with console errors, page errors and failed requests. Those are for you, and the bundle never copies them.

### Actions file (states)

The steps run in order, on every viewport unless a step has `only`. Add `shot` to screenshot after a step; `clip` (a selector) crops that shot to one element, which is useful for verify requests.

```json
[
  { "do": "click", "selector": "button[aria-label='Menu']", "wait": 400, "shot": "menu-open", "only": ["mobile"] },
  { "do": "press", "key": "Escape" },
  { "do": "hover", "selector": ".plan-card >> nth=1", "shot": "plan-hover", "only": ["desktop"] },
  { "do": "focus", "selector": "input[type=email]", "shot": "email-focus", "clip": "form" },
  { "do": "fill", "selector": "input[type=email]", "text": "not-an-email" },
  { "do": "click", "selector": "button[type=submit]", "wait": 300, "shot": "form-error" },
  { "do": "scroll", "selector": "#pricing", "shot": "pricing" },
  { "do": "reload" },
  { "do": "shot", "selector": "footer", "shot": "footer-zoom" }
]
```

- **Steps (`do`):** `hover`, `click`, `focus`, `fill`, `press` (`key`, with an optional `selector`), `scroll` (`selector` or `y`), `wait` (`ms`), `reload`, `shot`.
- **Labels:** state ids come out as `<viewport>-<shot>`. The critic sees the `label` text if you give one, or the shot name otherwise. It never sees selectors, because those are implementation.

## Frame-exact animation: `--animate`

```bash
node <skill>/scripts/capture-page.mjs scene.html --out <dir> --animate 3000 --fps 30 [--viewports 1920x1080] [--selector "#hero" --pad 32] [--encode out.mp4]
```

How it works:
1. Playwright's fake clock is installed before load. `Date`, `performance.now`, timers and `requestAnimationFrame` advance only when the script says so, so JS, canvas, GSAP, three.js and Lottie render exactly frame N.
2. Every CSS animation and transition (and any Web Animations API animation) is paused and seeked to the frame's time.
3. If the page defines `window.frameJudgeSeek(ms)`, that hook is called instead of the Web Animations seek. Your page owns its timeline then, so seek everything yourself. This is the most reliable route for animations you write.
4. Frames land in `<dir>/frames/` and get encoded to `<dir>/animation.mp4` (H.264, yuv420p, CRF 16). Use `--encode path.mp4` to choose the file.
5. Then cut views for the critic: `video-frames.mjs <dir>/animation.mp4 --out <dir>/views --as motion`.

Notes:
- **`--selector`** fixes a clip around the element's box at t=0, plus `--pad` pixels, so every frame is the same size. Make the pad big enough for the element's motion.
- **`--no-clock`** helps if the page misbehaves under the fake clock. CSS motion stays frame-exact; JS motion then runs in real time and `capture_timing` becomes `approximate`.
- **Not controlled:** `<video>` elements, animated GIFs, timers inside Web Workers, and scroll-driven CSS animations. Capture those with scroll actions or a real recording.
- **Duration:** capture the whole thing, loops included. Make it at least one full cycle plus a few frames, so the critic can see the seam.

## HTML to video

The same pipeline renders videos:
1. Build the scene as a function of time: CSS keyframes, WAAPI, a rAF loop, or a `frameJudgeSeek(ms)` that draws frame N.
2. Render it:
   ```bash
   node <skill>/scripts/capture-page.mjs scene.html --out .frame-judge/cap/render --animate 8000 --fps 30 --viewports 1920x1080 --encode out/final.mp4
   ```
   Use `--viewports 1080x1920` for vertical.
3. Add audio afterwards: `ffmpeg -i out/final.mp4 -i music.mp3 -c:v copy -c:a aac -shortest out/final-audio.mp4`.

For Remotion or any other renderer, render with its own CLI, then run `video-frames.mjs` on the result.

## Videos: `video-frames.mjs`

```bash
node <skill>/scripts/video-frames.mjs <video> --out <dir> [options]
```

| Option | Default | What |
|---|---|---|
| `--as video\|motion` | `video` | Picks the rubric kind hint, and the default keyframe count (4, or 2 for motion) |
| `--overview N` | `16` | Tiles in the contact sheet; `0` skips it |
| `--keyframes N` | 4 / 2 | Full-resolution single frames, long edge capped at 1568 px |
| `--motion a-b` | whole clip if ≤ 6 s | Window in seconds to cut into filmstrips plus a motion trail. Repeatable. |
| `--motion-fps N` | `12` | Filmstrip sample rate, capped at the source fps. `source` shows every frame. At 12 fps from a 30 fps clip, 3 frames in 5 are skipped, so a one-frame glitch can fall between tiles. |
| `--events N` | `2` | Scans every source frame for sudden jumps (pops, teleports) and stalls (dropped or repeated frames), and adds a full-rate `dense-N` strip around each, up to N. `0` turns it off. Detected events are listed in `motion_events`. |
| `--cols N` / `--rows N` | `4` / `3` | Filmstrip grid: 12 frames per image |
| `--width px` | `1536` | Sheet width |
| `--diffs` | off | Also writes frame-difference strips: bright means it changed. Good for flicker and jitter. |
| `--no-detect` | off | Skips the black, freeze and scene-change detection pass |
| `--no-labels` | off | No burned-in timestamps. The manifest still maps tiles to times. |

What the measurements contain: duration, fps, size, frame count, codec, audio (presence, integrated loudness, silences), `black_segments`, `freeze_segments`, `scene_changes_s`.

**Labels:** timestamps are burned in with ffmpeg `drawtext`, using a system font it finds (Consolas or Arial on Windows, Menlo on macOS, DejaVu or Liberation on Linux). To choose one, set `FRAME_JUDGE_FONT=/path/font.ttf`. If drawtext fails, the script carries on without labels.

## Image budget

Claude bills an image at about ⌈w/28⌉ × ⌈h/28⌉ tokens:

| Image | Tokens |
|---|---|
| 1440×900 | ~1.7k |
| 1536-wide sheet | ~2–3k |

Claude 4.7-and-later models take up to a 2576 px long edge natively; older ones downscale past 1568 px. Requests with more than 20 images get stricter per-image limits. Other vendors differ, but the advice is the same:
- Keep each round at about 20 images or fewer.
- Prefer sheets and strips over loose frames.
- Slice tall pages rather than sending them full-length.
- For a `verify` item, send a tight crop, not another full screen.

## Hand-rolled views

`video-frames.mjs` does these for you. Use them when you need something custom.

```bash
# contact sheet, 2 fps, 4x4
ffmpeg -i in.mp4 -vf "fps=2,scale=376:-2,tile=4x4:padding=6:margin=6:color=white" -frames:v 1 sheet.png
# motion trail of 1.0–2.0 s
ffmpeg -ss 1 -t 1 -i in.mp4 -vf "fps=8,tmix=frames=8" -update 1 trail.png
# zoomed crop for a verify item (crop=w:h:x:y)
ffmpeg -ss 2.5 -i in.mp4 -frames:v 1 -vf "crop=400:300:800:600,scale=1200:-2:flags=neighbor" zoom.png
# delivery encode
ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p -crf 18 -preset slow -movflags +faststart -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" out.mp4
```

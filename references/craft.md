# Craft: build it so the critic has less to say

Read the section for your medium before building. None of this replaces the critic. It just means round 1 isn't a massacre.

## Before anything

- **Re-read the brief and list it.** What was asked for explicitly, the constraints, and the style words. Build that, not your favourite version of it. Every unrequested section, feature, testimonial or animation counts as a scope finding.
- **Pick a direction on purpose.** Name the reference in your head ("editorial, lots of whitespace, one accent colour"). Defaults are what make AI output look like AI output.
- **Set tokens first.** A spacing scale, a type scale, colour roles, a radius and a shadow. Then use only those. Most "it looks off" findings are one-off values.
- **Use real content.** Plausible copy in the user's domain. Not lorem ipsum, not invented stats, not fake customer logos.

## Frontend

**Spacing**
- Use a 4/8 px scale: 4, 8, 12, 16, 24, 32, 48, 64, 96.
- Equal relationships get equal gaps.
- Spacing inside a component is smaller than spacing between components, and that is smaller than spacing between sections.

**Type**
- One scale with a ratio of 1.2–1.333: 14, 16, 18, 22, 28, 36, 48.
- Body 16–18 px. Line height 1.5–1.65 for body and 1.1–1.25 for headings.
- Line length 45–90 characters (`max-width: 65ch`).
- At most two families.
- Use weight and size for hierarchy, not five shades of grey.

**Colour**
- One brand colour, a neutral ramp, and semantic colours (success, warning, danger).
- Text contrast at least 4.5:1, and 3:1 for large text and UI.
- Design the dark mode: lift the surfaces, desaturate the accents. Don't just invert.

**Layout**
- Use one grid. Align to edges; don't centre everything by default.
- Give the eye one entry point per screen and one primary action.

**Responsive**
- Lay out mobile on purpose: stack, reorder, resize the type. Don't just squeeze the desktop.
- Tap targets at least 44 px. No horizontal scroll.
- Test 390, 768 and 1440 wide.

**States**
- Every interactive element gets hover, `:focus-visible`, active and disabled styles.
- Forms get error, empty and loading states.
- The focus ring must be visible.

**Craft**
- One icon set, at one size and stroke, optically aligned with its text.
- Consistent radii and shadows. Images use `aspect-ratio` and `object-fit`.
- No layout shift on load.

**Tells that scream "AI made this"**
Avoid these unless the brief asks for them:
- a purple-to-blue gradient hero with a centred headline and two buttons
- three identical feature cards with emoji icons
- glassmorphism and glow on everything
- "Trusted by 10,000+ teams" and a grey logo wall
- "Unlock / Elevate / Supercharge your workflow"
- gradient text on every heading
- a dark navy background with neon accents by default
- an animation on every element as it scrolls in

## Motion (UI)

**Purpose first.** Motion should show where something came from, what changed, or where to look. If it does none of these, cut it.

**Durations**
| Motion | Duration |
|---|---|
| Micro-interactions (hover, press) | 100–200 ms |
| Small transitions | 200–300 ms |
| Panels and modals | 300–400 ms |
| Page-level moves | ≤ 500–700 ms |

Bigger distance means a slightly longer duration. Exits are a little faster than entrances.

**Easing**
- Entering: ease-out, e.g. `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Exiting: ease-in.
- Moving on screen: ease-in-out.
- Physical feel: a spring with light overshoot, used sparingly.
- Never linear for anything physical. Linear is for spinners and progress bars.

**Choreography**
- Stagger lists by 30–60 ms, and cap the total.
- Related things move together.
- One hero motion at a time.

**Performance**
- Animate `transform` and `opacity` only. Not width, height, top or left.
- Avoid `filter: blur()` on large areas.

**Accessibility:** under `prefers-reduced-motion: reduce`, drop movement and keep opacity fades.

**Loops**
- The last frame must hand off seamlessly to the first.
- Use `animation-timing-function` per keyframe, or one ease across the whole cycle, but not a hard stop at the seam.

## Character and creature animation

This is the part critics catch most, because "a stick figure that moves" is not "a walk".

**A walk cycle**
- Four key poses per step: contact, down, passing, up.
- A normal walk is about 1 s per two steps, so at 24 fps each step is about 12 frames.
- **Contact foot:** planted, with zero sliding. In place (ground scrolling), the planted foot moves with the ground at exactly ground speed. Travelling, the planted foot stays fixed in world space.
- **Bob:** the hips are lowest at down (just after contact) and highest at up (just after passing).
- **Counter-movement:** arms swing opposite to the legs, and shoulders counter-rotate against the hips.
- **Knees:** they bend forward and never hyperextend backward. Limb lengths never change.
- **Arcs:** heads, hands and heels travel on arcs. Add overlap: hair, clothes, tails lag a few frames.

**Rigging in CSS or SVG**
- Nest groups as hip → thigh → shin → foot, and put each `transform-origin` at the joint.
- Rotate children relative to their parents. Don't move each limb independently.
- Foot planting needs either inverse kinematics (solve the knee from hip and foot positions) or keyframing the foot position and deriving the rotations. Pure rotation keyframes almost always slide.

**Weight**
- Anticipation before a jump, squash on landing (keep the volume constant), follow-through after.
- Heavy things accelerate slowly and stop slowly.

## Video

**Format**
- Output what was asked: 16:9 at 1920×1080, or 9:16 at 1080×1920 for Shorts, Reels and TikTok.
- Constant frame rate, 24, 30 or 60.
- H.264 yuv420p with `-movflags +faststart` and even dimensions.

**Safe areas**
- Keep text inside about a 5% margin.
- In vertical video, keep text clear of the bottom ~20% and the right edge, where the platform's buttons and captions sit.

**Text on screen**
- Leave it up long enough to read twice: roughly 3 words per second, plus a beat, and at least 1.5 s.
- Give it a backing (a shadow, a box or a darkened area) over busy footage.

**Pacing**
- For social video, the hook lands in the first 1–2 s.
- Vary the shot lengths, and cut on action or on a beat.
- Hold the end card for at least 1 s.

**Transitions:** pick one or two styles and keep them. A straight cut is the default; cross-dissolves and whips need a reason.

**Audio loudness** (if there's audio):
| Destination | Target |
|---|---|
| Streaming and social | ≈ -14 LUFS integrated |
| Broadcast (EBU R128) | -23 LUFS |

Check it with `video-frames.mjs`; it reports integrated loudness.

**Clean edges:** no black flash frame at the start, and no cut-off last frame. Check `black_segments` and the last tile of the contact sheet.

## Authoring HTML that renders to video

- **Make the timeline deterministic.** Drive everything from one `t`: CSS keyframes, WAAPI, a rAF loop that reads `performance.now()`, or a `window.frameJudgeSeek(ms)` that draws frame N. Avoid `Math.random()` unless it's seeded.
- **Set the canvas exactly.** Use `html, body { margin: 0; overflow: hidden }` and a stage at exactly the output size (for example 1920×1080). Capture with `--viewports 1920x1080`.
- **Wait for assets.** Preload fonts and images before t=0. Fonts loading mid-animation cause a visible pop.

# Rubric: motion (UI animation, motion graphics, character and sprite animation)

How to read the artifacts:
- **Filmstrips.** Read tile by tile, left to right and top to bottom. Each tile is stamped with its time in ms; `manifest.json` maps every tile to a time.
- **Sampling.** Most strips are samples (their `shows` says the rate), so a one-frame glitch can fall between tiles. `dense-*` strips show every frame around a sudden jump or stall the capture script detected (`motion_events`); judge whether it's a defect or intended. If motion looks suspicious and no dense strip covers it, add a `requests` entry for full-rate frames of that window.
- **Motion trails.** These average several frames into one image. Whatever is still stays sharp; whatever moves leaves ghosts along its path.
- **Scrolling ground.** If the ground or background scrolls, a planted foot must move exactly with it.
- **Measurements.** Treat `freeze_segments` and `black_segments` as facts, not verdicts. A hold can be intentional.
- **Timing.** If `capture_timing` is `exact`, uneven spacing between tiles is real, not a capture glitch.

### `fidelity`: the motion the brief asked for
The right thing moves, in the right style ("bouncy", "subtle", "cinematic"), with the right duration and loop behaviour.

### `timing`: speed and rhythm
- UI micro-interactions run about 100–200 ms, small transitions about 200–300 ms, larger moves about 300–500 ms.
- Nothing is sluggish, and nothing is too fast to follow.
- Spacing between frames matches the intended speed, with holds where the eye needs them.

Red flags: everything the same duration; a 1.2 s button hover; text animating out before it can be read.

### `easing`: acceleration
- Physical and UI motion speeds up and slows down.
- Entrances ease out; exits ease in.
- Overshoot appears only where it means something.

Red flags: constant-speed (linear) movement on anything physical, which shows as equal spacing across every tile; robotic starts and stops; bounce on everything.

### `arcs`: paths
Limbs, heads, thrown objects and most natural moves travel on arcs. Trace them in the trail.

Red flags: straight-line limb motion; zig-zag paths; arcs that kink.

### `continuity`: smoothness
- No pops, jumps, jitter, flicker, sudden resets, or duplicated or dropped frames.
- Loops are seamless: compare the last tiles with the first.
- Things that should be static stay pixel-still.

Red flags: an element teleporting between neighbouring tiles; a loop that visibly snaps back; shimmering edges.

### `weight`: physics and believability
- Anticipation before big moves; follow-through and overlap after them.
- Squash and stretch keeps the volume constant.
- Contact and gravity are plausible, and heavy things move slower.

Red flags: objects stopping dead; floating with no reason; stretch that changes the volume.

### `character`: bodies (characters and creatures only)
- Walk and run cycles have readable key poses: contact, down, passing, up.
- Feet stay planted during contact, with no sliding.
- Knees and elbows bend the right way, and limb lengths stay constant.
- Hips and shoulders counter-rotate, and arms swing opposite to the legs.
- The body bobs: lowest at down, highest at up. Head and hands travel on arcs.

Red flags:
- sliding feet (smeared feet in the trail)
- legs pivoting like scissors from a single hip point
- detached or stretching limbs
- the arm and leg on the same side moving together
- no vertical bob

### `staging`: readability
- It's clear where to look.
- The main action isn't clipped by the frame or hidden behind other motion.
- Secondary motion supports the main action and doesn't compete with it.

### `purpose`: does the motion earn its place?
- The motion communicates state, hierarchy or story; it isn't decoration slapped on everything.
- In any reduced-motion captures, big movement is removed or softened.

### `render`: technical quality
- Steady frame rate.
- Crisp edges and text.
- No tearing, banding, z-fighting, objects clipping through each other, or compression smear.

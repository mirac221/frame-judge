# Rubric: video (edits, generated clips, HTML-to-video, motion design pieces)

You probably can't hear audio. Treat the `audio` measurements (presence, loudness, silences) as facts, and don't invent judgments about sound. If you can watch video natively, the `video` artifact is there for you. Either way, cite sheet tiles and timestamps so the builder can find what you saw.

### `fidelity`: what the brief asked for
Duration, aspect ratio, resolution, content and tone match the brief. Check the measurements.

### `structure`: story and flow
- A clear opening, middle and end, and the message lands.
- For social video, the first 1–2 seconds give a reason to keep watching.
- It ends on a deliberate frame, not mid-motion.

### `pacing`: shot and scene lengths
- On-screen text stays up long enough to read: roughly 3 words per second, plus a beat.
- Nothing drags.
- Cuts aren't frantic unless that was the ask.

### `composition`: framing
- Subjects are framed with intent.
- Key content sits inside the safe areas: about a 5% margin on every edge. Vertical video also keeps text clear of the bottom ~20% and the right edge, where platform UI sits.
- Overlays are aligned consistently, and nothing important is cut off by an edge.

### `type`: on-screen text
- Legible at phone size.
- Enough contrast against moving backgrounds.
- Consistent styles, no typos.
- No text over busy areas without a backing.

### `transitions`: cuts and transitions
- Purposeful and consistent.
- No flash frames, black frames or accidental jump cuts. Check `black_segments` and `scene_changes_s`.

### `motion`: animated elements
Apply the timing, easing and continuity standards from the motion rubric to anything animated, even when that rubric isn't included.

### `technical`: delivery
- Resolution, fps and aspect ratio as asked; a steady frame rate.
- No banding, blockiness, stretching or accidental letterboxing.
- Clean first and last frames.
- No unintended frozen segments (`freeze_segments`).
- Audio present if it was expected.

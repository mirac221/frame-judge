# Rubric: frontend (pages, components, UI)

Score each criterion that the artifacts can actually show. If a criterion can't be judged (for example `states` when no state shots were captured), leave it out of `scores` rather than guessing.

### `fidelity`: does it do what the brief asked?
- The requested sections, components, content and behaviour are there and easy to recognize.
- Style words in the brief ("minimal", "brutalist", "playful", "like Linear") are visibly honoured.

Red flags: the requested thing is technically present but buried; a generic substitute stands in for a specific ask.

### `hierarchy`: is it obvious where to look and what to do?
- One clear primary action per screen.
- Headline, then subhead, then body reads at a glance.
- Important things look important.

Red flags: three competing CTAs; everything the same visual weight; the primary action pushed below the fold for no reason.

### `layout`: alignment, grid, grouping
- Elements share alignment edges, on a consistent grid or set of columns.
- Related things are grouped and unrelated things separated.
- Whitespace is balanced.

Red flags: ragged left edges; everything centred by default; orphaned elements; overlaps; cards in one row with random heights.

### `spacing`: rhythm
- A consistent spacing scale: equal gaps for equal relationships.
- Section padding is consistent.
- Nothing is jammed against an edge.

Red flags: 12px here and 18px there for the same relationship; text touching its container; huge random gaps.

### `type`: typography
- A clear scale with distinct steps.
- Body text big enough to read (about 16px or more on mobile).
- Line length roughly 45–90 characters, with comfortable line height.
- At most two families.

Red flags: clipped or overflowing text; tiny grey body copy; all-caps paragraphs; sizes 1px apart; a single word stranded on the last line of a headline.

### `color`: colour and contrast
- A coherent palette with clear roles.
- Text contrast looks at least WCAG AA: 4.5:1 for body, 3:1 for large text and UI.
- States are distinguishable.
- A dark mode is designed, not inverted.

Red flags: light grey on white; neon on neon; colour as the only error signal; accent colours that change from section to section.

### `responsive`: every captured viewport looks designed
- Mobile is composed for mobile, not a squeezed desktop.
- No horizontal overflow (check `horizontal_overflow_px` in the measurements).
- Tap targets look at least 44px.
- Nav adapts, and images keep their aspect ratio.

Red flags: text running over images at 390px; buttons wrapping into two lines; a desktop page that is just a narrow phone column, unless intended.

### `states`: interaction states (only if captured)
- Hover, focus, active, disabled, loading, empty and error states exist and are visible.
- Focus is visible.
- Errors say what to do.

Red flags: no visible focus; hover identical to rest; an error state that is just red text with no message.

### `craft`: details
- Icons come from one family, at consistent size and stroke, optically aligned with their text.
- Radii and shadows are consistent.
- Images are crisp: not stretched, blurred or badly cropped.
- No broken images (check `broken_images`), and no visible "undefined", "NaN", lorem ipsum or grey placeholder boxes.

Red flags: emoji standing in for icons in a "professional" UI; mixed outline and filled icons; one card with a different radius.

### `identity`: does it look designed, or default?
The page has a point of view that fits the brief. It is not the stock AI template:
- a purple-to-blue gradient hero
- a centred headline with two buttons
- three emoji feature cards
- glassmorphism everywhere
- a fake logo wall, "Trusted by 10,000+ teams", "Unlock the power of…"

Red flags: swap the logo and it could be any AI-generated SaaS page. Only penalize defaults the brief didn't ask for.

### `content`: copy and data
- Plausible, specific, and consistent with the brief.
- No invented metrics, testimonials, customer logos or legal claims unless asked.
- Labels say what things do.

Red flags: fake stats; "John Doe, CEO"; "Click here" buttons; the product name spelled two ways.

# Part 4 — The Dive: design plan

## Palette

The page background is always `#000000`. The planet's brightest chromatic palette stop supplies the accent (not a fixed site color):

- Deep Sea aqua — `#8CEBF0`
- Ember gold — `#FFCD32`
- Aurora pink — `#E66EC8`
- Ice blue — `#CDF2FF`

These are the brightest non-neutral stops of the four existing palettes. The terminal white stop is omitted so the accent remains recognizably tied to the selected planet. Before a planet exists, the accent is unset; only a single faint point breathes on the black page. Type is soft white and subdued gray, not an additional glow.

## Type

- **DM Sans**: invitation, button, status, and short supporting text; chosen for a clear, humanist interface voice.
- **Noto Sans** family: the typed name and landing name. The stack includes Noto Sans Devanagari, Noto Sans Arabic, and Noto Sans SC before a system sans-serif fallback so names retain script coverage.

The script-specific Noto faces are language-coverage fallbacks within one Noto family role, not additional display styles. Neither family uses the prohibited fonts.

## Screens and alignment

All screens share a pure-black full-viewport canvas and a centered vertical axis. On mobile, the square rendering stage is at most the viewport width; on desktop it is centered and at most the viewport height. Controls stay in the bottom safe-area region, with touch targets at least 44 px.

```text
S1 — Idle                         S2 — Gathering
┌────────────── 390 px ─────────┐ ┌────────────── 390 px ─────────┐
│                               │ │                               │
│             ·                 │ │              ·                │
│                               │ │      letters loosen into      │
│      Give the dark a name.    │ │       points toward light      │
│            Priya              │ │                               │
│      [ Fall into your planet ]│ │       Finding your planet      │
└───────────────────────────────┘ └───────────────────────────────┘

S3 — Dive, early                 S3 — Dive, later
┌────────────── 390 px ─────────┐ ┌────────────── 390 px ─────────┐
│                               │ │                               │
│       whole-set pattern       │ │       enlarging detail        │
│        · camera target        │ │         · destination          │
│                               │ │                               │
│                               │ │                               │
└───────────────────────────────┘ └───────────────────────────────┘

S4 — Landing                     Error / unavailable
┌────────────── 390 px ─────────┐ ┌────────────── 390 px ─────────┐
│                               │ │                               │
│       planet, circle crop     │ │               ·               │
│       halo + seeded stars     │ │       WebGPU is unavailable.   │
│                               │ │       Open this page in a      │
│             Priya             │ │       supported browser.       │
│      [ Save my planet ]       │ │                               │
│      [ Try another name ]     │ │                               │
└───────────────────────────────┘ └───────────────────────────────┘
```

The invitation, name, stage, and controls align to the same center line. The name is a real, labelled text input made visually transparent beneath a large mirrored text treatment; focus remains visible. Landing controls use a single vertical stack. No sidebar, card, stats strip, navigation, decorative eyebrow, or dashboard is present.

## Motion and integer camera

Let `W` be the final catalogue `widthQ24`, `Q = 2^24`, and
`N = ceil(log2(3Q / W)) + 1`. For `i` from 0 through `N-1`, let
`t = i / (N-1)` and `u = i / (N-1)`:

- `width_i = round(3Q * (W / (3Q))^t)`, clamped to `[W, 3Q]`, with the last width set exactly to `W`.
- `center_i = start + round((destination - start) * u)` per axis, with `start=(-Q/2, 0)` and the last center set exactly to the engine center.
- `maxIter_i = 500 + floor(1500 * i / (N-1))`, with the endpoints explicitly 500 and 2000.
- `scaleQ24_i = floor(width_i / 512)`; reject a sequence if any scale is below 256 or the destination falls outside any keyframe view.

Camera interpolation and crossfade use the current palette. The frame easing is cubic ease-in/out. Each keyframe is rendered by the existing fixed-point path and adaptive dispatch; the previous completed frame remains visible until the next is ready. Gathering animation continues while all keyframes are computed. Reduced-motion skips camera movement and crossfade-fades to the final render. Keyframe iteration data is hashed with the existing FNV-1a helper and included in a debug record.

## Sound and edge handling

Sound is off by default and requires a user gesture to enable. The toggle gates one synthesized, quiet low-frequency swell during the dive; no asset or sound starts automatically. Empty input gets inline guidance. Overlong input identifies the 40-character limit. GPU absence gives a recovery instruction. Device loss invalidates the run and provides a clean restart action rather than leaving a frozen frame.

## Critique and revision

The first pass risked looking like a familiar dark “space” landing page because a glowing point, a planetary halo, and accent-colored controls can become a generic neon theme. I revised it by removing every decorative accent before planet selection, keeping the idle prompt and controls neutral, making the name and camera composition the only typographic focus, and reserving the selected palette color for the point, dive imagery, focus treatment, and final halo. I removed dashboard-like debug output from the visible screens and kept the dive—not gradients, labels, or entrance animations—as the sole expressive feature.

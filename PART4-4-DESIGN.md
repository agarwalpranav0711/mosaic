# PART 4.4 — HOME SCREEN DESIGN SPECIFICATION

## 1. Palette & Named Colors (Pure Black Substrate)
- **Void Black** (`#000000`): The uninterrupted canvas. Never elevated into dark gray sheets, never covered by cards.
- **Luminous Ink** (`#f2f2f2`): Primary typography for the typed planet name and key actions.
- **Quiet Mineral** (`#999999`): Secondary text, invitations, and subtle status messages.
- **Neutral Light** (`#c9c9c9`): The idle breathing point core before any planet is computed.
- **Dynamic Planet Accent** (resolved per palette):
  - *Deep Sea:* `#90ebf0` (pale aqua luminescence)
  - *Ember:* `#ffd132` (radiant gold heat)
  - *Aurora:* `#e66ec8` (starlight violet/pink)
  - *Ice:* `#7dd7f8` (glacial blue)
- **Deep Radial Shadow** (`rgba(0, 0, 0, 0.72)`): Center-weighted radial falloff behind interactive text to guarantee WCAG AA 4.5:1 contrast against ambient fractal filaments without using any cards or boxes.

---

## 2. Typography & Typographic Roles
- **Display Name (`#name-display`):** `clamp(38px, 9vw, 84px)`, weight 400, line-height 1.25. Script stack: *DM Sans*, *Noto Sans Devanagari*, *Noto Sans Arabic*, *Noto Sans SC*, sans-serif.
- **Invitation (`#invitation`):** `clamp(16px, 3.5vw, 19px)`, weight 400, `#b8b8b8`. Exactly one single line: *"Give the dark a name."*
- **Drifting Satellite Labels (`.drift-label`):** `12px`, weight 400, letter-spacing 0.02em, `#777777`. Fades in and out softly beneath passing sample planets.
- **Celestial Action (`#start-button`):** `15px`, weight 500, letter-spacing -0.01em. An instrument with depth and responsive rim highlights.
- **Status / Guard Notice (`#status-message`):** `13px`, weight 400, `#999999`.

---

## 3. ASCII Wireframes

### Mobile Viewport (390 × 844)
```text
+---------------------------------------+
|                                [Sound]| <-- Top safe-area controls
|      .  (ambient dim fractal)         |
|   (Neha)  o                           | <-- Passing sample planet (depth 3)
|                                       |
|                  (*)                  | <-- Live preview planet / breathing point
|                                       |     (appears 350ms after typing)
|         Give the dark a name.         | <-- Quiet invitation
|                                       |
|             P r i y a                 | <-- Large typed name (zero box, floats in space)
|         -----------------             | <-- Responsive accent underline
|                                       |
|      [ Fall into your planet ]        | <-- Celestial action button (>=48px touch target)
|                                       |
|   o  (Kuber)                          | <-- Passing sample planet (depth 1)
|                                       |
|            (ambient zoom)             |
+---------------------------------------+
```

### Desktop Viewport (1440 × 900)
```text
+----------------------------------------------------------------------------------------------------+
|                                                                                      [ Sound off ] |
|            o (Aman)                                                                                |
|                                                                                                    |
|                                                (*)                                                 |
|                                    [Live Preview Planet (192px)]                                   |
|                                                                                                    |
|                                       Give the dark a name.                                        |
|                                                                                                    |
|                                         P  r  i  y  a                                              |
|                                    -----------------------                                         |
|                                                                                                    |
|                                   [ Fall into your planet ]                                        |
|                                                                                                    |
|                                                                                 o (Rahul)          |
|      o (Priya)                                                                                     |
+----------------------------------------------------------------------------------------------------+
```

---

## 4. Motion Plan
1. **Ambient World:**
   - A dedicated 2D canvas (`#ambient-canvas`) in the background renders a very slow, dim, continuous zoom through real Mandelbrot keyframes computed on the GPU.
   - Rotates gently through the 4 palettes.
   - Kept at low contrast/brightness (opacity 0.28 - 0.35) with a radial vignette centered on the interactive zone to guarantee text legibility.
   - Pauses on tab hide (`document.hidden`) and freezes completely when the dive begins.
2. **Drifting Sample Planets:**
   - 7 canonical planets (Priya, Rahul, Aman, Neha, Kuber, Artemis, Zenith) pre-rendered once at 256 tileSize into `ImageBitmap`s.
   - Drifting trajectories run via CSS `transform: translate3d(...)` across independent non-overlapping vertical tiers (outer margins top and bottom, never entering the central 400px interactive zone).
   - Zero per-frame GPU draw overhead.
3. **Live Interactive Preview:**
   - 350 ms debounce on typing in `#planet-name`.
   - Real engine execution (`createPlanet`) produces the exact planet parameters.
   - Rendered at 192 tileSize with maxIter capped at 800 for the preview only.
   - Crossfades smoothly (400 ms) in place of the breathing point, surrounded by a soft circular halo in the planet's accent color.
   - Cancelled immediately if another character is typed before completion.
4. **Reduced Motion:**
   - Under `prefers-reduced-motion: reduce`:
     - Ambient background renders a single static keyframe.
     - Drifting planets remain stationary or hidden.
     - Live preview transitions instantly (zero duration crossfade).

---

## 5. Design Critique & Revisions
- **Anti-Templates / What We Rejected:**
  - *No neon washes:* Standard dark AI/space templates flood the screen with cyan/purple gradient blur balls. We use pure `#000000` with real fractal math providing the ambient structure.
  - *No glass cards:* There are zero translucent cards with 1px border outlines. The text and button float directly in dark cosmic space.
  - *No uppercase tracked labels:* No `"DISCOVER THE COSMOS"` or `"POWERED BY WEBGPU"`. Pure understated sentence case.
  - *No hero stats:* No `"300+ REGIONS EXPLORED"`.
- **Key Revisions Made:**
  - Placed sample planet drift paths strictly in peripheral vertical bands so they never intersect the name input or button bounding boxes.
  - Introduced a soft radial vignette behind the text layer instead of a card container to preserve pure black aesthetics while exceeding WCAG AA 4.5:1 contrast.
  - Redesigned the primary button: moved away from a generic stark white pill to a dark obsidian body with a delicate 1px perimeter glow tied to `--accent`, elevating it into a bespoke physical artifact of the celestial world.

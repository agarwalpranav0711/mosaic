# Mosaic — Part 1: One-Tile Shader

## What this is

Part 1 of Mosaic: a WebGPU compute shader that computes one tile of a Mandelbrot set image, verified against a CPU reference implementation.

This is the foundation layer. It proves the GPU can compute tiles that match the CPU output, measures how long one tile takes, and measures how big the result is when compressed. Later parts will build a shared canvas, a backend, and a live event on top of this.

## What Mosaic is (and is not)

Mosaic is a web page where every visitor's GPU computes one tile of a large image using WebGPU. The tiles appear live on a shared canvas that everyone watches fill in together. No install, no account.

**Honest disclaimer:** the computation does not *need* to be distributed. A single modern GPU could render the whole image in seconds. The distributed aspect is a participation mechanic — like r/place — not a necessity. The product is the feeling of "my GPU drew that corner" and the shared experience of watching the image fill in.

## How to run

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in a browser with WebGPU support (Chrome 113+, Edge 113+, or Safari 26+).

Click **"Run Part 1 Tests"** and check that all tests pass.

## How to run CPU unit tests

```bash
npm run test
```

This runs the vitest test suite (`test/cpuReference.test.ts`) in Node — no GPU required.

## What a pass looks like

- All checks A through E show **PASS**
- Checks B, C, D show ≥99.0% exact match against the f32-style CPU reference
- Check E confirms determinism (two GPU runs produce identical output)
- Check F shows benchmark numbers (median ms per tile, tiles/sec)
- The visual section shows GPU and CPU tiles side-by-side with a diff map
- Compression experiment shows tile sizes in bytes

## Project structure

```
index.html              Test page
src/
  config.ts             All tunable constants
  cpuReference.ts       CPU reference (f32-style + f64 ground truth)
  gpuTile.ts            WebGPU setup + computeTile function
  shader.wgsl.ts        WGSL compute shader (exported as string)
  compare.ts            Tile comparison helpers
  main.ts               Test page logic
test/
  cpuReference.test.ts  Unit tests (Node, no GPU)
```

## Dependencies

- `vite` — dev server and bundler
- `typescript` — type checking
- `@webgpu/types` — TypeScript type definitions for the WebGPU API
- `vitest` — test runner for CPU unit tests

All are dev dependencies. No runtime dependencies.

## Part 4: The Dive & Planet Explorer

### How to Run
- `npm run dev`
  - Public Dive entry: [http://localhost:5173/](http://localhost:5173/) (home screen straight into the dive)
  - Engineering Verification Suite: [http://localhost:5173/dev/index.html](http://localhost:5173/dev/index.html)
  - Planet Dev Explorer: [http://localhost:5173/dev/planet.html](http://localhost:5173/dev/planet.html)

### How to Test
- `npm test`
  - Runs 42 CPU/unit tests with Vitest (no GPU required): limits, fixed-point math, palettes, name engine, and layout/mask contracts.
- Automated Playwright end-to-end suites:
  - `node scripts/audit-overlaps.mjs` — Bounding-box overlap audit across 5 viewports (360×640, 390×844, 768×1024, 1440×900, 1920×1080) for S1, S2, S3, S4, and Error state.
  - `node scripts/test-special-names.mjs` — Validates button hit-tests and wrapping for 40-char, Devanagari, Arabic (RTL), and CJK names.
  - `node scripts/test-transparency-and-caption.mjs` — Proves corner alpha 0 on planet canvas, pure `#000000` page, and caption strip export integrity.
  - `node scripts/test-b2c2d2.mjs` — Fixed iteration hash verification in browser (B2 `0x985dade1`, C2 `0x329ac730`, D2 `0xa63eed4d`, heavy tile `0x8a1e2fc9`).
  - `node scripts/test-fault-injection.mjs` — Fault-injection switches (`?fault=keyframe-timeout`, `?fault=device-lost`) and retry recovery.

### How to Build
- `npm run build`
  - Default production build: publishes strictly the public dive (`dist/index.html`) and associated optimized chunks. Engineering pages are omitted from default production builds.
- `VITE_DEV_PAGES=1 npm run build`
  - Opt-in engineering build: adds `/dev/index.html` and `/dev/planet.html` to `dist/dev/`.
  - Windows CMD: `set VITE_DEV_PAGES=1&& npm run build`
  - Windows PowerShell: `$env:VITE_DEV_PAGES="1"; npm run build`

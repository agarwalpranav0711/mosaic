# Mandelbrot Mosaic

A deterministic procedural planet dive engine running on WebGPU. Visitors type any name, and the browser computes a unique planetary destination in the Mandelbrot set and falls into it.

---

## What It Is

Mosaic generates procedural celestial bodies located at specific coordinates within the Mandelbrot set. Every name consistently maps to the same location, zoom depth, color palette, and visual features across runs.

There is no backend server rendering tiles, no database storing images, and no accounts or analytics. All computation happens locally in the browser via client-side WebGPU compute shaders.

---

## How It Works

1. **Name Normalization & Hashing:**
   The visitor's input is normalized (NFKC normalization, trimmed, collapsed whitespace, stripped control characters, max 40 characters) and hashed using SHA-256 (`mosaic-v1:<normalized_name>`).

2. **Deterministic Parameter Derivation:**
   Bytes from the SHA-256 digest select:
   - One of 300 curated regions from `regions.json`
   - Center coordinates $(x, y)$ inside the region
   - Magnification scale
   - Maximum iteration count (up to 2,000)
   - One of 4 atmospheric color palettes (Deep Sea, Ember, Aurora, Ice)

3. **Fixed-Point GPU Compute Shader (Q8.24):**
   Instead of floating-point arithmetic (which varies across GPU vendors and compiler optimizations), Mandelbrot iterations are evaluated using signed 32-bit integers in Q8.24 fixed-point format ($z_{real}, z_{imag}$ where 1.0 = $2^{24} = 16,777,216$). This guarantees bit-identical iteration counts regardless of whether the shader runs on NVIDIA, AMD, Intel, or Apple silicon.

4. **Atmospheric Rendering:**
   The resulting tile is passed through a custom renderer that applies:
   - Logarithmic iteration smoothing with $|z|^2$ escape value
   - Edge glow enhancement along boundary filaments
   - Circular planetary cropping with limb darkening and Rayleigh atmosphere halo
   - Deterministic procedural starfield background

---

## Why Fixed-Point Matters

Standard 32-bit floating-point (`f32`) operations are non-associative: $(a + b) + c \ne a + (b + c)$ in edge cases, and fused multiply-add (FMA) instructions differ between GPU hardware architectures. In deep fractal iterations, minute numerical deviations compound exponentially, causing different GPUs to produce different iteration counts for the exact same coordinate.

By enforcing integer arithmetic via Q8.24 fixed-point representations in WGSL compute shaders, every GPU computes the exact same mathematical results pixel-for-pixel, producing identical FNV-1a hash fingerprints across devices.

---

## Limitations

- **WebGPU Requirement:** Requires a modern browser with WebGPU support (Chrome 113+, Edge 113+, or Safari 26+). Browsers without WebGPU show a fallback message.
- **Curated Regions:** The catalogue contains 300 curated regions in `src/regions.json`. Coordinates outside these regions are not sampled.
- **Client Computation:** Rendering takes 1 to 3 seconds of local GPU time depending on device speed. Devices with very low GPU throughput will experience slower keyframe preparation.
- **No Per-Name Cloud OG Cards:** In v1, shared links use a static high-resolution preview card (`og-preview.png`). Unique per-name cards are generated on-demand as downloadable 1080×1350 PNG files on the client.

---

## Devices Tested So Far

- **Discrete GPU:** NVIDIA GeForce RTX 3050 Laptop GPU (Windows 11, Google Chrome 155, Direct3D12 backend via ANGLE)

### What Has NOT Been Tested

- Physical iOS / iPadOS devices (Safari WebGPU)
- Physical Android smartphones (ARM Mali / Qualcomm Adreno GPUs)
- Low-end mobile SoCs or software rasterizers (SwiftShader / WARP)
- Linux / Wayland WebGPU stacks

---

## Running Locally

### Development Server
```bash
npm install
npm run dev
```
Open [http://localhost:5173/](http://localhost:5173/) to enter the dive.

### Run Verification Tests
```bash
# Run unit test suite (42 tests in Node, no GPU required)
npm test

# Run build verification
npm run build
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.

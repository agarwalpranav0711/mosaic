/**
 * Mosaic Look & Atmosphere Renderer (Part 2).
 * Edge glow, planet circular crop, soft atmosphere halo, deterministic starfield,
 * and high-resolution export with caption bar.
 */

import { PALETTES, getColorForPixel } from './palette';
import type { PaletteName, MappingMode } from './palette';

export interface RenderOptions {
  paletteName: PaletteName;
  mappingMode: MappingMode;
  cycleSpeed: number;
  edgeGlowIntensity: number;
  planetMode: boolean;
  outputSize: number; // e.g. tileSize * 3 for display, or 1024 for export
  caption?: {
    name: string;
    hash8: string;
  };
}

/**
 * Deterministic pseudo-random number generator (Mulberry32) for reproducible starfield.
 */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Star {
  x: number; // [0, 1]
  y: number; // [0, 1]
  brightness: number; // [0.2, 1.0]
  radius: number;
}

// Generate a deterministic cosmic starfield
function generateStarfield(count: number = 140, seed: number = 42): Star[] {
  const rng = seededRandom(seed);
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: rng(),
      y: rng(),
      brightness: 0.25 + rng() * 0.75,
      radius: 0.6 + rng() * 1.2,
    });
  }
  return stars;
}

const STATIC_STARFIELD = generateStarfield(160, 1337);

/**
 * Precompute edge glow map for the tile using spatial iteration gradients.
 */
function computeEdgeGlowMap(iter: Uint32Array, tileSize: number, maxIter: number): Float32Array {
  const glow = new Float32Array(tileSize * tileSize);
  for (let y = 0; y < tileSize; y++) {
    for (let x = 0; x < tileSize; x++) {
      const idx = y * tileSize + x;
      const c = iter[idx];
      if (c >= maxIter) {
        // Interior has no edge glow inside
        glow[idx] = 0;
        continue;
      }

      const left = x > 0 ? iter[y * tileSize + (x - 1)] : c;
      const right = x < tileSize - 1 ? iter[y * tileSize + (x + 1)] : c;
      const up = y > 0 ? iter[(y - 1) * tileSize + x] : c;
      const down = y < tileSize - 1 ? iter[(y + 1) * tileSize + x] : c;

      const dx = Math.abs(right - left);
      const dy = Math.abs(down - up);
      const grad = Math.hypot(dx, dy);

      // Log-scaled gradient normalized to [0, 1]
      const g = Math.log(1.0 + grad) / Math.log(1.0 + Math.min(maxIter, 2000));
      glow[idx] = Math.max(0, Math.min(1, g));
    }
  }
  return glow;
}

/**
 * Render a Mandelbrot tile (with dual iter and z2 buffers) onto an HTMLCanvasElement
 * with smooth coloring, edge glow, planet mode, atmosphere, and starfield.
 */
export function renderTileToCanvas(
  iter: Uint32Array,
  z2: Uint32Array,
  tileSize: number,
  maxIter: number,
  opts: RenderOptions,
): HTMLCanvasElement {
  const outSize = opts.outputSize;
  const canvas = document.createElement('canvas');
  canvas.width = outSize;
  canvas.height = outSize;

  // Use smooth upscaling (not pixelated)
  canvas.style.imageRendering = 'auto';

  const ctx2d = canvas.getContext('2d')!;
  const imgData = ctx2d.createImageData(outSize, outSize);
  const data = imgData.data;

  const glowMap = opts.edgeGlowIntensity > 0 ? computeEdgeGlowMap(iter, tileSize, maxIter) : null;
  const palette = PALETTES[opts.paletteName];
  const brightestColor = palette[palette.length - 1]; // brightest atmosphere color

  const cx = outSize * 0.5;
  const cy = outSize * 0.5;
  const planetR = outSize * 0.40;
  const atmosWidth = outSize * 0.085;

  // Pre-draw starfield if planet mode is active
  const starCanvas = document.createElement('canvas');
  starCanvas.width = outSize;
  starCanvas.height = outSize;
  const starCtx = starCanvas.getContext('2d')!;
  starCtx.fillStyle = '#06080d';
  starCtx.fillRect(0, 0, outSize, outSize);

  if (opts.planetMode) {
    for (const star of STATIC_STARFIELD) {
      const sx = star.x * outSize;
      const sy = star.y * outSize;
      const dist = Math.hypot(sx - cx, sy - cy);
      // Only draw stars outside the planet body
      if (dist > planetR * 0.95) {
        starCtx.beginPath();
        starCtx.arc(sx, sy, star.radius, 0, Math.PI * 2);
        const b = Math.round(star.brightness * 255);
        starCtx.fillStyle = `rgba(${b}, ${b}, ${Math.min(255, b + 25)}, ${star.brightness})`;
        starCtx.fill();
      }
    }
  }
  const starData = starCtx.getImageData(0, 0, outSize, outSize).data;

  for (let oy = 0; oy < outSize; oy++) {
    for (let ox = 0; ox < outSize; ox++) {
      const pixelIdx = (oy * outSize + ox) * 4;

      if (opts.planetMode) {
        const dx = ox - cx;
        const dy = oy - cy;
        const dist = Math.hypot(dx, dy);

        if (dist > planetR) {
          // Outside planet disk: cosmic starfield + soft atmosphere halo
          let r = starData[pixelIdx];
          let g = starData[pixelIdx + 1];
          let b = starData[pixelIdx + 2];

          const d = dist - planetR;
          if (d < atmosWidth) {
            // Soft atmosphere halo exponential decay
            const halo = Math.exp(-3.2 * (d / atmosWidth)) * 0.85;
            r = Math.min(255, Math.round(r + brightestColor.r * halo));
            g = Math.min(255, Math.round(g + brightestColor.g * halo));
            b = Math.min(255, Math.round(b + brightestColor.b * halo));
          }

          data[pixelIdx + 0] = r;
          data[pixelIdx + 1] = g;
          data[pixelIdx + 2] = b;
          data[pixelIdx + 3] = 255;
          continue;
        }
      }

      // Map output coordinate to source tile coordinate with smooth bilinear interpolation
      const tx = (ox / outSize) * tileSize;
      const ty = (oy / outSize) * tileSize;
      const srcX = Math.min(tileSize - 1, Math.floor(tx));
      const srcY = Math.min(tileSize - 1, Math.floor(ty));
      const srcIdx = srcY * tileSize + srcX;

      const iterVal = iter[srcIdx];
      const z2Val = z2[srcIdx];

      let [r, g, b] = getColorForPixel(
        iterVal,
        z2Val,
        maxIter,
        opts.paletteName,
        opts.mappingMode,
        opts.cycleSpeed,
      );

      // Edge glow brightening
      if (glowMap && opts.edgeGlowIntensity > 0 && iterVal < maxIter) {
        const gVal = glowMap[srcIdx] * opts.edgeGlowIntensity;
        r = Math.min(255, Math.round(r + brightestColor.r * gVal * 0.8));
        g = Math.min(255, Math.round(g + brightestColor.g * gVal * 0.8));
        b = Math.min(255, Math.round(b + brightestColor.b * gVal * 0.8));
      }

      // Planet mode limb vignette
      if (opts.planetMode) {
        const dx = ox - cx;
        const dy = oy - cy;
        const normR = Math.hypot(dx, dy) / planetR;
        // Faint spherical limb darkening
        const vignette = Math.max(0.35, 1.0 - 0.45 * Math.pow(normR, 3.0));
        r = Math.round(r * vignette);
        g = Math.round(g * vignette);
        b = Math.round(b * vignette);
      }

      data[pixelIdx + 0] = r;
      data[pixelIdx + 1] = g;
      data[pixelIdx + 2] = b;
      data[pixelIdx + 3] = 255;
    }
  }

  ctx2d.putImageData(imgData, 0, 0);

  // If caption is requested (for export), render caption area
  if (opts.caption) {
    const captionH = Math.max(48, Math.round(outSize * 0.055));
    ctx2d.fillStyle = 'rgba(8, 12, 18, 0.82)';
    ctx2d.fillRect(0, outSize - captionH, outSize, captionH);

    ctx2d.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, outSize - captionH);
    ctx2d.lineTo(outSize, outSize - captionH);
    ctx2d.stroke();

    ctx2d.fillStyle = '#ffffff';
    ctx2d.font = `600 ${Math.round(captionH * 0.38)}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx2d.textBaseline = 'middle';
    ctx2d.fillText(opts.caption.name, 24, outSize - captionH * 0.5);

    ctx2d.fillStyle = '#8b949e';
    ctx2d.font = `400 ${Math.round(captionH * 0.32)}px 'Consolas', monospace`;
    ctx2d.textAlign = 'right';
    ctx2d.fillText(`Hash: 0x${opts.caption.hash8}  •  Mosaic Q8.24`, outSize - 24, outSize - captionH * 0.5);
  }

  return canvas;
}

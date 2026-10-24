/**
 * Pure TypeScript Mandelbrot tile computation — CPU reference implementations.
 *
 * Pixel-to-complex-plane mapping (must be IDENTICAL to the WGSL shader):
 *   px = (tileX * tileSize + localX) - (gridW * tileSize) * 0.5
 *   py = (tileY * tileSize + localY) - (gridH * tileSize) * 0.5
 *   cr = centerX + px * scale
 *   ci = centerY + py * scale
 *
 * This centres the image on (centerX, centerY) in the complex plane.
 */

import { CONFIG, getScale } from './config';
import type { MosaicConfig } from './config';

/**
 * 32-bit-style reference: uses Math.fround to truncate intermediates to f32.
 * This should closely match the GPU's f32 arithmetic.
 */
export function computeTileCPU(tileX: number, tileY: number, cfg: MosaicConfig = CONFIG): Uint32Array {
  const { tileSize, gridW, gridH, maxIter, centerX, centerY } = cfg;
  const scale = getScale(cfg);
  const out = new Uint32Array(tileSize * tileSize);

  const halfW = (gridW * tileSize) * 0.5;
  const halfH = (gridH * tileSize) * 0.5;

  for (let y = 0; y < tileSize; y++) {
    for (let x = 0; x < tileSize; x++) {
      // Pixel to complex plane — same formula as the shader
      const px = Math.fround(Math.fround(tileX * tileSize + x) - Math.fround(halfW));
      const py = Math.fround(Math.fround(tileY * tileSize + y) - Math.fround(halfH));
      const cr = Math.fround(Math.fround(centerX) + Math.fround(px * Math.fround(scale)));
      const ci = Math.fround(Math.fround(centerY) + Math.fround(py * Math.fround(scale)));

      let zr = Math.fround(0.0);
      let zi = Math.fround(0.0);
      let i = 0;

      while (i < maxIter) {
        const zr2 = Math.fround(zr * zr);
        const zi2 = Math.fround(zi * zi);
        if (Math.fround(zr2 + zi2) > 4.0) break;
        const t = Math.fround(Math.fround(zr2 - zi2) + cr);
        zi = Math.fround(Math.fround(Math.fround(2.0 * Math.fround(zr * zi))) + ci);
        zr = t;
        i++;
      }

      out[y * tileSize + x] = i;
    }
  }

  return out;
}

/**
 * 64-bit reference ("ground truth"): uses normal JS doubles.
 * Any mismatch between this and the GPU is expected due to f32 rounding.
 */
export function computeTileCPU64(tileX: number, tileY: number, cfg: MosaicConfig = CONFIG): Uint32Array {
  const { tileSize, gridW, gridH, maxIter, centerX, centerY } = cfg;
  const scale = getScale(cfg);
  const out = new Uint32Array(tileSize * tileSize);

  const halfW = (gridW * tileSize) * 0.5;
  const halfH = (gridH * tileSize) * 0.5;

  for (let y = 0; y < tileSize; y++) {
    for (let x = 0; x < tileSize; x++) {
      const px = (tileX * tileSize + x) - halfW;
      const py = (tileY * tileSize + y) - halfH;
      const cr = centerX + px * scale;
      const ci = centerY + py * scale;

      let zr = 0.0;
      let zi = 0.0;
      let i = 0;

      while (i < maxIter) {
        const zr2 = zr * zr;
        const zi2 = zi * zi;
        if (zr2 + zi2 > 4.0) break;
        const t = zr2 - zi2 + cr;
        zi = 2.0 * zr * zi + ci;
        zr = t;
        i++;
      }

      out[y * tileSize + x] = i;
    }
  }

  return out;
}

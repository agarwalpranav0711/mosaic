/**
 * CPU Reference implementation of Mandelbrot tile computation using Q8.24 fixed-point arithmetic.
 * Uses JavaScript BigInt to guarantee 100% exact bit-level arithmetic without floating-point rounding.
 *
 * PROOF OF NO OVERFLOW:
 * 1. Range of signed 32-bit integer: [-2,147,483,648 to +2,147,483,647]
 * 2. Range of Q8.24 format: [-128.0 to +127.99999994]
 * 3. Escape condition: |z|^2 > 4.0. Points outside radius 2 escape immediately.
 * 4. Maximum value before escape: |zr| <= 2, |zi| <= 2.
 * 5. Maximum next zr: zr^2 - zi^2 + cr. With |cr| <= 2.0: max value <= 4.0 + 2.0 = 6.0.
 * 6. Maximum next zi: 2*zr*zi + ci. Max value <= 2 * 2 * 2 + 2.0 = 10.0.
 * 7. In Q8.24 units: 10.0 * 2^24 = 167,772,160, which requires 28 bits (including sign).
 *    This leaves 4 full bits of headroom below the 32-bit limit (2,147,483,647).
 * 8. Intermediate products: (10.0 * 2^24)^2 = (2^27.3)^2 < 2^55.
 *    Fits well within signed 64-bit range (2^63 - 1) before the right-shift by 24 bits.
 *    Therefore, intermediate overflow is mathematically impossible.
 *
 * ROUNDING RULE:
 * Symmetric truncation towards zero (standard integer division by 2^24).
 */

import { CONFIG, validateConfigLimits } from './config';
import type { MosaicConfig } from './config';

export const Q24_SHIFT = 24n;
export const Q24_ONE = 1n << Q24_SHIFT; // 16,777,216
export const ESCAPE_RADIUS_SQ_Q24 = 4n * Q24_ONE; // 67,108,864

/** Signed Q8.24 product with BigInt division, which truncates toward zero. */
export function mulQ24(a: bigint, b: bigint): bigint {
  return (a * b) / Q24_ONE;
}

export const NEGATIVE_Q24_PRODUCTS: ReadonlyArray<readonly [bigint, bigint]> =
  Array.from({ length: 20 }, (_, index) => [
    -(Q24_ONE * BigInt(index + 1) + BigInt(index * 12345 + 1)),
    BigInt(index + 1),
  ] as const);

export interface FixedTileResult {
  iter: Uint32Array;
  z2: Uint32Array;
}

/** Convert float to Q8.24 integer */
export function floatToQ24(val: number): number {
  return Math.round(val * 16777216);
}

/** Get integer scale in units of 2^-24 */
export function getScaleQ24(cfg: MosaicConfig): number {
  return Math.round((cfg.viewWidth / (cfg.gridW * cfg.tileSize)) * 16777216);
}

/**
 * Compute a tile using BigInt fixed-point arithmetic following the identical
 * rounding rule as the WGSL shaderFixed implementation.
 */
export function computeTileCPUFixed(
  tileX: number,
  tileY: number,
  cfg: MosaicConfig = CONFIG,
): FixedTileResult {
  validateConfigLimits(cfg);
  const { tileSize, gridW, gridH, maxIter } = cfg;
  const iter = new Uint32Array(tileSize * tileSize);
  const z2Out = new Uint32Array(tileSize * tileSize);

  const halfW = BigInt((gridW * tileSize) >> 1);
  const halfH = BigInt((gridH * tileSize) >> 1);

  const cx = BigInt(floatToQ24(cfg.centerX));
  const cy = BigInt(floatToQ24(cfg.centerY));
  const sc = BigInt(getScaleQ24(cfg));

  for (let y = 0; y < tileSize; y++) {
    for (let x = 0; x < tileSize; x++) {
      const px = BigInt(tileX * tileSize + x) - halfW;
      const py = BigInt(tileY * tileSize + y) - halfH;

      const cr = cx + px * sc;
      const ci = cy + py * sc;

      let zr = 0n;
      let zi = 0n;
      let i = 0;
      let final_z2 = 0n;

      while (true) {
        const zr2 = mulQ24(zr, zr);
        const zi2 = mulQ24(zi, zi);
        const z2 = zr2 + zi2;

        if (i >= maxIter) {
          final_z2 = z2;
          break;
        }

        if (z2 > ESCAPE_RADIUS_SQ_Q24) {
          final_z2 = z2;
          break;
        }

        const t = zr2 - zi2 + cr;
        const zr_zi = mulQ24(zr, zi);
        zi = zr_zi * 2n + ci;
        zr = t;
        i++;
      }

      const idx = y * tileSize + x;
      iter[idx] = i;
      z2Out[idx] = Number(final_z2);
    }
  }

  return { iter, z2: z2Out };
}

/**
 * Compute a sub-block (e.g. 64x64 from center of 256x256 tile) using CPU BigInt.
 * This keeps CPU testing under ~200ms at maxIter 20,000 while maintaining 100% exactness test.
 */
export function computeTileCPUFixedSubBlock(
  tileX: number,
  tileY: number,
  cfg: MosaicConfig,
  startX: number,
  startY: number,
  blockW: number,
  blockH: number,
): FixedTileResult {
  validateConfigLimits(cfg);
  const { tileSize, gridW, gridH, maxIter } = cfg;
  const iter = new Uint32Array(blockW * blockH);
  const z2Out = new Uint32Array(blockW * blockH);

  const halfW = BigInt((gridW * tileSize) >> 1);
  const halfH = BigInt((gridH * tileSize) >> 1);

  const cx = BigInt(floatToQ24(cfg.centerX));
  const cy = BigInt(floatToQ24(cfg.centerY));
  const sc = BigInt(getScaleQ24(cfg));

  for (let by = 0; by < blockH; by++) {
    for (let bx = 0; bx < blockW; bx++) {
      const x = startX + bx;
      const y = startY + by;
      const px = BigInt(tileX * tileSize + x) - halfW;
      const py = BigInt(tileY * tileSize + y) - halfH;

      const cr = cx + px * sc;
      const ci = cy + py * sc;

      let zr = 0n;
      let zi = 0n;
      let i = 0;
      let final_z2 = 0n;

      while (true) {
        const zr2 = mulQ24(zr, zr);
        const zi2 = mulQ24(zi, zi);
        const z2 = zr2 + zi2;

        if (i >= maxIter) {
          final_z2 = z2;
          break;
        }

        if (z2 > ESCAPE_RADIUS_SQ_Q24) {
          final_z2 = z2;
          break;
        }

        const t = zr2 - zi2 + cr;
        const zr_zi = mulQ24(zr, zi);
        zi = zr_zi * 2n + ci;
        zr = t;
        i++;
      }

      const idx = by * blockW + bx;
      iter[idx] = i;
      z2Out[idx] = Number(final_z2);
    }
  }

  return { iter, z2: z2Out };
}

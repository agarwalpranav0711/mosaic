import { describe, it, expect } from 'vitest';
import { CONFIG, VIEW_ZOOMED } from '../src/config';
import { computeTileCPUFixed, computeTileCPUFixedSubBlock, mulQ24, Q24_ONE, NEGATIVE_Q24_PRODUCTS } from '../src/cpuFixed';

describe('cpuFixed (Q8.24 BigInt Reference with dual buffers)', () => {
  it('uses truncation toward zero for negative Q8.24 products, not arithmetic shift', () => {
    const negativeProduct = -1n * 1n;
    expect(mulQ24(-1n, 1n)).toBe(0n);
    expect(negativeProduct >> 24n).toBe(-1n);
    expect(mulQ24(-Q24_ONE - 1n, 1n)).toBe(-1n);
  });

  it('keeps 20 negative-product CPU reference vectors for GPU parity checks', () => {
    expect(NEGATIVE_Q24_PRODUCTS).toHaveLength(20);
    for (const [a, b] of NEGATIVE_Q24_PRODUCTS) {
      expect(a * b).toBeLessThan(0n);
      expect(mulQ24(a, b)).toBe((a * b) / Q24_ONE);
    }
    expect(mulQ24(-1n, 1n)).not.toBe((-1n * 1n) >> 24n);
  });
  it('computes both iter and z2 buffers with correct lengths', () => {
    const res = computeTileCPUFixed(0, 0, CONFIG);
    expect(res.iter.length).toBe(CONFIG.tileSize * CONFIG.tileSize);
    expect(res.z2.length).toBe(CONFIG.tileSize * CONFIG.tileSize);
  });

  it('interior pixel has iter = maxIter and positive z2', () => {
    // Tile (32, 32) at default settings covers center near (0,0)
    const res = computeTileCPUFixed(32, 32, CONFIG);
    // Origin pixel should reach maxIter
    const midIdx = (CONFIG.tileSize / 2) * CONFIG.tileSize + (CONFIG.tileSize / 2);
    expect(res.iter[midIdx]).toBe(CONFIG.maxIter);
    expect(res.z2[midIdx]).toBeGreaterThan(0);
  });

  it('exterior point escapes with z2 > ESCAPE_RADIUS_SQ (4 * 2^24 = 67,108,864)', () => {
    // Tile (0, 0) is far away from Mandelbrot set
    const res = computeTileCPUFixed(0, 0, CONFIG);
    const cornerVal = res.iter[0];
    expect(cornerVal).toBeLessThan(CONFIG.maxIter);
    expect(res.z2[0]).toBeGreaterThan(67108864);
  });

  it('sub-block matches full tile computation exactly', () => {
    const testCfg = {
      ...CONFIG,
      ...VIEW_ZOOMED,
      tileSize: 64,
      gridW: 64,
      gridH: 64,
      maxIter: 100,
    };
    const full = computeTileCPUFixed(32, 32, testCfg);
    const sub = computeTileCPUFixedSubBlock(32, 32, testCfg, 16, 16, 16, 16);

    for (let by = 0; by < 16; by++) {
      for (let bx = 0; bx < 16; bx++) {
        const fullIdx = (16 + by) * 64 + (16 + bx);
        const subIdx = by * 16 + bx;
        expect(sub.iter[subIdx]).toBe(full.iter[fullIdx]);
        expect(sub.z2[subIdx]).toBe(full.z2[fullIdx]);
      }
    }
  });
});

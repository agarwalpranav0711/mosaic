import { describe, it, expect } from 'vitest';
import { PALETTES, samplePalette, computeSmoothNu, mapNuToGradient, getColorForPixel } from '../src/palette';
import type { PaletteName } from '../src/palette';

describe('Palette Module (Part 2 Task 2)', () => {
  const paletteNames: PaletteName[] = ['Deep Sea', 'Ember', 'Aurora', 'Ice'];

  it('all 4 palettes exist and have at least 7 color stops', () => {
    for (const name of paletteNames) {
      const stops = PALETTES[name];
      expect(stops).toBeDefined();
      expect(stops.length).toBeGreaterThanOrEqual(7);
      // Check monotonicity of positions
      for (let i = 0; i < stops.length - 1; i++) {
        expect(stops[i].pos).toBeLessThanOrEqual(stops[i + 1].pos);
      }
      expect(stops[0].pos).toBe(0.0);
      expect(stops[stops.length - 1].pos).toBe(1.0);
    }
  });

  it('smooth interpolation between stops produces no NaN and bounds in [0, 255]', () => {
    for (const name of paletteNames) {
      for (let t = 0; t <= 1.0; t += 0.05) {
        const [r, g, b] = samplePalette(PALETTES[name], t);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(255);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(255);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(255);
      }
    }
  });

  it('interior pixel (iter == maxIter) always colors black [0, 0, 0]', () => {
    for (const name of paletteNames) {
      const rgb = getColorForPixel(500, 16777216, 500, name);
      expect(rgb).toEqual([0, 0, 0]);
    }
  });

  it('smooth nu calculation works for escaping point', () => {
    // Escape at iter = 10, |z|^2 = 16.0 (16 * 16777216 = 268,435,456)
    // modZ = 4.0, log2(modZ) = 2.0, log2(2.0) = 1.0
    // nu = 10 + 1 - 1 = 10.0
    const nu = computeSmoothNu(10, 268435456, 500);
    expect(nu).toBeCloseTo(10.0, 3);
  });

  it('log and sqrt mappings stay within [0, 1] without discontinuities', () => {
    const tLog = mapNuToGradient(50, 500, 'log', 1.0);
    const tSqrt = mapNuToGradient(50, 500, 'sqrt', 1.0);
    expect(tLog).toBeGreaterThanOrEqual(0);
    expect(tLog).toBeLessThanOrEqual(1);
    expect(tSqrt).toBeGreaterThanOrEqual(0);
    expect(tSqrt).toBeLessThanOrEqual(1);
  });
});

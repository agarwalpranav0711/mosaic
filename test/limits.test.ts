import { describe, it, expect } from 'vitest';
import { CONFIG, validateConfigLimits } from '../src/config';
import { tileToU16Bytes } from '../src/compare';

describe('Part 1.8 Limits and Validation Tests', () => {
  it('default CONFIG passes validateConfigLimits', () => {
    expect(() => validateConfigLimits(CONFIG)).not.toThrow();
  });

  it('maxIter above 65535 throws a clear error (no silent clamp)', () => {
    const invalidCfg = { ...CONFIG, maxIter: 65536 };
    expect(() => validateConfigLimits(invalidCfg)).toThrowError(
      /maxIter exceeds u16 limit \(65535\): received 65536/,
    );
  });

  it('maxIter at boundary 65535 succeeds', () => {
    const validCfg = { ...CONFIG, maxIter: 65535 };
    expect(() => validateConfigLimits(validCfg)).not.toThrow();
  });

  it('scale_q24 below 16 units per pixel throws a clear error', () => {
    // scale_q24 = round(viewWidth / (gridW * tileSize) * 2^24)
    // To get scale_q24 < 16, e.g. viewWidth = 0.000001 with gridW=64, tileSize=128
    // 0.000001 / 8192 * 16777216 = 0.002 < 16
    const invalidCfg = { ...CONFIG, viewWidth: 0.000001 };
    expect(() => validateConfigLimits(invalidCfg)).toThrowError(
      /scale_q24 is below minimum safe threshold \(16 units\/pixel\)/,
    );
  });

  it('scale_q24 at exactly 16 units per pixel succeeds', () => {
    // We want scale * 16777216 = 16 => scale = 16 / 16777216 = 2^-20
    // totalPixels = 64 * 128 = 8192 = 2^13
    // viewWidth = scale * 8192 = 2^-20 * 2^13 = 2^-7 = 0.0078125
    const validBoundaryCfg = { ...CONFIG, viewWidth: 0.0078125 };
    expect(() => validateConfigLimits(validBoundaryCfg)).not.toThrow();
  });

  it('tileToU16Bytes throws if an iteration count exceeds 65535 (no silent clamping)', () => {
    const data = new Uint32Array([10, 500, 65536]);
    expect(() => tileToU16Bytes(data)).toThrowError(
      /Iteration count exceeds u16 limit \(65535\): received 65536/,
    );
  });

  it('tileToU16Bytes successfully packs valid iteration counts up to 65535', () => {
    const data = new Uint32Array([0, 1, 500, 65535]);
    const bytes = tileToU16Bytes(data);
    expect(bytes.length).toBe(8);
    const u16 = new Uint16Array(bytes.buffer);
    expect(u16[0]).toBe(0);
    expect(u16[1]).toBe(1);
    expect(u16[2]).toBe(500);
    expect(u16[3]).toBe(65535);
  });
});

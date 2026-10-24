import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, REGION_CATALOGUE, createPlanet, hashName, normalizeName } from '../src/nameEngine';
import { NEGATIVE_Q24_PRODUCTS, mulQ24, Q24_ONE } from '../src/cpuFixed';

describe('name engine identity', () => {
  it('keeps engine version 1 draft and normalizes equivalent names identically', async () => {
    expect(ENGINE_VERSION).toBe(1);
    expect(normalizeName('Priya')).toBe('priya');
    expect(await hashName('Priya')).toBe(await hashName(' priya '));
    expect(await hashName('PRIYA')).toBe(await hashName('priya'));
    expect(await hashName('Priya')).toBe('742e05ed0c86200ebf57562ba7b8b27e768b72f5a73cf45974c64cfe471e9220');
  });

  it('accepts Devanagari, Arabic, CJK, and numeric names', async () => {
    for (const name of ['प्रिया', 'ليلى', '美咲', '12345']) {
      expect(await hashName(name)).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('rejects empty and more-than-40-character normalized names', () => {
    expect(() => normalizeName(' \t\n ')).toThrow(/must not be empty/u);
    expect(() => normalizeName('x'.repeat(41))).toThrow(/40 characters/u);
  });

  it('uses truncation toward zero on 20 negative Q8.24 products', () => {
    expect(NEGATIVE_Q24_PRODUCTS).toHaveLength(20);
    for (const [a, b] of NEGATIVE_Q24_PRODUCTS) {
      expect(a * b).toBeLessThan(0n);
      expect(mulQ24(a, b)).toBe((a * b) / Q24_ONE);
    }
  });

  it('maps only to integer centers and preserves the full region width', async () => {
    const probe = async () => passingProbe();
    const planet = await createPlanet('Priya', probe);
    const repeated = await createPlanet('Priya', probe);
    const region = REGION_CATALOGUE[planet.regionIndex];
    expect(planet.widthQ24).toBe(region.widthQ24);
    expect(planet.scale_q24).toBe(Math.floor(region.widthQ24 / 512));
    expect(planet.scale_q24).toBeGreaterThanOrEqual(256);
    expect(Number.isInteger(planet.centerXQ24)).toBe(true);
    expect(Number.isInteger(planet.centerYQ24)).toBe(true);
    expect(planet.paletteIndex).toBeGreaterThanOrEqual(0);
    expect(planet.paletteIndex).toBeLessThan(4);
    expect(planet.fallbackUsed).toBe(false);
    expect(repeated.planetId).toBe(planet.planetId);
  });

  it('rehashes failed probes and chooses the highest-distinct deterministic fallback', async () => {
    let calls = 0;
    const rehashed = await createPlanet('Rehash', async () => {
      calls++;
      return calls === 1 ? new Uint32Array(64 * 64) : passingProbe();
    });
    expect(rehashed.counter).toBe(1);
    expect(rehashed.fallbackUsed).toBe(false);

    calls = 0;
    const fallbackA = await createPlanet('Fallback', async () => {
      calls++;
      const pixels = new Uint32Array(64 * 64);
      pixels.fill(calls);
      return pixels;
    });
    calls = 0;
    const fallbackB = await createPlanet('Fallback', async () => {
      calls++;
      const pixels = new Uint32Array(64 * 64);
      pixels.fill(calls);
      return pixels;
    });
    expect(fallbackA.counter).toBe(0);
    expect(fallbackA.fallbackUsed).toBe(true);
    expect(fallbackA.planetId).toBe(fallbackB.planetId);
  });

  it('rejects a probe with the wrong dimensions', async () => {
    await expect(createPlanet('bad probe', async () => new Uint32Array(10))).rejects.toThrow(/64x64/u);
  });
});

function passingProbe(): Uint32Array {
  return Uint32Array.from({ length: 64 * 64 }, (_, index) => index % 2000);
}

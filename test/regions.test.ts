import { describe, expect, it } from 'vitest';
import { REGION_CATALOGUE } from '../src/nameEngine';

const Q24 = 1 << 24;

describe('region catalogue constraints', () => {
  it('keeps each catalogue region integer-valued and within the frozen scale bounds', () => {
    expect(REGION_CATALOGUE).toHaveLength(300);
    for (const region of REGION_CATALOGUE) {
      expect(Object.keys(region).sort()).toEqual(['area', 'centerXQ24', 'centerYQ24', 'widthQ24']);
      expect(Number.isInteger(region.centerXQ24)).toBe(true);
      expect(Number.isInteger(region.centerYQ24)).toBe(true);
      expect(Number.isInteger(region.widthQ24)).toBe(true);
      expect(region.widthQ24).toBeGreaterThanOrEqual(Math.ceil(0.01 * Q24));
      expect(region.widthQ24).toBeLessThanOrEqual(Math.floor(0.2 * Q24));
      expect(Math.floor(region.widthQ24 / 512)).toBeGreaterThanOrEqual(256);
      expect(typeof region.area).toBe('string');
    }
  });
});

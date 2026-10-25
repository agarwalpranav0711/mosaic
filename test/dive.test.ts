import { describe, expect, it } from 'vitest';
import { REGION_CATALOGUE } from '../src/nameEngine';
import { makeDiveKeyframes, DIVE_Q24 } from '../src/dive';

describe('integer dive keyframes', () => {
  it('starts at the whole-set view and ends exactly at the selected planet', () => {
    const planet = { centerXQ24: -23340119, centerYQ24: -243158, widthQ24: 392182 };
    const frames = makeDiveKeyframes(planet);

    expect(frames.length).toBe(Math.ceil(Math.log2(3 * DIVE_Q24 / planet.widthQ24)) + 1);
    expect(frames[0]).toMatchObject({ widthQ24: 3 * DIVE_Q24, centerXQ24: -DIVE_Q24 / 2, centerYQ24: 0, maxIter: 500 });
    expect(frames.at(-1)).toMatchObject({
      widthQ24: planet.widthQ24,
      centerXQ24: planet.centerXQ24,
      centerYQ24: planet.centerYQ24,
      maxIter: 2000,
    });
    expect(frames.every((frame) => Number.isInteger(frame.widthQ24)
      && Number.isInteger(frame.centerXQ24)
      && Number.isInteger(frame.centerYQ24)
      && Number.isInteger(frame.scaleQ24)
      && frame.scaleQ24 >= 256)).toBe(true);
    expect(frames.every((frame) => (
      Math.abs(planet.centerXQ24 - frame.centerXQ24) * 2 <= frame.scaleQ24 * 512
      && Math.abs(planet.centerYQ24 - frame.centerYQ24) * 2 <= frame.scaleQ24 * 512
    ))).toBe(true);
  });

  it('generates deterministic, safe paths for the entire frozen catalogue', () => {
    for (const region of REGION_CATALOGUE) {
      const planet = {
        centerXQ24: region.centerXQ24,
        centerYQ24: region.centerYQ24,
        widthQ24: region.widthQ24,
      };
      const first = makeDiveKeyframes(planet);
      const second = makeDiveKeyframes(planet);
      expect(second).toEqual(first);
      expect(first.at(-1)?.widthQ24).toBe(region.widthQ24);
    }
  });
});

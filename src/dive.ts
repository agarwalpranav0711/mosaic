import type { PlanetParameters } from './nameEngine';

export const DIVE_Q24 = 1 << 24;
export const DIVE_TILE_SIZE = 512;
export const DIVE_START_MAX_ITER = 500;
export const DIVE_END_MAX_ITER = 2000;

export interface DiveKeyframe {
  index: number;
  widthQ24: number;
  centerXQ24: number;
  centerYQ24: number;
  scaleQ24: number;
  maxIter: number;
}

export function makeDiveKeyframes(planet: Pick<PlanetParameters, 'centerXQ24' | 'centerYQ24' | 'widthQ24'>): DiveKeyframe[] {
  const startWidthQ24 = 3 * DIVE_Q24;
  const endWidthQ24 = planet.widthQ24;
  const count = Math.ceil(Math.log2(startWidthQ24 / endWidthQ24)) + 1;
  const denominator = count - 1;
  const deltaX = planet.centerXQ24 + DIVE_Q24 / 2;
  const deltaY = planet.centerYQ24;

  if (Math.abs(deltaX) > startWidthQ24 / 2 || Math.abs(deltaY) > startWidthQ24 / 2) {
    throw new Error('The destination planet is outside the required 3.0-wide starting view.');
  }

  const frames = Array.from({ length: count }, (_, index): DiveKeyframe => {
    const widthQ24 = index === 0
      ? startWidthQ24
      : index === denominator
        ? endWidthQ24
        : Math.round(startWidthQ24 * 2 ** (Math.log2(endWidthQ24 / startWidthQ24) * index / denominator));
    const viewWidthQ24 = Math.floor(widthQ24 / DIVE_TILE_SIZE) * DIVE_TILE_SIZE;
    const remainingWidthQ24 = widthQ24 - endWidthQ24;
    const centerXQ24 = index === 0
      ? -DIVE_Q24 / 2
      : index === denominator
        ? planet.centerXQ24
        : planet.centerXQ24 - Math.round(deltaX * remainingWidthQ24 / (startWidthQ24 - endWidthQ24));
    const centerYQ24 = index === 0
      ? 0
      : index === denominator
        ? planet.centerYQ24
        : planet.centerYQ24 - Math.round(deltaY * remainingWidthQ24 / (startWidthQ24 - endWidthQ24));
    const scaleQ24 = Math.floor(widthQ24 / DIVE_TILE_SIZE);
    const maxIter = index === 0
      ? DIVE_START_MAX_ITER
      : index === denominator
        ? DIVE_END_MAX_ITER
        : DIVE_START_MAX_ITER + Math.floor((DIVE_END_MAX_ITER - DIVE_START_MAX_ITER) * index / denominator);

    if (scaleQ24 < 256) throw new Error(`Dive keyframe ${index} has an unsafe scale_q24 of ${scaleQ24}.`);
    if (Math.abs(planet.centerXQ24 - centerXQ24) * 2 > viewWidthQ24
      || Math.abs(planet.centerYQ24 - centerYQ24) * 2 > viewWidthQ24) {
      throw new Error(`Dive keyframe ${index} does not contain the destination planet center.`);
    }

    return { index, widthQ24, centerXQ24, centerYQ24, scaleQ24, maxIter };
  });

  return frames;
}

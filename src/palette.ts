/**
 * Mosaic Palette & Display Module (Part 2).
 * Provides 4 distinct palettes (each with 7 color stops), continuous interpolation,
 * smooth coloring calculation nu = iter + 1 - log2(log2(|z|)), and selectable mappings.
 */

export interface ColorStop {
  pos: number;
  r: number;
  g: number;
  b: number;
}

export type PaletteName = 'Deep Sea' | 'Ember' | 'Aurora' | 'Ice';
export type MappingMode = 'log' | 'sqrt';

export const PALETTES: Record<PaletteName, ColorStop[]> = {
  'Deep Sea': [
    { pos: 0.00, r: 2,   g: 4,   b: 12  }, // Black
    { pos: 0.15, r: 8,   g: 25,  b: 65  }, // Navy
    { pos: 0.32, r: 12,  g: 70,  b: 110 }, // Deep Teal
    { pos: 0.50, r: 20,  g: 130, b: 145 }, // Teal
    { pos: 0.68, r: 45,  g: 195, b: 190 }, // Aqua
    { pos: 0.84, r: 140, g: 235, b: 240 }, // Pale Aqua
    { pos: 1.00, r: 250, g: 255, b: 255 }, // White
  ],
  'Ember': [
    { pos: 0.00, r: 6,   g: 1,   b: 8   }, // Black
    { pos: 0.15, r: 45,  g: 5,   b: 58  }, // Deep Purple
    { pos: 0.32, r: 125, g: 12,  b: 85  }, // Dark Magenta
    { pos: 0.50, r: 215, g: 35,  b: 60  }, // Crimson Magenta
    { pos: 0.68, r: 245, g: 120, b: 20  }, // Blazing Orange
    { pos: 0.84, r: 255, g: 205, b: 50  }, // Radiant Gold
    { pos: 1.00, r: 255, g: 255, b: 245 }, // Warm White
  ],
  'Aurora': [
    { pos: 0.00, r: 2,   g: 6,   b: 8   }, // Black
    { pos: 0.15, r: 6,   g: 48,  b: 32  }, // Deep Green
    { pos: 0.32, r: 18,  g: 125, b: 80  }, // Emerald
    { pos: 0.50, r: 35,  g: 205, b: 185 }, // Cyan
    { pos: 0.68, r: 115, g: 90,  b: 215 }, // Electric Violet
    { pos: 0.84, r: 230, g: 110, b: 200 }, // Neon Pink
    { pos: 1.00, r: 255, g: 248, b: 255 }, // Starlight White
  ],
  'Ice': [
    { pos: 0.00, r: 3,   g: 6,   b: 16  }, // Black
    { pos: 0.15, r: 12,  g: 28,  b: 72  }, // Deep Blue
    { pos: 0.32, r: 28,  g: 72,  b: 148 }, // Royal Blue
    { pos: 0.50, r: 65,  g: 145, b: 215 }, // Glacial Blue
    { pos: 0.68, r: 125, g: 215, b: 248 }, // Cyan
    { pos: 0.84, r: 205, g: 242, b: 255 }, // Pale Ice
    { pos: 1.00, r: 255, g: 255, b: 255 }, // Pure White
  ],
};

/**
 * Interpolate smoothly between color stops in a palette.
 * No hard jumps between neighboring values.
 */
export function samplePalette(palette: ColorStop[], t: number): [number, number, number] {
  const clampedT = Math.max(0, Math.min(1, t));
  const n = palette.length;

  if (clampedT <= palette[0].pos) {
    return [palette[0].r, palette[0].g, palette[0].b];
  }
  if (clampedT >= palette[n - 1].pos) {
    return [palette[n - 1].r, palette[n - 1].g, palette[n - 1].b];
  }

  for (let i = 0; i < n - 1; i++) {
    const s0 = palette[i];
    const s1 = palette[i + 1];
    if (clampedT >= s0.pos && clampedT <= s1.pos) {
      const span = s1.pos - s0.pos;
      const u = span > 0 ? (clampedT - s0.pos) / span : 0;
      // Smooth interpolation
      const r = Math.round(s0.r + (s1.r - s0.r) * u);
      const g = Math.round(s0.g + (s1.g - s0.g) * u);
      const b = Math.round(s0.b + (s1.b - s0.b) * u);
      return [r, g, b];
    }
  }

  return [palette[n - 1].r, palette[n - 1].g, palette[n - 1].b];
}

/**
 * Calculate smooth continuous iteration count nu at display time only:
 * nu = iter + 1 - log2(log2(|z|))
 * Where |z|^2 is retrieved from the second fixed-point output buffer in Q8.24.
 */
export function computeSmoothNu(iter: number, z2Q24: number, maxIter: number): number {
  if (iter >= maxIter) {
    return maxIter; // Interior
  }

  // Convert Q8.24 integer to floating-point |z|^2
  const z2 = z2Q24 / 16777216.0;
  if (z2 <= 1.0) {
    return iter;
  }

  const modZ = Math.sqrt(z2);
  const log2ModZ = Math.log2(modZ);
  if (log2ModZ <= 0) {
    return iter;
  }

  const nu = iter + 1.0 - Math.log2(log2ModZ);
  return Math.max(0, nu);
}

/**
 * Map smooth nu to normalized [0, 1] gradient coordinate t using log or sqrt mapping,
 * and seamless triangular folding for cycle speed.
 */
export function mapNuToGradient(
  nu: number,
  maxIter: number,
  mode: MappingMode = 'log',
  cycleSpeed: number = 1.0,
): number {
  let baseT = 0;
  if (mode === 'log') {
    baseT = Math.log(1.0 + nu) / Math.log(1.0 + maxIter);
  } else {
    // sqrt mapping
    baseT = Math.sqrt(nu / maxIter);
  }
  baseT = Math.max(0, Math.min(1, baseT));

  // Seamless ping-pong cycling so there is never a hard jump at cycle boundaries
  const folded = (baseT * cycleSpeed) % 2.0;
  return folded > 1.0 ? 2.0 - folded : folded;
}

/**
 * Get RGB color for a given pixel at display time.
 * If interior (iter >= maxIter), returns black [0, 0, 0].
 */
export function getColorForPixel(
  iter: number,
  z2Q24: number,
  maxIter: number,
  paletteName: PaletteName,
  mode: MappingMode = 'log',
  cycleSpeed: number = 1.0,
): [number, number, number] {
  if (iter >= maxIter) {
    return [0, 0, 0]; // Interior is black
  }

  const nu = computeSmoothNu(iter, z2Q24, maxIter);
  const t = mapNuToGradient(nu, maxIter, mode, cycleSpeed);
  return samplePalette(PALETTES[paletteName], t);
}

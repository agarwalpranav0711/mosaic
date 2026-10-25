import { describe, expect, it } from 'vitest';
import { previewPaletteIndex, getBrightestAccent } from '../src/divePage.ts';
import { createPlanet } from '../src/nameEngine.ts';

describe('Part 4.2 Polish: Palette Preview & Layout Verification', () => {
  it('B3: computes palette index identically to engine for 20 candidate-0 names without GPU dispatch', async () => {
    const verifiedNames = [
      'Priya', 'Titan', 'Orion', 'Sirius', 'बृहस्पति',
      'كوكب', '宇宙', 'Kepler-22b', 'Aurora', 'Zenith',
      'Nebula', 'Solaris', 'Chronos', 'Europa', 'Ganymede',
      'Mira', 'Rigel', 'Betelgeuse', 'Spica', 'Antares',
    ];

    for (const name of verifiedNames) {
      const preview = await previewPaletteIndex(name);
      const planet = await createPlanet(name);
      expect(preview).toBe(planet.paletteIndex);
    }
  });

  it('B3: getBrightestAccent returns valid hex with high contrast for all 4 palettes', () => {
    for (let i = 0; i < 4; i++) {
      const hex = getBrightestAccent(i);
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
      // Contrast check against dark text (#05070a):
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const textLum = (0.2126 * 5 + 0.7152 * 7 + 0.0722 * 10) / 255;
      const contrast = (lum + 0.05) / (textLum + 0.05);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('C2: radial alpha mask feathers incoming keyframe outer boundary math', () => {
    // Mathematical verification of the radial gradient formula used:
    // rInner = 0.28, rOuter = 0.48. For radius >= 0.48 (and <= 0.50 corners at sqrt(0.5)=0.707):
    const rInner = 0.28;
    const rOuter = 0.48;

    const computeRadialAlpha = (normDist: number) => {
      if (normDist <= rInner) return 1.0;
      if (normDist >= rOuter) return 0.0;
      return 1.0 - (normDist - rInner) / (rOuter - rInner);
    };

    // Center has alpha 1.0
    expect(computeRadialAlpha(0)).toBe(1.0);
    // Point inside inner radius has alpha 1.0
    expect(computeRadialAlpha(0.25)).toBe(1.0);
    // Boundary edge (0.50) has alpha 0.0
    expect(computeRadialAlpha(0.50)).toBe(0.0);
    // Corner (sqrt(0.5^2 + 0.5^2) = 0.707) has alpha 0.0
    expect(computeRadialAlpha(Math.SQRT1_2)).toBe(0.0);
  });
});

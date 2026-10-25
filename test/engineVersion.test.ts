import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION as CONFIG_ENGINE_VERSION } from '../src/config';
import { ENGINE_VERSION as ENGINE_VERSION_EXPORT, createPlanet } from '../src/nameEngine';
import { makeDiveKeyframes } from '../src/dive';
import { computeTileCPUFixed } from '../src/cpuFixed';
import { fnv1a32, u16LittleEndian } from '../src/fnv';

describe('engine version and frozen reference planets', () => {
  it('freezes ENGINE_VERSION at 1 across config and engine', () => {
    expect(CONFIG_ENGINE_VERSION).toBe(1);
    expect(ENGINE_VERSION_EXPORT).toBe(1);
  });

  const REFERENCE_TARGETS = [
    {
      name: 'Priya',
      planetId: '81357026',
      counter: 0,
      paletteIndex: 3,
      paletteName: 'Ice',
      keyframeHash: '9a90facd',
    },
    {
      name: 'Rahul',
      planetId: '184b2ca5',
      counter: 0,
      paletteIndex: 0,
      paletteName: 'Deep Sea',
      keyframeHash: '1c470754',
    },
    {
      name: 'Aman',
      planetId: 'e57d2897',
      counter: 3,
      paletteIndex: 2,
      paletteName: 'Aurora',
      keyframeHash: '7d0ece54',
    },
    {
      name: 'Neha',
      planetId: 'ed0aa39e',
      counter: 0,
      paletteIndex: 2,
      paletteName: 'Aurora',
      keyframeHash: '48050231',
    },
    {
      name: 'Kuber',
      planetId: '81e905b5',
      counter: 1,
      paletteIndex: 3,
      paletteName: 'Ice',
      keyframeHash: '3fca3290',
    },
  ];

  for (const ref of REFERENCE_TARGETS) {
    it(`verifies reference planet "${ref.name}" (ID ${ref.planetId}, hash 0x${ref.keyframeHash}) against Engine v1`, async () => {
      // Must enforce ENGINE_VERSION === 1
      expect(CONFIG_ENGINE_VERSION).toBe(1);

      // Generate planet parameters via Engine v1
      const planet = await createPlanet(ref.name);
      expect(planet.planetId).toBe(ref.planetId);
      expect(planet.counter).toBe(ref.counter);
      expect(planet.paletteIndex).toBe(ref.paletteIndex);

      // Compute final 512x512 keyframe tile via deterministic Q8.24 CPU fixed-point reference
      const frames = makeDiveKeyframes(planet);
      const finalFrame = frames.at(-1);
      expect(finalFrame).toBeDefined();

      const cfg = {
        tileSize: 512,
        gridW: 1,
        gridH: 1,
        maxIter: finalFrame!.maxIter,
        centerX: finalFrame!.centerXQ24 / (1 << 24),
        centerY: finalFrame!.centerYQ24 / (1 << 24),
        viewWidth: (finalFrame!.scaleQ24 * 512) / (1 << 24),
        workgroupSize: 8,
        tolerance: { minExactMatchPct: 100 },
      };

      const tile = computeTileCPUFixed(0, 0, cfg);
      const hash = fnv1a32(u16LittleEndian(tile.iter));

      expect(hash).toBe(ref.keyframeHash);
    }, 35000);
  }
});

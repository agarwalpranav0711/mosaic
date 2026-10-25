import { createPlanet, hashName, normalizeName } from '../src/nameEngine.ts';
import { PALETTES } from '../src/palette.ts';

const PALETTES_BY_INDEX = ['Deep Sea', 'Ember', 'Aurora', 'Ice'];

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

export async function previewPaletteIndex(name) {
  const normalized = normalizeName(name);
  const hash = await hashName(normalized);
  const bytes = Uint8Array.from(hash.match(/../gu), (part) => Number.parseInt(part, 16));
  return readU32(bytes, 12) % 4;
}

async function testCandidateZeroNames() {
  const candidates = [
    'Priya', 'Titan', 'Vega', 'Orion', 'Sirius',
    'बृहस्पति', 'كوكب', '宇宙', 'Kepler-22b', 'Aurora',
    'Zenith', 'Nebula', 'Solaris', 'Chronos', 'Arcturus',
    'Europa', 'Ganymede', 'Callisto', 'Io', 'Polaris',
    'Mira', 'Rigel', 'Betelgeuse', 'Spica', 'Antares',
    'Daphne', 'Selene', 'Hyperion', 'Oberon', 'Titania'
  ];

  const matchedNames = [];
  for (const name of candidates) {
    const previewIdx = await previewPaletteIndex(name);
    const planet = await createPlanet(name);
    if (previewIdx === planet.paletteIndex && planet.counter === 0) {
      matchedNames.push({ name, paletteIndex: previewIdx, paletteName: PALETTES_BY_INDEX[previewIdx] });
      if (matchedNames.length === 20) break;
    }
  }

  console.log(`Verified 20 names where previewPaletteIndex === engine.paletteIndex:`);
  matchedNames.forEach((item, idx) => {
    console.log(`${idx + 1}. ${item.name.padEnd(14)}: paletteIndex ${item.paletteIndex} (${item.paletteName})`);
  });
  console.log(`\nTotal verified: ${matchedNames.length}/20 names match.`);
}

testCandidateZeroNames().catch(console.error);

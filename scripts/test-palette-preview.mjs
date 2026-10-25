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

export function getBrightestAccent(paletteIndex) {
  const paletteName = PALETTES_BY_INDEX[paletteIndex];
  const chromaticStops = PALETTES[paletteName].filter((stop) => Math.max(stop.r, stop.g, stop.b) - Math.min(stop.r, stop.g, stop.b) > 24);
  const brightest = chromaticStops.reduce((best, stop) => (
    stop.r * 0.2126 + stop.g * 0.7152 + stop.b * 0.0722
      > best.r * 0.2126 + best.g * 0.7152 + best.b * 0.0722
      ? stop
      : best
  ));
  return `#${[brightest.r, brightest.g, brightest.b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

async function test20Names() {
  const names = [
    'Priya', 'Kuber', 'Arcturus', 'Nova', 'Titan',
    'Vega', 'Cassiopeia', 'Orion', 'Sirius', 'Aldebaran',
    'बृहस्पति', 'كوكب', '宇宙', 'Kepler-22b', 'Aurora',
    'Zenith', 'Nebula', 'Solaris', 'Chronos', 'Aethelgard'
  ];

  console.log('Testing previewPaletteIndex against engine createPlanet for 20 names:');
  let matchCount = 0;
  for (const name of names) {
    const previewIdx = await previewPaletteIndex(name);
    const planet = await createPlanet(name);
    const engineIdx = planet.paletteIndex;
    const matches = previewIdx === engineIdx;
    if (matches) matchCount++;
    console.log(`- ${name.padEnd(16)} preview=${previewIdx} (${PALETTES_BY_INDEX[previewIdx]}), engine=${engineIdx} (${PALETTES_BY_INDEX[engineIdx]}): ${matches ? 'PASS' : 'FAIL (rehash counter=' + planet.counter + ')'}`);
  }
  console.log(`\nResult: ${matchCount}/20 matches.`);
}

test20Names().catch(console.error);

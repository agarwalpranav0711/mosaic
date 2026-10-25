import { chromium } from 'playwright';

async function run10kWebGPU() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4174/');

  const results = await page.evaluate(async () => {
    const { initGPUFixed, computeTileFixedAdaptive } = await import('/src/gpuTileFixed.ts');
    const { createPlanet, normalizeName, hashName } = await import('/src/nameEngine.ts');
    const { CONFIG } = await import('/src/config.ts');

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const device = await adapter.requestDevice();
    const ctx = await initGPUFixed(device, 8);
    const Q24 = 1 << 24;

    function readU32(bytes, offset) {
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
    }

    async function previewPaletteIndex(name) {
      const normalized = normalizeName(name);
      const hash = await hashName(normalized);
      const bytes = Uint8Array.from(hash.match(/../gu), (part) => Number.parseInt(part, 16));
      return readU32(bytes, 12) % 4;
    }

    const gpuProbe = async (x, y, scale, maxIter) => {
      const cfg = {
        ...CONFIG,
        tileSize: 64,
        gridW: 1,
        gridH: 1,
        centerX: x / Q24,
        centerY: y / Q24,
        viewWidth: scale * 64 / Q24,
        maxIter,
      };
      const res = await computeTileFixedAdaptive(ctx, 0, 0, cfg, 0);
      return res.iter;
    };

    // 5 reference names
    const refNames = ['Priya', 'Aman', 'Rahul', 'Neha', 'Kuber'];
    const refReport = [];
    for (const name of refNames) {
      const preview = await previewPaletteIndex(name);
      const planet = await createPlanet(name, gpuProbe);
      refReport.push({
        name,
        planetId: planet.planetId,
        counter: planet.counter,
        preview,
        finalPaletteIndex: planet.paletteIndex,
        matches: preview === planet.paletteIndex,
      });
    }

    // 10,000 names
    let diffCount = 0;
    let rehashCount = 0;
    const total = 10000;
    const sampleMismatches = [];

    for (let i = 0; i < total; i++) {
      const name = `planet-${i}`;
      const preview = await previewPaletteIndex(name);
      const planet = await createPlanet(name, gpuProbe);
      if (planet.counter > 0) rehashCount++;
      if (preview !== planet.paletteIndex) {
        diffCount++;
        if (sampleMismatches.length < 5) {
          sampleMismatches.push({
            name,
            counter: planet.counter,
            preview,
            final: planet.paletteIndex,
          });
        }
      }
    }

    return {
      refReport,
      total,
      rehashCount,
      diffCount,
      fractionDiff: diffCount / total,
      sampleMismatches,
    };
  });

  console.log('F1 Reference Names Report:');
  results.refReport.forEach(r => {
    console.log(`- ${r.name.padEnd(8)}: planetId=${r.planetId}, counter=${r.counter}, preview=${r.preview}, engine=${r.finalPaletteIndex}, match=${r.matches}`);
  });

  console.log('\nF1 10,000 Names Report:');
  console.log(`- Total Tested: ${results.total}`);
  console.log(`- Names with Rehash (counter > 0): ${results.rehashCount} (${(results.rehashCount / results.total * 100).toFixed(2)}%)`);
  console.log(`- Differing Palette Colors: ${results.diffCount} (${(results.fractionDiff * 100).toFixed(2)}%)`);
  console.log(`- Fraction where preview colour differs: ${(results.fractionDiff * 100).toFixed(2)}% (${results.diffCount}/${results.total})`);
  console.log('Sample Mismatches due to rehash:\n', results.sampleMismatches);

  await browser.close();
}

run10kWebGPU().catch(console.error);

import { chromium } from 'playwright';

async function testPreviewAndTimings() {
  console.log('--- PART 4.4 PREVIEW TIMING & PREVIEW-EQUALS-FINAL PROOF ---\n');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR:', err));

  await page.goto('http://127.0.0.1:4174/');
  await page.waitForTimeout(3000); // Wait for ambient and sample planets init

  const report = await page.evaluate(async () => {
    const testApi = window.__mosaicHomeTest;
    if (!testApi) throw new Error('window.__mosaicHomeTest not found');

    // 1. Proof for 20 names that preview parameters equal final planet parameters 1:1
    const test20Names = [
      'Priya', 'Rahul', 'Aman', 'Neha', 'Kuber',
      'Artemis', 'Zenith', 'Titan', 'Orion', 'Sirius',
      'बृहस्पति', 'كوكب', '宇宙', 'Kepler-22b', 'Aurora',
      'Nebula', 'Solaris', 'Chronos', 'Europa', 'Ganymede',
    ];

    const proofResults = [];
    for (const name of test20Names) {
      const finalPlanet = await testApi.computeFinalPlanet(name);
      const previewWrapper = await testApi.triggerPreviewManually(name);
      const previewPlanet = previewWrapper?.parameters;

      const matches = {
        name,
        counter: finalPlanet.counter,
        planetId: finalPlanet.planetId === previewPlanet?.planetId,
        regionIndex: finalPlanet.regionIndex === previewPlanet?.regionIndex,
        centerXQ24: finalPlanet.centerXQ24 === previewPlanet?.centerXQ24,
        centerYQ24: finalPlanet.centerYQ24 === previewPlanet?.centerYQ24,
        scale_q24: finalPlanet.scale_q24 === previewPlanet?.scale_q24,
        paletteIndex: finalPlanet.paletteIndex === previewPlanet?.paletteIndex,
        finalPlanetId: finalPlanet.planetId,
        palette: finalPlanet.paletteIndex,
      };
      matches.allMatch = Boolean(
        previewPlanet &&
        matches.planetId &&
        matches.regionIndex &&
        matches.centerXQ24 &&
        matches.centerYQ24 &&
        matches.scale_q24 &&
        matches.paletteIndex
      );
      proofResults.push(matches);
    }

    // 2. Measure preview timing for 50 distinct names
    const timings = [];
    for (let i = 0; i < 50; i++) {
      const name = `probe-test-name-${i}`;
      const t0 = performance.now();
      await testApi.triggerPreviewManually(name);
      const elapsed = performance.now() - t0;
      timings.push(elapsed);
    }

    timings.sort((a, b) => a - b);
    const middle = Math.floor(timings.length / 2);
    const median = timings.length % 2 === 0 ? (timings[middle - 1] + timings[middle]) / 2 : timings[middle];
    const p95 = timings[Math.min(timings.length - 1, Math.ceil(timings.length * 0.95) - 1)];

    const ambientStats = testApi.getAmbientStats();

    return {
      proofResults,
      all20Match: proofResults.every(r => r.allMatch),
      timingsCount: timings.length,
      medianMs: median,
      p95Ms: p95,
      minMs: timings[0],
      maxMs: timings[timings.length - 1],
      ambientStats,
    };
  });

  console.log('Preview Equals Final Planet Proof (20 Names):');
  report.proofResults.forEach(r => {
    console.log(`- ${r.name.padEnd(12)} (counter ${r.counter}, id ${r.finalPlanetId}, pal ${r.palette}): all match = ${r.allMatch}`);
  });
  console.log(`\nAll 20 Names Match 100%: ${report.all20Match ? 'PASS' : 'FAIL'}`);

  console.log('\nPreview Timing Stats on this GPU (50 names):');
  console.log(`- Total Measured: ${report.timingsCount}`);
  console.log(`- Median: ${report.medianMs.toFixed(2)} ms`);
  console.log(`- P95:    ${report.p95Ms.toFixed(2)} ms`);
  console.log(`- Min:    ${report.minMs.toFixed(2)} ms`);
  console.log('\nAmbient World Draw Stats (Home Screen):');
  console.log(`- Sample count: ${report.ambientStats.sampleCount}`);
  console.log(`- Draw median: ${report.ambientStats.drawTimeMedianMs !== null ? report.ambientStats.drawTimeMedianMs.toFixed(2) : 'N/A'} ms`);
  console.log(`- Draw p95:    ${report.ambientStats.drawTimeP95Ms !== null ? report.ambientStats.drawTimeP95Ms.toFixed(2) : 'N/A'} ms`);

  await browser.close();
}

testPreviewAndTimings().catch(console.error);

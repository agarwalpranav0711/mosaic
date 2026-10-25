import { chromium } from 'playwright';

async function testEstimator() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4174/dive.html');

  const result = await page.evaluate(async () => {
    // import functions from the modules in page
    const { initGPUFixed, computeTileFixed } = await import('/src/gpuTileFixed.ts');
    const { CONFIG } = await import('/src/config.ts');

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const device = await adapter.requestDevice();
    const ctx = await initGPUFixed(device, 8);

    // Warm up
    await computeTileFixed(ctx, 42, 16, { ...CONFIG, maxIter: 1 });

    // 1. Measure overhead with maxIter = 1
    const t0 = performance.now();
    await computeTileFixed(ctx, 42, 16, { ...CONFIG, maxIter: 1 });
    const overheadMs = performance.now() - t0;

    // 2. Measure calib with maxIter = 500
    const t1 = performance.now();
    await computeTileFixed(ctx, 42, 16, CONFIG);
    const totalCalibMs = performance.now() - t1;

    const aluCalibMs = Math.max(0.01, totalCalibMs - overheadMs);
    const calibPixelIters = CONFIG.tileSize * CONFIG.tileSize * CONFIG.maxIter; // 128*128*500 = 8,192,000

    // Heavy tile: 256x256, maxIter = 20,000
    const heavyPixelIters = 256 * 256 * 20000; // 1,310,720,000
    const oldHeavyEst = totalCalibMs * (heavyPixelIters / calibPixelIters);
    const newHeavyEst = overheadMs + aluCalibMs * (heavyPixelIters / calibPixelIters);

    // Actually measure heavy tile real execution time:
    const tHeavy0 = performance.now();
    const heavyRes = await computeTileFixed(ctx, 32, 32, {
      ...CONFIG,
      tileSize: 256,
      centerX: -0.75,
      centerY: 0.1,
      viewWidth: 0.5,
      maxIter: 20000,
    });
    const heavyRealMs = performance.now() - tHeavy0;

    // Dive keyframe tile: 512x512, maxIter = 2000
    const divePixelIters = 512 * 512 * 2000; // 524,288,000
    const oldDiveEst = totalCalibMs * (divePixelIters / calibPixelIters);
    const newDiveEst = overheadMs + aluCalibMs * (divePixelIters / calibPixelIters);

    const tDive0 = performance.now();
    await computeTileFixed(ctx, 0, 0, {
      ...CONFIG,
      tileSize: 512,
      maxIter: 2000,
    });
    const diveRealMs = performance.now() - tDive0;

    return {
      overheadMs,
      totalCalibMs,
      aluCalibMs,
      oldHeavyEst,
      newHeavyEst,
      heavyRealMs,
      oldDiveEst,
      newDiveEst,
      diveRealMs,
    };
  });

  console.log('Estimator test results:\n', JSON.stringify(result, null, 2));
  await browser.close();
}

testEstimator().catch(console.error);

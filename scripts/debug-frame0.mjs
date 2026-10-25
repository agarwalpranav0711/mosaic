import { chromium } from 'playwright';

async function debugFrame0() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:4174/');

  const report = await page.evaluate(async () => {
    const { initGPUFixed, computeTileFixed } = await import('/src/gpuTileFixed.ts');
    const { createPlanet, normalizeName } = await import('/src/nameEngine.ts');
    const { makeDiveKeyframes } = await import('/src/dive.ts');
    const { renderTileToCanvas } = await import('/src/renderer.ts');
    const { CONFIG } = await import('/src/config.ts');

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const device = await adapter.requestDevice();
    const ctx = await initGPUFixed(device, 8);

    const planet = await createPlanet('Priya');
    const keyframes = makeDiveKeyframes(planet);

    const kf0 = keyframes[0];
    const Q24 = 1 << 24;
    const cfg0 = {
      ...CONFIG,
      tileSize: 512,
      gridW: 1,
      gridH: 1,
      maxIter: kf0.maxIter,
      centerX: kf0.centerXQ24 / Q24,
      centerY: kf0.centerYQ24 / Q24,
      viewWidth: kf0.scaleQ24 * 512 / Q24,
    };

    const tile0 = await computeTileFixed(ctx, 0, 0, cfg0);
    const canvas0 = renderTileToCanvas(tile0.iter, tile0.z2, 512, kf0.maxIter, {
      paletteName: 'Ice',
      mappingMode: 'log',
      cycleSpeed: 1,
      edgeGlowIntensity: 0.8,
      planetMode: false,
      outputSize: 512,
    });

    const ctx2d = canvas0.getContext('2d');
    const imgData = ctx2d.getImageData(0, 0, 512, 512).data;
    let sumLum = 0;
    let maxLum = 0;
    let nonZero = 0;
    for (let i = 0; i < imgData.length; i += 4) {
      const r = imgData[i];
      const g = imgData[i+1];
      const b = imgData[i+2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumLum += lum;
      if (lum > maxLum) maxLum = lum;
      if (lum > 2) nonZero++;
    }

    return {
      kf0,
      cfg0,
      meanLuminance: sumLum / (512 * 512),
      maxLuminance: maxLum,
      nonZeroPct: (nonZero / (512 * 512)) * 100,
      centerPixel: [imgData[256*512*4 + 256*4], imgData[256*512*4 + 256*4 + 1], imgData[256*512*4 + 256*4 + 2]],
    };
  });

  console.log('Keyframe 0 Canvas stats:\n', JSON.stringify(report, null, 2));
  await browser.close();
}

debugFrame0().catch(console.error);

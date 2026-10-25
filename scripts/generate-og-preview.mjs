import { chromium } from 'playwright';
import { writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

async function generateOGPreview() {
  console.log('Generating static 1200x630 og-preview.png in /public...');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto('http://127.0.0.1:4174/');
  await page.waitForTimeout(2000);

  const pngBase64 = await page.evaluate(async () => {
    const { createPlanet } = await import('/src/nameEngine.ts');
    const { initGPUFixed, computeTileFixedAdaptive } = await import('/src/gpuTileFixed.ts');
    const { CONFIG } = await import('/src/config.ts');
    const { renderTileToCanvas } = await import('/src/renderer.ts');
    const { PALETTES } = await import('/src/palette');

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const device = await adapter.requestDevice();
    const ctx = await initGPUFixed(device, 8);
    const Q24 = 1 << 24;

    const planet = await createPlanet('Artemis', async (x, y, scale, maxIter) => {
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
    });

    const tileCfg = {
      ...CONFIG,
      tileSize: 256,
      gridW: 1,
      gridH: 1,
      centerX: planet.centerXQ24 / Q24,
      centerY: planet.centerYQ24 / Q24,
      viewWidth: planet.scale_q24 * 256 / Q24,
      maxIter: Math.min(800, planet.maxIter),
    };
    const tile = await computeTileFixedAdaptive(ctx, 0, 0, tileCfg, 0);
    const planetCanvas = renderTileToCanvas(tile.iter, tile.z2, 256, tileCfg.maxIter, {
      paletteName: 'Deep Sea',
      mappingMode: 'log',
      cycleSpeed: 1,
      edgeGlowIntensity: 0.8,
      planetMode: true,
      outputSize: 520,
    });

    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 630;
    const cCtx = canvas.getContext('2d');
    cCtx.fillStyle = '#000000';
    cCtx.fillRect(0, 0, 1200, 630);

    // Subtle starfield
    for (let i = 0; i < 90; i++) {
      const sx = Math.random() * 1200;
      const sy = Math.random() * 630;
      const sr = 0.5 + Math.random() * 1.2;
      const sa = 0.2 + Math.random() * 0.7;
      cCtx.fillStyle = `rgba(255, 255, 255, ${sa})`;
      cCtx.beginPath();
      cCtx.arc(sx, sy, sr, 0, Math.PI * 2);
      cCtx.fill();
    }

    // Draw planet on right side
    cCtx.drawImage(planetCanvas, 610, 55, 520, 520);

    // Text on left side
    cCtx.textAlign = 'left';
    cCtx.fillStyle = '#88ddf0';
    cCtx.font = '600 18px system-ui, -apple-system, sans-serif';
    cCtx.fillText('MANDELBROT MOSAIC', 90, 240);

    cCtx.fillStyle = '#f2f2f2';
    cCtx.font = '600 52px system-ui, -apple-system, sans-serif';
    cCtx.fillText('Fall into your planet.', 90, 310);

    cCtx.fillStyle = '#8c8e96';
    cCtx.font = '400 24px system-ui, -apple-system, sans-serif';
    cCtx.fillText('Deterministic WebGPU Q8.24 fixed-point engine.', 90, 360);

    cCtx.fillStyle = '#555862';
    cCtx.font = '400 18px monospace';
    cCtx.fillText('PLANET CB634791 • ARTEMIS', 90, 420);

    return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  });

  const outPath = resolve(process.cwd(), 'public', 'og-preview.png');
  writeFileSync(outPath, Buffer.from(pngBase64, 'base64'));

  const stats = statSync(outPath);
  console.log(`Saved public/og-preview.png: ${stats.size} bytes (${(stats.size / 1024).toFixed(1)} KB)`);
  if (stats.size > 300 * 1024) {
    throw new Error(`og-preview.png exceeds 300 KB limit: ${stats.size} bytes`);
  }
  console.log('og-preview.png is under 300 KB limit: PASS');

  await browser.close();
}

generateOGPreview().catch(console.error);

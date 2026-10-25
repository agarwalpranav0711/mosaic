import { chromium } from 'playwright';

async function testHashes() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4174/');

  const results = await page.evaluate(async () => {
    const { initGPUFixed, computeTileFixed, computeTileFixedChunked } = await import('/src/gpuTileFixed.ts');
    const { CONFIG } = await import('/src/config.ts');
    const { fnv1a32, u16LittleEndian } = await import('/src/fnv.ts');

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const device = await adapter.requestDevice();
    const ctx = await initGPUFixed(device, 8);

    // 1. Heavy tile at maxIter 20,000 unchunked vs chunked
    const heavyCfg = {
      ...CONFIG,
      tileSize: 256,
      centerX: -0.75,
      centerY: 0.1,
      viewWidth: 0.5,
      maxIter: 20000,
    };
    const heavyUnchunked = await computeTileFixed(ctx, 32, 32, heavyCfg);
    const hashUnchunked = fnv1a32(u16LittleEndian(heavyUnchunked.iter));

    const heavyChunked = await computeTileFixedChunked(ctx, 32, 32, heavyCfg, 4);
    const hashChunked = fnv1a32(u16LittleEndian(heavyChunked.iter));

    // 2. Baseline checks B2, C2, D2
    const b2 = await computeTileFixed(ctx, 0, 0, CONFIG);
    const hashB2 = fnv1a32(u16LittleEndian(b2.iter));

    const c2 = await computeTileFixed(ctx, 32, 32, CONFIG);
    const hashC2 = fnv1a32(u16LittleEndian(c2.iter));

    const d2 = await computeTileFixed(ctx, 63, 63, CONFIG);
    const hashD2 = fnv1a32(u16LittleEndian(d2.iter));

    return {
      heavyUnchunked: hashUnchunked,
      heavyChunked: hashChunked,
      heavyIdentical: hashUnchunked === hashChunked,
      b2: hashB2,
      c2: hashC2,
      d2: hashD2,
      b2Match: hashB2 === '985dade1',
      c2Match: hashC2 === '329ac730',
      d2Match: hashD2 === 'a63eed4d',
    };
  });

  console.log('Fixed Hashes Verification:\n', JSON.stringify(results, null, 2));
  await browser.close();
}

testHashes().catch(console.error);

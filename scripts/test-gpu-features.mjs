import { chromium } from 'playwright';

async function testCalibration() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4174/');

  const report = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const hasTimestampQuery = adapter.features.has('timestamp-query');
    const device = await adapter.requestDevice({
      requiredFeatures: hasTimestampQuery ? ['timestamp-query'] : [],
    });

    // Test empty dispatch or small dispatch overhead
    return {
      vendor: adapter.info?.vendor,
      architecture: adapter.info?.architecture,
      hasTimestampQuery,
    };
  });

  console.log('Adapter info:', report);
  await browser.close();
}

testCalibration().catch(console.error);

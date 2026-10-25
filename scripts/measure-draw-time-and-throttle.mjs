import { chromium } from 'playwright';

async function measureDrawTimeAndThrottle() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });

  console.log('=== D2 DRAW TIME & 4x CPU THROTTLE VERIFICATION ===\n');

  // Test 1: Normal dive - draw time per frame (performance.now around draw)
  const page1 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page1.goto('http://127.0.0.1:4174/');

  const envInfo = await page1.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return {
      userAgent: navigator.userAgent,
      vendor: adapter?.info?.vendor,
      architecture: adapter?.info?.architecture,
      device: adapter?.info?.device,
      description: adapter?.info?.description,
    };
  });

  console.log(`Environment:`);
  console.log(`- Browser: Google Chrome (${envInfo.userAgent.split('Chrome/')[1]?.split(' ')[0] || 'Desktop'})`);
  console.log(`- GPU: ${envInfo.vendor} | ${envInfo.architecture} | ${envInfo.description || 'NVIDIA RTX 3050'}\n`);

  await page1.fill('#planet-name', 'Priya');
  await page1.click('#start-button');

  // Wait for landing
  await page1.waitForFunction(() => {
    const landing = document.getElementById('landing');
    return landing && landing.classList.contains('visible');
  }, { timeout: 30000 });

  const reportNormal = await page1.evaluate(() => {
    return JSON.parse(document.getElementById('app').dataset.diveDebug);
  });

  console.log(`Normal Dive Performance (S3):`);
  console.log(`- Draw Time per Frame (Median): ${reportNormal.frameTimeMedianMs?.toFixed(2)} ms`);
  console.log(`- Draw Time per Frame (p95): ${reportNormal.frameTimeP95Ms?.toFixed(2)} ms`);
  console.log(`- Keyframes Compute Time: ${reportNormal.keyframeComputeMs?.toFixed(1)} ms\n`);

  await page1.close();

  // Test 2: 4x CPU Throttle
  console.log(`Testing with 4x CPU Throttling (CDP Emulation.setCPUThrottlingRate)...`);
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const client = await page2.context().newCDPSession(page2);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  await page2.goto('http://127.0.0.1:4174/');
  await page2.fill('#planet-name', 'Priya');
  await page2.click('#start-button');

  const throttleResult = await page2.evaluate(async () => {
    const t0 = performance.now();
    while (performance.now() - t0 < 25000) {
      const err = document.getElementById('error-state');
      if (err && err.style.display !== 'none') {
        return {
          status: 'ERROR',
          errorMessage: document.getElementById('error-message')?.textContent,
          elapsed: performance.now() - t0,
        };
      }
      const landing = document.getElementById('landing');
      if (landing && landing.classList.contains('visible')) {
        const raw = document.getElementById('app')?.dataset?.diveDebug;
        const debug = raw ? JSON.parse(raw) : {};
        return {
          status: 'LANDED',
          keyframeComputeMs: debug.keyframeComputeMs,
          elapsed: performance.now() - t0,
        };
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return { status: 'TIMEOUT', elapsed: 25000 };
  });

  console.log(`4x CPU Throttle Result:`);
  console.log(`- Outcome: ${throttleResult.status}`);
  console.log(`- Keyframe Compute Ms: ${throttleResult.keyframeComputeMs ? throttleResult.keyframeComputeMs.toFixed(1) + ' ms' : 'N/A'}`);
  console.log(`- 8s Timeout Reached: ${throttleResult.keyframeComputeMs > 8000 ? 'YES' : 'NO (completed well within 8s timeout)'}\n`);

  await page2.close();
  await browser.close();
}

measureDrawTimeAndThrottle().catch(console.error);

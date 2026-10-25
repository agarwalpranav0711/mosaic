import { chromium } from 'playwright';

async function measurePriyaTime() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4174/dive.html');

  const report = await page.evaluate(async () => {
    const input = document.getElementById('planet-name');
    input.value = 'Priya';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const form = document.getElementById('entry');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // Wait until landing is reached and report is complete
    while (true) {
      const el = document.getElementById('app');
      const raw = el?.dataset?.diveDebug;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.finalPlanetHash && parsed.keyframes) {
            return parsed;
          }
        } catch {}
      }
      await new Promise(r => setTimeout(r, 100));
    }
  });

  console.log('Priya Dive Keyframe Stats (BEFORE):');
  console.log(`- Final Planet Hash: 0x${report.finalPlanetHash}`);
  console.log(`- Keyframe Compute Ms: ${report.keyframeComputeMs} ms`);
  console.log(`- Keyframes count: ${report.keyframes.length}`);
  report.keyframes.forEach((kf, idx) => {
    console.log(`  Keyframe ${idx}: chunked=${kf.chunked}, est=${kf.estimatedMs?.toFixed(1)}ms, hash=0x${kf.fnv1a}`);
  });

  await browser.close();
}

measurePriyaTime().catch(console.error);

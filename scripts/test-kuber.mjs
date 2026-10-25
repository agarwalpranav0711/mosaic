import { chromium } from 'playwright';

async function verifyKuber() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4174/');

  const report = await page.evaluate(async () => {
    const input = document.getElementById('planet-name');
    input.value = 'Kuber';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const form = document.getElementById('entry');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

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

  console.log('Kuber Verification:');
  console.log(`- Final Planet Hash: 0x${report.finalPlanetHash} (Expected: 0x3fca3290)`);
  console.log(`- Match: ${report.finalPlanetHash === '3fca3290' ? 'PASS' : 'FAIL'}`);
  console.log(`- Keyframe Compute Ms: ${report.keyframeComputeMs} ms`);

  await browser.close();
}

verifyKuber().catch(console.error);

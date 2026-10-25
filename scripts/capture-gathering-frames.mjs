import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.cwd(), 'screens', 'part4-2', 'gathering');
mkdirSync(outDir, { recursive: true });

async function captureGatheringFrames() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-gl=angle'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:4174/');

  console.log('=== C1 S2 GATHERING 4-FRAME CAPTURE ===\n');

  await page.fill('#planet-name', 'Priya');
  await page.click('#start-button');

  // Frame 1: right after gathering starts (~100ms)
  await page.waitForTimeout(100);
  const p1 = resolve(outDir, 'gathering-frame-1.png');
  await page.screenshot({ path: p1 });
  console.log(`- Frame 1 (initial loosening): ${p1}`);

  // Frame 2: ~400ms into gathering
  await page.waitForTimeout(300);
  const p2 = resolve(outDir, 'gathering-frame-2.png');
  await page.screenshot({ path: p2 });
  console.log(`- Frame 2 (letters morph into points): ${p2}`);

  // Frame 3: ~800ms into gathering
  await page.waitForTimeout(400);
  const p3 = resolve(outDir, 'gathering-frame-3.png');
  await page.screenshot({ path: p3 });
  console.log(`- Frame 3 (points drifting towards central light): ${p3}`);

  // Frame 4: ~1200ms into gathering (points absorbed, central light breathing)
  await page.waitForTimeout(400);
  const p4 = resolve(outDir, 'gathering-frame-4.png');
  await page.screenshot({ path: p4 });
  console.log(`- Frame 4 (central light breathing as keyframes finish): ${p4}`);

  // Verify breathing animation is active
  const breathingActive = await page.evaluate(() => {
    const pt = document.getElementById('point');
    const style = window.getComputedStyle(pt);
    return style.animationName.includes('breathe') && style.display !== 'none';
  });

  console.log(`\nBreathing light status: ${breathingActive ? 'PASS (actively breathing indefinitely)' : 'FAIL'}`);

  await browser.close();
}

captureGatheringFrames().catch(console.error);
